import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CustomerDocument = HydratedDocument<Customer>;

export enum CustomerSource {
  CONTACTS = 'contacts',
  MANUAL = 'manual',
}

@Schema({ timestamps: true })
export class Customer {
  @Prop({ type: Types.ObjectId, ref: 'Shop', required: true, index: true })
  shopId!: Types.ObjectId;

  @Prop({ required: true, trim: true, minlength: 2, maxlength: 60 })
  name!: string;

  /** E.164, always +91XXXXXXXXXX. */
  @Prop({ required: true, match: /^\+91[6-9]\d{9}$/ })
  phone!: string;

  /** Optional, not unique. Stored only (no email is sent yet). */
  @Prop({ type: String, lowercase: true, trim: true, maxlength: 100, default: null })
  email!: string | null;

  /**
   * Integer paise (never floats). Positive: the customer owes the shop.
   * Negative: the customer paid in advance.
   */
  @Prop({
    required: true,
    default: 0,
    validate: { validator: Number.isInteger, message: 'balance must be an integer number of paise' },
  })
  balance!: number;

  @Prop({ type: Date, default: null })
  lastEntryAt!: Date | null;

  @Prop({ default: false })
  isArchived!: boolean;

  /** How the customer was added; kept for product analytics only. */
  @Prop({ type: String, enum: Object.values(CustomerSource) })
  source?: CustomerSource;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

// One customer per phone number per shop (archived ones included, so a
// deleted customer is restored rather than duplicated).
CustomerSchema.index({ shopId: 1, phone: 1 }, { unique: true });
// Serves the default list order.
CustomerSchema.index({ shopId: 1, isArchived: 1, lastEntryAt: -1, createdAt: -1 });
// Serves the Balance report's 'who owes the most' (balance desc, ties by name).
CustomerSchema.index({ shopId: 1, balance: -1, name: 1 });
