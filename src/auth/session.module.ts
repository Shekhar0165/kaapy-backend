import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [RedisModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
