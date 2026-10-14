import { Body, Controller, Get, HttpCode, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentShopId } from './current-shop.decorator.js';
import {
  ReverseGeocodeDto,
  ReverseGeocodeResponseDto,
  SetShopAddressDto,
  ShopProfileDto,
  UpdateShopDto,
  UpdateShopSettingsDto,
} from './dto/shop.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ShopService } from './shop.service.js';

// Every route acts on the caller's own shop; there is deliberately no route
// that takes a shop id, so one shop can never read or change another.
@ApiTags('shops')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token' })
@UseGuards(JwtAuthGuard)
@Controller('shops/me')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get()
  @ApiOperation({ summary: "Get the logged-in shop's profile" })
  @ApiOkResponse({ type: ShopProfileDto })
  getMe(@CurrentShopId() shopId: string): Promise<ShopProfileDto> {
    return this.shopService.getProfile(shopId);
  }

  @Patch()
  @ApiOperation({ summary: "Update the logged-in shop's name" })
  @ApiOkResponse({ type: ShopProfileDto })
  @ApiBadRequestResponse({ description: 'Invalid shop name or unknown fields' })
  updateMe(@CurrentShopId() shopId: string, @Body() dto: UpdateShopDto): Promise<ShopProfileDto> {
    return this.shopService.updateProfile(shopId, dto);
  }

  @Patch('settings')
  @ApiOperation({
    summary: "Change the logged-in shop's language and message settings",
    description:
      'Send any subset of language, messageLanguage, notifyCustomers, emailFallback, includeNote. ' +
      'Only enabled language codes are accepted.',
  })
  @ApiOkResponse({ type: ShopProfileDto })
  @ApiBadRequestResponse({ description: 'Unknown or disabled language, wrong types, or unknown fields' })
  updateSettings(
    @CurrentShopId() shopId: string,
    @Body() dto: UpdateShopSettingsDto,
  ): Promise<ShopProfileDto> {
    return this.shopService.updateSettings(shopId, dto);
  }

  @Put('address')
  @ApiOperation({ summary: "Save the logged-in shop's address" })
  @ApiOkResponse({ type: ShopProfileDto })
  @ApiBadRequestResponse({ description: 'Invalid address, PIN code or coordinates' })
  setAddress(
    @CurrentShopId() shopId: string,
    @Body() dto: SetShopAddressDto,
  ): Promise<ShopProfileDto> {
    return this.shopService.setAddress(shopId, dto);
  }

  @Post('address/reverse-geocode')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suggest an address for a location (best effort)',
    description: 'Rate limited to 10 lookups per minute per shop. Nothing is saved.',
  })
  @ApiOkResponse({ type: ReverseGeocodeResponseDto })
  @ApiBadRequestResponse({ description: 'Latitude or longitude out of range' })
  @ApiNotFoundResponse({ description: 'No address found for this location' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiBadGatewayResponse({ description: 'Geocoding provider failed or timed out' })
  @ApiServiceUnavailableResponse({ description: 'Geocoding is not configured' })
  reverseGeocode(
    @CurrentShopId() shopId: string,
    @Body() dto: ReverseGeocodeDto,
  ): Promise<ReverseGeocodeResponseDto> {
    return this.shopService.reverseGeocode(shopId, dto);
  }
}
