import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { NOTIFICATION_STATUSES, SMS_RESULTS } from '../schemas/transaction.schema.js';
import type { NotificationStatus, SmsResult } from '../schemas/transaction.schema.js';

/**
 * What the app may report. There is deliberately no field for an email address
 * or message text: the fallback email always uses the customer's stored email
 * and text built from the stored entry. Unknown fields are rejected (400).
 */
export class ReportNotificationDto {
  @ApiPropertyOptional({ enum: SMS_RESULTS, example: 'sent' })
  @IsOptional()
  @IsIn(SMS_RESULTS)
  smsResult?: SmsResult;

  @ApiPropertyOptional({
    example: 1,
    minimum: 0,
    maximum: 999,
    description:
      'Raw code from the phone (Android SmsManager result code, or 900-999 for checks made ' +
      'before sending). Diagnostics only; never changes the outcome.',
  })
  @IsOptional()
  @IsInt({ message: 'smsErrorCode must be a whole number' })
  @Min(0)
  @Max(999)
  smsErrorCode?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Delivery report for an SMS already reported as sent. Never triggers an email.',
  })
  @IsOptional()
  @Equals(true, { message: 'delivered can only be true' })
  delivered?: true;
}

export class NotificationStateDto {
  @ApiProperty({ example: '6710c0ffee0000000000beef' })
  transactionId!: string;

  @ApiProperty({ enum: NOTIFICATION_STATUSES })
  status!: NotificationStatus;

  @ApiProperty({ enum: SMS_RESULTS, nullable: true })
  smsResult!: SmsResult | null;

  @ApiProperty({ type: Number, nullable: true })
  smsErrorCode!: number | null;

  @ApiProperty()
  smsDelivered!: boolean;

  @ApiProperty()
  emailSent!: boolean;
}
