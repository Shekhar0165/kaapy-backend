import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { TransactionType } from '../../transaction/schemas/transaction.schema.js';
import { REPORT_PERIODS } from '../ist-period.js';
import type { ReportPeriod } from '../ist-period.js';

export class BalanceReportQueryDto {
  @ApiPropertyOptional({
    enum: REPORT_PERIODS,
    default: 'month',
    description: 'Period for given/received, by the India (IST) calendar',
  })
  @IsOptional()
  @IsIn(REPORT_PERIODS)
  period?: ReportPeriod;
}

export class TopDebtorDto {
  @ApiProperty({ example: '6710c0ffee0000000000abcd' })
  customerId!: string;

  @ApiProperty({ example: 'Meena Kumari' })
  name!: string;

  @ApiProperty({ example: 500000, description: 'Positive balance in paise' })
  balance!: number;
}

export class RecentEntryDto {
  @ApiProperty({ example: '6710c0ffee0000000000beef' })
  id!: string;

  @ApiProperty({ example: '6710c0ffee0000000000abcd' })
  customerId!: string;

  @ApiProperty({ example: 'Ramesh Kumar' })
  customerName!: string;

  @ApiProperty({ enum: TransactionType })
  type!: TransactionType;

  @ApiProperty({ example: 120000, description: 'Paise' })
  amount!: number;

  @ApiProperty({ type: String, format: 'date-time', description: 'Server time (UTC)' })
  createdAt!: Date;
}

export class BalanceReportDto {
  @ApiProperty({ enum: REPORT_PERIODS })
  period!: ReportPeriod;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'null for all' })
  periodStart!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  periodEnd!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt!: Date;

  @ApiProperty({ example: 1203000, description: 'Sum of positive balances (paise)' })
  totalDue!: number;

  @ApiProperty({ example: 25000, description: 'Sum of |negative balances| (paise), not netted' })
  totalAdvance!: number;

  @ApiProperty({ example: 5 })
  customersWithDue!: number;

  @ApiProperty({ example: 6 })
  totalCustomers!: number;

  @ApiProperty({ example: 1840000, description: "Sum of 'gave' amounts in the period (paise)" })
  given!: number;

  @ApiProperty({ example: 915000, description: "Sum of 'got' amounts in the period (paise)" })
  received!: number;

  @ApiProperty({ example: 12 })
  givenCount!: number;

  @ApiProperty({ example: 7 })
  receivedCount!: number;

  @ApiProperty({ type: [TopDebtorDto], description: 'Top 5 positive balances, desc, ties by name' })
  topDebtors!: TopDebtorDto[];

  @ApiProperty({ type: [RecentEntryDto], description: 'Last 10 entries, newest first (any period)' })
  recent!: RecentEntryDto[];
}
