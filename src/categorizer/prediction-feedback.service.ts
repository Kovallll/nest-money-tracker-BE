import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { PredictionCacheService } from './prediction-cache.service';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import type { CategorizerMetrics } from './categorizer.service';

@Injectable()
export class PredictionFeedbackService implements OnModuleInit {
  constructor(
    private readonly predictionCache: PredictionCacheService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS categorizer_feedback (
        id BIGSERIAL PRIMARY KEY,
        prediction_key TEXT NOT NULL,
        predicted_category_id TEXT,
        actual_category_id TEXT,
        is_accepted BOOLEAN NOT NULL,
        user_id UUID NULL,
        room_id UUID NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS idx_categorizer_feedback_created_at ON categorizer_feedback(created_at DESC)',
    );
  }

  /**
   * Records whether the user accepted the prediction (chose the predicted category) or rejected it.
   * Call after transaction create/update when predictionKey and predictedCategoryId were sent.
   */
  async recordFeedback(
    predictionKey: string,
    predictedCategoryId: string,
    actualCategoryId: string | null,
    context: { userId?: string; roomId?: string } = {},
  ): Promise<void> {
    if (!predictionKey?.trim()) return;
    const normalizedPredicted = String(predictedCategoryId ?? '').trim();
    const normalizedActual = actualCategoryId != null ? String(actualCategoryId).trim() : null;
    const isAccepted =
      normalizedPredicted.length > 0 &&
      normalizedActual != null &&
      normalizedPredicted === normalizedActual;
    await this.predictionCache.updateFeedback(predictionKey, isAccepted);
    await this.pool.query(
      `INSERT INTO categorizer_feedback (
        prediction_key, predicted_category_id, actual_category_id, is_accepted, user_id, room_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        predictionKey,
        normalizedPredicted || null,
        normalizedActual,
        isAccepted,
        context.userId ?? null,
        context.roomId ?? null,
      ],
    );
  }

  async getMetrics(periodDays: number = 30): Promise<CategorizerMetrics> {
    const days = Math.max(1, Math.floor(periodDays));
    const { rows } = await this.pool.query<{
      total: string;
      accepted: string;
      rejected: string;
      unknown: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE is_accepted = true)::text AS accepted,
         COUNT(*) FILTER (WHERE is_accepted = false)::text AS rejected,
         COUNT(*) FILTER (WHERE predicted_category_id IS NULL OR predicted_category_id = '')::text AS unknown
       FROM categorizer_feedback
       WHERE created_at >= NOW() - ($1::text || ' days')::interval`,
      [days],
    );
    const total = Number(rows[0]?.total ?? 0);
    const accepted = Number(rows[0]?.accepted ?? 0);
    const rejected = Number(rows[0]?.rejected ?? 0);
    const unknown = Number(rows[0]?.unknown ?? 0);
    return {
      periodDays: days,
      total,
      accepted,
      rejected,
      unknown,
      acceptanceRate: total > 0 ? accepted / total : 0,
      unknownRate: total > 0 ? unknown / total : 0,
    };
  }
}
