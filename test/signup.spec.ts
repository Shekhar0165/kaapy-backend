import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { EmailService } from '../src/auth/email.service.js';
import { hasUsablePassword, verifyPassword } from '../src/auth/password.js';
import { SessionService } from '../src/auth/session.service.js';
import { createValidationPipe } from '../src/common/validation.js';
import { RedisService } from '../src/redis/redis.service.js';
import { JwtAuthGuard } from '../src/shop/jwt-auth.guard.js';
import { Shop, ShopDocument, ShopProvider, ShopSchema } from '../src/shop/schemas/shop.schema.js';
import { ShopController } from '../src/shop/shop.controller.js';
import { ShopService } from '../src/shop/shop.service.js';
import { GeocodingService } from '../src/geocoding/geocoding.service.js';
import { FakeRedisService, JWT_SECRET } from './support/test-app.js';

/**
 * Email + password sign-up against a real (in-memory) MongoDB, so the unique
 * email index and parallel requests behave as in production.
 */
describe('email sign-up', () => {
  let mongo: MongoMemoryServer;
  let app: INestApplication<Server>;
  let model: Model<ShopDocument>;
  let redis: FakeRedisService;
  /** Codes as the owner would read them in their inbox. */
  const inbox: { to: string; code: string }[] = [];
  const email = {
    sendVerificationCode: vi.fn(async (to: string, _name: string, code: string) => {
      inbox.push({ to, code });
    }),
    sendPasswordResetCode: vi.fn(),
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    redis = new FakeRedisService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri('kaapy-signup')),
        MongooseModule.forFeature([{ name: Shop.name, schema: ShopSchema }]),
        JwtModule.register({ secret: JWT_SECRET }),
      ],
      controllers: [AuthController, ShopController],
      providers: [
        AuthService,
        SessionService,
        ShopService,
        JwtAuthGuard,
        { provide: GeocodingService, useValue: {} },
        { provide: RedisService, useValue: redis },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_EXPIRES_IN: '1h', GOOGLE_WEB_CLIENT_ID: 'test' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    model = moduleRef.get(getModelToken(Shop.name));
    await model.syncIndexes();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await model.deleteMany({});
    redis.data.clear();
    inbox.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());
  const details = (gmail: string, extra: object = {}) => ({
    gmail,
    password: 'Password123',
    fullName: 'Rakesh Sharma',
    shopName: 'Sharma Store',
    ...extra,
  });
  const register = (gmail: string, extra: object = {}) =>
    http().post('/auth/register').send(details(gmail, extra));
  const verify = (gmail: string, code: string) =>
    http().post('/auth/verify-gmail').send({ gmail, code });
  const resend = (gmail: string) => http().post('/auth/resend-verification').send({ gmail });
  const lastCode = () => inbox.at(-1)!.code;
  const wrongCode = (right: string) => (right === '111111' ? '222222' : '111111');
  const shopOf = (gmail: string) => model.findOne({ gmail }).select('+passwordHash').lean();
  /** Moves the clock forward (Redis expiry in the fake follows Date.now). */
  const later = (seconds: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + seconds * 1000);
  };

  function googleSignIn(gmail: string, language?: string) {
    vi.spyOn(app.get(AuthService), 'verifyGoogleToken').mockResolvedValue({
      aud: 'test',
      email: gmail,
      email_verified: true,
      exp: 0,
      iat: 0,
      iss: 'accounts.google.com',
      name: 'Raju',
      sub: 'google-sub',
    });
    return http().post('/auth/google').send({ idToken: 'id-token', ...(language ? { language } : {}) });
  }

  describe('POST /auth/register', () => {
    it('creates an unverified password shop, emails a code and says only verification_sent', async () => {
      const { body } = await register('new@gmail.com').expect(201);

      expect(body.status).toBe('verification_sent');
      expect(Object.keys(body).sort()).toEqual(['status', 'verificationCode']); // dev/test only
      const shop = await shopOf('new@gmail.com');
      expect(shop).toMatchObject({ provider: ShopProvider.GAMIL, isGmailVerify: false });
      expect(verifyPassword('Password123', shop!.passwordHash)).toBe(true);
      expect(inbox).toEqual([{ to: 'new@gmail.com', code: expect.stringMatching(/^\d{6}$/) }]);
    });

    it('returns only { status } in production', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const { body } = await register('prod@gmail.com').expect(201);
        expect(body).toEqual({ status: 'verification_sent' });
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('normalizes case and spaces: Test@Gmail.com is test@gmail.com', async () => {
      await register('  Test@Gmail.com ').expect(201);
      expect(await model.countDocuments({ gmail: 'test@gmail.com' })).toBe(1);

      later(61);
      await register('TEST@gmail.com').expect(201);
      expect(await model.countDocuments({})).toBe(1);
      await verify('Test@GMAIL.com', lastCode()).expect(201);
      expect((await shopOf('test@gmail.com'))!.isGmailVerify).toBe(true);
    });

    it('a retry on an unverified account takes the new details, sends a new code and kills the old one', async () => {
      await register('retry@gmail.com', { fullName: 'Old Name' }).expect(201);
      const oldCode = lastCode();

      later(61);
      await register('retry@gmail.com', { fullName: 'New Name', password: 'NewPassword9' }).expect(201);
      const newCode = lastCode();

      const shop = await shopOf('retry@gmail.com');
      expect(shop!.fullName).toBe('New Name');
      expect(verifyPassword('NewPassword9', shop!.passwordHash)).toBe(true);
      expect(await model.countDocuments({})).toBe(1);
      if (oldCode !== newCode) {
        const { body } = await verify('retry@gmail.com', oldCode).expect(400);
        expect(body.code).toBe('invalid_code');
      }
      await verify('retry@gmail.com', newCode).expect(201);
    });

    it('a quick retry inside 60 s updates the details but does not send a second email', async () => {
      await register('quick@gmail.com').expect(201);
      const { body } = await register('quick@gmail.com', { fullName: 'Changed' }).expect(429);
      expect(body.code).toBe('resend_cooldown');
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(inbox).toHaveLength(1);
      expect((await shopOf('quick@gmail.com'))!.fullName).toBe('Changed');
      await verify('quick@gmail.com', inbox[0].code).expect(201);
    });

    it('a verified password account gets 409 account_exists_password', async () => {
      await register('done@gmail.com').expect(201);
      await verify('done@gmail.com', lastCode()).expect(201);

      const { body } = await register('done@gmail.com').expect(409);
      expect(body).toMatchObject({
        code: 'account_exists_password',
        message: 'This email is already registered. Please log in.',
      });
    });

    it('a Google account gets 409 account_exists_google and is not changed', async () => {
      await googleSignIn('g@gmail.com').expect(201);
      const before = await shopOf('g@gmail.com');

      const { body } = await register('g@gmail.com').expect(409);
      expect(body).toMatchObject({
        code: 'account_exists_google',
        message: 'This email is registered with Google. Please use Continue with Google.',
      });
      expect(await shopOf('g@gmail.com')).toEqual(before);
    });

    it('an email failure gives 503 email_send_failed, keeps the shop unverified, and a retry works', async () => {
      email.sendVerificationCode.mockRejectedValueOnce(new Error('resend down'));
      const { body } = await register('flaky@gmail.com').expect(503);
      expect(body).toMatchObject({
        code: 'email_send_failed',
        message: 'We could not send the code. Please try again.',
      });
      expect((await shopOf('flaky@gmail.com'))!.isGmailVerify).toBe(false);

      // No 60 s wait after a failed send, and never "already exists".
      await register('flaky@gmail.com').expect(201);
      await verify('flaky@gmail.com', lastCode()).expect(201);
    });

    it('two parallel registers for one new email make one shop and one email', async () => {
      const results = await Promise.all([1, 2, 3].map(() => register('race@gmail.com')));

      expect(await model.countDocuments({ gmail: 'race@gmail.com' })).toBe(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => r.status === 201 || r.body.code === 'resend_cooldown')).toBe(true);
      expect(inbox).toHaveLength(1);
    });

    it('allows 5 attempts per email per hour', async () => {
      for (let i = 0; i < 5; i++) {
        await register('busy@gmail.com').expect((r) => expect([201, 429]).toContain(r.status));
        later(61);
      }
      const { body } = await register('busy@gmail.com').expect(429);
      expect(body.code).toBe('too_many_requests');

      later(3600);
      await register('busy@gmail.com').expect(201);
    });

    it('allows 5 attempts per IP per hour', async () => {
      for (let i = 0; i < 5; i++) await register(`shop${i}@gmail.com`).expect(201);
      const { body } = await register('shop6@gmail.com').expect(429);
      expect(body.code).toBe('too_many_requests');
      expect(await model.countDocuments({ gmail: 'shop6@gmail.com' })).toBe(0);
    });
  });

  describe('POST /auth/verify-gmail', () => {
    it('stays unverified until the right code, which verifies and returns working tokens', async () => {
      await register('owner@gmail.com').expect(201);
      const code = lastCode();

      const wrong = await verify('owner@gmail.com', wrongCode(code)).expect(400);
      expect(wrong.body.code).toBe('invalid_code');
      expect(wrong.body.accessToken).toBeUndefined();
      expect((await shopOf('owner@gmail.com'))!.isGmailVerify).toBe(false);

      const { body } = await verify('owner@gmail.com', code).expect(201);
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'refreshToken']);
      expect((await shopOf('owner@gmail.com'))!.isGmailVerify).toBe(true);

      const me = await http().get('/shops/me').set('Authorization', `Bearer ${body.accessToken}`).expect(200);
      expect(me.body.address).toBeNull();
      await http().post('/auth/refresh-token').send({ refreshToken: body.refreshToken }).expect(201);
    });

    it('an expired code (after 10 minutes) is code_expired', async () => {
      await register('slow@gmail.com').expect(201);
      const code = lastCode();
      later(601);
      const { body } = await verify('slow@gmail.com', code).expect(400);
      expect(body.code).toBe('code_expired');
      expect((await shopOf('slow@gmail.com'))!.isGmailVerify).toBe(false);
    });

    it('5 wrong codes throw the code away; then even the right code fails until a new one', async () => {
      await register('typo@gmail.com').expect(201);
      const code = lastCode();

      for (let i = 0; i < 4; i++) {
        expect((await verify('typo@gmail.com', wrongCode(code)).expect(400)).body.code).toBe('invalid_code');
      }
      expect((await verify('typo@gmail.com', wrongCode(code)).expect(400)).body.code).toBe('too_many_attempts');
      expect((await verify('typo@gmail.com', code).expect(400)).body.code).toBe('code_expired');
      expect((await shopOf('typo@gmail.com'))!.isGmailVerify).toBe(false);

      later(61);
      await resend('typo@gmail.com').expect(201);
      await verify('typo@gmail.com', lastCode()).expect(201);
    });

    it('a new code resets the wrong-attempt count', async () => {
      await register('again@gmail.com').expect(201);
      for (let i = 0; i < 4; i++) await verify('again@gmail.com', wrongCode(lastCode())).expect(400);
      later(61);
      await resend('again@gmail.com').expect(201);
      const { body } = await verify('again@gmail.com', wrongCode(lastCode())).expect(400);
      expect(body.code).toBe('invalid_code');
    });

    it('an already verified account gets no tokens (409 already_verified)', async () => {
      await register('twice@gmail.com').expect(201);
      const code = lastCode();
      await verify('twice@gmail.com', code).expect(201);

      const { body } = await verify('twice@gmail.com', code).expect(409);
      expect(body.code).toBe('already_verified');
      expect(body.accessToken).toBeUndefined();
    });

    it('a Google account or an unknown email gets no tokens', async () => {
      await googleSignIn('g@gmail.com').expect(201);
      expect((await verify('g@gmail.com', '123456').expect(409)).body.accessToken).toBeUndefined();
      expect((await verify('nobody@gmail.com', '123456').expect(400)).body.code).toBe('code_expired');
    });

    it('two parallel verifies with the right code issue tokens once', async () => {
      await register('both@gmail.com').expect(201);
      const code = lastCode();
      const results = await Promise.all([verify('both@gmail.com', code), verify('both@gmail.com', code)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.body.accessToken)).toHaveLength(1);
    });

    it('limits verify requests per IP', async () => {
      for (let i = 0; i < 30; i++) await verify(`x${i}@gmail.com`, '123456');
      const { body } = await verify('y@gmail.com', '123456').expect(429);
      expect(body.code).toBe('too_many_requests');
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('sends a new code to a pending sign-up after the 60 s cooldown', async () => {
      await register('wait@gmail.com').expect(201);
      const first = lastCode();

      const early = await resend('wait@gmail.com').expect(429);
      expect(early.body.code).toBe('resend_cooldown');
      expect(inbox).toHaveLength(1);

      later(61);
      expect((await resend('wait@gmail.com').expect(201)).body.status).toBe('verification_sent');
      expect(inbox).toHaveLength(2);
      if (lastCode() !== first) await verify('wait@gmail.com', first).expect(400);
      await verify('wait@gmail.com', lastCode()).expect(201);
    });

    it('answers unknown, verified and Google emails the same way and sends nothing', async () => {
      await register('done@gmail.com').expect(201);
      await verify('done@gmail.com', lastCode()).expect(201);
      await googleSignIn('g@gmail.com').expect(201);
      inbox.length = 0;
      later(61);

      const answers = await Promise.all(
        ['nobody@gmail.com', 'done@gmail.com', 'g@gmail.com'].map(async (gmail) => {
          const { status, body } = await resend(gmail);
          return { status, body };
        }),
      );
      for (const answer of answers) expect(answer).toEqual({ status: 201, body: { status: 'verification_sent' } });
      expect(inbox).toHaveLength(0);

      // The cooldown applies to every address alike, so it reveals nothing either.
      expect((await resend('nobody@gmail.com').expect(429)).body.code).toBe('resend_cooldown');
    });

    it('allows 5 resends per email per hour', async () => {
      await register('lots@gmail.com').expect(201);
      for (let i = 0; i < 4; i++) {
        later(61);
        await resend('lots@gmail.com').expect(201);
      }
      later(61);
      expect((await resend('lots@gmail.com').expect(429)).body.code).toBe('too_many_requests');
    });
  });

  describe('POST /auth/login', () => {
    it('an unverified password account gets 403 email_not_verified and no tokens', async () => {
      await register('pending@gmail.com').expect(201);
      const { body } = await http()
        .post('/auth/login')
        .send({ gmail: 'Pending@Gmail.com', password: 'Password123' })
        .expect(403);
      expect(body.code).toBe('email_not_verified');
      expect(body.accessToken).toBeUndefined();
    });

    it('a wrong password on an unverified account does not reveal that it exists', async () => {
      await register('pending@gmail.com').expect(201);
      const wrong = await http().post('/auth/login').send({ gmail: 'pending@gmail.com', password: 'Wrong12345' });
      const unknown = await http().post('/auth/login').send({ gmail: 'nobody@gmail.com', password: 'Wrong12345' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('works after verification', async () => {
      await register('ok@gmail.com').expect(201);
      await verify('ok@gmail.com', lastCode()).expect(201);
      await http().post('/auth/login').send({ gmail: 'ok@gmail.com', password: 'Password123' }).expect(201);
    });
  });

  describe('Google sign-in', () => {
    it('takes over an unverified password sign-up: password and code are dropped', async () => {
      await register('mine@gmail.com', { password: 'SquatterPw1' }).expect(201);
      const pendingCode = lastCode();

      const { body } = await googleSignIn('Mine@Gmail.com').expect(201);
      expect(body.isNewShop).toBe(true);

      const shop = await shopOf('mine@gmail.com');
      expect(shop).toMatchObject({ provider: ShopProvider.GOOGLE, isGmailVerify: true });
      expect(hasUsablePassword(shop!.passwordHash)).toBe(false);
      expect(await model.countDocuments({})).toBe(1);
      await http().post('/auth/login').send({ gmail: 'mine@gmail.com', password: 'SquatterPw1' }).expect(401);
      expect((await verify('mine@gmail.com', pendingCode).expect(409)).body.accessToken).toBeUndefined();
    });

    it('signs in to a verified password account as it is (same owner, password still works)', async () => {
      await register('both@gmail.com').expect(201);
      await verify('both@gmail.com', lastCode()).expect(201);

      const { body } = await googleSignIn('both@gmail.com').expect(201);
      expect(body.isNewShop).toBe(false);
      expect(await shopOf('both@gmail.com')).toMatchObject({ provider: ShopProvider.GAMIL, isGmailVerify: true });
      await http().post('/auth/login').send({ gmail: 'both@gmail.com', password: 'Password123' }).expect(201);
    });
  });


  describe('language chosen on the first screen', () => {
    it('register stores it on the new shop', async () => {
      await register('ta@gmail.com', { language: 'ta' }).expect(201);
      expect((await shopOf('ta@gmail.com'))!.language).toBe('ta');
    });

    it('without one the shop starts in English', async () => {
      await register('plain@gmail.com').expect(201);
      expect((await shopOf('plain@gmail.com'))!.language).toBe('en');
    });

    it.each(['ur', 'xx', 'HI', ''])('register rejects %j with 400 and creates nothing', async (language) => {
      await register('bad@gmail.com', { language }).expect(400);
      expect(await model.countDocuments({})).toBe(0);
    });

    it('Google sign-in sets it only when the shop is created', async () => {
      await googleSignIn('g@gmail.com', 'bn').expect(201);
      expect((await shopOf('g@gmail.com'))!.language).toBe('bn');

      // Logging in again from a phone set to another language keeps the saved one.
      await googleSignIn('g@gmail.com', 'kn').expect(201);
      expect((await shopOf('g@gmail.com'))!.language).toBe('bn');
    });

    it('Google sign-in rejects a disabled language', async () => {
      await googleSignIn('g2@gmail.com', 'ur').expect(400);
      expect(await model.countDocuments({})).toBe(0);
    });
  });

  it('never logs emails or codes', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (writes.push(String(chunk)), true));
    vi.spyOn(console, 'log').mockImplementation((...args) => void writes.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void writes.push(args.join(' ')));
    email.sendVerificationCode.mockRejectedValueOnce(new Error('down'));

    await register('secret@gmail.com').expect(503);
    await register('secret@gmail.com').expect(201);
    await verify('secret@gmail.com', wrongCode(lastCode()));
    await verify('secret@gmail.com', lastCode());

    const all = writes.join('\n');
    expect(all).not.toContain('secret@gmail.com');
    expect(all).not.toContain(lastCode());
  });
});

