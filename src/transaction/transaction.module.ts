import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionModule } from '../auth/session.module.js';
import { Customer, CustomerSchema } from '../customer/schemas/customer.schema.js';
import { RedisModule } from '../redis/redis.module.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { Shop, ShopSchema } from '../shop/schemas/shop.schema.js';
import { NotificationController } from './notification.controller.js';
import { NotificationEmailService } from './notification-email.service.js';
import { NotificationService } from './notification.service.js';
import { Transaction, TransactionSchema } from './schemas/transaction.schema.js';
import { TransactionController } from './transaction.controller.js';
import { TransactionService } from './transaction.service.js';

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
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: Shop.name, schema: ShopSchema },
    ]),
  ],
  controllers: [TransactionController, NotificationController],
  providers: [TransactionService, NotificationService, NotificationEmailService, JwtAuthGuard],
})
export class TransactionModule {}
