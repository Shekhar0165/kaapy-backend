import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionModule } from '../auth/session.module.js';
import { GeocodingModule } from '../geocoding/geocoding.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ShopController } from './shop.controller.js';
import { ShopService } from './shop.service.js';
import { Shop, ShopSchema } from './schemas/shop.schema.js';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    SessionModule,
    GeocodingModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    MongooseModule.forFeature([{ name: Shop.name, schema: ShopSchema }]),
  ],
  controllers: [ShopController],
  providers: [ShopService, JwtAuthGuard],
})
export class ShopModule {}
