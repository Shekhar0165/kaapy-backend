import { ShopProvider } from '../schemas/shop.schema.js';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NoHtml } from '../../common/validators/no-html.validator.js';

export class CreateShopDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoHtml()
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoHtml()
  shopName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @NoHtml()
  phone!: string;

  @IsOptional()
  @IsBoolean()
  isPhoneVerify?: boolean;

  @IsEmail()
  @IsNotEmpty()
  gmail!: string;

  @IsOptional()
  @IsBoolean()
  isGmailVerify?: boolean;

  @IsEnum(ShopProvider)
  @IsNotEmpty()
  provider!: ShopProvider;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @NoHtml()
  address!: string;
}