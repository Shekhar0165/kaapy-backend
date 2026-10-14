import { Model, Types } from 'mongoose';
import type { CustomerDocument } from './schemas/customer.schema.js';

export interface CustomerBalanceSummary {
  /** Sum of positive balances (paise): what customers owe the shop. */
  totalDue: number;
  /** Sum of |negative balances| (paise): paid in advance. Never netted against totalDue. */
  totalAdvance: number;
  customersWithDue: number;
  totalCustomers: number;
}

/**
 * The one definition of a shop's balance totals, shared by the customers list
 * summary and the Balance report so the two screens can never disagree.
 * Archived customers are not counted. Uses the (shopId, isArchived, ...) index.
 */
export async function summarizeCustomerBalances(
  customerModel: Model<CustomerDocument>,
  shopId: Types.ObjectId,
): Promise<CustomerBalanceSummary> {
  const [row] = await customerModel
    .aggregate<CustomerBalanceSummary>([
      { $match: { shopId, isArchived: false } },
      {
        $group: {
          _id: null,
          totalDue: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } },
          totalAdvance: {
            $sum: { $cond: [{ $lt: ['$balance', 0] }, { $multiply: ['$balance', -1] }, 0] },
          },
          customersWithDue: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } },
          totalCustomers: { $sum: 1 },
        },
      },
      { $project: { _id: 0, totalDue: 1, totalAdvance: 1, customersWithDue: 1, totalCustomers: 1 } },
    ])
    .exec();
  return row ?? { totalDue: 0, totalAdvance: 0, customersWithDue: 0, totalCustomers: 0 };
}
