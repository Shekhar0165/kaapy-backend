import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types, type QueryFilter } from 'mongoose';
// Type-only: as a value import, decorator metadata would emit a runtime import of
// `Connection`, which mongoose's CommonJS build doesn't expose to native ESM.
// @InjectConnection() resolves the instance by token, not by this type.
import type { Connection } from 'mongoose';
import { Customer, CustomerDocument } from '../customer/schemas/customer.schema.js';
import { languageOf, settingsOf, Shop, ShopDocument } from '../shop/schemas/shop.schema.js';
import { buildNotificationMessage, resolveMessageLanguage } from './notification-message.js';
import {
  CreateTransactionDto,
  CreateTransactionResponseDto,
  ListTransactionsQueryDto,
  TransactionListResponseDto,
  TransactionResponseDto,
} from './dto/transaction.dto.js';
import {
  Transaction,
  TransactionDocument,
  TransactionType,
} from './schemas/transaction.schema.js';

const DEFAULT_LIMIT = 30;
const DUPLICATE_KEY_ERROR = 11000;

type Cursor = { createdAt: Date; id: Types.ObjectId };

export function encodeCursor(entry: { createdAt: Date; _id: Types.ObjectId }): string {
  return Buffer.from(`${entry.createdAt.toISOString()}_${entry._id.toString()}`).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('_');
  const createdAt = new Date(iso ?? '');
  if (Number.isNaN(createdAt.getTime()) || !id || !isValidObjectId(id)) {
    throw new BadRequestException('cursor is invalid');
  }
  return { createdAt, id: new Types.ObjectId(id) };
}

export type CreateResult = CreateTransactionResponseDto & { created: boolean };

@Injectable()
export class TransactionService {
  constructor(
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Saves one entry and moves the customer's balance in a single MongoDB
   * transaction, so neither can happen without the other. The time is the
   * server's; `balanceAfter` comes from the atomic $inc result, never the client.
   */
  async create(shopId: string, customerId: string, dto: CreateTransactionDto): Promise<CreateResult> {
    const shop = new Types.ObjectId(shopId);
    const customer = this.customerObjectId(customerId);

    // A retry of a request we already saved: answer with the original entry.
    const replay = await this.findReplay(shop, customer, dto.clientRequestId);
    if (replay) return replay;

    const delta = dto.type === TransactionType.GAVE ? dto.amount : -dto.amount;
    // Message settings are read here, on the server, when the entry is saved.
    const shopDoc = await this.shopModel.findById(shop).select('language settings').lean().exec();
    const settings = settingsOf(shopDoc);
    const notification = settings.notifyCustomers
      ? {
          status: 'pending' as const,
          language: resolveMessageLanguage(settings.messageLanguage, languageOf(shopDoc)),
          includeNote: settings.includeNote,
          emailFallback: settings.emailFallback,
        }
      : { status: 'skipped' as const };
    let saved: { entry: TransactionDocument; balance: number } | undefined;

    try {
      await this.connection.transaction(async (session) => {
        const now = new Date();
        const updated = await this.customerModel
          .findOneAndUpdate(
            { _id: customer, shopId: shop, isArchived: false },
            { $inc: { balance: delta }, $set: { lastEntryAt: now } },
            { returnDocument: 'after', session },
          )
          .exec();
        if (!updated) throw new NotFoundException('Customer not found');

        const [entry] = await this.transactionModel.create(
          [
            {
              shopId: shop,
              customerId: customer,
              type: dto.type,
              amount: dto.amount,
              note: dto.note ?? null,
              balanceAfter: updated.balance,
              createdAt: now,
              clientRequestId: dto.clientRequestId,
              notification,
            },
          ],
          { session },
        );
        saved = { entry, balance: updated.balance };
      });
    } catch (error) {
      // The same request raced itself (double tap): the other copy won. Its
      // transaction committed and ours rolled back, so the balance moved once.
      if ((error as { code?: number }).code === DUPLICATE_KEY_ERROR) {
        const original = await this.findReplay(shop, customer, dto.clientRequestId);
        if (original) return original;
      }
      throw error;
    }

    if (!saved) throw new Error('Transaction finished without saving');
    return {
      transaction: this.toResponse(saved.entry),
      balance: saved.balance,
      ...(await this.notificationInfo(shop, saved.entry)),
      created: true,
    };
  }

  async list(
    shopId: string,
    customerId: string,
    query: ListTransactionsQueryDto,
  ): Promise<TransactionListResponseDto> {
    const shop = new Types.ObjectId(shopId);
    const customer = await this.findOwnCustomer(shop, this.customerObjectId(customerId));
    const limit = query.limit ?? DEFAULT_LIMIT;

    const filter: QueryFilter<TransactionDocument> = { shopId: shop, customerId: customer._id };
    if (query.cursor) {
      const { createdAt, id } = decodeCursor(query.cursor);
      filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }];
    }

