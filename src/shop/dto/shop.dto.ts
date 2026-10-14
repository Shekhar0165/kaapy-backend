import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  ValidateIf,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { NoHtml } from '../../common/validators/no-html.validator.js';
import { NoImplicitConversion, TrimString } from '../../common/validation.js';
import {
  ENABLED_LANGUAGES,
  type LanguageCode,
  MESSAGE_LANGUAGES,
  type MessageLanguage,
} from '../../common/languages.js';
import { AddressSource, ShopProvider } from '../schemas/shop.schema.js';

/** Indian PIN code: six digits, never starting with 0. */
export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

export class UpdateShopDto {
  @ApiProperty({ example: 'Sharma General Store', minLength: 2, maxLength: 60 })
  @TrimString()
  @IsString()
  @Length(2, 60)
  @NoHtml()
  shopName!: string;
}

export class CoordinatesDto {
  @ApiProperty({ example: 28.6139, minimum: -90, maximum: 90 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 77.209, minimum: -180, maximum: 180 })
  @IsLongitude()
  lng!: number;
}

export class SetShopAddressDto {
  @ApiProperty({ example: '12 Main Bazaar Road' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @NoHtml()
  line1!: string;

  @ApiPropertyOptional({ example: 'Near Hanuman Mandir', description: 'Area or landmark' })
  @TrimString({ emptyAsUndefined: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @NoHtml()
  line2?: string;

  @ApiProperty({ example: 'New Delhi' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @NoHtml()
  city!: string;

  @ApiProperty({ example: 'Delhi' })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @NoHtml()
  state!: string;

  @ApiProperty({ example: '110001', description: '6-digit Indian PIN code' })
  @TrimString()
  @IsString()
  @Matches(PINCODE_PATTERN, { message: 'pincode must be a valid 6-digit Indian PIN code' })
  pincode!: string;

  @ApiProperty({ enum: AddressSource, example: AddressSource.MANUAL })
  @IsEnum(AddressSource)
  source!: AddressSource;

  @ApiPropertyOptional({ type: CoordinatesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  location?: CoordinatesDto;
}

export class ReverseGeocodeDto extends CoordinatesDto {}

export class ReverseGeocodeResponseDto {
  @ApiProperty({ example: '12 Main Bazaar Road' })
  line1!: string;

  @ApiProperty({ example: 'Chandni Chowk' })
  area!: string;

  @ApiProperty({ example: 'New Delhi' })
  city!: string;

  @ApiProperty({ example: 'Delhi' })
  state!: string;

  @ApiProperty({ example: '110006' })
  pincode!: string;
}

export class ShopAddressResponseDto {
  @ApiProperty({ example: '12 Main Bazaar Road' })
  line1!: string;

  @ApiPropertyOptional({ example: 'Near Hanuman Mandir' })
  line2?: string;

  @ApiProperty({ example: 'New Delhi' })
  city!: string;

  @ApiProperty({ example: 'Delhi' })
  state!: string;

  @ApiProperty({ example: '110001' })
  pincode!: string;

  @ApiProperty({ enum: AddressSource })
  source!: AddressSource;

  @ApiPropertyOptional({ type: CoordinatesDto })
  location?: CoordinatesDto;
}

export class ShopSettingsDto {
  @ApiProperty({ enum: MESSAGE_LANGUAGES, example: 'en' })
  messageLanguage!: MessageLanguage;

  @ApiProperty({ example: true })
  notifyCustomers!: boolean;

  @ApiProperty({ example: true })
  emailFallback!: boolean;

  @ApiProperty({ example: true })
  includeNote!: boolean;
}

/** Present means "change it": undefined skips the field, but null is rejected. */
const IsPresentOrAbsent = () => ValidateIf((_object, value) => value !== undefined);

/** Any subset; unknown fields are rejected. Acts only on the caller's own shop. */
export class UpdateShopSettingsDto {
  @ApiPropertyOptional({ enum: ENABLED_LANGUAGES, description: 'App and message language' })
  @IsPresentOrAbsent()
  @IsIn(ENABLED_LANGUAGES as unknown as string[], { message: 'language must be one of the enabled languages' })
  language?: LanguageCode;

  @ApiPropertyOptional({ enum: MESSAGE_LANGUAGES })
  @IsPresentOrAbsent()
  @IsIn(MESSAGE_LANGUAGES as unknown as string[])
  messageLanguage?: MessageLanguage;

  @ApiPropertyOptional()
  @IsPresentOrAbsent()
  @NoImplicitConversion()
  @IsBoolean()
  notifyCustomers?: boolean;

  @ApiPropertyOptional()
  @IsPresentOrAbsent()
  @NoImplicitConversion()
  @IsBoolean()
  emailFallback?: boolean;

  @ApiPropertyOptional()
  @IsPresentOrAbsent()
  @NoImplicitConversion()
  @IsBoolean()
  includeNote?: boolean;
}

export class ShopProfileDto {
  @ApiProperty({ example: '66f1c0ffee0000000000abcd' })
  id!: string;

  @ApiProperty({ example: 'Sharma General Store' })
  shopName!: string;

  @ApiProperty({ example: 'Rakesh Sharma' })
  fullName!: string;

  @ApiProperty({ example: 'shop@gmail.com' })
  gmail!: string;

  @ApiProperty()
  isGmailVerify!: boolean;

  @ApiProperty({ enum: ShopProvider })
  provider!: ShopProvider;

  @ApiProperty({ description: 'False for Google-only accounts that never set a password' })
  hasPassword!: boolean;

  @ApiProperty({ type: ShopAddressResponseDto, nullable: true })
  address!: ShopAddressResponseDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Free-text address from registration, when no structured address is saved yet',
  })
  legacyAddress!: string | null;

  @ApiProperty({ enum: ENABLED_LANGUAGES, example: 'en' })
  language!: LanguageCode;

  @ApiProperty({ type: ShopSettingsDto })
  settings!: ShopSettingsDto;
}
