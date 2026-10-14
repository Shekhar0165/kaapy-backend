import type { Server } from 'node:http';
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
import { normalizeIndianMobile } from '../src/customer/phone.js';
import {
  Customer,
  CustomerDocument,
  CustomerSchema,
} from '../src/customer/schemas/customer.schema.js';
import { RedisService } from '../src/redis/redis.service.js';
import { JwtAuthGuard } from '../src/shop/jwt-auth.guard.js';
import { FakeRedisService, JWT_SECRET } from './support/test-app.js';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['98765-43210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['(+91) 6000012345', '+916000012345'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each([
    ['5876543210', 'starts with 5'],
    ['987654321', '9 digits'],
    ['98765432101', '11 digits without 0'],
    ['+1 9876543210', 'not +91'],
    ['+919876543210123', 'too long'],
    ['98765abcde', 'letters'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input, _reason) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});

describe('/customers', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication<Server>;
  let model: Model<CustomerDocument>;
  let jwt: JwtService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri('kaapy-test')),
        MongooseModule.forFeature([{ name: Customer.name, schema: CustomerSchema }]),
        JwtModule.register({ secret: JWT_SECRET }),
      ],
      controllers: [CustomerController],
      providers: [
        CustomerService,
        SessionService,
        JwtAuthGuard,
        { provide: RedisService, useValue: new FakeRedisService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    model = moduleRef.get(getModelToken(Customer.name));
    jwt = moduleRef.get(JwtService);
    // The duplicate-phone rule relies on the unique index existing.
    await model.syncIndexes();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await model.deleteMany({});
  });

  const http = () => request(app.getHttpServer());

  async function newShop() {
    const shopId = new Types.ObjectId().toString();
    const token = await jwt.signAsync(
      { sub: shopId, gmail: `${shopId}@gmail.com`, type: 'access' },
      { expiresIn: '1h' },
    );
    const auth = { Authorization: `Bearer ${token}` };
    return {
      shopId,
      auth,
      add: (name: string, phone: string) =>
        http().post('/customers').set(auth).send({ name, phone, source: 'manual' }),
    };
  }

  /** Inserts directly, for balances and dates the API can't set yet. */
  async function seed(shopId: string, fields: Partial<Customer> & { name: string; phone: string }) {
    const doc = await model.create({ shopId: new Types.ObjectId(shopId), ...fields });
    return doc.id as string;
  }

  describe('authentication', () => {
    it.each([
      ['post', '/customers'],
      ['get', '/customers'],
      ['get', `/customers/${new Types.ObjectId()}`],
      ['patch', `/customers/${new Types.ObjectId()}`],
      ['delete', `/customers/${new Types.ObjectId()}`],
    ] as const)('%s %s requires an access token', async (method, path) => {
      await http()[method](path).expect(401);
    });

    it('rejects a refresh token', async () => {
      const token = await jwt.signAsync(
        { sub: new Types.ObjectId().toString(), gmail: 'x@gmail.com', type: 'refresh' },
        { expiresIn: '1h' },
      );
      await http().get('/customers').set('Authorization', `Bearer ${token}`).expect(401);
    });
  });

  describe('POST /customers', () => {
    it('creates a customer with a normalized phone and zero balance', async () => {
      const shop = await newShop();

      const { body } = await shop.add('  Ramesh Kumar ', '+91 98765-43210').expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        name: 'Ramesh Kumar',
        phone: '+919876543210',
        email: null,
        balance: 0,
        lastEntryAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body).not.toHaveProperty('shopId');
      const stored = await model.findById(body.id).lean();
      expect(stored?.shopId.toString()).toBe(shop.shopId);
      expect(stored?.source).toBe('manual');
    });

    it('returns 409 with the existing customer for a duplicate phone in any format', async () => {
      const shop = await newShop();
      const { body: first } = await shop.add('Ramesh Kumar', '9876543210').expect(201);

      const { body } = await shop.add('Ramesh K', '09876543210').expect(409);

      expect(body).toMatchObject({
        code: 'CUSTOMER_EXISTS',
        customer: { id: first.id, name: 'Ramesh Kumar' },
      });
      expect(await model.countDocuments()).toBe(1);
    });

    it('lets two different shops add the same phone', async () => {
      const a = await newShop();
      const b = await newShop();
      await a.add('Ramesh Kumar', '9876543210').expect(201);
      await b.add('Ramesh Kumar', '9876543210').expect(201);
    });

    it('restores a deleted customer instead of failing', async () => {
      const shop = await newShop();
      const { body: created } = await shop.add('Ramesh Kumar', '9876543210').expect(201);
      await http().delete(`/customers/${created.id}`).set(shop.auth).expect(204);

      const { body } = await shop.add('Ramesh K', '9876543210').expect(201);

      expect(body.id).toBe(created.id);
      expect(body.name).toBe('Ramesh K');
      await http().get(`/customers/${created.id}`).set(shop.auth).expect(200);
    });

    it.each([
      [{ name: 'R', phone: '9876543210', source: 'manual' }, 'name too short'],
      [{ name: 'x'.repeat(61), phone: '9876543210', source: 'manual' }, 'name too long'],
      [{ name: '<b>Ramesh</b>', phone: '9876543210', source: 'manual' }, 'HTML in name'],
      [{ name: 'Ramesh', phone: '5876543210', source: 'manual' }, 'phone starts with 5'],
      [{ name: 'Ramesh', phone: '98765', source: 'manual' }, 'short phone'],
      [{ name: 'Ramesh', phone: '9876543210', source: 'sms' }, 'unknown source'],
      [{ name: 'Ramesh', phone: '9876543210' }, 'missing source'],
      [{ name: 'Ramesh', phone: '9876543210', source: 'manual', balance: 500 }, 'extra field'],
      [{ name: 'Ramesh', phone: '9876543210', source: 'manual', shopId: 'x' }, 'shopId field'],
    ])('rejects %j (%s)', async (payload, _reason) => {
      const shop = await newShop();
      await http().post('/customers').set(shop.auth).send(payload).expect(400);
      expect(await model.countDocuments()).toBe(0);
    });
  });

  describe('GET /customers', () => {
    it('sorts by last entry, then newest, and pages', async () => {
      const shop = await newShop();
      await seed(shop.shopId, { name: 'Old entry', phone: '+919000000001', lastEntryAt: new Date('2026-09-01') });
      await seed(shop.shopId, { name: 'New entry', phone: '+919000000002', lastEntryAt: new Date('2026-10-12') });
      await seed(shop.shopId, { name: 'No entries', phone: '+919000000003' });

      const { body } = await http().get('/customers?limit=2').set(shop.auth).expect(200);
      expect(body.items.map((c: { name: string }) => c.name)).toEqual(['New entry', 'Old entry']);
      expect(body).toMatchObject({ total: 3, page: 1, limit: 2 });

      const { body: page2 } = await http().get('/customers?limit=2&page=2').set(shop.auth);
      expect(page2.items.map((c: { name: string }) => c.name)).toEqual(['No entries']);
    });

    it('summarizes every customer of the shop regardless of filter and page', async () => {
      const shop = await newShop();
      const other = await newShop();
      await seed(shop.shopId, { name: 'Ramesh', phone: '+919000000001', balance: 465000 });
      await seed(shop.shopId, { name: 'Sunita', phone: '+919000000002', balance: 120000 });
      await seed(shop.shopId, { name: 'Anil', phone: '+919000000003', balance: 0 });
      await seed(shop.shopId, { name: 'Advance', phone: '+919000000004', balance: -5000 });
      await seed(shop.shopId, { name: 'Gone', phone: '+919000000005', isArchived: true });
      await seed(other.shopId, { name: 'Other shop', phone: '+919000000006', balance: 99900 });

      const { body } = await http().get('/customers?filter=due&limit=1').set(shop.auth).expect(200);

      expect(body.summary).toEqual({ totalDue: 585000, customersWithDue: 2, totalCustomers: 4 });
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(1);
    });

    it('filters due and settled customers', async () => {
      const shop = await newShop();
      await seed(shop.shopId, { name: 'Owes', phone: '+919000000001', balance: 100 });
      await seed(shop.shopId, { name: 'Zero', phone: '+919000000002', balance: 0 });
      await seed(shop.shopId, { name: 'Advance', phone: '+919000000003', balance: -100 });

      const names = async (filter: string) =>
        (await http().get(`/customers?filter=${filter}`).set(shop.auth)).body.items
          .map((c: { name: string }) => c.name)
          .sort();

      expect(await names('due')).toEqual(['Owes']);
      expect(await names('settled')).toEqual(['Advance', 'Zero']);
      expect(await names('all')).toEqual(['Advance', 'Owes', 'Zero']);
    });

    it('searches names case-insensitively and phone digits', async () => {
      const shop = await newShop();
      await seed(shop.shopId, { name: 'Ramesh Kumar', phone: '+919876543210' });
      await seed(shop.shopId, { name: 'Sunita Devi', phone: '+917000011111' });

      const search = async (term: string) =>
        (await http().get('/customers').query({ search: term }).set(shop.auth)).body.items.map(
          (c: { name: string }) => c.name,
        );

      expect(await search('rAmEsH')).toEqual(['Ramesh Kumar']);
      expect(await search('98765')).toEqual(['Ramesh Kumar']);
      expect(await search('70000 11')).toEqual(['Sunita Devi']);
      expect(await search('nobody')).toEqual([]);
    });

    it('saves, lists and searches names in Indian scripts', async () => {
      const shop = await newShop();
      const create = (name: string, phone: string) =>
        http().post('/customers').set(shop.auth).send({ name, phone, source: 'manual' }).expect(201);

      // Hindi (conjunct + vowel signs), Tamil (pulli), Bengali, Malayalam (chillu with ZWJ), mixed.
      const names = ['क्षितिज शर्मा', 'ஸ்ரீனிவாசன்', 'শ্রীকান্ত দাস', 'കൃഷ്ണൻ\u200d', 'Gupta जी'];
      for (const [index, name] of names.entries()) {
        const { body } = await create(name, `+91987654321${index}`);
        expect(body.name).toBe(name.normalize('NFC'));
      }

      const search = async (term: string) =>
        (await http().get('/customers').query({ search: term }).set(shop.auth).expect(200)).body.items
          .map((c: { name: string }) => c.name)
          .sort();

      const listed = (await http().get('/customers').set(shop.auth).expect(200)).body.items.map(
        (c: { name: string }) => c.name,
      );
      expect(listed.sort()).toEqual(names.map((name) => name.normalize('NFC')).sort());

      expect(await search('शर्मा')).toEqual(['क्षितिज शर्मा']);
      expect(await search('क्षि')).toEqual(['क्षितिज शर्मा']);
      expect(await search('னிவா')).toEqual(['ஸ்ரீனிவாசன்']);
      expect(await search('দাস')).toEqual(['শ্রীকান্ত দাস']);
      expect(await search('കൃഷ്ണ')).toEqual(['കൃഷ്ണൻ\u200d']);
      // Latin letters inside a mixed name are still case-insensitive.
      expect(await search('GUPTA')).toEqual(['Gupta जी']);
      // Regex characters next to Indic text are literal.
      expect(await search('शर्मा.*')).toEqual([]);
      expect(await search('(জ')).toEqual([]);
    });

    it('matches a name typed with a different Unicode sequence (NFD vs NFC)', async () => {
      const shop = await newShop();
      // "क़" can be one code point (U+0958) or क + nukta; NFC keeps the second form, so
      // test with Latin é, which NFC always composes.
      const decomposed = 'Rene\u0301 Store';
      const { body } = await http()
        .post('/customers')
        .set(shop.auth)
        .send({ name: decomposed, phone: '+919000000001', source: 'manual' })
        .expect(201);
      expect(body.name).toBe('Ren\u00e9 Store');

      const found = await http().get('/customers').query({ search: 'rene\u0301' }).set(shop.auth).expect(200);
      expect(found.body.items.map((c: { name: string }) => c.name)).toEqual(['Ren\u00e9 Store']);
    });

    it('treats regex characters in the search literally', async () => {
      const shop = await newShop();
      await seed(shop.shopId, { name: 'Ramesh Kumar', phone: '+919876543210' });
      await seed(shop.shopId, { name: 'A.B. Stores (Main)', phone: '+917000011111' });

      const search = async (term: string) =>
        (await http().get('/customers').query({ search: term }).set(shop.auth).expect(200)).body
          .items.map((c: { name: string }) => c.name);

      expect(await search('.*')).toEqual([]);
      expect(await search('(Main)')).toEqual(['A.B. Stores (Main)']);
      expect(await search('A.B.')).toEqual(['A.B. Stores (Main)']);
      expect(await search('[')).toEqual([]);
    });

    it("never lists another shop's customers", async () => {
      const shop = await newShop();
      const other = await newShop();
      await seed(other.shopId, { name: 'Other shop customer', phone: '+919876543210' });

      const { body } = await http().get('/customers').set(shop.auth).expect(200);
      expect(body.items).toEqual([]);
      expect(body.summary.totalCustomers).toBe(0);
    });

    it.each(['limit=0', 'limit=101', 'page=0', 'filter=owing', 'page=abc'])(
      'rejects ?%s',
      async (query) => {
        const shop = await newShop();
        await http().get(`/customers?${query}`).set(shop.auth).expect(400);
      },
    );
  });

  describe('optional email', () => {
    const create = (shop: { auth: Record<string, string> }, email: unknown) =>
      http()
        .post('/customers')
        .set(shop.auth)
        .send({ name: 'Ramesh Kumar', phone: '9876543210', source: 'manual', email });

    it('stores a trimmed, lowercased email and returns it', async () => {
      const shop = await newShop();
      const { body } = await create(shop, '  Ramesh.K@Example.COM ').expect(201);
      expect(body.email).toBe('ramesh.k@example.com');
      const { body: fetched } = await http().get(`/customers/${body.id}`).set(shop.auth);
      expect(fetched.email).toBe('ramesh.k@example.com');
    });

    it.each([undefined, '', '   '])('treats %j as no email', async (email) => {
      const shop = await newShop();
      const { body } = await create(shop, email).expect(201);
      expect(body.email).toBeNull();
    });

    it.each([
      ['not-an-email', 'no @'],
      ['ramesh@', 'no domain'],
      [`${'a'.repeat(95)}@x.com`, 'over 100 characters'],
      ['<b>x</b>@example.com', 'HTML'],
      [42, 'not a string'],
    ])('rejects %j (%s)', async (email, _reason) => {
      const shop = await newShop();
      await create(shop, email).expect(400);
      expect(await model.countDocuments()).toBe(0);
    });

    it('is not unique', async () => {
      const shop = await newShop();
      await create(shop, 'family@example.com').expect(201);
      await http()
        .post('/customers')
        .set(shop.auth)
        .send({ name: 'Sunita Devi', phone: '9000000002', source: 'manual', email: 'family@example.com' })
        .expect(201);
    });

    it('can be changed and removed with PATCH, leaving the name alone', async () => {
      const shop = await newShop();
      const { body: created } = await create(shop, 'old@example.com').expect(201);
      const patch = (body: object) =>
        http().patch(`/customers/${created.id}`).set(shop.auth).send(body);

      expect((await patch({ email: 'New@Example.com' }).expect(200)).body).toMatchObject({
        email: 'new@example.com',
        name: 'Ramesh Kumar',
      });
      expect((await patch({ email: null }).expect(200)).body.email).toBeNull();
      await patch({ email: 'again@example.com' }).expect(200);
      expect((await patch({ email: '' }).expect(200)).body.email).toBeNull();
    });

    it('PATCH leaves the email unchanged when only the name is sent', async () => {
      const shop = await newShop();
      const { body: created } = await create(shop, 'keep@example.com').expect(201);
      const { body } = await http()
        .patch(`/customers/${created.id}`)
        .set(shop.auth)
        .send({ name: 'Ramesh K' })
        .expect(200);
      expect(body).toMatchObject({ email: 'keep@example.com', name: 'Ramesh K' });
    });

    it('PATCH rejects an invalid email, an empty body and a phone change', async () => {
      const shop = await newShop();
      const { body: created } = await create(shop, undefined).expect(201);
      const patch = (body: object) =>
        http().patch(`/customers/${created.id}`).set(shop.auth).send(body);

      await patch({ email: 'nope' }).expect(400);
      await patch({}).expect(400);
      await patch({ phone: '9000000009' }).expect(400);
      expect((await model.findById(created.id).lean())?.phone).toBe('+919876543210');
    });
  });

  describe('single customer routes', () => {
    it('reads and renames a customer, never the phone', async () => {
      const shop = await newShop();
      const id = await seed(shop.shopId, { name: 'Ramesh', phone: '+919876543210' });

      await http().get(`/customers/${id}`).set(shop.auth).expect(200);
      const { body } = await http()
        .patch(`/customers/${id}`)
        .set(shop.auth)
        .send({ name: 'Ramesh Kumar' })
        .expect(200);
      expect(body.name).toBe('Ramesh Kumar');

      await http()
        .patch(`/customers/${id}`)
        .set(shop.auth)
        .send({ name: 'Ramesh', phone: '9000000000' })
        .expect(400);
      expect((await model.findById(id).lean())?.phone).toBe('+919876543210');
    });

    it("returns 404 for another shop's customer on read, update and delete", async () => {
      const owner = await newShop();
      const intruder = await newShop();
      const id = await seed(owner.shopId, { name: 'Ramesh', phone: '+919876543210' });

      await http().get(`/customers/${id}`).set(intruder.auth).expect(404);
      await http().patch(`/customers/${id}`).set(intruder.auth).send({ name: 'Hacked' }).expect(404);
      await http().delete(`/customers/${id}`).set(intruder.auth).expect(404);

      const stored = await model.findById(id).lean();
      expect(stored).toMatchObject({ name: 'Ramesh', isArchived: false });
    });

    it('returns 404 for malformed ids', async () => {
      const shop = await newShop();
      await http().get('/customers/not-an-id').set(shop.auth).expect(404);
    });

    it('archives a settled customer and hides it', async () => {
      const shop = await newShop();
      const id = await seed(shop.shopId, { name: 'Ramesh', phone: '+919876543210' });

      await http().delete(`/customers/${id}`).set(shop.auth).expect(204);

      expect((await model.findById(id).lean())?.isArchived).toBe(true);
      await http().get(`/customers/${id}`).set(shop.auth).expect(404);
      const { body } = await http().get('/customers').set(shop.auth);
      expect(body.summary.totalCustomers).toBe(0);
    });

    it.each([465000, -5000])('refuses to delete with balance %i', async (balance) => {
      const shop = await newShop();
      const id = await seed(shop.shopId, { name: 'Ramesh', phone: '+919876543210', balance });

      const { body } = await http().delete(`/customers/${id}`).set(shop.auth).expect(409);

      expect(body).toMatchObject({ code: 'BALANCE_NOT_ZERO', balance });
      expect(body.message).toContain('₹');
      expect((await model.findById(id).lean())?.isArchived).toBe(false);
    });
  });
});
