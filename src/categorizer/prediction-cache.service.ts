import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(PredictionCacheService.name);

  constructor(private readonly redis: RedisService) {}

  buildKey(
    modelVersion: string,
    normalizedText: string,
    context: { userId?: string; roomId?: string } = {},
  ): string {
    const scope = [context.userId || 'anon', context.roomId || 'global'].join(':');
    const hash = createHash('sha1').update(normalizedText).digest('hex').slice(0, 16);
    return `${KEY_PREFIX}${modelVersion}:${scope}:${hash}`;
  }

  private parseEntry(raw: string): CacheEntry | null {
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  private getHistoricalPattern(redisKey: string): string | null {
    const parts = redisKey.split(':');
    // New format: ml:predict:{modelVersion}:{userId}:{roomId}:{hash}
    if (parts.length >= 6 && parts[0] === 'ml' && parts[1] === 'predict') {
      const userId = parts[parts.length - 3];
      const roomId = parts[parts.length - 2];
      const hash = parts[parts.length - 1];
      return `${KEY_PREFIX}*:${userId}:${roomId}:${hash}`;
    }
    // Legacy format: ml:predict:{modelVersion}:{hash}
    if (parts.length >= 4 && parts[0] === 'ml' && parts[1] === 'predict') {
      const hash = parts[parts.length - 1];
      return `${KEY_PREFIX}*:${hash}`;
    }
    return null;
  }

  /**
   * Тот же текст+скоуп могут иметь разные ключи при смене model_version.
   * Для feedback нужен ключ, который реально есть в Redis.
   */
  private async resolveKeyForFeedback(redisKey: string): Promise<string | null> {
    const direct = await this.redis.get(redisKey);
    if (direct) return redisKey;

    const pattern = this.getHistoricalPattern(redisKey);
    const client = this.redis.getClient();
    if (!pattern || !client) return null;

    let cursor = '0';
    let bestKey: string | null = null;
    let bestScore = -1;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const k of keys) {
        const raw = await this.redis.get(k);
        if (!raw) continue;
        const e = this.parseEntry(raw);
        if (!e) continue;
        const score = (e.acceptedCount ?? 0) + (e.rejectedCount ?? 0) + (e.usesCount ?? 0);
        if (score > bestScore) {
          bestScore = score;
          bestKey = k;
        }
      }
    } while (cursor !== '0');

    return bestKey;
  }

  /** Все записи по тому же тексту+скоупу (включая текущий redisKey), чтобы не терять счётчики при перезаписи prediction. */
  private async gatherAllEntriesForIdentity(redisKey: string): Promise<CacheEntry[]> {
    const pattern = this.getHistoricalPattern(redisKey);
    const client = this.redis.getClient();
    if (!pattern || !client) return [];
    const out: CacheEntry[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const e = this.parseEntry(raw);
        if (e) out.push(e);
      }
    } while (cursor !== '0');
    return out;
  }

  /** Берём максимум по счётчикам между всеми «близнецами» ключа (один текст, разные model_version и т.д.). */
  private mergeCountersMax(entries: CacheEntry[]): {
    usesCount: number;
    acceptedCount: number;
    rejectedCount: number;
    lastFeedbackAt?: string;
    createdAt: string;
  } {
    const now = new Date().toISOString();
    if (entries.length === 0) {
      return {
        usesCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        createdAt: now,
      };
    }
    let usesCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let lastFeedbackAt: string | undefined;
    let createdAt = entries[0].createdAt ?? now;
    for (const e of entries) {
      usesCount = Math.max(usesCount, e.usesCount ?? 0);
      acceptedCount = Math.max(acceptedCount, e.acceptedCount ?? 0);
      rejectedCount = Math.max(rejectedCount, e.rejectedCount ?? 0);
      const fb = e.lastFeedbackAt;
      if (fb && (!lastFeedbackAt || fb > lastFeedbackAt)) lastFeedbackAt = fb;
      const c = e.createdAt ?? '';
      if (c && c < createdAt) createdAt = c;
    }
    return { usesCount, acceptedCount, rejectedCount, lastFeedbackAt, createdAt };
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
    const all = await this.gatherAllEntriesForIdentity(redisKey);
    const merged = this.mergeCountersMax(all);
    const entry: CacheEntry = {
      prediction,
      createdAt: merged.createdAt,
      lastUsedAt: now,
      usesCount: merged.usesCount,
      acceptedCount: merged.acceptedCount,
      rejectedCount: merged.rejectedCount,
      lastFeedbackAt: merged.lastFeedbackAt,
    };
    this.logger.log(
      `setPrediction key=${redisKey} sources=${all.length} usesCount=${merged.usesCount} acceptedCount=${merged.acceptedCount} rejectedCount=${merged.rejectedCount}`,
    );
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async touchPrediction(redisKey: string, ttlSeconds: number = DEFAULT_TTL_SEC): Promise<void> {
    const raw = await this.redis.get(redisKey);
    if (!raw) return;
    const entry = this.parseEntry(raw);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    entry.usesCount = (entry.usesCount || 0) + 1;
    this.logger.log(
      `touchPrediction key=${redisKey} usesCount=${entry.usesCount} acceptedCount=${entry.acceptedCount ?? 0} rejectedCount=${entry.rejectedCount ?? 0}`,
    );
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async updateFeedback(redisKey: string, isAccepted: boolean): Promise<void> {
    const resolvedKey = await this.resolveKeyForFeedback(redisKey);
    if (!resolvedKey) return;

    const raw = await this.redis.get(resolvedKey);
    if (!raw) return;
    const entry = this.parseEntry(raw);
    if (!entry) return;
    const now = new Date().toISOString();
    entry.lastFeedbackAt = now;
    /** Одно сохранение транзакции = одно использование предикта для feedback (не путать с touchPrediction). */
    entry.usesCount = (entry.usesCount || 0) + 1;
    if (isAccepted) {
      entry.acceptedCount = (entry.acceptedCount || 0) + 1;
    } else {
      entry.rejectedCount = (entry.rejectedCount || 0) + 1;
    }
    this.logger.log(
      `updateFeedback key=${resolvedKey} requestedKey=${redisKey} isAccepted=${isAccepted} usesCount=${entry.usesCount} acceptedCount=${entry.acceptedCount} rejectedCount=${entry.rejectedCount}`,
    );
    const ttl = await this.redis.ttl(resolvedKey);
    await this.redis.set(resolvedKey, JSON.stringify(entry), ttl > 0 ? ttl : DEFAULT_TTL_SEC);
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
    const client = this.redis.getClient();
    if (!client) return 0;
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', prefix, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        await client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    return deleted;
  }
}
