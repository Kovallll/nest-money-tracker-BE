import { Inject, Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Pool } from 'pg';
import { firstValueFrom } from 'rxjs';
import { retry, throwError, timer } from 'rxjs';
import { AxiosError } from 'axios';
import { PG_POOL } from '@/pg/pg.module';
import { PredictionCacheService } from './prediction-cache.service';
import { PredictionFeedbackService } from './prediction-feedback.service';

export interface PredictionResult {
  category_id: string;
  category_name: string;
  category_icon: string;
  category_color: string;
  confidence: number;
}

export interface Prediction {
  primary: PredictionResult;
  alternatives: PredictionResult[];
  needs_confirmation: boolean;
  source: string;
}

export interface PredictionContext {
  userId?: string;
  roomId?: string;
}

export interface CategorizerMetrics {
  periodDays: number;
  total: number;
  accepted: number;
  rejected: number;
  unknown: number;
  acceptanceRate: number;
  unknownRate: number;
}

/** Response of predict(): prediction + predictionKey for feedback when user creates a transaction. */
export interface PredictionResponse extends Prediction {
  predictionKey: string;
}

interface PredictResponse {
  success: boolean;
  primary?: PredictionResult;
  alternatives?: PredictionResult[];
  needs_confirmation?: boolean;
  source?: string;
  error?: string;
  is_training?: boolean;
}

const MODEL_VERSION_REFRESH_MS = 5 * 60 * 1000; // 5 min
const CACHE_TTL_SEC = 30 * 24 * 3600; // 30 days
/** Короткий TTL, если после ML+лексикона категория так и не определена — чтобы не «залипало» Неизвестно на месяцы. */
const CACHE_TTL_UNKNOWN_SEC = 5 * 60; // 5 min

