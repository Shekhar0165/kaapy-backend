import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionModule } from '../auth/session.module.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { CustomerController } from './customer.controller.js';
import { CustomerService } from './customer.service.js';
import { Customer, CustomerSchema } from './schemas/customer.schema.js';

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
    MongooseModule.forFeature([{ name: Customer.name, schema: CustomerSchema }]),
  ],
  controllers: [CustomerController],
  providers: [CustomerService, JwtAuthGuard],
})
export class CustomerModule {}
