import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types, type QueryFilter } from 'mongoose';
import {
  CreateCustomerDto,
  CustomerListResponseDto,
  CustomerResponseDto,
  CustomerSummaryDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto.js';
import { summarizeCustomerBalances } from './customer-summary.js';
import { Customer, CustomerDocument } from './schemas/customer.schema.js';

const DEFAULT_LIMIT = 30;
const DUPLICATE_KEY_ERROR = 11000;

/** Escapes user input for use inside a RegExp. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ₹4,650 from 465000 paise (Indian grouping), for error messages. */
function formatRupees(paise: number): string {
  return `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

@Injectable()
export class CustomerService {
  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
  ) {}

  async create(shopId: string, dto: CreateCustomerDto): Promise<CustomerResponseDto> {
    const owner = this.shopObjectId(shopId);

    try {
      const created = await this.customerModel.create({
        shopId: owner,
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        source: dto.source,
      });
      return this.toResponse(created);
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw error;
    }

    // The unique (shopId, phone) index caught a duplicate, even under concurrent requests.
    const existing = await this.customerModel.findOne({ shopId: owner, phone: dto.phone }).exec();
    if (!existing) {
      throw new ConflictException('A customer with this phone number already exists');
    }

    if (existing.isArchived) {
      // Deleted customers always have a zero balance; bring them back under the new name.
      existing.isArchived = false;
      existing.name = dto.name;
      existing.email = dto.email ?? null;
      await existing.save();
      return this.toResponse(existing);
    }

    throw new ConflictException({
      statusCode: 409,
      code: 'CUSTOMER_EXISTS',
      message: 'A customer with this phone number already exists',
      customer: { id: existing.id, name: existing.name },
    });
  }

  async list(shopId: string, query: ListCustomersQueryDto): Promise<CustomerListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const base = this.activeFilter(shopId);
    const filter: QueryFilter<CustomerDocument> = { ...base };

    if (query.filter === 'due') filter.balance = { $gt: 0 };
    if (query.filter === 'settled') filter.balance = { $lte: 0 };

    if (query.search) {
      const or: QueryFilter<CustomerDocument>[] = [
        { name: { $regex: escapeRegex(query.search), $options: 'i' } },
      ];
      const digits = query.search.replace(/\D/g, '');
      if (digits.length > 0) {
        // Digits only, so no escaping is needed.
        or.push({ phone: { $regex: digits } });
      }
      filter.$or = or;
    }

    const [docs, total, summary] = await Promise.all([
      this.customerModel
        .find(filter)
        // Customers with no entries (lastEntryAt null) sort after active ones.
        .sort({ lastEntryAt: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.customerModel.countDocuments(filter).exec(),
      this.summary(shopId),
    ]);

    return { items: docs.map((doc) => this.toResponse(doc)), total, page, limit, summary };
  }

  async get(shopId: string, id: string): Promise<CustomerResponseDto> {
    return this.toResponse(await this.findOwn(shopId, id));
  }

  async update(shopId: string, id: string, dto: UpdateCustomerDto): Promise<CustomerResponseDto> {
    if (dto.name === undefined && dto.email === undefined) {
      throw new BadRequestException('Send a name and/or an email to update');
    }
    const customer = await this.findOwn(shopId, id);
    if (dto.name !== undefined) customer.name = dto.name;
    if (dto.email !== undefined) customer.email = dto.email;
    await customer.save();
    return this.toResponse(customer);
  }

  async archive(shopId: string, id: string): Promise<void> {
    const customer = await this.findOwn(shopId, id);
    if (customer.balance !== 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'BALANCE_NOT_ZERO',
        message: `Settle the balance of ${formatRupees(customer.balance)} before deleting this customer`,
        balance: customer.balance,
      });
    }
    customer.isArchived = true;
    await customer.save();
  }

  /** Totals over every active customer of the shop, ignoring search, filter and paging. */
  private async summary(shopId: string): Promise<CustomerSummaryDto> {
    const { totalDue, customersWithDue, totalCustomers } = await summarizeCustomerBalances(
      this.customerModel,
      this.shopObjectId(shopId),
    );
    return { totalDue, customersWithDue, totalCustomers };
  }

  /**
   * Loads one active customer that belongs to this shop. Another shop's
   * customer, an archived one and a malformed id all look the same: 404.
   */
  private async findOwn(shopId: string, id: string): Promise<CustomerDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Customer not found');
    const customer = await this.customerModel
      .findOne({ _id: new Types.ObjectId(id), ...this.activeFilter(shopId) })
      .exec();
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Every customer query starts here, so it is always scoped to the caller's shop. */
  private activeFilter(shopId: string): QueryFilter<CustomerDocument> {
    return { shopId: this.shopObjectId(shopId), isArchived: false };
  }

  private shopObjectId(shopId: string): Types.ObjectId {
    return new Types.ObjectId(shopId);
  }

  private toResponse(doc: CustomerDocument): CustomerResponseDto {
    return {
      id: doc.id,
      name: doc.name,
      phone: doc.phone,
      email: doc.email ?? null,
      balance: doc.balance,
      lastEntryAt: doc.lastEntryAt ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
