import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import type { LanguageCode } from '../common/languages.js';
import { normalizeEmail } from '../common/validation.js';
import { RedisService } from '../redis/redis.service.js';
import { Shop, ShopDocument, ShopProvider } from '../shop/schemas/shop.schema.js';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyGmailDto,
} from './dto/auth.dto.js';
import { EmailService } from './email.service.js';
import { hashPassword, hasUsablePassword, verifyPassword } from './password.js';
import { SessionService } from './session.service.js';

const VERIFICATION_TTL = 600;
const REFRESH_TTL = 604800;
const LOGIN_WINDOW = 1800;
const MAX_LOGIN_ATTEMPTS = 5;
/** Wrong codes allowed for one emailed code before it is thrown away. */
const MAX_CODE_ATTEMPTS = 5;
/** Sign-up sends and resends: per email and per IP, per hour. */
const SEND_WINDOW = 3600;
const MAX_SENDS_PER_WINDOW = 5;
/** Minimum time between two codes emailed to one address. */
const RESEND_COOLDOWN = 60;
/** All verify requests (right or wrong): per email and per IP, per hour. */
const MAX_VERIFY_REQUESTS_PER_WINDOW = 30;

export type ChangePasswordErrorCode =
  | 'WRONG_PASSWORD'
  | 'SAME_PASSWORD'
  | 'TOO_MANY_ATTEMPTS'
  | 'NO_PASSWORD';

export type SignupErrorCode =
  | 'account_exists_password'
  | 'account_exists_google'
  | 'email_send_failed'
  | 'email_not_verified'
  | 'invalid_code'
  | 'code_expired'
  | 'too_many_attempts'
  | 'already_verified'
  | 'resend_cooldown'
  | 'too_many_requests';

function codedError(
  status: HttpStatus,
  code: ChangePasswordErrorCode | SignupErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}

export type VerificationSent = { status: 'verification_sent'; verificationCode?: string };

/** Emails are hashed in the new Redis keys so a key never holds an address. */
const emailKey = (gmail: string) => createHash('sha256').update(gmail).digest('hex').slice(0, 32);
const keys = {
  code: (gmail: string) => `auth:verify:${gmail}`,
  codeAttempts: (gmail: string) => `auth:verify-code-attempts:${emailKey(gmail)}`,
  cooldown: (gmail: string) => `auth:verify-cooldown:${emailKey(gmail)}`,
  sendsByEmail: (gmail: string) => `auth:verify-sends:email:${emailKey(gmail)}`,
  sendsByIp: (ip: string) => `auth:verify-sends:ip:${ip}`,
  verifyByEmail: (gmail: string) => `auth:verify-requests:email:${emailKey(gmail)}`,
  verifyByIp: (ip: string) => `auth:verify-requests:ip:${ip}`,
};