    const docs = await this.transactionModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .exec();
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((doc) => this.toResponse(doc)),
      nextCursor: docs.length > limit && last ? encodeCursor(last) : null,
      balance: customer.balance,
    };
  }

  private async findReplay(
    shop: Types.ObjectId,
    customer: Types.ObjectId,
    clientRequestId: string,
  ): Promise<CreateResult | null> {
    const existing = await this.transactionModel.findOne({ shopId: shop, clientRequestId }).exec();
    if (!existing) return null;
    if (!existing.customerId.equals(customer)) {
      throw new ConflictException('This clientRequestId was already used for another customer');
    }
    const current = await this.customerModel
      .findOne({ _id: customer, shopId: shop })
      .select('balance')
      .lean()
      .exec();
    return {
      transaction: this.toResponse(existing),
      balance: current?.balance ?? existing.balanceAfter,
      ...(await this.notificationInfo(shop, existing)),
      created: false,
    };
  }

  /**
   * What the app needs to notify the customer: the server-built text (same as
   * the email fallback would use), the phone to text, and whether email exists.
   */
  private async notificationInfo(shop: Types.ObjectId, entry: TransactionDocument) {
    const [customer, shopDoc] = await Promise.all([
      this.customerModel.findOne({ _id: entry.customerId, shopId: shop }).select('phone email').lean().exec(),
      this.shopModel.findById(shop).select('shopName').lean().exec(),
    ]);
    // Messages turned off for this entry: nothing for the app to send.
    const skipped = entry.notification?.status === 'skipped';
    return {
      messageText: skipped
        ? null
        : buildNotificationMessage({
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
            createdAt: entry.createdAt,
            includeNote: entry.notification?.includeNote ?? true,
            language: entry.notification?.language ?? 'en',
            note: entry.note,
            shopName: shopDoc?.shopName ?? 'Your shop',
            type: entry.type,
          }),
      customerPhone: customer?.phone ?? '',
      hasEmail: Boolean(customer?.email),
    };
  }

  /** Active customer of this shop; anything else is a 404. */
  private async findOwnCustomer(shop: Types.ObjectId, customer: Types.ObjectId) {
    const found = await this.customerModel
      .findOne({ _id: customer, shopId: shop, isArchived: false })
      .select('balance')
      .lean()
      .exec();
    if (!found) throw new NotFoundException('Customer not found');
    return found;
  }

  private customerObjectId(id: string): Types.ObjectId {
    if (!isValidObjectId(id)) throw new NotFoundException('Customer not found');
    return new Types.ObjectId(id);
  }

  private toResponse(doc: TransactionDocument): TransactionResponseDto {
    return {
      id: doc.id,
      customerId: doc.customerId.toString(),
      type: doc.type,
      amount: doc.amount,
      note: doc.note ?? null,
      balanceAfter: doc.balanceAfter,
      createdAt: doc.createdAt,
      notification: {
        // Entries saved before notifications existed have none: report 'unknown'.
        status: doc.notification?.status ?? 'unknown',
        smsDelivered: doc.notification?.smsDelivered ?? false,
      },
    };
  }
}
