import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentShopId } from '../shop/current-shop.decorator.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { CustomerService } from './customer.service.js';
import {
  BalanceNotZeroErrorDto,
  CreateCustomerDto,
  CustomerListResponseDto,
  CustomerResponseDto,
  DuplicateCustomerErrorDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto.js';

// The shop always comes from the access token; customers of other shops are
// indistinguishable from missing ones (404).
@ApiTags('customers')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token' })
@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  @ApiOperation({
    summary: 'Add a customer',
    description: 'Re-adding the phone of a deleted customer restores that customer.',
  })
  @ApiCreatedResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid name or phone, or unknown fields' })
  @ApiConflictResponse({ type: DuplicateCustomerErrorDto, description: 'Phone already used' })
  create(
    @CurrentShopId() shopId: string,
    @Body() dto: CreateCustomerDto,
  ): Promise<CustomerResponseDto> {
    return this.customerService.create(shopId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the shop's customers, most recently active first" })
  @ApiOkResponse({ type: CustomerListResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid filter, page or limit' })
  list(
    @CurrentShopId() shopId: string,
    @Query() query: ListCustomersQueryDto,
  ): Promise<CustomerListResponseDto> {
    return this.customerService.list(shopId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one customer' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No such customer in this shop' })
  get(@CurrentShopId() shopId: string, @Param('id') id: string): Promise<CustomerResponseDto> {
    return this.customerService.get(shopId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Update a customer's name and/or email (the phone can't be changed)" })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid name or email, nothing to update, or the phone was sent' })
  @ApiNotFoundResponse({ description: 'No such customer in this shop' })
  update(
    @CurrentShopId() shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerResponseDto> {
    return this.customerService.update(shopId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete (archive) a customer whose balance is zero' })
  @ApiNoContentResponse({ description: 'Customer archived' })
  @ApiNotFoundResponse({ description: 'No such customer in this shop' })
  @ApiConflictResponse({ type: BalanceNotZeroErrorDto, description: 'Balance is not zero' })
  remove(@CurrentShopId() shopId: string, @Param('id') id: string): Promise<void> {
    return this.customerService.archive(shopId, id);
  }
}
