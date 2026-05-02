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

  private keySuffix(redisKey: string): string {
    const parts = redisKey.split(':');
    return parts.slice(Math.max(0, parts.length - 3)).join(':');
  }

  private entryStats(entry: CacheEntry | null | undefined): string {
    if (!entry) return 'entry=null';
    return `uses=${entry.usesCount ?? 0} accepted=${entry.acceptedCount ?? 0} rejected=${entry.rejectedCount ?? 0} lastFeedbackAt=${entry.lastFeedbackAt ?? '-'} primaryId=${entry.prediction?.primary?.category_id ?? ''} source=${entry.prediction?.source ?? ''}`;
  }

  buildKey(
    modelVersion: string,
    normalizedText: string,
    context: { userId?: string; roomId?: string } = {},
  ): string {
    const scope = [context.userId || 'anon', context.roomId || 'global'].join(':');
    const hash = createHash('sha1').update(normalizedText).digest('hex').slice(0, 16);
    const key = `${KEY_PREFIX}${modelVersion}:${scope}:${hash}`;
    this.logger.log(
      `[redis-cache] buildKey model=${modelVersion} scope=${scope} hash=${hash} suffix=${this.keySuffix(key)}`,
    );
    return key;
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
    this.logger.log(
      `[redis-cache] resolveKeyForFeedback start suffix=${this.keySuffix(redisKey)}`,
    );
    const direct = await this.redis.get(redisKey);
    if (direct) {
      this.logger.log(
        `[redis-cache] resolveKeyForFeedback direct-hit suffix=${this.keySuffix(redisKey)}`,
      );
      return redisKey;
    }

    const pattern = this.getHistoricalPattern(redisKey);
    const client = this.redis.getClient();
    if (!pattern || !client) {
      this.logger.warn(
        `[redis-cache] resolveKeyForFeedback no-pattern-or-client suffix=${this.keySuffix(redisKey)} pattern=${pattern ?? 'null'} client=${client ? 'yes' : 'no'}`,
      );
      return null;
    }
    this.logger.log(
      `[redis-cache] resolveKeyForFeedback scan pattern=${pattern}`,
    );

    let cursor = '0';
    let bestKey: string | null = null;
    let bestScore = -1;
    let scanned = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      scanned += keys.length;
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

    this.logger.log(
      `[redis-cache] resolveKeyForFeedback done scanned=${scanned} bestScore=${bestScore} bestSuffix=${bestKey ? this.keySuffix(bestKey) : 'none'}`,
    );
    return bestKey;
  }

  /** Все записи по тому же тексту+скоупу (включая текущий redisKey), чтобы не терять счётчики при перезаписи prediction. */
  private async gatherAllEntriesForIdentity(redisKey: string): Promise<CacheEntry[]> {
    const pattern = this.getHistoricalPattern(redisKey);
    const client = this.redis.getClient();
    if (!pattern || !client) {
      this.logger.warn(
        `[redis-cache] gatherAllEntriesForIdentity skip suffix=${this.keySuffix(redisKey)} pattern=${pattern ?? 'null'} client=${client ? 'yes' : 'no'}`,
      );
      return [];
    }
    this.logger.log(
      `[redis-cache] gatherAllEntriesForIdentity start pattern=${pattern}`,
    );
    const out: CacheEntry[] = [];
    let cursor = '0';
    let scanned = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      scanned += keys.length;
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const e = this.parseEntry(raw);
        if (e) out.push(e);
      }
    } while (cursor !== '0');
    this.logger.log(
      `[redis-cache] gatherAllEntriesForIdentity done scanned=${scanned} parsed=${out.length} suffix=${this.keySuffix(redisKey)}`,
    );
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
    this.logger.log(`[redis-cache] getPrediction suffix=${this.keySuffix(redisKey)} start`);
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      this.logger.log(`[redis-cache] getPrediction suffix=${this.keySuffix(redisKey)} miss`);
      return null;
    }
    const parsed = this.parseEntry(raw);
    if (!parsed) {
      this.logger.warn(
        `[redis-cache] getPrediction suffix=${this.keySuffix(redisKey)} parse-failed`,
      );
      return null;
    }
    this.logger.log(
      `[redis-cache] getPrediction suffix=${this.keySuffix(redisKey)} hit ${this.entryStats(parsed)}`,
    );
    return parsed;
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
      `[redis-cache] setPrediction suffix=${this.keySuffix(redisKey)} ttl=${ttlSeconds}s sources=${all.length} merged(uses=${merged.usesCount},accepted=${merged.acceptedCount},rejected=${merged.rejectedCount}) newPrimary=${prediction.primary?.category_id ?? ''} source=${prediction.source}`,
    );
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async touchPrediction(redisKey: string, ttlSeconds: number = DEFAULT_TTL_SEC): Promise<void> {
    this.logger.log(
      `[redis-cache] touchPrediction suffix=${this.keySuffix(redisKey)} ttl=${ttlSeconds}s start`,
    );
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      this.logger.log(
        `[redis-cache] touchPrediction suffix=${this.keySuffix(redisKey)} skip=missing`,
      );
      return;
    }
    const entry = this.parseEntry(raw);
    if (!entry) {
      this.logger.warn(
        `[redis-cache] touchPrediction suffix=${this.keySuffix(redisKey)} skip=parse-failed`,
      );
      return;
    }
    entry.lastUsedAt = new Date().toISOString();
    entry.usesCount = (entry.usesCount || 0) + 1;
    this.logger.log(
      `[redis-cache] touchPrediction suffix=${this.keySuffix(redisKey)} ${this.entryStats(entry)}`,
    );
    await this.redis.set(redisKey, JSON.stringify(entry), ttlSeconds);
  }

  async updateFeedback(redisKey: string, isAccepted: boolean): Promise<void> {
    this.logger.log(
      `[redis-cache] updateFeedback requestedSuffix=${this.keySuffix(redisKey)} isAccepted=${isAccepted} start`,
    );
    const resolvedKey = await this.resolveKeyForFeedback(redisKey);
    if (!resolvedKey) {
      this.logger.warn(
        `[redis-cache] updateFeedback requestedSuffix=${this.keySuffix(redisKey)} skip=resolve-failed`,
      );
      return;
    }

    const raw = await this.redis.get(resolvedKey);
    if (!raw) {
      this.logger.warn(
        `[redis-cache] updateFeedback resolvedSuffix=${this.keySuffix(resolvedKey)} skip=missing`,
      );
      return;
    }
    const entry = this.parseEntry(raw);
    if (!entry) {
      this.logger.warn(
        `[redis-cache] updateFeedback resolvedSuffix=${this.keySuffix(resolvedKey)} skip=parse-failed`,
      );
      return;
    }
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
      `[redis-cache] updateFeedback requestedSuffix=${this.keySuffix(redisKey)} resolvedSuffix=${this.keySuffix(resolvedKey)} ${this.entryStats(entry)}`,
    );
    const ttl = await this.redis.ttl(resolvedKey);
    this.logger.log(
      `[redis-cache] updateFeedback resolvedSuffix=${this.keySuffix(resolvedKey)} currentTtl=${ttl}s`,
    );
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
      const ok = accuracy >= 0.7;
      this.logger.log(
        `[redis-cache] isGoodQuality accepted=${accepted} rejected=${rejected} total=${total} accuracy=${accuracy.toFixed(3)} result=${ok}`,
      );
      return ok;
    }
    this.logger.log(
      `[redis-cache] isGoodQuality accepted=${accepted} rejected=${rejected} total=${total} accuracy=n/a result=false`,
    );
    return false;
  }

  /** Returns true if entry is known bad (invalidate or always refresh from ML). */
  isBadQuality(entry: CacheEntry): boolean {
    const rejected = entry.rejectedCount ?? 0;
    const accepted = entry.acceptedCount ?? 0;
    const bad =
      rejected >= BAD_ACCURACY_REJECTED_THRESHOLD && accepted === BAD_ACCURACY_ACCEPTED_ZERO;
    this.logger.log(
      `[redis-cache] isBadQuality accepted=${accepted} rejected=${rejected} threshold=${BAD_ACCURACY_REJECTED_THRESHOLD} result=${bad}`,
    );
    return bad;
  }

  async deletePrediction(redisKey: string): Promise<void> {
    this.logger.log(`[redis-cache] deletePrediction suffix=${this.keySuffix(redisKey)}`);
    await this.redis.del(redisKey);
  }

  async flushCacheByPrefix(prefix: string): Promise<number> {
    this.logger.log(`[redis-cache] flushCacheByPrefix start prefix=${prefix}`);
    const client = this.redis.getClient();
    if (!client) {
      this.logger.warn(`[redis-cache] flushCacheByPrefix skip=no-client prefix=${prefix}`);
      return 0;
    }
    let cursor = '0';
    let deleted = 0;
    let scanned = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', prefix, 'COUNT', 200);
      cursor = nextCursor;
      scanned += keys.length;
      if (keys.length > 0) {
        await client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    this.logger.log(
      `[redis-cache] flushCacheByPrefix done prefix=${prefix} scanned=${scanned} deleted=${deleted}`,
    );
    return deleted;
  }
}
