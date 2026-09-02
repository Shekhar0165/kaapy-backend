import { Module } from '@nestjs/common';
import { redisProvider } from '../redis.provider.js';
import { RedisService } from './redis.service.js';

@Module({
  providers: [redisProvider, RedisService],
  exports: [RedisService],
})
export class RedisModule {}