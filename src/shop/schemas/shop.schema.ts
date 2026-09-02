import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopDocument = HydratedDocument<Shop>;

export enum ShopProvider {
  GOOGLE = 'google',
  GAMIL = 'gamil',
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

  @Prop({ required: true, trim: true })
  address!: string;
}

export const ShopSchema = SchemaFactory.createForClass(Shop);