/** Constant-time code comparison. */
function sameCode(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) {
    // Same amount of work as a real comparison, then fail.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

function alreadyVerified() {
  return codedError(
    HttpStatus.CONFLICT,
    'already_verified',
    'This email is already verified. Please log in.',
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly emailService: EmailService,
    private readonly sessionService: SessionService,
  ) {}

  async verifyGoogleToken(idToken: string): Promise<TokenPayload> {
    this.logger.log(`[GoogleAuth] verifying ID token; token length=${idToken.length}`);
    try {
      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.configService.getOrThrow<string>('GOOGLE_WEB_CLIENT_ID'),
      });
      const payload = ticket.getPayload();

      if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        this.logger.warn('[GoogleAuth] token rejected: missing subject, email, or verified email');
        throw new UnauthorizedException('Google account email is not verified');
      }

      this.logger.log('[GoogleAuth] token verified successfully');
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error('[GoogleAuth] token verification failed');
      throw new UnauthorizedException('Invalid Google ID token');
    }
  }

  async findOrCreateFromGoogle(
    payload: TokenPayload,
    language?: LanguageCode,
  ): Promise<{ shop: ShopDocument; isNewShop: boolean }> {
    const gmail = normalizeEmail(payload.email!);
    const existingShop = await this.shopModel.findOne({ gmail }).exec();

    if (existingShop?.isGmailVerify) {
      // A verified shop (Google, or a password account that proved the email by OTP)
      // belongs to the same email owner Google just proved, so it signs in as it is.
      this.logger.log('[GoogleAuth] existing user found');
      return { shop: existingShop, isNewShop: false };
    }

    if (existingShop) {
      // An unfinished password sign-up. Google proves who owns the email, so it takes
      // the account over: the unconfirmed password and any pending code are dropped.
      // This also stops someone squatting another person's email with a password.
      this.logger.log('[GoogleAuth] taking over an unverified password sign-up');
      existingShop.passwordHash = randomBytes(32).toString('hex');
      existingShop.provider = ShopProvider.GOOGLE;
      existingShop.isGmailVerify = true;
      if (language) existingShop.language = language;
      await existingShop.save();
      await this.clearVerification(gmail);
      return { shop: existingShop, isNewShop: true };
    }

    this.logger.log('[GoogleAuth] creating user from Google account');
    try {
      const shop = await this.shopModel.create({
        gmail,
        fullName: payload.name?.trim() || gmail.split('@')[0],
        shopName: payload.name?.trim() || 'My shop',
        address: 'Not provided',
        passwordHash: randomBytes(32).toString('hex'),
        provider: ShopProvider.GOOGLE,
        isGmailVerify: true,
        language: language ?? 'en',
      });
      return { shop, isNewShop: true };
    } catch (error) {
      // Another request created it a moment ago; use that one.
      if (isDuplicateKeyError(error)) return this.findOrCreateFromGoogle(payload, language);
      throw error;
    }
  }

  async loginWithGoogle(
    idToken: string,
    language?: LanguageCode,
  ): Promise<{ accessToken: string; user: GoogleUser; isNewShop: boolean }> {
    try {
      const payload = await this.verifyGoogleToken(idToken);
      // An existing shop keeps its saved language; only a new one takes the app's.
      const { shop, isNewShop } = await this.findOrCreateFromGoogle(payload, language);
      const { accessToken } = await this.issueTokens(shop);
      this.logger.log('[GoogleAuth] application login completed');

      return {
        accessToken,
        // The app asks a brand-new shop for its address before anything else.
        isNewShop,
        user: {
          id: shop.id,
          gmail: shop.gmail,
          fullName: shop.fullName,
          shopName: shop.shopName,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[GoogleAuth] application login failed: ${message}`);
      throw error;
    }
  }

  /**
   * Starts (or restarts) an email + password sign-up. Safe to retry:
   * - new email: creates the shop unverified and emails a code;
   * - unverified password account: takes the new name and password and emails a
   *   fresh code (the old one stops working), so a failed email or a closed app
   *   never leaves the owner stuck;
   * - verified or Google account: 409 with a code the app turns into the right action.
   * The shop is only ever verified by verifyGmail (or Google sign-in).
   */
  async register(dto: RegisterDto, ip: string): Promise<VerificationSent> {
    const gmail = normalizeEmail(dto.gmail);
    await this.limitSends(gmail, ip);

    let shop = await this.shopModel.findOne({ gmail }).select('+passwordHash').exec();
    this.assertCanSignUp(shop);

    const passwordHash = hashPassword(dto.password);
    if (shop) {
      shop.fullName = dto.fullName;
      shop.shopName = dto.shopName;
      shop.passwordHash = passwordHash;
      // Still a sign-up in progress, so the language picked now applies.
      if (dto.language) shop.language = dto.language;
      await shop.save();
    } else {
      try {
        shop = await this.shopModel.create({
          gmail,
          passwordHash,
          fullName: dto.fullName,
          shopName: dto.shopName,
          address: dto.address ?? 'Not provided',
          provider: ShopProvider.GAMIL,
          isGmailVerify: false,
          language: dto.language ?? 'en',
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // A parallel request created it first. Re-check it (it may even be a Google
        // account by now); the cooldown below stops a second email.
        shop = await this.shopModel.findOne({ gmail }).exec();
        this.assertCanSignUp(shop);
      }
    }

    return this.sendVerificationCode(gmail, dto.fullName);
  }

  /**
   * "Resend code". Unknown, verified and Google emails get the same answer as real
   * pending sign-ups, so it can't be used to find out who has an account. Limits and
   * the 60 s cooldown apply to every email alike.
   */
  async resendVerification(dto: ResendVerificationDto, ip: string): Promise<VerificationSent> {
    const gmail = normalizeEmail(dto.gmail);
    await this.limitSends(gmail, ip);

    const shop = await this.shopModel.findOne({ gmail }).exec();
    if (!shop || shop.isGmailVerify || shop.provider !== ShopProvider.GAMIL) {
      await this.takeSendSlot(gmail);
      return { status: 'verification_sent' };
    }
    return this.sendVerificationCode(gmail, shop.fullName);
  }

  /**
   * Checks the emailed code and, when it matches, verifies the shop and logs it in
   * (same token pair as /auth/login). This is the only place a password account
   * becomes verified. Five wrong codes throw the code away.
   */
  async verifyGmail(dto: VerifyGmailDto, ip: string): Promise<TokenResponse> {
    const gmail = normalizeEmail(dto.gmail);
    const [byEmail, byIp] = await Promise.all([
      this.redisService.increment(keys.verifyByEmail(gmail), SEND_WINDOW),
      this.redisService.increment(keys.verifyByIp(ip), SEND_WINDOW),
    ]);
    if (byEmail > MAX_VERIFY_REQUESTS_PER_WINDOW || byIp > MAX_VERIFY_REQUESTS_PER_WINDOW) {
      throw codedError(
        HttpStatus.TOO_MANY_REQUESTS,
        'too_many_requests',
        'Too many tries. Please wait an hour and try again.',
      );
    }

    const shop = await this.shopModel.findOne({ gmail }).exec();
    if (shop && (shop.isGmailVerify || shop.provider !== ShopProvider.GAMIL)) {
      throw alreadyVerified();
    }

    const expectedCode = await this.redisService.get(keys.code(gmail));
    if (!shop || !expectedCode) {
      throw codedError(
        HttpStatus.BAD_REQUEST,
        'code_expired',
        'This code has expired. Please ask for a new code.',
      );
    }

    if (!sameCode(expectedCode, dto.code)) {
      const wrong = await this.redisService.increment(keys.codeAttempts(gmail), VERIFICATION_TTL);
      if (wrong >= MAX_CODE_ATTEMPTS) {
        await this.clearVerification(gmail);
        throw codedError(
          HttpStatus.BAD_REQUEST,
          'too_many_attempts',
          'Too many wrong codes. Please ask for a new code.',
        );
      }
      throw codedError(
        HttpStatus.BAD_REQUEST,
        'invalid_code',
        'That code is not right. Please check it and try again.',
      );
    }

    // Conditional update, so two parallel verifies can't both get tokens.
    const verified = await this.shopModel
      .findOneAndUpdate(
        { _id: shop._id, isGmailVerify: false, provider: ShopProvider.GAMIL },
        { $set: { isGmailVerify: true } },
        { returnDocument: 'after' },
      )
      .exec();
    await this.clearVerification(gmail);
    if (!verified) throw alreadyVerified();
    return this.issueTokens(verified);
  }

  async login(dto: LoginDto): Promise<TokenResponse> {
    const gmail = normalizeEmail(dto.gmail);
    const attemptKey = `auth:login-attempts:${gmail}`;
    const attempts = await this.redisService.get(attemptKey);

    if (attempts && Number(attempts) >= MAX_LOGIN_ATTEMPTS) {
      throw new UnauthorizedException('Too many login attempts. Try again in 30 minutes.');
    }

    const shop = await this.shopModel.findOne({ gmail }).select('+passwordHash').exec();
    if (!shop || !verifyPassword(dto.password, shop.passwordHash)) {
      const count = await this.redisService.increment(attemptKey, LOGIN_WINDOW);
      if (count >= MAX_LOGIN_ATTEMPTS) {
        throw new UnauthorizedException('Too many login attempts. Try again in 30 minutes.');
      }
      throw new UnauthorizedException('Invalid credentials or unverified Gmail');
    }

    await this.redisService.delete(attemptKey);
    // Only said after the right password, so it tells a stranger nothing.
    if (!shop.isGmailVerify) {
      throw codedError(
        HttpStatus.FORBIDDEN,
        'email_not_verified',
        'Please confirm your email first. We can send you a new code.',
      );
    }
    return this.issueTokens(shop);
  }

  private assertCanSignUp(shop: ShopDocument | null): void {
    if (!shop) return;
    if (shop.provider === ShopProvider.GOOGLE) {
      throw codedError(
        HttpStatus.CONFLICT,
        'account_exists_google',
        'This email is registered with Google. Please use Continue with Google.',
      );
    }
    if (shop.isGmailVerify) {
      throw codedError(
        HttpStatus.CONFLICT,
        'account_exists_password',
        'This email is already registered. Please log in.',
      );
    }
  }

  /** At most 5 sign-up/resend requests per email and per IP each hour. */
  private async limitSends(gmail: string, ip: string): Promise<void> {
    const [byEmail, byIp] = await Promise.all([
      this.redisService.increment(keys.sendsByEmail(gmail), SEND_WINDOW),
      this.redisService.increment(keys.sendsByIp(ip), SEND_WINDOW),
    ]);
    if (byEmail > MAX_SENDS_PER_WINDOW || byIp > MAX_SENDS_PER_WINDOW) {
      throw codedError(
        HttpStatus.TOO_MANY_REQUESTS,
        'too_many_requests',
        'Too many tries. Please wait an hour and try again.',
      );
    }
  }

  /** Takes the 60 s send slot for an email, or throws resend_cooldown. Atomic. */
  private async takeSendSlot(gmail: string): Promise<void> {
    if (await this.redisService.setIfAbsent(keys.cooldown(gmail), '1', RESEND_COOLDOWN)) return;
    const wait = Math.max(1, await this.redisService.ttl(keys.cooldown(gmail)));
    throw codedError(
      HttpStatus.TOO_MANY_REQUESTS,
      'resend_cooldown',
      `Please wait ${wait} seconds before asking for a new code.`,
      { retryAfterSeconds: wait },
    );
  }

  /**
   * Emails a new code, replacing any older one, unless one went out in the last
   * 60 seconds. The slot is taken before sending, so parallel requests send one
   * email. A failed email gives the slot back so the owner can retry straight away;
   * the shop stays unverified.
   */
  private async sendVerificationCode(gmail: string, fullName: string): Promise<VerificationSent> {
    await this.takeSendSlot(gmail);

    const code = this.createCode();
    await this.redisService.set(keys.code(gmail), code, VERIFICATION_TTL);
    await this.redisService.delete(keys.codeAttempts(gmail));

    try {
      await this.emailService.sendVerificationCode(gmail, fullName, code);
    } catch {
      await this.redisService.delete(keys.cooldown(gmail));
      await this.redisService.delete(keys.code(gmail));
      this.logger.error('verification email could not be sent');
      throw codedError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'email_send_failed',
        'We could not send the code. Please try again.',
      );
    }

    // Outside production the code is returned for manual testing only; the app never reads it.
    if (process.env.NODE_ENV === 'production') return { status: 'verification_sent' };
    return { status: 'verification_sent', verificationCode: code };
  }

  private async clearVerification(gmail: string): Promise<void> {
    await this.redisService.delete(keys.code(gmail));
    await this.redisService.delete(keys.codeAttempts(gmail));
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string; resetCode?: string }> {
    const gmail = normalizeEmail(dto.gmail);
    const shop = await this.shopModel.exists({ gmail });
    const response = { message: 'If the Gmail exists, a reset code has been sent.' };

    if (!shop) {
      return response;
    }

    const code = this.createCode();
    await this.redisService.set(`auth:reset:${gmail}`, code, VERIFICATION_TTL);
    await this.emailService.sendPasswordResetCode(gmail, code);
    const codeResult = this.codeResponse(response.message, code, 'resetCode');
    return { ...response, resetCode: codeResult.resetCode };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const gmail = normalizeEmail(dto.gmail);
    const expectedCode = await this.redisService.get(`auth:reset:${gmail}`);
    const shop = await this.shopModel.findOne({ gmail }).select('+passwordHash').exec();

    if (!expectedCode || expectedCode !== dto.code || !shop) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    shop.passwordHash = hashPassword(dto.password);
    await shop.save();
    await this.redisService.delete(`auth:reset:${gmail}`);
    return { message: 'Password reset successfully' };
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenResponse> {
    let payload: { sub: string; type: string; iat?: number };
    try {
      payload = await this.jwtService.verifyAsync(dto.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Refresh token required');
    }

    const tokenKey = `auth:refresh:${this.tokenHash(dto.refreshToken)}`;
    const shopId = await this.redisService.get(tokenKey);
    if (shopId !== payload.sub || (await this.sessionService.isRevoked(payload.sub, payload.iat))) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const shop = await this.shopModel.findById(payload.sub).exec();
    if (!shop) {
      throw new UnauthorizedException('Shop no longer exists');
    }

    await this.redisService.delete(tokenKey);
    return this.issueTokens(shop);
  }

  async changePassword(shopId: string, dto: ChangePasswordDto): Promise<TokenResponse> {
    const attemptKey = `auth:change-password-attempts:${shopId}`;
    const attempts = await this.redisService.get(attemptKey);
    if (attempts && Number(attempts) >= MAX_LOGIN_ATTEMPTS) {
      throw codedError(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong attempts. Try again in 30 minutes.',
      );
    }

    const shop = await this.shopModel.findById(shopId).select('+passwordHash').exec();
    if (!shop) {
      throw new UnauthorizedException('Shop no longer exists');
    }

    if (!hasUsablePassword(shop.passwordHash)) {
      throw codedError(
        HttpStatus.BAD_REQUEST,
        'NO_PASSWORD',
        'You signed in with Google, so there is no password to change.',
      );
    }

    if (!verifyPassword(dto.currentPassword, shop.passwordHash)) {
      const count = await this.redisService.increment(attemptKey, LOGIN_WINDOW);
      if (count >= MAX_LOGIN_ATTEMPTS) {
        throw codedError(
          HttpStatus.TOO_MANY_REQUESTS,
          'TOO_MANY_ATTEMPTS',
          'Too many wrong attempts. Try again in 30 minutes.',
        );
      }
      throw codedError(HttpStatus.FORBIDDEN, 'WRONG_PASSWORD', 'Current password is incorrect');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw codedError(
        HttpStatus.BAD_REQUEST,
        'SAME_PASSWORD',
        'New password must be different from your current password',
      );
    }

    await this.redisService.delete(attemptKey);
    shop.passwordHash = hashPassword(dto.newPassword);
    await shop.save();

    // Log out every device, then hand this device a fresh pair (issued after the cut-off).
    await this.sessionService.revokeAll(shop.id);
    return this.issueTokens(shop);
  }

  /** Revokes one refresh token. Succeeds even when the token is unknown or already invalid. */
  async logout(refreshToken: string): Promise<{ message: string }> {
    await this.redisService.delete(`auth:refresh:${this.tokenHash(refreshToken)}`);
    return { message: 'Logged out' };
  }

  private async issueTokens(shop: ShopDocument): Promise<TokenResponse> {
    const payload = { sub: shop.id, gmail: shop.gmail };
    const accessToken = await this.jwtService.signAsync(
      { ...payload, type: 'access' },
      {
        expiresIn: this.configService.getOrThrow<string>(
          'JWT_EXPIRES_IN',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const refreshToken = await this.jwtService.signAsync({ ...payload, type: 'refresh' }, { expiresIn: '7d' });
    await this.redisService.set(
      `auth:refresh:${this.tokenHash(refreshToken)}`,
      shop.id,
      REFRESH_TTL,
    );
    return { accessToken, refreshToken };
  }

  private createCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private codeResponse(
    message: string,
    code: string,
    key: 'verificationCode' | 'resetCode' = 'verificationCode',
  ): { message: string; verificationCode?: string; resetCode?: string } {
    if (process.env.NODE_ENV === 'production') return { message };
    return { message, [key]: code };
  }
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
}

export interface GoogleUser {
  id: string;
  gmail: string;
  fullName: string;
  shopName: string;
}