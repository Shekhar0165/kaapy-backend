import type { Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { SessionService } from '../src/auth/session.service.js';
import { createValidationPipe } from '../src/common/validation.js';
import { Customer, CustomerDocument, CustomerSchema } from '../src/customer/schemas/customer.schema.js';
import { RedisService } from '../src/redis/redis.service.js';
import { JwtAuthGuard } from '../src/shop/jwt-auth.guard.js';
import { Shop, ShopProvider, ShopSchema } from '../src/shop/schemas/shop.schema.js';
import {
  buildNotificationMessage,
  formatIst,
  formatRs,
  toGsm7,
} from '../src/transaction/notification-message.js';
import {
  NotificationEmailService,
  type ResendLike,
} from '../src/transaction/notification-email.service.js';
import { NotificationController } from '../src/transaction/notification.controller.js';
import {
  MAX_EMAILS_PER_CUSTOMER_PER_DAY,
  MAX_EMAILS_PER_SHOP_PER_DAY,
  NotificationService,
} from '../src/transaction/notification.service.js';
import {
  SMS_RESULTS,
  Transaction,
  TransactionDocument,
  TransactionSchema,
} from '../src/transaction/schemas/transaction.schema.js';
import { TransactionController } from '../src/transaction/transaction.controller.js';
import { TransactionService } from '../src/transaction/transaction.service.js';
import { FakeRedisService, JWT_SECRET } from './support/test-app.js';

// 14 Oct 2026, 11:43 AM IST
const AT = new Date('2026-10-14T06:13:00.000Z');

describe('notification message', () => {
  const base = {
    amount: 50000,
    balanceAfter: 515000,
    createdAt: AT,
    note: 'Tea, biscuits',
    shopName: 'Sharma General Store',
    type: 'gave' as const,
  };

  it('formats a "gave" entry', () => {
    expect(buildNotificationMessage(base)).toBe(
      'Sharma General Store: Rs.500 added to your khata (Tea, biscuits) on 14 Oct 2026, 11:43 AM. Total due: Rs.5,150.',
    );
  });

  it('formats a "got" entry (no note)', () => {
    expect(buildNotificationMessage({ ...base, balanceAfter: 465000, type: 'got' })).toBe(
      'Sharma General Store: Rs.500 received on 14 Oct 2026, 11:43 AM. Total due: Rs.4,650.',
    );
  });

  it('says "No dues." at zero and "Advance" when negative', () => {
    expect(buildNotificationMessage({ ...base, balanceAfter: 0, note: null, type: 'got' })).toMatch(
      / No dues\.$/,
    );
    expect(buildNotificationMessage({ ...base, balanceAfter: -25050, type: 'got' })).toMatch(
      / Advance: Rs\.250\.50\.$/,
    );
  });

  it('truncates a long note to 40 and a long shop name to 30 characters', () => {
    const text = buildNotificationMessage({
      ...base,
      note: 'Rice 5 kg, cooking oil 2 litres, sugar 1 kg, tea powder',
      shopName: 'Shri Ganesh Kirana and General Provision Store',
    });
    const shop = text.split(':')[0];
    const note = text.match(/\((.*)\)/)?.[1] ?? '';
    expect(shop.length).toBeLessThanOrEqual(30);
    expect(shop.endsWith('...')).toBe(true);
    expect(note.length).toBeLessThanOrEqual(40);
    expect(note.endsWith('...')).toBe(true);
  });

  it('keeps only GSM-7 characters (no ₹, emoji, Hindi, curly quotes)', () => {
    expect(toGsm7('चाय Tea ₹50 “2 kg” 🍪  biscuits')).toBe('Tea 50 2 kg biscuits');
    const text = buildNotificationMessage({ ...base, note: '₹ चाय 🍵', shopName: 'शर्मा Store' });
    expect(text).toBe(
      'Store: Rs.500 added to your khata on 14 Oct 2026, 11:43 AM. Total due: Rs.5,150.',
    );
    expect(/^[\x20-\x7E]*$/.test(text)).toBe(true);
  });

  it('uses Indian grouping and IST time', () => {
    expect(formatRs(12000000)).toBe('Rs.1,20,000');
    expect(formatRs(1234567800)).toBe('Rs.1,23,45,678');
    expect(formatRs(-50)).toBe('Rs.0.50');
    expect(formatIst(new Date('2026-10-13T18:45:00.000Z'))).toBe('14 Oct 2026, 12:15 AM');
    expect(formatIst(new Date('2026-10-14T12:00:00.000Z'))).toBe('14 Oct 2026, 5:30 PM');
  });
});

describe('NotificationEmailService', () => {
  const params = { subject: 'Sharma: khata update', text: 'Hello', to: 'c@example.com', transactionId: 'tx1' };

  it('sends text and plain HTML with an idempotency key, no links', async () => {
    const send = vi.fn().mockResolvedValue({ error: null });
    const result = await NotificationEmailService.withClient({ emails: { send } }).send(params);
    expect(result).toEqual({ ok: true });
    const [payload, options] = send.mock.calls[0];
    expect(payload).toMatchObject({ subject: 'Sharma: khata update', text: 'Hello', to: 'c@example.com' });
    expect(payload.html).toBe('<p>Hello</p>');
    expect(options).toEqual({ idempotencyKey: 'kaapy-entry-tx1' });
  });

  it('retries once on a network error with the same idempotency key', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({ error: null });
    const result = await NotificationEmailService.withClient({ emails: { send } }).send(params);
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
  });

  it('gives up after one retry', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await NotificationEmailService.withClient({ emails: { send } }).send(params);
    expect(result).toEqual({ error: 'network', ok: false });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not retry a provider error', async () => {
    const send = vi.fn().mockResolvedValue({ error: { statusCode: 422 } });
    const result = await NotificationEmailService.withClient({ emails: { send } }).send(params);
    expect(result).toEqual({ error: 'provider_error', ok: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('times out after 8 seconds without retrying', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => new Promise<never>(() => undefined));
      const pending = NotificationEmailService.withClient({ emails: { send } } as ResendLike).send(params);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ error: 'timeout', ok: false });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports not_configured without an API key', async () => {
    expect(await NotificationEmailService.withClient(null).send(params)).toEqual({
      error: 'not_configured',
      ok: false,
    });
  });

  it('never logs addresses or message text', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleSpies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const send = vi.fn().mockResolvedValue({ error: { statusCode: 500 } });
      await NotificationEmailService.withClient({ emails: { send } }).send({
        ...params,
        text: 'SECRET-TEXT',
        to: 'secret@example.com',
      });
      const logged = [...write.mock.calls, ...consoleSpies.flatMap((s) => s.mock.calls)].flat().join(' ');
      expect(logged).not.toContain('secret@example.com');
      expect(logged).not.toContain('SECRET-TEXT');
    } finally {
      write.mockRestore();
      consoleSpies.forEach((s) => s.mockRestore());
    }
  });
});

