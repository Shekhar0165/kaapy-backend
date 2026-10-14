import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentShopId } from '../shop/current-shop.decorator.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { NotificationStateDto, ReportNotificationDto } from './dto/notification.dto.js';
import { NotificationService } from './notification.service.js';

@ApiTags('transactions')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token' })
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post(':id/notification')
  @HttpCode(200)
  @ApiOperation({
    summary: "Report the app's SMS attempt for an entry",
    description:
      "smsResult 'sent' finishes as sms_sent. Any other result falls back to emailing the " +
      "customer's stored email (if any), else not_delivered. Only the first report for a " +
      "pending entry has any effect; later or parallel calls return the current state. " +
      "{ delivered: true } after sms_sent only records the delivery report.",
  })
  @ApiOkResponse({ type: NotificationStateDto })
  @ApiBadRequestResponse({ description: 'Unknown smsResult, empty body, or an extra field' })
  @ApiNotFoundResponse({ description: 'No such entry in this shop' })
  report(
    @CurrentShopId() shopId: string,
    @Param('id') id: string,
    @Body() dto: ReportNotificationDto,
  ): Promise<NotificationStateDto> {
    return this.notificationService.report(shopId, id, dto);
  }
}
