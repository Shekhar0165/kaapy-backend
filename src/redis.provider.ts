import { Redis } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const redisProvider = {
  provide: REDIS_CLIENT,
  useFactory: () => {
    if (process.env.NODE_ENV === 'test' || !process.env.REDIS_URL) {
      return null;
    }

    return new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
  },
};
