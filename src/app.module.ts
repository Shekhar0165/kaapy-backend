import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { createObserveModule } from '@nestjs/observe';
import Joi from 'joi';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CustomerModule } from './customer/customer.module.js';
import { TransactionModule } from './transaction/transaction.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { HealthController } from './health.controller.js';
import { redisProvider } from './redis.provider.js';
import { ShopModule } from './shop/shop.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

/**
 * Observe runs only with real credentials. Read after ConfigModule.forRoot has
 * loaded .env (it is evaluated first in the imports below, and main.ts calls
 * this after importing AppModule).
 */
export function isObserveEnabled(): boolean {
  return Boolean(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET);
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        GOOGLE_WEB_CLIENT_ID: Joi.string().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES_IN: Joi.string().required(),
      }),
    }),
    ...(process.env.NODE_ENV === 'test' ? [] : [AuthModule, ShopModule, CustomerModule, TransactionModule, ReportsModule]),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    ...(process.env.NODE_ENV === 'test'
      ? []
      : [
          MongooseModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
              uri: config.getOrThrow<string>('MONGO_URI'),
            }),
          }),
        ]),
    // NestJS Observe (tracing, metrics, error telemetry): only when real credentials
    // from https://observe.nestjs.com are set. Without them the collector rejects
    // every batch with 401, so the module is left out entirely.
    ...(isObserveEnabled()
      ? [
          ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY as string,
            appSecret: process.env.OBSERVE_APP_SECRET as string,
            serviceId: 'kaapy',
          }),
        ]
      : []),
  ],
  controllers: [AppController, HealthController],
  providers: [AppService, redisProvider],
})
export class AppModule {}
