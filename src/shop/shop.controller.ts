import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Shop, ShopDocument } from './schemas/shop.schema.js';
import { ShopService } from './shop.service.js';

@ApiTags('shops')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('shops')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get()
  @ApiOperation({ summary: 'Get all shops' })
  @ApiOkResponse({ type: Shop, isArray: true })
  getShops(): Promise<ShopDocument[]> {
    return this.shopService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a shop by id' })
  @ApiOkResponse({ type: Shop })
  getShop(@Param('id') id: string): Promise<ShopDocument> {
    return this.shopService.findOne(id);
  }
}