/** Static guarantees about the code base. */
describe('who can verify an account', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(path) ? [path] : [];
    });

  it('only verify-gmail and Google sign-in set isGmailVerify to true', () => {
    const writes = sources(join(__dirname, '..', 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: line.trim(), index }))
        .filter(({ line }) => /isGmailVerify\s*(=|:)\s*true|\$set:\s*\{\s*isGmailVerify:\s*true/.test(line)),
    );
    expect(writes.map(({ file }) => file.replace(/\\/g, '/').split('/src/')[1])).toEqual([
      'auth/auth.service.ts', // Google: take over an unverified sign-up
      'auth/auth.service.ts', // Google: create
      'auth/auth.service.ts', // verifyGmail
    ]);
    const service = readFileSync(join(__dirname, '..', 'src/auth/auth.service.ts'), 'utf8');
    const verifyBody = service.slice(service.indexOf('async verifyGmail('), service.indexOf('async login('));
    expect(verifyBody).toContain('$set: { isGmailVerify: true }');
  });

  it('no request body can carry isGmailVerify', () => {
    const dtoFiles = sources(join(__dirname, '..', 'src')).filter((file) => /dto/.test(file));
    const offending = dtoFiles.filter((file) => {
      const text = readFileSync(file, 'utf8');
      // Response DTOs may describe the flag; request DTOs must not accept it.
      return /isGmailVerify\?:\s*boolean/.test(text);
    });
    expect(offending).toEqual([]);
  });

  it('the app never reads the dev code from the register response', () => {
    const appSrc = join(__dirname, '..', '..', 'kaapyapp', 'src');
    let files: string[];
    try {
      files = sources(appSrc);
    } catch {
      return; // The app is not checked out next to the backend.
    }
    expect(files.length).toBeGreaterThan(10);
    const readers = files.filter((file) => /verificationCode/.test(readFileSync(file, 'utf8')));
    expect(readers).toEqual([]);
  });
});

