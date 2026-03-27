import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  getClient(): Redis | null {
    if (this.client) return this.client;
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set, Redis disabled');
      return null;
    }
    try {
      this.client = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
        lazyConnect: true,
      });
      this.client.on('error', (err) => this.logger.error('Redis error:', err.message));
      this.client.on('connect', () => this.logger.log('Redis connected'));
      return this.client;
    } catch (e) {
      this.logger.warn('Redis init failed:', (e as Error).message);
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async get(key: string): Promise<string | null> {
    const redis = this.getClient();
    if (!redis) return null;
    try {
      return await redis.get(key);
    } catch (e) {
      this.logger.warn('Redis get failed:', (e as Error).message);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const redis = this.getClient();
    if (!redis) return;
    try {
      if (ttlSeconds != null) {
        await redis.setex(key, ttlSeconds, value);
      } else {
        await redis.set(key, value);
      }
    } catch (e) {
      this.logger.warn('Redis set failed:', (e as Error).message);
    }
  }

  async ttl(key: string): Promise<number> {
    const redis = this.getClient();
    if (!redis) return -2;
    try {
      return await redis.ttl(key);
    } catch (e) {
      this.logger.warn('Redis ttl failed:', (e as Error).message);
      return -2;
    }
  }

  async del(key: string): Promise<void> {
    const redis = this.getClient();
    if (!redis) return;
    try {
      await redis.del(key);
    } catch (e) {
      this.logger.warn('Redis del failed:', (e as Error).message);
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    const redis = this.getClient();
    if (!redis) return;
    try {
      await redis.expire(key, seconds);
    } catch (e) {
      this.logger.warn('Redis expire failed:', (e as Error).message);
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const redis = this.getClient();
    if (!redis) return {};
    try {
      const raw = await redis.hgetall(key);
      return raw ?? {};
    } catch (e) {
      this.logger.warn('Redis hgetall failed:', (e as Error).message);
      return {};
    }
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const redis = this.getClient();
    if (!redis) return;
    try {
      await redis.hset(key, field, value);
    } catch (e) {
      this.logger.warn('Redis hset failed:', (e as Error).message);
    }
  }

  async hmset(key: string, obj: Record<string, string>): Promise<void> {
    const redis = this.getClient();
    if (!redis) return;
    try {
      const args: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        args.push(k, v);
      }
      if (args.length) await redis.hset(key, ...args);
    } catch (e) {
      this.logger.warn('Redis hmset failed:', (e as Error).message);
    }
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const redis = this.getClient();
    if (!redis) return 0;
    try {
      return await redis.hincrby(key, field, increment);
    } catch (e) {
      this.logger.warn('Redis hincrby failed:', (e as Error).message);
      return 0;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    const redis = this.getClient();
    if (!redis) return [];
    try {
      return await redis.keys(pattern);
    } catch (e) {
      this.logger.warn('Redis keys failed:', (e as Error).message);
      return [];
    }
  }
}
