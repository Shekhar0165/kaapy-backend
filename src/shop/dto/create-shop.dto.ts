import { ShopProvider } from '../schemas/shop.schema.js';

export class CreateShopDto {
  fullName!: string;
  shopName!: string;
  phone!: string;
  isPhoneVerify?: boolean;
  gmail!: string;
  isGmailVerify?: boolean;
  provider!: ShopProvider;
  address!: string;
}