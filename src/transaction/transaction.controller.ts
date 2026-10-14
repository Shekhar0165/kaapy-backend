import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentShopId } from '../shop/current-shop.decorator.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import {
  CreateTransactionDto,
  CreateTransactionResponseDto,
  ListTransactionsQueryDto,
  TransactionListResponseDto,
} from './dto/transaction.dto.js';
import { TransactionService } from './transaction.service.js';

// Append-only ledger: there are intentionally no update or delete routes.
@ApiTags('transactions')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token' })
@UseGuards(JwtAuthGuard)
@Controller('customers/:customerId/transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post()
  @ApiOperation({
    summary: 'Add a ledger entry (You gave / You got)',
    description:
      'The date and time are set by the server. Resending the same clientRequestId returns the ' +
      'original entry with 200 instead of creating another.',
  })
  @ApiCreatedResponse({ type: CreateTransactionResponseDto, description: 'Entry saved' })
  @ApiOkResponse({ type: CreateTransactionResponseDto, description: 'Already saved (retry)' })
  @ApiBadRequestResponse({
    description: 'Invalid type, amount or note, or a field such as a date was sent',
  })
  @ApiNotFoundResponse({ description: 'No such active customer in this shop' })
  async create(
    @CurrentShopId() shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: CreateTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateTransactionResponseDto> {
    const { created, ...result } = await this.transactionService.create(shopId, customerId, dto);
    response.status(created ? 201 : 200);
    return result;
  }

  @Get()
  @ApiOperation({ summary: "A customer's ledger entries, newest first (cursor paginated)" })
  @ApiOkResponse({ type: TransactionListResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid limit or cursor' })
  @ApiNotFoundResponse({ description: 'No such active customer in this shop' })
  list(
    @CurrentShopId() shopId: string,
    @Param('customerId') customerId: string,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionListResponseDto> {
    return this.transactionService.list(shopId, customerId, query);
  }
}
