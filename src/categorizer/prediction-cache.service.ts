import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '@/redis/redis.service';
import type { Prediction } from './categorizer.service';

const KEY_PREFIX = 'ml:predict:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600; // 30 days
const BAD_ACCURACY_REJECTED_THRESHOLD = 3;
const BAD_ACCURACY_ACCEPTED_ZERO = 0;

export interface CacheEntry {
  prediction: Prediction;
  createdAt: string;
  lastUsedAt: string;
  usesCount: number;
  acceptedCount: number;
  rejectedCount: number;
  lastFeedbackAt?: string;
}

export interface PredictionWithKey {
  prediction: Prediction;
  predictionKey: string;
}

@Injectable()
export class PredictionCacheService {
  constructor(private readonly redis: RedisService) {}

  buildKey(modelVersion: string, normalizedText: string): string {
    const hash = createHash('sha1').update(normalizedText).digest('hex').slice(0, 16);
    return `${KEY_PREFIX}${modelVersion}:${hash}`;
  }

  private parseEntry(raw: string): CacheEntry | null {
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async getPrediction(redisKey: string): Promise<CacheEntry | null> {
    const raw = await this.redis.get(redisKey);
    if (!raw) return null;
    return this.parseEntry(raw);
  }

  async setPrediction(
    redisKey: string,
    prediction: Prediction,
    ttlSeconds: number = DEFAULT_TTL_SEC,
  ): Promise<void> {
    const now = new Date().toISOString();
    const entry: CacheEntry = {
      prediction,
      createdAt: now,
      lastUsedAt: now,
      usesCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
    };
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async touchPrediction(redisKey: string, ttlSeconds: number = DEFAULT_TTL_SEC): Promise<void> {
    const raw = await this.redis.get(redisKey);
    if (!raw) return;
    const entry = this.parseEntry(raw);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    entry.usesCount = (entry.usesCount || 0) + 1;
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async updateFeedback(redisKey: string, isAccepted: boolean): Promise<void> {
    const raw = await this.redis.get(redisKey);
    if (!raw) return;
    const entry = this.parseEntry(raw);
    if (!entry) return;
    const now = new Date().toISOString();
    entry.lastFeedbackAt = now;
    entry.usesCount = (entry.usesCount || 0) + 1;
    if (isAccepted) {
      entry.acceptedCount = (entry.acceptedCount || 0) + 1;
    } else {
      entry.rejectedCount = (entry.rejectedCount || 0) + 1;
    }
    const ttl = await this.redis.ttl(redisKey);
    await this.redis.set(redisKey, JSON.stringify(entry), ttl > 0 ? ttl : DEFAULT_TTL_SEC);
  }

  /** Returns true if cache entry should be trusted (use cache, don't call ML). */
  isGoodQuality(entry: CacheEntry): boolean {
    const accepted = entry.acceptedCount ?? 0;
    const rejected = entry.rejectedCount ?? 0;
    const total = accepted + rejected;
    if (total === 0) return false;
    if (accepted >= 3) {
      const accuracy = accepted / total;
      return accuracy >= 0.7;
    }
    return false;
  }

  /** Returns true if entry is known bad (invalidate or always refresh from ML). */
  isBadQuality(entry: CacheEntry): boolean {
    const rejected = entry.rejectedCount ?? 0;
    const accepted = entry.acceptedCount ?? 0;
    return rejected >= BAD_ACCURACY_REJECTED_THRESHOLD && accepted === BAD_ACCURACY_ACCEPTED_ZERO;
  }

  async deletePrediction(redisKey: string): Promise<void> {
    await this.redis.del(redisKey);
  }

  async flushCacheByPrefix(prefix: string): Promise<number> {
    const keys = await this.redis.keys(prefix);
    const client = this.redis.getClient();
    if (!client || keys.length === 0) return 0;
    await Promise.all(keys.map((k) => this.redis.del(k)));
    return keys.length;
  }
}
