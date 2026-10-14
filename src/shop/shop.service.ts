import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { hasUsablePassword } from '../auth/password.js';
import { GeocodingService, ReverseGeocodeResult } from '../geocoding/geocoding.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  ReverseGeocodeDto,
  SetShopAddressDto,
  ShopProfileDto,
  UpdateShopDto,
  UpdateShopSettingsDto,
} from './dto/shop.dto.js';
import { languageOf, settingsOf, Shop, ShopDocument } from './schemas/shop.schema.js';

// Placeholder stored for Google sign-ups that never entered an address.
const MISSING_ADDRESS = 'Not provided';
const GEOCODE_WINDOW_SECONDS = 60;
const MAX_GEOCODES_PER_WINDOW = 10;

@Injectable()
export class ShopService {
  constructor(
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
    private readonly redisService: RedisService,
    private readonly geocodingService: GeocodingService,
  ) {}

  async reverseGeocode(shopId: string, dto: ReverseGeocodeDto): Promise<ReverseGeocodeResult> {
    const count = await this.redisService.increment(
      `shop:reverse-geocode:${shopId}`,
      GEOCODE_WINDOW_SECONDS,
    );
    if (count > MAX_GEOCODES_PER_WINDOW) {
      throw new HttpException(
        'Too many address lookups. Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.geocodingService.reverseGeocode(dto.lat, dto.lng);
  }

  async getProfile(shopId: string): Promise<ShopProfileDto> {
    return this.toProfile(await this.findOwnShop(shopId));
  }

  async updateProfile(shopId: string, dto: UpdateShopDto): Promise<ShopProfileDto> {
    const shop = await this.findOwnShop(shopId);
    shop.shopName = dto.shopName;
    await shop.save();
    return this.toProfile(shop);
  }

  /** Partial update; only the fields sent change. */
  async updateSettings(shopId: string, dto: UpdateShopSettingsDto): Promise<ShopProfileDto> {
    const shop = await this.findOwnShop(shopId);
    const next = settingsOf(shop);
    if (dto.messageLanguage !== undefined) next.messageLanguage = dto.messageLanguage;
    if (dto.notifyCustomers !== undefined) next.notifyCustomers = dto.notifyCustomers;
    if (dto.emailFallback !== undefined) next.emailFallback = dto.emailFallback;
    if (dto.includeNote !== undefined) next.includeNote = dto.includeNote;
    shop.settings = next;
    if (dto.language !== undefined) shop.language = dto.language;
    await shop.save();
    return this.toProfile(shop);
  }

  async setAddress(shopId: string, dto: SetShopAddressDto): Promise<ShopProfileDto> {
    const shop = await this.findOwnShop(shopId);
    shop.addressDetails = {
      line1: dto.line1,
      line2: dto.line2,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      source: dto.source,
      location: dto.location
        ? { type: 'Point', coordinates: [dto.location.lng, dto.location.lat] }
        : undefined,
    };
    await shop.save();
    return this.toProfile(shop);
  }

  /** Loads the caller's own shop; the id always comes from the access token. */
  private async findOwnShop(shopId: string): Promise<ShopDocument> {
    const shop = await this.shopModel.findById(shopId).select('+passwordHash').exec();
    if (!shop) {
      // The token is valid but the shop was deleted.
      throw new UnauthorizedException('Shop no longer exists');
    }
    return shop;
  }

  /** Explicit whitelist so password hashes and internal fields never leave the API. */
  private toProfile(shop: ShopDocument): ShopProfileDto {
    const details = shop.addressDetails;
    const legacy = shop.address?.trim();

    return {
      id: shop.id,
      shopName: shop.shopName,
      fullName: shop.fullName,
      gmail: shop.gmail,
      isGmailVerify: shop.isGmailVerify,
      provider: shop.provider,
      hasPassword: hasUsablePassword(shop.passwordHash),
      address: details
        ? {
            line1: details.line1,
            ...(details.line2 ? { line2: details.line2 } : {}),
            city: details.city,
            state: details.state,
            pincode: details.pincode,
            source: details.source,
            ...(details.location
              ? {
                  location: {
                    lat: details.location.coordinates[1],
                    lng: details.location.coordinates[0],
                  },
                }
              : {}),
          }
        : null,
      legacyAddress: legacy && legacy !== MISSING_ADDRESS ? legacy : null,
      language: languageOf(shop),
      settings: settingsOf(shop),
    };
  }
}