describe('/transactions/:id/notification', () => {
  let replSet: MongoMemoryReplSet;
  let app: INestApplication<Server>;
  let customers: Model<CustomerDocument>;
  let transactions: Model<TransactionDocument>;
  let shops: Model<Shop>;
  let jwt: JwtService;
  let redis: FakeRedisService;
  let notifications: NotificationService;
  const emailSend = vi.fn();

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    redis = new FakeRedisService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri('kaapy-notify-test')),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: Transaction.name, schema: TransactionSchema },
          { name: Shop.name, schema: ShopSchema },
        ]),
        JwtModule.register({ secret: JWT_SECRET }),
      ],
      controllers: [TransactionController, NotificationController],
      providers: [
        TransactionService,
        NotificationService,
        SessionService,
        JwtAuthGuard,
        { provide: RedisService, useValue: redis },
        { provide: NotificationEmailService, useValue: { send: emailSend } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    customers = moduleRef.get(getModelToken(Customer.name));
    transactions = moduleRef.get(getModelToken(Transaction.name));
    shops = moduleRef.get(getModelToken(Shop.name));
    jwt = moduleRef.get(JwtService);
    notifications = moduleRef.get(NotificationService);
    for (const model of [customers, transactions, shops] as Model<unknown>[]) {
      await model.createCollection();
      await model.syncIndexes();
    }
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await transactions.deleteMany({});
    await customers.deleteMany({});
    await shops.deleteMany({});
    redis.data.clear();
    emailSend.mockReset();
    emailSend.mockResolvedValue({ ok: true });
  });

  const http = () => request(app.getHttpServer());

  async function newShop(overrides: Record<string, unknown> = {}) {
    const doc = await shops.create({
      address: 'Not provided',
      fullName: 'Rakesh Sharma',
      gmail: `${randomUUID()}@gmail.com`,
      isGmailVerify: true,
      passwordHash: 'x',
      provider: ShopProvider.GAMIL,
      shopName: 'Sharma General Store',
      ...overrides,
    });
    const shopId = doc.id as string;
    const token = await jwt.signAsync({ sub: shopId, gmail: 'x@gmail.com', type: 'access' }, { expiresIn: '1h' });
    return { auth: { Authorization: `Bearer ${token}` }, shopId };
  }

  async function newCustomer(shopId: string, email: string | null = 'customer@example.com') {
    const doc = await customers.create({
      email,
      name: 'Ramesh Kumar',
      phone: `+919${Math.floor(100000000 + Math.random() * 899999999)}`,
      shopId: new Types.ObjectId(shopId),
    });
    return doc.id as string;
  }

  async function newEntry(shop: { auth: Record<string, string> }, customerId: string, note = 'Tea, biscuits') {
    const { body } = await http()
      .post(`/customers/${customerId}/transactions`)
      .set(shop.auth)
      .send({ amount: 50000, clientRequestId: randomUUID(), note, type: 'gave' })
      .expect(201);
    return body;
  }

  const report = (shop: { auth: Record<string, string> }, id: string, body: object) =>
    http().post(`/transactions/${id}/notification`).set(shop.auth).send(body);

  const stored = async (id: string) => (await transactions.findById(id).lean())?.notification;

  it('creating an entry returns the server-built message, phone, hasEmail and pending', async () => {
    const shop = await newShop();
    const customerId = await newCustomer(shop.shopId);
    const body = await newEntry(shop, customerId);

    expect(body.messageText).toMatch(
      /^Sharma General Store: Rs\.500 added to your khata \(Tea, biscuits\) on \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM)\. Total due: Rs\.500\.$/,
    );
    expect(body.customerPhone).toMatch(/^\+919\d{9}$/);
    expect(body.hasEmail).toBe(true);
    expect(body.transaction.notification).toEqual({ smsDelivered: false, status: 'pending' });
    // The date in the message is the stored createdAt in IST.
    expect(body.messageText).toContain(formatIst(new Date(body.transaction.createdAt)));
  });

  it('sms sent: status sms_sent and no email', async () => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));

    const { body } = await report(shop, entry.transaction.id, { smsResult: 'sent' }).expect(200);

    expect(body).toMatchObject({ emailSent: false, smsResult: 'sent', status: 'sms_sent' });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it.each(SMS_RESULTS.filter((r) => r !== 'sent'))(
    '%s with an email on file: email_sent, using only stored data',
    async (smsResult) => {
      const shop = await newShop();
      const entry = await newEntry(shop, await newCustomer(shop.shopId, 'ramesh@example.com'));

      const { body } = await report(shop, entry.transaction.id, { smsResult }).expect(200);

      expect(body).toMatchObject({ emailSent: true, smsResult, status: 'email_sent' });
      expect(emailSend).toHaveBeenCalledTimes(1);
      expect(emailSend).toHaveBeenCalledWith({
        subject: 'Sharma General Store: khata update',
        text: entry.messageText,
        to: 'ramesh@example.com',
        transactionId: entry.transaction.id,
      });
    },
  );

  it('failure without an email: not_delivered, nothing sent', async () => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId, null));
    expect(entry.hasEmail).toBe(false);

    const { body } = await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200);

    expect(body.status).toBe('not_delivered');
    expect(emailSend).not.toHaveBeenCalled();
    expect((await stored(entry.transaction.id))?.emailError).toBe('no_email');
  });

  it('Resend failing: not_delivered with a short error code', async () => {
    emailSend.mockResolvedValue({ error: 'provider_error', ok: false });
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));

    const { body } = await report(shop, entry.transaction.id, { smsResult: 'timeout' }).expect(200);

    expect(body).toMatchObject({ emailSent: false, status: 'not_delivered' });
    expect((await stored(entry.transaction.id))?.emailError).toBe('provider_error');
  });

  it('a final status never changes again, and nothing is re-sent', async () => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    await report(shop, entry.transaction.id, { smsResult: 'no_service' }).expect(200);

    const again = await report(shop, entry.transaction.id, { smsResult: 'generic_failure' }).expect(200);
    const sent = await report(shop, entry.transaction.id, { smsResult: 'sent' }).expect(200);

    expect(again.body.status).toBe('email_sent');
    expect(sent.body.status).toBe('email_sent');
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it('parallel failure reports send exactly one email', async () => {
    // A slow email widens the race window.
    emailSend.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 150)),
    );
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        report(shop, entry.transaction.id, { smsResult: i % 2 ? 'timeout' : 'no_sim' }),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect((await stored(entry.transaction.id))?.status).toBe('email_sent');
  });

  it("returns 404 for another shop's entry and changes nothing", async () => {
    const owner = await newShop();
    const intruder = await newShop();
    const entry = await newEntry(owner, await newCustomer(owner.shopId));

    await report(intruder, entry.transaction.id, { smsResult: 'no_sim' }).expect(404);
    await report(intruder, 'not-an-id', { smsResult: 'no_sim' }).expect(404);

    expect((await stored(entry.transaction.id))?.status).toBe('pending');
    expect(emailSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ smsResult: 'no_sim', email: 'attacker@example.com' }, 'email address'],
    [{ smsResult: 'no_sim', text: 'Pay now at evil.example' }, 'message text'],
    [{ smsResult: 'no_sim', to: 'attacker@example.com' }, 'recipient'],
    [{ smsResult: 'no_sim', status: 'email_sent' }, 'status'],
    [{ smsResult: 'delivered_maybe' }, 'unknown smsResult'],
    [{ delivered: false }, 'delivered false'],
    [{}, 'empty body'],
  ])('rejects %j (%s) without sending anything', async (body, _reason) => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    await report(shop, entry.transaction.id, body).expect(400);
    expect(emailSend).not.toHaveBeenCalled();
    expect((await stored(entry.transaction.id))?.status).toBe('pending');
  });

  it('requires an access token', async () => {
    await http().post(`/transactions/${new Types.ObjectId()}/notification`).send({ smsResult: 'sent' }).expect(401);
  });

  it('stores smsErrorCode with the result', async () => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId, null));

    const { body } = await report(shop, entry.transaction.id, {
      smsErrorCode: 1,
      smsResult: 'generic_failure',
    }).expect(200);

    expect(body).toMatchObject({ smsErrorCode: 1, smsResult: 'generic_failure', status: 'not_delivered' });
    expect((await stored(entry.transaction.id))?.smsErrorCode).toBe(1);
  });

  it.each([-1, 1000, 1.5, 'abc'])('rejects smsErrorCode %j', async (smsErrorCode) => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    await report(shop, entry.transaction.id, { smsErrorCode, smsResult: 'generic_failure' }).expect(400);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it.each(['limit_exceeded', 'invalid_number', 'sim_not_ready'])(
    'new value %s is accepted and falls back to email',
    async (smsResult) => {
      const shop = await newShop();
      const entry = await newEntry(shop, await newCustomer(shop.shopId));
      const { body } = await report(shop, entry.transaction.id, { smsErrorCode: 5, smsResult }).expect(200);
      expect(body.status).toBe('email_sent');
    },
  );

  it('accepts every smsResult the app can send, and rejects anything else', async () => {
    // Drift guard: the app's list (kaapyapp/src/api/notifications.ts) must be a subset of ours.
    const appFile = path.resolve(__dirname, '../../kaapyapp/src/api/notifications.ts');
    if (existsSync(appFile)) {
      const source = readFileSync(appFile, 'utf8');
      const block = source.match(/SMS_RESULTS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
      const appValues = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      expect(appValues.length).toBeGreaterThan(0);
      expect([...SMS_RESULTS]).toEqual(expect.arrayContaining(appValues));
    }

    const shop = await newShop();
    for (const smsResult of SMS_RESULTS) {
      const entry = await newEntry(shop, await newCustomer(shop.shopId, null));
      await report(shop, entry.transaction.id, { smsResult }).expect(200);
    }
    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    await report(shop, entry.transaction.id, { smsResult: 'carrier_on_fire' }).expect(400);
  });

  it('logs ids, codes and booleans only', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId, 'private@example.com'));
    emailSend.mockResolvedValue({ error: 'provider_error', ok: false });

    await report(shop, entry.transaction.id, { smsErrorCode: 4, smsResult: 'no_service' }).expect(200);

    const line = logSpy.mock.calls.map((call) => String(call[0])).find((text) => text.includes(entry.transaction.id));
    expect(line).toBe(
      `Entry ${entry.transaction.id} notification: not_delivered ` +
        '(smsResult=no_service, smsErrorCode=4, emailAttempted=true, customerHasEmail=true)',
    );
    const everything = logSpy.mock.calls.flat().join(' ');
    expect(everything).not.toContain('private@example.com');
    expect(everything).not.toContain(entry.customerPhone);
    expect(everything).not.toContain(entry.messageText);
    logSpy.mockRestore();
  });

  it('logs why nothing was emailed when the customer has no email', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId, null));
    await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200);
    const line = logSpy.mock.calls.map((call) => String(call[0])).find((text) => text.includes(entry.transaction.id));
    expect(line).toContain('emailAttempted=false, customerHasEmail=false');
    logSpy.mockRestore();
  });

  it('delivered only marks a sent SMS and never emails or changes status', async () => {
    const shop = await newShop();
    const pending = await newEntry(shop, await newCustomer(shop.shopId));

    // Before sms_sent: no effect at all.
    const early = await report(shop, pending.transaction.id, { delivered: true }).expect(200);
    expect(early.body).toMatchObject({ smsDelivered: false, status: 'pending' });

    await report(shop, pending.transaction.id, { smsResult: 'sent' }).expect(200);
    const late = await report(shop, pending.transaction.id, { delivered: true }).expect(200);
    expect(late.body).toMatchObject({ smsDelivered: true, status: 'sms_sent' });

    // On a failed SMS: still nothing.
    const failed = await newEntry(shop, await newCustomer(shop.shopId, null));
    await report(shop, failed.transaction.id, { smsResult: 'no_sim' }).expect(200);
    const afterFail = await report(shop, failed.transaction.id, { delivered: true }).expect(200);
    expect(afterFail.body).toMatchObject({ smsDelivered: false, status: 'not_delivered' });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it(`stops at ${MAX_EMAILS_PER_CUSTOMER_PER_DAY} fallback emails per customer per day`, async () => {
    const shop = await newShop();
    const customerId = await newCustomer(shop.shopId);
    const statuses: string[] = [];
    for (let i = 0; i < MAX_EMAILS_PER_CUSTOMER_PER_DAY + 1; i += 1) {
      const entry = await newEntry(shop, customerId);
      statuses.push((await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200)).body.status);
    }
    expect(statuses.slice(0, MAX_EMAILS_PER_CUSTOMER_PER_DAY).every((s) => s === 'email_sent')).toBe(true);
    expect(statuses.at(-1)).toBe('not_delivered');
    expect(emailSend).toHaveBeenCalledTimes(MAX_EMAILS_PER_CUSTOMER_PER_DAY);

    // Another customer of the same shop is unaffected.
    const other = await newEntry(shop, await newCustomer(shop.shopId));
    expect((await report(shop, other.transaction.id, { smsResult: 'no_sim' })).body.status).toBe('email_sent');
  });

  it(`stops at ${MAX_EMAILS_PER_SHOP_PER_DAY} emails per shop per day`, async () => {
    const shop = await newShop();
    // Pretend the shop already used today's allowance (key uses the IST day).
    const day = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    redis.data.set(`notify:email:shop:${shop.shopId}:${day}`, String(MAX_EMAILS_PER_SHOP_PER_DAY));

    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    const { body } = await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200);

    expect(body.status).toBe('not_delivered');
    expect(emailSend).not.toHaveBeenCalled();
    expect((await stored(entry.transaction.id))?.emailError).toBe('rate_limited');
  });

  it('cleanup turns 24h-old pending entries into unknown and never emails', async () => {
    const shop = await newShop();
    const customerId = await newCustomer(shop.shopId);
    const old = await newEntry(shop, customerId);
    const fresh = await newEntry(shop, customerId);
    const done = await newEntry(shop, customerId);
    await report(shop, done.transaction.id, { smsResult: 'sent' }).expect(200);

    const tomorrow = new Date(new Date(old.transaction.createdAt).getTime() + 24 * 60 * 60 * 1000 + 1000);
    // Only entries created more than 24h before "now" qualify; make "fresh" newer.
    await transactions.collection.updateOne(
      { _id: new Types.ObjectId(fresh.transaction.id) },
      { $set: { createdAt: new Date(tomorrow.getTime() - 60 * 1000) } },
    );

    expect(await notifications.markStaleAsUnknown(tomorrow)).toBe(1);
    expect((await stored(old.transaction.id))?.status).toBe('unknown');
    expect((await stored(fresh.transaction.id))?.status).toBe('pending');
    expect((await stored(done.transaction.id))?.status).toBe('sms_sent');
    expect(emailSend).not.toHaveBeenCalled();

    // A late report after cleanup changes nothing.
    await report(shop, old.transaction.id, { smsResult: 'no_sim' }).expect(200);
    expect((await stored(old.transaction.id))?.status).toBe('unknown');
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('notification updates cannot touch the immutable ledger fields', async () => {
    const shop = await newShop();
    const entry = await newEntry(shop, await newCustomer(shop.shopId));
    await expect(
      transactions.updateOne(
        { _id: entry.transaction.id },
        { $set: { 'notification.status': 'sms_sent', amount: 1 } },
      ),
    ).rejects.toThrow('immutable');
    expect((await transactions.findById(entry.transaction.id).lean())?.amount).toBe(50000);
  });

  describe('shop message settings (read on the server when the entry is saved)', () => {
    const settings = (values: Record<string, unknown>) => ({
      settings: { emailFallback: true, includeNote: true, messageLanguage: 'en', notifyCustomers: true, ...values },
    });

    it("notifyCustomers off: the entry is saved, status 'skipped', no message, nothing sent later", async () => {
      const shop = await newShop(settings({ notifyCustomers: false }));
      const customerId = await newCustomer(shop.shopId);
      const body = await newEntry(shop, customerId);

      expect(body.transaction.amount).toBe(50000);
      expect(body.balance).toBe(50000);
      expect(body.messageText).toBeNull();
      expect(body.transaction.notification.status).toBe('skipped');

      // Even a (buggy) report changes nothing and sends no email.
      await report(shop, body.transaction.id, { smsResult: 'no_sim' }).expect(200);
      expect((await stored(body.transaction.id))?.status).toBe('skipped');
      expect(emailSend).not.toHaveBeenCalled();

      // The ledger lists it as skipped too.
      const list = await http().get(`/customers/${customerId}/transactions`).set(shop.auth).expect(200);
      expect(list.body.items[0].notification.status).toBe('skipped');
    });

    it("messageLanguage 'app' with Hindi: Hindi text with ₹ and Latin digits", async () => {
      const shop = await newShop({ language: 'hi', ...settings({ messageLanguage: 'app' }) });
      const body = await newEntry(shop, await newCustomer(shop.shopId), 'चाय');
      expect(body.messageText).toContain('आपके खाते में ₹500 उधार लिखा (चाय)');
      expect(body.messageText).toContain('कुल बाकी: ₹500');
      expect(body.messageText).not.toMatch(/[०-९]/);
    });

    it("messageLanguage 'en' keeps English even for a Hindi shop, and 'app' with 'en' is English", async () => {
      const hindi = await newShop({ language: 'hi', ...settings({ messageLanguage: 'en' }) });
      const english = await newShop({ language: 'en', ...settings({ messageLanguage: 'app' }) });
      const a = await newEntry(hindi, await newCustomer(hindi.shopId));
      const b = await newEntry(english, await newCustomer(english.shopId));
      expect(a.messageText).toMatch(/^Sharma General Store: Rs\.500 added to your khata \(Tea, biscuits\)/);
      expect(b.messageText).toMatch(/^Sharma General Store: Rs\.500 added to your khata \(Tea, biscuits\)/);
    });

    it('includeNote off leaves the item out of the message', async () => {
      const shop = await newShop(settings({ includeNote: false }));
      const body = await newEntry(shop, await newCustomer(shop.shopId), 'Secret item');
      expect(body.messageText).not.toContain('Secret item');
      expect(body.messageText).toMatch(/^Sharma General Store: Rs\.500 added to your khata on /);
      // The entry itself still keeps the note.
      expect(body.transaction.note).toBe('Secret item');
    });

    it('emailFallback off: a failed SMS becomes not_delivered without any email', async () => {
      const shop = await newShop(settings({ emailFallback: false }));
      const entry = await newEntry(shop, await newCustomer(shop.shopId));
      const { body } = await report(shop, entry.transaction.id, { smsResult: 'no_service' }).expect(200);
      expect(body).toMatchObject({ emailSent: false, status: 'not_delivered' });
      expect(emailSend).not.toHaveBeenCalled();
    });

    it('the email fallback uses the message language for the text and the subject', async () => {
      const shop = await newShop({ language: 'ta', ...settings({ messageLanguage: 'app' }) });
      const entry = await newEntry(shop, await newCustomer(shop.shopId), 'அரிசி');
      await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200);
      expect(emailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Sharma General Store: கணக்கு விவரம்',
          text: entry.messageText,
        }),
      );
      expect(entry.messageText).toContain('₹500');
    });

    it('settings changed after saving do not change that entry', async () => {
      const shop = await newShop(settings({ emailFallback: true }));
      const entry = await newEntry(shop, await newCustomer(shop.shopId));
      await shops.updateOne({ _id: shop.shopId }, { $set: { 'settings.emailFallback': false, language: 'hi', 'settings.messageLanguage': 'app' } });
      await report(shop, entry.transaction.id, { smsResult: 'no_sim' }).expect(200);
      expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ text: entry.messageText }));
      expect(entry.messageText).toMatch(/^Sharma General Store: Rs\./);
    });
  });
});
