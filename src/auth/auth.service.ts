import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import { RedisService } from '../redis/redis.service.js';
import { Shop, ShopDocument, ShopProvider } from '../shop/schemas/shop.schema.js';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyGmailDto,
} from './dto/auth.dto.js';
import { EmailService } from './email.service.js';

const VERIFICATION_TTL = 600;
const REFRESH_TTL = 604800;
const LOGIN_WINDOW = 1800;
const MAX_LOGIN_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly emailService: EmailService,
  ) {}

  async register(dto: RegisterDto): Promise<{ message: string; verificationCode?: string }> {
    const gmail = dto.gmail.trim().toLowerCase();
    const existingShop = await this.shopModel.exists({ gmail });

    if (existingShop) {
      throw new ConflictException('A shop already exists for this Gmail address');
    }

    const code = this.createCode();
    await this.shopModel.create({
      gmail,
      passwordHash: this.hashPassword(dto.password), 
      fullName: dto.fullName,
      shopName: dto.shopName,
      address: dto.address,
      provider: ShopProvider.GAMIL,
      isGmailVerify: false,
    });
    await this.redisService.set(`auth:verify:${gmail}`, code, VERIFICATION_TTL);
    await this.emailService.sendVerificationCode(gmail, dto.fullName, code);

    return this.codeResponse('Registration received. Check Gmail for the verification code.', code);
  }

  async verifyGmail(dto: VerifyGmailDto): Promise<{ message: string }> {
    const gmail = dto.gmail.trim().toLowerCase();
    const expectedCode = await this.redisService.get(`auth:verify:${gmail}`);
    const shop = await this.shopModel.findOne({ gmail }).exec();

    if (!expectedCode || expectedCode !== dto.code || !shop) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    shop.isGmailVerify = true;
    await shop.save();
    await this.redisService.delete(`auth:verify:${gmail}`);
    return { message: 'Gmail verified successfully' };
  }

  async login(dto: LoginDto): Promise<TokenResponse> {
    const gmail = dto.gmail.trim().toLowerCase();
    const attemptKey = `auth:login-attempts:${gmail}`;
    const attempts = await this.redisService.get(attemptKey);

    if (attempts && Number(attempts) >= MAX_LOGIN_ATTEMPTS) {
      throw new UnauthorizedException('Too many login attempts. Try again in 30 minutes.');
    }

    const shop = await this.shopModel.findOne({ gmail }).select('+passwordHash').exec();
    if (!shop || !this.verifyPassword(dto.password, shop.passwordHash) || !shop.isGmailVerify) {
      const count = await this.redisService.increment(attemptKey, LOGIN_WINDOW);
      if (count >= MAX_LOGIN_ATTEMPTS) {
        throw new UnauthorizedException('Too many login attempts. Try again in 30 minutes.');
      }
      throw new UnauthorizedException('Invalid credentials or unverified Gmail');
    }

    await this.redisService.delete(attemptKey);
    return this.issueTokens(shop);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string; resetCode?: string }> {
    const gmail = dto.gmail.trim().toLowerCase();
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
    const gmail = dto.gmail.trim().toLowerCase();
    const expectedCode = await this.redisService.get(`auth:reset:${gmail}`);
    const shop = await this.shopModel.findOne({ gmail }).select('+passwordHash').exec();

    if (!expectedCode || expectedCode !== dto.code || !shop) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    shop.passwordHash = this.hashPassword(dto.password);
    await shop.save();
    await this.redisService.delete(`auth:reset:${gmail}`);
    return { message: 'Password reset successfully' };
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenResponse> {
    let payload: { sub: string; type: string };
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
    if (shopId !== payload.sub) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const shop = await this.shopModel.findById(payload.sub).exec();
    if (!shop) {
      throw new UnauthorizedException('Shop no longer exists');
    }

    await this.redisService.delete(tokenKey);
    return this.issueTokens(shop);
  }

  private async issueTokens(shop: ShopDocument): Promise<TokenResponse> {
    const payload = { sub: shop.id, gmail: shop.gmail };
    const accessToken = await this.jwtService.signAsync({ ...payload, type: 'access' }, { expiresIn: '1d' });
    const refreshToken = await this.jwtService.signAsync({ ...payload, type: 'refresh' }, { expiresIn: '7d' });
    await this.redisService.set(
      `auth:refresh:${this.tokenHash(refreshToken)}`,
      shop.id,
      REFRESH_TTL,
    );
    return { accessToken, refreshToken };
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const derivedHash = scryptSync(password, salt, 64);
    return timingSafeEqual(derivedHash, Buffer.from(hash, 'hex'));
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