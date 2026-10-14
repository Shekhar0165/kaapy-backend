import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { Customer, CustomerDocument } from '../customer/schemas/customer.schema.js';
import { RedisService } from '../redis/redis.service.js';
import { Shop, ShopDocument } from '../shop/schemas/shop.schema.js';
import { NotificationStateDto, ReportNotificationDto } from './dto/notification.dto.js';
import { buildEmailSubject, buildNotificationMessage } from './notification-message.js';
import { NotificationEmailService } from './notification-email.service.js';
import {
  NotificationStatus,
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema.js';

export const MAX_EMAILS_PER_SHOP_PER_DAY = 300;
export const MAX_EMAILS_PER_CUSTOMER_PER_DAY = 5;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

type FinalOutcome = {
  status: NotificationStatus;
  emailSent: boolean;
  emailError: string | null;
  /** For the log only: was an email send actually tried, and did the customer have one. */
  emailAttempted: boolean;
  customerHasEmail: boolean;
};

/** "2026-10-14": the India calendar day, so daily limits reset at IST midnight. */
function istDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
    private readonly redisService: RedisService,
    private readonly emailService: NotificationEmailService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.cleanupTimer = setInterval(() => {
      this.markStaleAsUnknown().catch(() => this.logger.warn('Pending-notification cleanup failed'));
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * The app reports its SMS attempt. 'pending' moves to a final status exactly
   * once; repeated or parallel calls just read back the current state.
   */
  async report(shopId: string, transactionId: string, dto: ReportNotificationDto): Promise<NotificationStateDto> {
    if (dto.smsResult === undefined && dto.delivered !== true) {
      throw new BadRequestException('Send smsResult, or delivered: true');
    }
    if (!isValidObjectId(transactionId)) throw new NotFoundException('Entry not found');

    const shop = new Types.ObjectId(shopId);
    const id = new Types.ObjectId(transactionId);
    const own = { _id: id, shopId: shop };
    const now = new Date();

    const entry = await this.transactionModel.findOne(own).exec();
    if (!entry) throw new NotFoundException('Entry not found');

    // A delivery report only ever marks a sent SMS as delivered.
    if (dto.smsResult === undefined) {
      const updated = await this.transactionModel
        .findOneAndUpdate(
          { ...own, 'notification.status': 'sms_sent' },
          { $set: { 'notification.smsDelivered': true, 'notification.updatedAt': now } },
          { returnDocument: 'after' },
        )
        .exec();
      return this.toState(updated ?? entry);
    }

    // Claim: only the first report for a pending entry gets past this point.
    const claimed = await this.transactionModel
      .findOneAndUpdate(
        { ...own, 'notification.status': 'pending', 'notification.smsResult': null },
        {
          $set: {
            'notification.smsResult': dto.smsResult,
            'notification.smsErrorCode': dto.smsErrorCode ?? null,
            'notification.updatedAt': now,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      return this.toState((await this.transactionModel.findOne(own).exec()) ?? entry);
    }

    const outcome: FinalOutcome =
      dto.smsResult === 'sent'
        ? {
            customerHasEmail: false,
            emailAttempted: false,
            emailError: null,
            emailSent: false,
            status: 'sms_sent',
          }
        : await this.emailFallback(shop, claimed);

    const finalized = await this.transactionModel
      .findOneAndUpdate(
        { ...own, 'notification.status': 'pending' },
        {
          $set: {
            'notification.status': outcome.status,
            'notification.emailSent': outcome.emailSent,
            'notification.emailError': outcome.emailError,
            'notification.updatedAt': new Date(),
            ...(dto.smsResult === 'sent' && dto.delivered === true
              ? { 'notification.smsDelivered': true }
              : {}),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    // Ids, codes and booleans only: never phone numbers, emails or message text.
    this.logger.log(
      `Entry ${transactionId} notification: ${outcome.status} ` +
        `(smsResult=${dto.smsResult}, smsErrorCode=${dto.smsErrorCode ?? 'none'}, ` +
        `emailAttempted=${outcome.emailAttempted}, customerHasEmail=${outcome.customerHasEmail})`,
    );
    return this.toState(finalized ?? (await this.transactionModel.findOne(own).exec()) ?? claimed);
  }

  /**
   * Entries still 'pending' after 24 hours become 'unknown'. Never emails: the
   * SMS may well have gone out and only the app's report was lost.
   */
  async markStaleAsUnknown(now: Date = new Date()): Promise<number> {
    const result = await this.transactionModel
      .updateMany(
        { 'notification.status': 'pending', createdAt: { $lt: new Date(now.getTime() - STALE_AFTER_MS) } },
        { $set: { 'notification.status': 'unknown', 'notification.updatedAt': now } },
      )
      .exec();
    if (result.modifiedCount > 0) {
      this.logger.log(`Marked ${result.modifiedCount} stale pending notifications as unknown`);
    }
    return result.modifiedCount;
  }

  private async emailFallback(shop: Types.ObjectId, entry: TransactionDocument): Promise<FinalOutcome> {
    const notDelivered = (
      emailError: string,
      flags: { emailAttempted: boolean; customerHasEmail: boolean },
    ): FinalOutcome => ({ ...flags, emailError, emailSent: false, status: 'not_delivered' });

    // The shop turned the email fallback off (as it was when this entry was saved).
    if (entry.notification?.emailFallback === false) {
      return notDelivered('email_fallback_off', { customerHasEmail: false, emailAttempted: false });
    }

    // Only the address stored on the customer, never one from the client.
    const customer = await this.customerModel
      .findOne({ _id: entry.customerId, shopId: shop })
      .select('email')
      .lean()
      .exec();
    if (!customer?.email) {
      return notDelivered('no_email', { customerHasEmail: false, emailAttempted: false });
    }
    const hasEmail = { customerHasEmail: true, emailAttempted: false };

    const day = istDay(new Date());
    try {
      const shopCount = await this.redisService.increment(
        `notify:email:shop:${shop.toString()}:${day}`,
        COUNTER_TTL_SECONDS,
      );
      const customerCount = await this.redisService.increment(
        `notify:email:customer:${entry.customerId.toString()}:${day}`,
        COUNTER_TTL_SECONDS,
      );
      if (shopCount > MAX_EMAILS_PER_SHOP_PER_DAY || customerCount > MAX_EMAILS_PER_CUSTOMER_PER_DAY) {
        return notDelivered('rate_limited', hasEmail);
      }
    } catch {
      // Can't check the limits: don't risk unlimited email.
      return notDelivered('rate_limit_unavailable', hasEmail);
    }

    const shopDoc = await this.shopModel.findById(shop).select('shopName').lean().exec();
    const shopName = shopDoc?.shopName ?? 'Your shop';
    // Built from stored data only, the same text the SMS would have had.
    const language = entry.notification?.language ?? 'en';
    const text = buildNotificationMessage({
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      createdAt: entry.createdAt,
      includeNote: entry.notification?.includeNote ?? true,
      language,
      note: entry.note,
      shopName,
      type: entry.type,
    });

    const result = await this.emailService.send({
      subject: buildEmailSubject(shopName, language),
      text,
      to: customer.email,
      transactionId: entry.id,
    });
    const attempted = { customerHasEmail: true, emailAttempted: true };
    return result.ok
      ? { ...attempted, emailError: null, emailSent: true, status: 'email_sent' }
      : notDelivered(result.error, attempted);
  }

  private toState(doc: TransactionDocument): NotificationStateDto {
    const notification = doc.notification;
    return {
      emailSent: notification?.emailSent ?? false,
      smsDelivered: notification?.smsDelivered ?? false,
      smsErrorCode: notification?.smsErrorCode ?? null,
      smsResult: notification?.smsResult ?? null,
      status: notification?.status ?? 'unknown',
      transactionId: doc.id,
    };
  }
}
