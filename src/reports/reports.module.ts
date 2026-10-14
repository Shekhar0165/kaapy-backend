import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionModule } from '../auth/session.module.js';
import { Customer, CustomerSchema } from '../customer/schemas/customer.schema.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { Transaction, TransactionSchema } from '../transaction/schemas/transaction.schema.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [
    ConfigModule,
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
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService, JwtAuthGuard],
})
export class ReportsModule {}
