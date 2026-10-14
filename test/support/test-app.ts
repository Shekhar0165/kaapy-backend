import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { AuthController } from '../../src/auth/auth.controller.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { EmailService } from '../../src/auth/email.service.js';
import { hashPassword } from '../../src/auth/password.js';
import { SessionService } from '../../src/auth/session.service.js';
import { createValidationPipe } from '../../src/common/validation.js';
import { GeocodingService } from '../../src/geocoding/geocoding.service.js';
import { RedisService } from '../../src/redis/redis.service.js';
import { JwtAuthGuard } from '../../src/shop/jwt-auth.guard.js';
import { Shop, ShopProvider } from '../../src/shop/schemas/shop.schema.js';
import { ShopController } from '../../src/shop/shop.controller.js';
import { ShopService } from '../../src/shop/shop.service.js';

export const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

type ShopFields = Partial<Shop> & { _id: string };

/** Minimal stand-in for a hydrated Mongoose document. */
class FakeShopDoc {
  [key: string]: unknown;

  constructor(
    fields: ShopFields,
    private readonly store: Map<string, ShopFields>,
  ) {
    Object.assign(this, structuredClone(fields));
  }

  get id(): string {
    return this._id as string;
  }

  async save(): Promise<this> {
    const { store: _store, ...fields } = this as unknown as ShopFields & { store: unknown };
    this.store.set(this.id, structuredClone(fields));
    return this;
  }
}

/** In-memory model covering the calls the shop and auth services make. */
export class FakeShopModel {
  readonly store = new Map<string, ShopFields>();

  findById(id: string) {
    const fields = this.store.get(id);
    const result = fields ? new FakeShopDoc(fields, this.store) : null;
    const query = {
      select: () => query,
      exec: async () => result,
    };
    return query;
  }

  findOne(filter: { gmail?: string }) {
    const fields = [...this.store.values()].find((shop) => shop.gmail === filter.gmail);
    const result = fields ? new FakeShopDoc(fields, this.store) : null;
    const query = {
      select: () => query,
      exec: async () => result,
    };
    return query;
  }

  async create(fields: Omit<ShopFields, '_id'>) {
    const id = this.insert(fields);
    return new FakeShopDoc(this.store.get(id)!, this.store);
  }

  insert(fields: Omit<ShopFields, '_id'>): string {
    const id = randomBytes(12).toString('hex');
    this.store.set(id, { _id: id, ...fields });
    return id;
  }
}

/**
 * In-memory Redis with the same surface as RedisService. Expiry follows Date.now(),
 * so tests can move time with vi.setSystemTime.
 */
export class FakeRedisService {
  readonly data = new Map<string, string>();
  private readonly expiresAt = new Map<string, number>();

  private alive(key: string): boolean {
    const at = this.expiresAt.get(key);
    if (at !== undefined && at <= Date.now()) {
      this.data.delete(key);
      this.expiresAt.delete(key);
    }
    return this.data.has(key);
  }

  async get(key: string) {
    return this.alive(key) ? this.data.get(key)! : null;
  }

  async set(key: string, value: string, seconds?: number) {
    this.data.set(key, value);
    if (seconds) this.expiresAt.set(key, Date.now() + seconds * 1000);
    else this.expiresAt.delete(key);
    return 'OK' as const;
  }

  async setIfAbsent(key: string, value: string, seconds: number) {
    if (this.alive(key)) return false;
    await this.set(key, value, seconds);
    return true;
  }

  async ttl(key: string) {
    if (!this.alive(key)) return -2;
    const at = this.expiresAt.get(key);
    return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
  }

  async delete(key: string) {
    this.expiresAt.delete(key);
    return this.alive(key) && this.data.delete(key) ? 1 : 0;
  }

  async increment(key: string, seconds?: number) {
    const next = Number((await this.get(key)) ?? 0) + 1;
    const isNew = next === 1;
    this.data.set(key, String(next));
    if (isNew && seconds) this.expiresAt.set(key, Date.now() + seconds * 1000);
    return next;
  }
}

export interface TestContext {
  app: INestApplication<Server>;
  model: FakeShopModel;
  redis: FakeRedisService;
  jwt: JwtService;
  geocoding: { reverseGeocode: ReturnType<typeof vi.fn> };
  /** Creates a shop and returns its id plus a valid access token. */
  createShop(overrides?: Partial<Shop> & { password?: string | null }): Promise<{
    id: string;
    accessToken: string;
  }>;
  accessToken(shopId: string, gmail: string, issuedSecondsAgo?: number): Promise<string>;
}

export async function createTestApp(): Promise<TestContext> {
  const model = new FakeShopModel();
  const redis = new FakeRedisService();
  const geocoding = { reverseGeocode: vi.fn() };

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_SECRET })],
    controllers: [ShopController, AuthController],
    providers: [
      ShopService,
      AuthService,
      SessionService,
      JwtAuthGuard,
      { provide: getModelToken(Shop.name), useValue: model },
      { provide: RedisService, useValue: redis },
      { provide: GeocodingService, useValue: geocoding },
      { provide: EmailService, useValue: {} },
      {
        provide: ConfigService,
        useValue: new ConfigService({ JWT_EXPIRES_IN: '1h', GOOGLE_WEB_CLIENT_ID: 'test' }),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
  app.useGlobalPipes(createValidationPipe());
  await app.init();

  const jwt = moduleRef.get(JwtService);

  async function accessToken(shopId: string, gmail: string, issuedSecondsAgo = 0) {
    const iat = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
    return jwt.signAsync({ sub: shopId, gmail, type: 'access', iat }, { expiresIn: '1h' });
  }

  async function createShop(overrides: Partial<Shop> & { password?: string | null } = {}) {
    const { password = 'OldPassword1', ...fields } = overrides;
    const gmail = fields.gmail ?? `shop-${randomBytes(4).toString('hex')}@gmail.com`;
    const id = model.insert({
      fullName: 'Rakesh Sharma',
      shopName: 'Sharma General Store',
      gmail,
      isGmailVerify: true,
      provider: password === null ? ShopProvider.GOOGLE : ShopProvider.GAMIL,
      // Google-created shops store random hex that can never match a password.
      passwordHash: password === null ? randomBytes(32).toString('hex') : hashPassword(password),
      address: 'Not provided',
      ...fields,
    });
    return { id, accessToken: await accessToken(id, gmail) };
  }

  return { app, model, redis, jwt, geocoding, createShop, accessToken };
}
