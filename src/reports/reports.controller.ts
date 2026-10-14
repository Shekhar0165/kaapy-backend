import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentShopId } from '../shop/current-shop.decorator.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { BalanceReportDto, BalanceReportQueryDto } from './dto/balance-report.dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token' })
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('balance')
  @ApiOperation({
    summary: "The logged-in shop's balance overview",
    description:
      'totalDue/totalAdvance/customer counts and topDebtors reflect current balances; given and ' +
      'received cover the period (IST); recent is the last 10 entries regardless of period.',
  })
  @ApiOkResponse({ type: BalanceReportDto })
  @ApiBadRequestResponse({ description: 'period is not today, month or all' })
  balance(
    @CurrentShopId() shopId: string,
    @Query() query: BalanceReportQueryDto,
  ): Promise<BalanceReportDto> {
    return this.reportsService.balance(shopId, query.period ?? 'month');
  }
}