@Injectable()
export class CategorizerService {
  private readonly logger = new Logger(CategorizerService.name);
  private readonly baseUrl: string;
  private modelVersion: string = 'default';
  private modelVersionAt: number = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly predictionCache: PredictionCacheService,
    private readonly predictionFeedback: PredictionFeedbackService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8080';
    this.logger.log(`HTTP ML сервис: ${this.baseUrl}`);
  }

  /** Нормализация для ключа кэша и лексикона: Unicode NFKC, ё→е, регистр, пробелы. */
  private normalizeText(text: string): string {
    return (text ?? '')
      .normalize('NFKC')
      .replace(/ё/gi, 'е')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private handleError(error: AxiosError, context: string): never {
    this.logger.error(`${context}: ${error.message}`);

    if (error.response?.status === 429) {
      throw new HttpException(
        'Слишком много запросов к сервису категоризации. Повторите через несколько секунд.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (error.response?.status === 503) {
      throw new HttpException('Модель обучается, подождите', HttpStatus.SERVICE_UNAVAILABLE);
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      this.logger.warn('ML сервис недоступен, будет использован fallback');
      throw new HttpException('ML сервис недоступен', HttpStatus.SERVICE_UNAVAILABLE);
    }

    throw new HttpException(
      error.response?.data || 'Ошибка ML сервиса',
      error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private async getModelVersion(): Promise<string> {
    const now = Date.now();
    if (now - this.modelVersionAt < MODEL_VERSION_REFRESH_MS) {
      return this.modelVersion;
    }
    try {
      const data = await this.getModelInfo();
      if (data?.model_version) {
        this.modelVersion = String(data.model_version);
        this.modelVersionAt = now;
      }
    } catch {
      // keep previous or 'default'
    }
    return this.modelVersion;
  }

  private async callMlPredict(text: string): Promise<Prediction> {
    const source$ = this.httpService.post<PredictResponse>(`${this.baseUrl}/predict`, { text }).pipe(
      retry({
        count: 2,
        delay: (err: AxiosError) => {
          const status = err?.response?.status;
          const code = err?.code;
          if (status === 429) {
            this.logger.warn('ML 429, повтор через 3с...');
            return timer(3000);
          }
          if (status != null && status >= 500) {
            this.logger.warn(`ML ${status}, повтор через 1.5с...`);
            return timer(1500);
          }
          if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
            this.logger.warn(`ML ${code}, повтор через 1.5с...`);
            return timer(1500);
          }
          return throwError(() => err);
        },
      }),
    );
    const { data } = await firstValueFrom(source$);
    if (!data.success) {
      throw new HttpException(data.error || 'Ошибка предсказания', HttpStatus.BAD_REQUEST);
    }
    if (!data.primary) {
      throw new HttpException('Нет результата предсказания', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return {
      primary: data.primary,
      alternatives: data.alternatives || [],
      needs_confirmation: data.needs_confirmation ?? true,
      source: data.source || 'fasttext',
    };
  }

  private sanitizePrediction(prediction: Prediction): Prediction {
    const normalized = {
      ...prediction,
      primary: {
        ...prediction.primary,
        category_id: String(prediction.primary?.category_id ?? '').trim(),
      },
      alternatives: (prediction.alternatives ?? []).map((p) => ({
        ...p,
        category_id: String(p?.category_id ?? '').trim(),
      })),
    };

    const unknownPrimary =
      !normalized.primary.category_id ||
      !normalized.primary.category_name ||
      normalized.primary.category_name === 'Неизвестно' ||
      normalized.primary.category_name === 'unknown';

    if (!unknownPrimary) return normalized;
    return {
      ...normalized,
      needs_confirmation: true,
      primary: {
        ...normalized.primary,
        category_id: '',
        category_name: 'Неизвестно',
        category_icon: normalized.primary.category_icon || '❓',
        category_color: normalized.primary.category_color || '#CCCCCC',
        confidence: Math.min(Number(normalized.primary.confidence || 0), 0.49),
      },
    };
  }

  /**
   * Если ML не уверен: ищем категорию по совпадению названия с текстом транзакции (личные / комната / шаблоны).
   */
  private async enrichUnknownWithLexicon(
    text: string,
    context: PredictionContext,
    prediction: Prediction,
  ): Promise<Prediction> {
    if (prediction.primary?.category_id) return prediction;
    const hit = await this.lookupCategoryLexicon(text, context);
    if (!hit) return prediction;
    return {
      ...prediction,
      primary: hit,
      source: 'lexicon',
      needs_confirmation: true,
    };
  }

  private rowToLexiconResult(row: {
    id: string;
    name: string;
    icon: string | null;
    color: string | null;
  }): PredictionResult {
    return {
      category_id: String(row.id),
      category_name: row.name,
      category_icon: row.icon?.trim() || 'category',
      category_color: row.color?.trim() || '#CCCCCC',
      confidence: 0.62,
    };
  }

  /** То же, что normalizeText на стороне SQL для c.name (ё/Е → е, lower, trim). */
  private static readonly LEXICON_CAT_NORM = `replace(lower(trim(c.name)), 'ё', 'е')`;

  /** Совпадение названия категории с текстом: подстроки + общий префикс (склонения: одежда / одежды). */
  private static readonly LEXICON_NAME_MATCH_SQL = `(
               ${CategorizerService.LEXICON_CAT_NORM} = $norm
               OR ${CategorizerService.LEXICON_CAT_NORM} LIKE '%' || $norm || '%'
               OR $norm LIKE '%' || ${CategorizerService.LEXICON_CAT_NORM} || '%'
               OR (
                 char_length($norm) >= 4
                 AND char_length(trim(c.name)) >= 4
                 AND left(${CategorizerService.LEXICON_CAT_NORM}, 4) = left($norm, 4)
               )
             )`;

  /** Полная фраза и отдельные слова (длиной ≥3) — чтобы «магазин одежды» нашёл категорию «Одежда». */
  private lexiconSearchTerms(normalizedPhrase: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (t: string) => {
      const s = t.trim();
      if (s.length < 2 || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    push(normalizedPhrase);
    for (const w of normalizedPhrase.split(/\s+/)) {
      if (w.length >= 3) push(w);
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  private async lookupLexiconForTerm(
    term: string,
    roomId: string | undefined,
    userId: string | undefined,
  ): Promise<PredictionResult | null> {
    const matchSql = CategorizerService.LEXICON_NAME_MATCH_SQL.replaceAll('$norm', '$2');

    if (roomId) {
      const roomRes = await this.pool.query<{
        id: string;
        name: string;
        icon: string | null;
        color: string | null;
      }>(
        `SELECT c.id, c.name, c.icon, c.color
         FROM categories c
         WHERE c.group_room_id = $1::uuid
           AND COALESCE(c.is_archived, false) = false
           AND ${matchSql}
         ORDER BY
           CASE WHEN ${CategorizerService.LEXICON_CAT_NORM} = $2 THEN 0 ELSE 1 END,
           length(trim(c.name))
         LIMIT 1`,
        [roomId, term],
      );
      if (roomRes.rows[0]) return this.rowToLexiconResult(roomRes.rows[0]);

      const globalRes = await this.pool.query<{
        id: string;
        name: string;
        icon: string | null;
        color: string | null;
      }>(
        `SELECT c.id, c.name, c.icon, c.color
         FROM categories c
         WHERE c.group_room_id IS NULL
           AND c.user_id IS NULL
           AND COALESCE(c.is_archived, false) = false
           AND ${matchSql.replaceAll('$2', '$1')}
         ORDER BY
           CASE WHEN ${CategorizerService.LEXICON_CAT_NORM} = $1 THEN 0 ELSE 1 END,
           length(trim(c.name))
         LIMIT 1`,
        [term],
      );
      if (globalRes.rows[0]) return this.rowToLexiconResult(globalRes.rows[0]);
      return null;
    }

    if (!userId) return null;

    const personalRes = await this.pool.query<{
      id: string;
      name: string;
      icon: string | null;
      color: string | null;
    }>(
      `SELECT c.id, c.name, c.icon, c.color
       FROM categories c
       WHERE c.group_room_id IS NULL
         AND (c.user_id IS NULL OR c.user_id = $1::uuid)
         AND COALESCE(c.is_archived, false) = false
         AND ${matchSql}
       ORDER BY
         CASE WHEN c.user_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE WHEN ${CategorizerService.LEXICON_CAT_NORM} = $2 THEN 0 ELSE 1 END,
         length(trim(c.name))
       LIMIT 1`,
      [userId, term],
    );
    if (personalRes.rows[0]) return this.rowToLexiconResult(personalRes.rows[0]);
    return null;
  }

  private async lookupCategoryLexicon(
    text: string,
    context: PredictionContext,
  ): Promise<PredictionResult | null> {
    const exact = this.normalizeText(text);
    if (exact.length < 2) return null;

    const roomId = context.roomId?.trim() || undefined;
    const userId = context.userId?.trim() || undefined;

    try {
      for (const term of this.lexiconSearchTerms(exact)) {
        const hit = await this.lookupLexiconForTerm(term, roomId, userId);
        if (hit) return hit;
      }
      return null;
    } catch (err) {
      this.logger.warn(`lookupCategoryLexicon: ${(err as Error).message}`);
      return null;
    }
  }

  async predict(text: string, context: PredictionContext = {}): Promise<PredictionResponse> {
    const keyText = this.normalizeText(text);
    if (!keyText) {
      throw new HttpException('Пустой текст для предсказания', HttpStatus.BAD_REQUEST);
    }

    const modelVersion = await this.getModelVersion();
    const redisKey = this.predictionCache.buildKey(modelVersion, keyText, {
      userId: context.userId,
      roomId: context.roomId,
    });

    const cached = await this.predictionCache.getPrediction(redisKey);
    if (cached) {
      if (this.predictionCache.isBadQuality(cached)) {
        await this.predictionCache.deletePrediction(redisKey);
      } else if (this.predictionCache.isGoodQuality(cached)) {
        await this.predictionCache.touchPrediction(redisKey, CACHE_TTL_SEC);
        return { ...cached.prediction, predictionKey: redisKey };
      }
    }

    try {
      let prediction = this.sanitizePrediction(await this.callMlPredict(text));
      prediction = await this.enrichUnknownWithLexicon(text, context, prediction);
      const outcome = prediction.primary.category_id ? 'known' : 'unknown';
      this.logger.log(`categorizer.predict outcome=${outcome} source=${prediction.source}`);
      const ttl = prediction.primary.category_id ? CACHE_TTL_SEC : CACHE_TTL_UNKNOWN_SEC;
      await this.predictionCache.setPrediction(redisKey, prediction, ttl);
      return { ...prediction, predictionKey: redisKey };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.handleError(error as AxiosError, 'Ошибка предсказания');
    }
  }

  async forceRetrain(full: boolean = false): Promise<any> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/retrain`, { full }),
      );
      return data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.handleError(error as AxiosError, 'Force retrain failed');
    }
  }

  async getStatus(): Promise<any> {
    try {
      const { data } = await firstValueFrom(this.httpService.get(`${this.baseUrl}/status`));
      return data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.handleError(error as AxiosError, 'Ошибка получения статуса');
    }
  }

  async getModelInfo(): Promise<any> {
    try {
      const { data } = await firstValueFrom(this.httpService.get(`${this.baseUrl}/model-info`));
      return data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.handleError(error as AxiosError, 'Ошибка получения информации о модели');
    }
  }

  async getCategories(): Promise<any> {
    try {
      const { data } = await firstValueFrom(this.httpService.get(`${this.baseUrl}/categories`));
      return data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.handleError(error as AxiosError, 'Ошибка получения категорий');
    }
  }

  async getMetrics(periodDays: number = 30): Promise<CategorizerMetrics> {
    return this.predictionFeedback.getMetrics(periodDays);
  }
}
