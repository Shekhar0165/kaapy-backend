import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { SessionService } from '../src/auth/session.service.js';
import { createValidationPipe } from '../src/common/validation.js';
import { CustomerController } from '../src/customer/customer.controller.js';
import { CustomerService } from '../src/customer/customer.service.js';
import { Customer, CustomerDocument, CustomerSchema } from '../src/customer/schemas/customer.schema.js';
import { RedisService } from '../src/redis/redis.service.js';
import { istPeriodStart } from '../src/reports/ist-period.js';
import { ReportsController } from '../src/reports/reports.controller.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { JwtAuthGuard } from '../src/shop/jwt-auth.guard.js';
import {
  Transaction,
  TransactionDocument,
  TransactionSchema,
} from '../src/transaction/schemas/transaction.schema.js';
import { FakeRedisService, JWT_SECRET } from './support/test-app.js';

describe('istPeriodStart', () => {
  it('month starts at 00:00 IST on the 1st (18:30 UTC the day before)', () => {
    expect(istPeriodStart('month', new Date('2026-10-14T06:00:00Z'))?.toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
  });

  it('an entry at 2026-10-31T18:40Z is 1 Nov 00:10 IST, so it belongs to November', () => {
    const now = new Date('2026-10-31T18:40:00Z');
    const start = istPeriodStart('month', now);
    expect(start?.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(now.getTime()).toBeGreaterThanOrEqual(start!.getTime());
  });

  it('today starts at 00:00 IST, even when UTC is still on the previous day', () => {
    // 2026-10-14 01:00 IST = 2026-10-13T19:30Z
    expect(istPeriodStart('today', new Date('2026-10-13T19:30:00Z'))?.toISOString()).toBe(
      '2026-10-13T18:30:00.000Z',
    );
    expect(istPeriodStart('today', new Date('2026-10-14T18:29:59Z'))?.toISOString()).toBe(
      '2026-10-13T18:30:00.000Z',
    );
  });

  it('crosses the year at IST midnight', () => {
    expect(istPeriodStart('month', new Date('2026-12-31T18:31:00Z'))?.toISOString()).toBe(
      '2026-12-31T18:30:00.000Z',
    );
  });

  it('all has no start', () => {
    expect(istPeriodStart('all')).toBeNull();
  });
});

describe('/reports/balance', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication<Server>;
  let customers: Model<CustomerDocument>;
  let transactions: Model<TransactionDocument>;
  let reports: ReportsService;
  let jwt: JwtService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri('kaapy-reports-test')),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: Transaction.name, schema: TransactionSchema },
        ]),
        JwtModule.register({ secret: JWT_SECRET }),
      ],
      controllers: [ReportsController, CustomerController],
      providers: [
        ReportsService,
        CustomerService,
        SessionService,
        JwtAuthGuard,
        { provide: RedisService, useValue: new FakeRedisService() },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    customers = moduleRef.get(getModelToken(Customer.name));
    transactions = moduleRef.get(getModelToken(Transaction.name));
    reports = moduleRef.get(ReportsService);
    jwt = moduleRef.get(JwtService);
    await customers.syncIndexes();
    await transactions.syncIndexes();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await transactions.deleteMany({});
    await customers.deleteMany({});
  });

  const http = () => request(app.getHttpServer());

  async function newShop() {
    const shopId = new Types.ObjectId().toString();
    const token = await jwt.signAsync({ sub: shopId, gmail: 'x@gmail.com', type: 'access' }, { expiresIn: '1h' });
    return { auth: { Authorization: `Bearer ${token}` }, shopId };
  }

  let phone = 9000000000;
  async function customer(shopId: string, name: string, balance = 0, extra: Partial<Customer> = {}) {
    phone += 1;
    const doc = await customers.create({
      balance,
      name,
      phone: `+91${phone}`,
      shopId: new Types.ObjectId(shopId),
      ...extra,
    });
    return doc.id as string;
  }

  async function entry(
    shopId: string,
    customerId: string,
    type: 'gave' | 'got',
    amount: number,
    createdAt: Date,
  ) {
    const [doc] = await transactions.insertMany([
      {
        amount,
        balanceAfter: 0,
        clientRequestId: randomUUID(),
        createdAt,
        customerId: new Types.ObjectId(customerId),
        shopId: new Types.ObjectId(shopId),
        type,
      },
    ]);
    return doc._id.toString();
  }

  it('requires an access token and rejects refresh tokens', async () => {
    await http().get('/reports/balance').expect(401);
    const refresh = await jwt.signAsync(
      { sub: new Types.ObjectId().toString(), gmail: 'x@gmail.com', type: 'refresh' },
      { expiresIn: '1h' },
    );
    await http().get('/reports/balance').set('Authorization', `Bearer ${refresh}`).expect(401);
  });

  it.each(['week', 'year', 'TODAY', ''])('rejects period=%j', async (period) => {
    const shop = await newShop();
    await http().get('/reports/balance').query({ period }).set(shop.auth).expect(400);
  });

  it('empty shop: zeros and empty lists', async () => {
    const shop = await newShop();
    const { body } = await http().get('/reports/balance').set(shop.auth).expect(200);
    expect(body).toMatchObject({
      customersWithDue: 0,
      given: 0,
      givenCount: 0,
      period: 'month',
      received: 0,
      receivedCount: 0,
      recent: [],
      topDebtors: [],
      totalAdvance: 0,
      totalCustomers: 0,
      totalDue: 0,
    });
    expect(body.periodStart).toEqual(expect.any(String));
  });

  it('totals: due and advance are separate, archived customers are not counted', async () => {
    const shop = await newShop();
    await customer(shop.shopId, 'Ramesh', 465000);
    await customer(shop.shopId, 'Sunita', 120000);
    await customer(shop.shopId, 'Anil', 0);
    await customer(shop.shopId, 'Advance A', -25000);
    await customer(shop.shopId, 'Advance B', -5050);
    await customer(shop.shopId, 'Gone', 999900, { isArchived: true });

    const { body } = await http().get('/reports/balance').set(shop.auth).expect(200);
    expect(body).toMatchObject({
      customersWithDue: 2,
      totalAdvance: 30050,
      totalCustomers: 5,
      totalDue: 585000,
    });
  });

  it('totalDue matches the customers list summary exactly', async () => {
    const shop = await newShop();
    await customer(shop.shopId, 'Aa', 100);
    await customer(shop.shopId, 'Bb', -50);
    await customer(shop.shopId, 'Cc', 2500);
    await customer(shop.shopId, 'Dd', 7, { isArchived: true });

    const [{ body: report }, { body: list }] = await Promise.all([
      http().get('/reports/balance').set(shop.auth),
      http().get('/customers').set(shop.auth),
    ]);
    expect({
      customersWithDue: report.customersWithDue,
      totalCustomers: report.totalCustomers,
      totalDue: report.totalDue,
    }).toEqual(list.summary);
  });

  it('given/received follow the IST period; archived customers still count', async () => {
    const shop = await newShop();
    const now = new Date('2026-10-14T06:00:00Z'); // 14 Oct 11:30 IST
    const a = await customer(shop.shopId, 'Aa');
    const archived = await customer(shop.shopId, 'Archived', 0, { isArchived: true });
    await entry(shop.shopId, a, 'gave', 1000, new Date('2026-10-14T05:00:00Z')); // today
    await entry(shop.shopId, a, 'got', 300, new Date('2026-10-13T18:31:00Z')); // today 00:01 IST
    await entry(shop.shopId, a, 'gave', 2000, new Date('2026-10-13T18:29:00Z')); // yesterday 23:59 IST
    await entry(shop.shopId, archived, 'gave', 500, new Date('2026-10-02T10:00:00Z')); // this month
    await entry(shop.shopId, a, 'got', 700, new Date('2026-09-30T18:29:00Z')); // 30 Sep 23:59 IST
    await entry(shop.shopId, a, 'gave', 4000, new Date('2026-03-01T00:00:00Z')); // long ago

    const today = await reports.balance(shop.shopId, 'today', now);
    expect(today).toMatchObject({ given: 1000, givenCount: 1, received: 300, receivedCount: 1 });

    const month = await reports.balance(shop.shopId, 'month', now);
    expect(month).toMatchObject({ given: 3500, givenCount: 3, received: 300, receivedCount: 1 });
    expect(month.periodStart?.toISOString()).toBe('2026-09-30T18:30:00.000Z');

    const all = await reports.balance(shop.shopId, 'all', now);
    expect(all).toMatchObject({ given: 7500, givenCount: 4, received: 1000, receivedCount: 2 });
    expect(all.periodStart).toBeNull();
  });

  it('the 31 Oct 18:40Z entry counts in November, not October', async () => {
    const shop = await newShop();
    const a = await customer(shop.shopId, 'Aa');
    await entry(shop.shopId, a, 'gave', 111, new Date('2026-10-31T18:40:00Z')); // 1 Nov 00:10 IST
    await entry(shop.shopId, a, 'gave', 222, new Date('2026-10-31T18:20:00Z')); // 31 Oct 23:50 IST

    const november = await reports.balance(shop.shopId, 'month', new Date('2026-11-05T06:00:00Z'));
    expect(november.given).toBe(111);
    const october = await reports.balance(shop.shopId, 'month', new Date('2026-10-31T18:25:00Z'));
    expect(october.given).toBe(222);
  });

  it('top debtors: positive only, top 5, balance desc, ties by name', async () => {
    const shop = await newShop();
    await customer(shop.shopId, 'Zed', 5000);
    await customer(shop.shopId, 'Amit', 5000);
    await customer(shop.shopId, 'Big', 90000);
    await customer(shop.shopId, 'Mid', 3000);
    await customer(shop.shopId, 'Low', 100);
    await customer(shop.shopId, 'Lowest', 1);
    await customer(shop.shopId, 'Zero', 0);
    await customer(shop.shopId, 'Advance', -10000);
    await customer(shop.shopId, 'Archived rich', 999999, { isArchived: true });

    const { body } = await http().get('/reports/balance').set(shop.auth).expect(200);
    expect(body.topDebtors.map((d: { name: string; balance: number }) => [d.name, d.balance])).toEqual([
      ['Big', 90000],
      ['Amit', 5000],
      ['Zed', 5000],
      ['Mid', 3000],
      ['Low', 100],
    ]);
  });

  it('recent: last 10 newest first regardless of period, with names (archived too)', async () => {
    const shop = await newShop();
    const a = await customer(shop.shopId, 'Ramesh');
    const gone = await customer(shop.shopId, 'Old customer', 0, { isArchived: true });
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 12; i += 1) {
      await entry(shop.shopId, i === 11 ? gone : a, i % 2 ? 'got' : 'gave', (i + 1) * 100, new Date(base + i * 60000));
    }

    const { body } = await http().get('/reports/balance').query({ period: 'today' }).set(shop.auth);
    expect(body.recent).toHaveLength(10);
    expect(body.recent.map((r: { amount: number }) => r.amount)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => n * 100),
    );
    expect(body.recent[0]).toMatchObject({ customerId: gone, customerName: 'Old customer', type: 'got' });
    expect(body.recent[1]).toMatchObject({ customerName: 'Ramesh', type: 'gave' });
  });

  it("never includes another shop's data", async () => {
    const shop = await newShop();
    const other = await newShop();
    const theirs = await customer(other.shopId, 'Their customer', 50000);
    await customer(other.shopId, 'Their advance', -100);
    await entry(other.shopId, theirs, 'gave', 50000, new Date());

    const { body } = await http().get('/reports/balance').query({ period: 'all' }).set(shop.auth);
    expect(body).toMatchObject({
      given: 0,
      recent: [],
      topDebtors: [],
      totalAdvance: 0,
      totalCustomers: 0,
      totalDue: 0,
    });
  });

  it('every report query uses an index (no collection scan)', async () => {
    const shop = new Types.ObjectId();
    const plans = [
      await transactions
        .find({ createdAt: { $gte: new Date(0), $lte: new Date() }, shopId: shop })
        .explain('queryPlanner'),
      await transactions.find({ shopId: shop }).sort({ _id: -1, createdAt: -1 }).limit(10).explain('queryPlanner'),
      await transactions.find({ shopId: shop }).sort({ createdAt: -1, _id: -1 }).limit(10).explain('queryPlanner'),
      await customers
        .find({ balance: { $gt: 0 }, isArchived: false, shopId: shop })
        .sort({ balance: -1, name: 1 })
        .limit(5)
        .explain('queryPlanner'),
      await customers.find({ isArchived: false, shopId: shop }).explain('queryPlanner'),
    ];
    for (const plan of plans) {
      const winning = JSON.stringify((plan as unknown as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      expect(winning).not.toContain('COLLSCAN');
      expect(winning).toContain('IXSCAN');
    }
  });
});
