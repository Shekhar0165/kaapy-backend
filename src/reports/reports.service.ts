import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type QueryFilter } from 'mongoose';
import { summarizeCustomerBalances } from '../customer/customer-summary.js';
import { Customer, CustomerDocument } from '../customer/schemas/customer.schema.js';
import {
  Transaction,
  TransactionDocument,
  TransactionType,
} from '../transaction/schemas/transaction.schema.js';
import { BalanceReportDto } from './dto/balance-report.dto.js';
import { istPeriodStart, type ReportPeriod } from './ist-period.js';

const TOP_DEBTORS = 5;
const RECENT_ENTRIES = 10;

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
  ) {}

  /** Every query below is filtered by this shop's id. Not cached. */
  async balance(shopId: string, period: ReportPeriod, now: Date = new Date()): Promise<BalanceReportDto> {
    const shop = new Types.ObjectId(shopId);
    const periodStart = istPeriodStart(period, now);

    const [summary, flows, topDebtors, recent] = await Promise.all([
      // Same function as the customers list summary.
      summarizeCustomerBalances(this.customerModel, shop),
      this.flows(shop, periodStart, now),
      this.topDebtors(shop),
      this.recent(shop),
    ]);

    return {
      period,
      periodStart,
      periodEnd: now,
      generatedAt: now,
      ...summary,
      ...flows,
      topDebtors,
      recent,
    };
  }

  /**
   * Given/received in the period. Archived customers' past entries still count.
   * Uses the (shopId, createdAt) index.
   */
  private async flows(shop: Types.ObjectId, start: Date | null, end: Date) {
    const match: QueryFilter<TransactionDocument> = {
      shopId: shop,
      createdAt: start ? { $gte: start, $lte: end } : { $lte: end },
    };
    const rows = await this.transactionModel
      .aggregate<{ _id: TransactionType; total: number; count: number }>([
        { $match: match },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .exec();
    const of = (type: TransactionType) => rows.find((row) => row._id === type);
    return {
      given: of(TransactionType.GAVE)?.total ?? 0,
      givenCount: of(TransactionType.GAVE)?.count ?? 0,
      received: of(TransactionType.GOT)?.total ?? 0,
      receivedCount: of(TransactionType.GOT)?.count ?? 0,
    };
  }

  /** Top positive balances, desc, ties by name. Uses (shopId, balance desc, name). */
  private async topDebtors(shop: Types.ObjectId) {
    const docs = await this.customerModel
      .find({ shopId: shop, balance: { $gt: 0 }, isArchived: false })
      .sort({ balance: -1, name: 1 })
      .limit(TOP_DEBTORS)
      .select('name balance')
      .lean()
      .exec();
    return docs.map((doc) => ({ balance: doc.balance, customerId: doc._id.toString(), name: doc.name }));
  }

  /** The shop's last entries, any period. Uses (shopId, createdAt desc, _id desc). */
  private async recent(shop: Types.ObjectId) {
    const entries = await this.transactionModel
      .find({ shopId: shop })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_ENTRIES)
      .select('customerId type amount createdAt')
      .lean()
      .exec();

    // Names, archived customers included (their entries still show).
    const ids = [...new Set(entries.map((entry) => entry.customerId.toString()))];
    const customers = await this.customerModel
      .find({ shopId: shop, _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('name')
      .lean()
      .exec();
    const names = new Map(customers.map((customer) => [customer._id.toString(), customer.name]));

    return entries.map((entry) => ({
      amount: entry.amount,
      createdAt: entry.createdAt,
      customerId: entry.customerId.toString(),
      customerName: names.get(entry.customerId.toString()) ?? '',
      id: entry._id.toString(),
      type: entry.type,
    }));
  }
}
