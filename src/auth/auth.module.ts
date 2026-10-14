import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { RedisModule } from '../redis/redis.module.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { Shop, ShopSchema } from '../shop/schemas/shop.schema.js';
import { AuthController } from './auth.controller.js';
import { EmailService } from './email.service.js';
import { AuthService } from './auth.service.js';
import { SessionModule } from './session.module.js';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    SessionModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    MongooseModule.forFeature([{ name: Shop.name, schema: ShopSchema }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailService, JwtAuthGuard],
})
export class AuthModule {}
