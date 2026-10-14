import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { SessionService } from '../src/auth/session.service.js';
import { createValidationPipe } from '../src/common/validation.js';
import { CustomerController } from '../src/customer/customer.controller.js';
import { CustomerService } from '../src/customer/customer.service.js';
import { Customer, CustomerDocument, CustomerSchema } from '../src/customer/schemas/customer.schema.js';
import { RedisService } from '../src/redis/redis.service.js';
import { JwtAuthGuard } from '../src/shop/jwt-auth.guard.js';
import { Shop, ShopSchema } from '../src/shop/schemas/shop.schema.js';
import {
  Transaction,
  TransactionDocument,
  TransactionSchema,
} from '../src/transaction/schemas/transaction.schema.js';
import { TransactionController } from '../src/transaction/transaction.controller.js';
import { TransactionService } from '../src/transaction/transaction.service.js';
import { FakeRedisService, JWT_SECRET } from './support/test-app.js';

// Transactions need a replica set, like production (Atlas).
describe('/customers/:customerId/transactions', () => {
  let replSet: MongoMemoryReplSet;
  let app: INestApplication<Server>;
  let customers: Model<CustomerDocument>;
  let transactions: Model<TransactionDocument>;
  let jwt: JwtService;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri('kaapy-tx-test')),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: Transaction.name, schema: TransactionSchema },
          { name: Shop.name, schema: ShopSchema },
        ]),
        JwtModule.register({ secret: JWT_SECRET }),
      ],
      controllers: [CustomerController, TransactionController],
      providers: [
        CustomerService,
        TransactionService,
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
    jwt = moduleRef.get(JwtService);
    // Collections must exist before use inside a transaction; also builds the unique indexes.
    await customers.createCollection();
    await transactions.createCollection();
    await customers.syncIndexes();
    await transactions.syncIndexes();
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await transactions.deleteMany({});
    await customers.deleteMany({});
  });

  const http = () => request(app.getHttpServer());

  async function newShop() {
    const shopId = new Types.ObjectId().toString();
    const token = await jwt.signAsync(
      { sub: shopId, gmail: `${shopId}@gmail.com`, type: 'access' },
      { expiresIn: '1h' },
    );
    return { shopId, auth: { Authorization: `Bearer ${token}` } };
  }

  async function newCustomer(shopId: string, fields: Partial<Customer> = {}) {
    const doc = await customers.create({
      shopId: new Types.ObjectId(shopId),
      name: 'Ramesh Kumar',
      phone: `+919${Math.floor(100000000 + Math.random() * 899999999)}`,
      ...fields,
    });
    return doc.id as string;
  }

  function addEntry(
    shop: { auth: Record<string, string> },
    customerId: string,
    body: Record<string, unknown>,
  ) {
    return http()
      .post(`/customers/${customerId}/transactions`)
      .set(shop.auth)
      .send({ clientRequestId: randomUUID(), ...body });
  }

  const balanceOf = async (id: string) => (await customers.findById(id).lean())?.balance;

  describe('creating entries', () => {
    it('gave raises the balance, got lowers it, with a server timestamp', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const before = Date.now();

      const gave = await addEntry(shop, id, { type: 'gave', amount: 120000, note: ' Rice 5 kg ' }).expect(201);
      expect(gave.body.balance).toBe(120000);
      expect(gave.body.transaction).toMatchObject({
        type: 'gave',
        amount: 120000,
        note: 'Rice 5 kg',
        balanceAfter: 120000,
        customerId: id,
      });
      const createdAt = new Date(gave.body.transaction.createdAt).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(Date.now());

      const got = await addEntry(shop, id, { type: 'got', amount: 30000 }).expect(201);
      expect(got.body).toMatchObject({ balance: 90000, transaction: { balanceAfter: 90000, note: null } });

      const stored = await customers.findById(id).lean();
      expect(stored?.balance).toBe(90000);
      expect(stored?.lastEntryAt?.toISOString()).toBe(got.body.transaction.createdAt);
    });

    it('keeps balanceAfter right across several entries and allows an advance', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const steps: [string, number, number][] = [
        ['gave', 200000, 200000],
        ['got', 100000, 100000],
        ['gave', 275000, 375000],
        ['got', 30000, 345000],
        ['got', 400000, -55000],
      ];
      for (const [type, amount, expected] of steps) {
        const { body } = await addEntry(shop, id, { type, amount }).expect(201);
        expect(body.transaction.balanceAfter).toBe(expected);
      }
      expect(await balanceOf(id)).toBe(-55000);
    });

    it.each([
      [{ type: 'gave', amount: 0 }, 'zero amount'],
      [{ type: 'gave', amount: -500 }, 'negative amount'],
      [{ type: 'gave', amount: 500.5 }, 'decimal paise'],
      [{ type: 'gave', amount: 1_000_000_001 }, 'over ₹1 crore'],
      [{ type: 'gave' }, 'missing amount'],
      [{ type: 'lent', amount: 500 }, 'unknown type'],
      [{ type: 'gave', amount: 500, note: 'x'.repeat(201) }, 'note too long'],
      [{ type: 'gave', amount: 500, note: '<script>x</script>' }, 'HTML note'],
      [{ type: 'gave', amount: 500, createdAt: '2020-01-01T00:00:00Z' }, 'client createdAt'],
      [{ type: 'gave', amount: 500, date: '2020-01-01' }, 'client date'],
      [{ type: 'gave', amount: 500, balanceAfter: 999 }, 'client balance'],
      [{ type: 'gave', amount: 500, shopId: 'x' }, 'client shopId'],
      [{ type: 'gave', amount: 500, clientRequestId: 'bad id!' }, 'bad clientRequestId'],
    ])('rejects %j (%s) without touching the balance', async (body, _reason) => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      await addEntry(shop, id, body).expect(400);
      expect(await balanceOf(id)).toBe(0);
      expect(await transactions.countDocuments()).toBe(0);
    });

    it('accepts the maximum of ₹1,00,00,000', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      await addEntry(shop, id, { type: 'gave', amount: 1_000_000_000 }).expect(201);
    });

    it('a retry with the same clientRequestId returns the original entry once', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const body = { type: 'gave', amount: 50000, clientRequestId: randomUUID() };

      const first = await addEntry(shop, id, body).expect(201);
      const retry = await addEntry(shop, id, body).expect(200);

      expect(retry.body).toEqual(first.body);
      expect(await transactions.countDocuments()).toBe(1);
      expect(await balanceOf(id)).toBe(50000);
    });

    it('concurrent copies of the same request still save only one entry', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const body = { type: 'gave', amount: 10000, clientRequestId: randomUUID() };

      const responses = await Promise.all(Array.from({ length: 5 }, () => addEntry(shop, id, body)));

      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(responses.map((r) => r.body.transaction.id)).size).toBe(1);
      expect(await transactions.countDocuments()).toBe(1);
      expect(await balanceOf(id)).toBe(10000);
    });

    it('different entries at the same time keep the balance exact', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => addEntry(shop, id, { type: 'gave', amount: 10000 })),
      );

      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(await balanceOf(id)).toBe(100000);
      // Each entry saw a distinct balance: 100, 200, ... 1000 rupees.
      const after = responses.map((r) => r.body.transaction.balanceAfter).sort((a, b) => a - b);
      expect(after).toEqual(Array.from({ length: 10 }, (_, i) => (i + 1) * 10000));
    }, 60000);

    it("returns 404 for another shop's customer and changes nothing", async () => {
      const owner = await newShop();
      const intruder = await newShop();
      const id = await newCustomer(owner.shopId);

      await addEntry(intruder, id, { type: 'gave', amount: 500 }).expect(404);
      await http().get(`/customers/${id}/transactions`).set(intruder.auth).expect(404);
      expect(await balanceOf(id)).toBe(0);
      expect(await transactions.countDocuments()).toBe(0);
    });

    it('rejects archived customers and malformed ids with 404', async () => {
      const shop = await newShop();
      const archived = await newCustomer(shop.shopId, { isArchived: true });
      await addEntry(shop, archived, { type: 'gave', amount: 500 }).expect(404);
      await addEntry(shop, 'not-an-id', { type: 'gave', amount: 500 }).expect(404);
      expect(await transactions.countDocuments()).toBe(0);
    });

    it('requires an access token', async () => {
      const id = new Types.ObjectId().toString();
      await http().post(`/customers/${id}/transactions`).send({}).expect(401);
      await http().get(`/customers/${id}/transactions`).expect(401);
    });

    it('has no update or delete routes', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const { body } = await addEntry(shop, id, { type: 'gave', amount: 500 }).expect(201);
      const path = `/customers/${id}/transactions/${body.transaction.id}`;
      await http().patch(path).set(shop.auth).send({ amount: 1 }).expect(404);
      await http().delete(path).set(shop.auth).expect(404);
    });

    it('refuses to modify a saved entry at the database level', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const { body } = await addEntry(shop, id, { type: 'gave', amount: 500 }).expect(201);

      await expect(
        transactions.updateOne({ _id: body.transaction.id }, { $set: { amount: 1 } }),
      ).rejects.toThrow('immutable');

      const doc = await transactions.findById(body.transaction.id);
      doc!.amount = 1;
      doc!.createdAt = new Date('2020-01-01');
      await doc!.save();
      const reloaded = await transactions.findById(body.transaction.id).lean();
      expect(reloaded?.amount).toBe(500);
      expect(reloaded?.createdAt.toISOString()).toBe(body.transaction.createdAt);
    });
  });

  describe('listing entries', () => {
    it('pages newest first with a cursor and returns the current balance', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      for (let i = 1; i <= 5; i += 1) {
        await addEntry(shop, id, { type: 'gave', amount: i * 100, note: `#${i}` }).expect(201);
      }

      const page1 = await http().get(`/customers/${id}/transactions?limit=2`).set(shop.auth).expect(200);
      expect(page1.body.items.map((t: { note: string }) => t.note)).toEqual(['#5', '#4']);
      expect(page1.body.balance).toBe(1500);

      const page2 = await http()
        .get(`/customers/${id}/transactions`)
        .query({ limit: 2, cursor: page1.body.nextCursor })
        .set(shop.auth);
      expect(page2.body.items.map((t: { note: string }) => t.note)).toEqual(['#3', '#2']);

      const page3 = await http()
        .get(`/customers/${id}/transactions`)
        .query({ limit: 2, cursor: page2.body.nextCursor })
        .set(shop.auth);
      expect(page3.body.items.map((t: { note: string }) => t.note)).toEqual(['#1']);
      expect(page3.body.nextCursor).toBeNull();
    });

    it('pages correctly when entries share the same timestamp', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      const sameTime = new Date('2026-10-14T06:00:00.000Z');
      await transactions.insertMany(
        Array.from({ length: 4 }, (_, i) => ({
          shopId: new Types.ObjectId(shop.shopId),
          customerId: new Types.ObjectId(id),
          type: 'gave',
          amount: 100,
          balanceAfter: (i + 1) * 100,
          createdAt: sameTime,
          clientRequestId: `same-time-${i}`,
        })),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const { body }: { body: { items: { id: string }[]; nextCursor: string | null } } = await http()
          .get(`/customers/${id}/transactions`)
          .query({ limit: 3, ...(cursor ? { cursor } : {}) })
          .set(shop.auth);
        seen.push(...body.items.map((t) => t.id));
        cursor = body.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });

    it.each(['limit=0', 'limit=101', 'cursor=@@@', `cursor=${Buffer.from('junk').toString('base64url')}`])(
      'rejects ?%s',
      async (query) => {
        const shop = await newShop();
        const id = await newCustomer(shop.shopId);
        await http().get(`/customers/${id}/transactions?${query}`).set(shop.auth).expect(400);
      },
    );
  });

  describe('customer list and delete use the real balances', () => {
    it('summary reflects entries', async () => {
      const shop = await newShop();
      const ramesh = await newCustomer(shop.shopId, { name: 'Ramesh' });
      const sunita = await newCustomer(shop.shopId, { name: 'Sunita' });
      await newCustomer(shop.shopId, { name: 'Anil' });
      await addEntry(shop, ramesh, { type: 'gave', amount: 465000 }).expect(201);
      await addEntry(shop, sunita, { type: 'gave', amount: 160000 }).expect(201);
      await addEntry(shop, sunita, { type: 'got', amount: 40000 }).expect(201);

      const { body } = await http().get('/customers').set(shop.auth).expect(200);
      expect(body.summary).toEqual({ totalDue: 585000, customersWithDue: 2, totalCustomers: 3 });
      // Most recent entry first.
      expect(body.items[0].name).toBe('Sunita');
    });

    it('delete is blocked until the balance is back to 0', async () => {
      const shop = await newShop();
      const id = await newCustomer(shop.shopId);
      await addEntry(shop, id, { type: 'gave', amount: 50000 }).expect(201);
      await http().delete(`/customers/${id}`).set(shop.auth).expect(409);

      await addEntry(shop, id, { type: 'got', amount: 50000 }).expect(201);
      await http().delete(`/customers/${id}`).set(shop.auth).expect(204);
    });
  });
});
