import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ENABLED_LANGUAGES,
  type LanguageCode,
  MESSAGE_LANGUAGES,
  type MessageLanguage,
} from '../../common/languages.js';

export type ShopDocument = HydratedDocument<Shop>;

export enum ShopProvider {
  GOOGLE = 'google',
  GAMIL = 'gamil',
}

export enum AddressSource {
  GPS = 'gps',
  MANUAL = 'manual',
}

/** GeoJSON Point. Coordinates are [longitude, latitude]. */
@Schema({ _id: false })
export class GeoPoint {
  @Prop({ type: String, enum: ['Point'], required: true, default: 'Point' })
  type!: 'Point';

  @Prop({ type: [Number], required: true })
  coordinates!: [number, number];
}

export const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);

@Schema({ _id: false, timestamps: { createdAt: false, updatedAt: true } })
export class ShopAddress {
  @Prop({ required: true, trim: true })
  line1!: string;

  /** Area or landmark. */
  @Prop({ trim: true })
  line2?: string;

  @Prop({ required: true, trim: true })
  city!: string;

  @Prop({ required: true, trim: true })
  state!: string;

  @Prop({ required: true, trim: true })
  pincode!: string;

  @Prop({ type: String, required: true, enum: Object.values(AddressSource) })
  source!: AddressSource;

  // No 2dsphere index: nothing queries shops by location yet. Add one when a
  // "shops near me" style query needs it.
  @Prop({ type: GeoPointSchema })
  location?: GeoPoint;

  updatedAt?: Date;
}

export const ShopAddressSchema = SchemaFactory.createForClass(ShopAddress);

/** How the shop's customers are messaged. Read on the server when an entry is saved. */
@Schema({ _id: false })
export class ShopSettings {
  /** 'en' = English (GSM-7, cheapest); 'app' = the shop's language. */
  @Prop({ type: String, enum: MESSAGE_LANGUAGES, default: 'en' })
  messageLanguage!: MessageLanguage;

  /** Message the customer on every entry. Off: entries are saved with status 'skipped'. */
  @Prop({ type: Boolean, default: true })
  notifyCustomers!: boolean;

  /** Email the customer (if their email is saved) when the SMS fails. */
  @Prop({ type: Boolean, default: true })
  emailFallback!: boolean;

  /** Put the entry's item or note in the message. */
  @Prop({ type: Boolean, default: true })
  includeNote!: boolean;
}

export const ShopSettingsSchema = SchemaFactory.createForClass(ShopSettings);

export const DEFAULT_SHOP_SETTINGS: ShopSettings = {
  emailFallback: true,
  includeNote: true,
  messageLanguage: 'en',
  notifyCustomers: true,
};

/**
 * Settings with defaults filled in. Shops saved before settings existed (or
 * lean reads) may have none or only some fields.
 */
export function settingsOf(shop: { settings?: Partial<ShopSettings> | null } | null | undefined): ShopSettings {
  const saved = shop?.settings ?? {};
  return {
    emailFallback: typeof saved.emailFallback === 'boolean' ? saved.emailFallback : DEFAULT_SHOP_SETTINGS.emailFallback,
    includeNote: typeof saved.includeNote === 'boolean' ? saved.includeNote : DEFAULT_SHOP_SETTINGS.includeNote,
    messageLanguage: saved.messageLanguage === 'app' ? 'app' : 'en',
    notifyCustomers:
      typeof saved.notifyCustomers === 'boolean' ? saved.notifyCustomers : DEFAULT_SHOP_SETTINGS.notifyCustomers,
  };
}

/** The shop's language, English for unknown or missing values. */
export function languageOf(shop: { language?: string | null } | null | undefined): LanguageCode {
  const value = shop?.language;
  return value && (ENABLED_LANGUAGES as readonly string[]).includes(value) ? (value as LanguageCode) : 'en';
}

@Schema({ timestamps: true })
export class Shop {
  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ required: true, trim: true })
  shopName!: string;

  @Prop({ trim: true })
  phone!: string;

  @Prop({ default: false })
  isPhoneVerify!: boolean;

  @Prop({ required: true, lowercase: true, trim: true })
  gmail!: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({ default: false })
  isGmailVerify!: boolean;

  @Prop({ type: String, required: true, enum: Object.values(ShopProvider) })
  provider!: ShopProvider;

  /**
   * Legacy free-text address entered at registration ("Not provided" for
   * Google sign-ups). Kept as-is so existing data stays readable; the
   * structured address lives in `addressDetails`.
   */
  @Prop({ required: true, trim: true })
  address!: string;

  @Prop({ type: ShopAddressSchema })
  addressDetails?: ShopAddress;

  /** App and message language chosen by the owner (Tier 1 codes only). */
  @Prop({ type: String, enum: ENABLED_LANGUAGES, default: 'en' })
  language!: LanguageCode;

  @Prop({ type: ShopSettingsSchema, default: () => ({}) })
  settings!: ShopSettings;
}

export const ShopSchema = SchemaFactory.createForClass(Shop);

// One shop per email. The schema already trims and lowercases `gmail`, so this is
// unique on the normalized address (and stops two parallel sign-ups racing).
ShopSchema.index({ gmail: 1 }, { unique: true });
