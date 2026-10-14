import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { NoHtml } from '../../common/validators/no-html.validator.js';
import { TrimString } from '../../common/validation.js';
import { normalizeIndianMobile } from '../phone.js';
import { CustomerSource } from '../schemas/customer.schema.js';

const E164_INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

export const CUSTOMER_FILTERS = ['all', 'due', 'settled'] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

class CustomerNameDto {
  @ApiProperty({ example: 'Ramesh Kumar', minLength: 2, maxLength: 60 })
  @TrimString()
  @IsString()
  @Length(2, 60)
  @NoHtml()
  name!: string;
}

export class CreateCustomerDto extends CustomerNameDto {
  @ApiProperty({
    example: '98765 43210',
    description:
      'Indian mobile number. Accepts +91, 91, 0091 or 0 prefixes, spaces and dashes; stored as +91XXXXXXXXXX.',
  })
  // Normalize first; an invalid number is left as-is so the check below rejects it.
  @Transform(({ value }: { value: unknown }) => normalizeIndianMobile(value) ?? value)
  @IsString()
  @Matches(E164_INDIAN_MOBILE, {
    message: 'phone must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9',
  })
  phone!: string;

  @ApiProperty({ enum: CustomerSource, example: CustomerSource.MANUAL })
  @IsEnum(CustomerSource)
  source!: CustomerSource;

  @ApiPropertyOptional({ example: 'ramesh@example.com', maxLength: 100 })
  // Trimmed and lowercased; an empty string means "no email".
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : value,
  )
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(100)
  @NoHtml()
  email?: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'Ramesh Kumar', minLength: 2, maxLength: 60 })
  @TrimString()
  @IsOptional()
  @IsString()
  @Length(2, 60)
  @NoHtml()
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ramesh@example.com',
    description: 'New email. null or an empty string removes it; omit to leave it unchanged.',
  })
  // "" and null both mean "remove"; undefined means "leave unchanged".
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  @ValidateIf((_dto: UpdateCustomerDto, value: unknown) => value !== null && value !== undefined)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(100)
  @NoHtml()
  email?: string | null;

  // Phone is deliberately absent: it can never change. Sending it is a 400.
}

export class ListCustomersQueryDto {
  @ApiPropertyOptional({ description: 'Matches the name (case-insensitive) or phone digits' })
  @TrimString({ emptyAsUndefined: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(CUSTOMER_FILTERS)
  filter?: CustomerFilter;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CustomerResponseDto {
  @ApiProperty({ example: '6710c0ffee0000000000abcd' })
  id!: string;

  @ApiProperty({ example: 'Ramesh Kumar' })
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  phone!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ramesh@example.com' })
  email!: string | null;

  @ApiProperty({
    example: 465000,
    description: 'Integer paise. Positive: the customer owes the shop. Negative: advance.',
  })
  balance!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastEntryAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class CustomerSummaryDto {
  @ApiProperty({ example: 1203000, description: 'Sum of positive balances, in paise' })
  totalDue!: number;

  @ApiProperty({ example: 5 })
  customersWithDue!: number;

  @ApiProperty({ example: 6 })
  totalCustomers!: number;
}

export class CustomerListResponseDto {
  @ApiProperty({ type: [CustomerResponseDto] })
  items!: CustomerResponseDto[];

  @ApiProperty({ example: 42, description: 'Customers matching the search and filter' })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 30 })
  limit!: number;

  @ApiProperty({
    type: CustomerSummaryDto,
    description: "Covers all of the shop's customers, regardless of search, filter and page",
  })
  summary!: CustomerSummaryDto;
}

export class DuplicateCustomerErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'CUSTOMER_EXISTS' })
  code!: string;

  @ApiProperty({ example: 'A customer with this phone number already exists' })
  message!: string;

  @ApiProperty({ example: { id: '6710c0ffee0000000000abcd', name: 'Ramesh Kumar' } })
  customer!: { id: string; name: string };
}

export class BalanceNotZeroErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'BALANCE_NOT_ZERO' })
  code!: string;

  @ApiProperty({ example: 'Settle the balance of ₹4,650 before deleting this customer' })
  message!: string;

  @ApiProperty({ example: 465000, description: 'Current balance in paise' })
  balance!: number;
}
