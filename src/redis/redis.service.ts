import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis.provider.js';

@Injectable()
export class RedisService {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  private getClient(): Redis {
    if (!this.client) {
      throw new ServiceUnavailableException('Redis is not configured');
    }

    return this.client;
  }

  get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  set(key: string, value: string, seconds?: number): Promise<'OK' | null> {
    return seconds
      ? this.getClient().set(key, value, 'EX', seconds)
      : this.getClient().set(key, value);
  }

  delete(key: string): Promise<number> {
    return this.getClient().del(key);
  }

  async increment(key: string, seconds: number): Promise<number> {
    const client = this.getClient();
    const count = await client.incr(key);

    if (count === 1) {
      await client.expire(key, seconds);
    }

    return count;
  }
}