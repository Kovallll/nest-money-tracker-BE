import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { retry, throwError, timer } from 'rxjs';
import { AxiosError } from 'axios';
import { PredictionCacheService } from './prediction-cache.service';

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

@Injectable()
export class CategorizerService {
  private readonly logger = new Logger(CategorizerService.name);
  private readonly baseUrl: string;
  private modelVersion: string = 'default';
  private modelVersionAt: number = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly predictionCache: PredictionCacheService,
  ) {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8080';
    this.logger.log(`HTTP ML сервис: ${this.baseUrl}`);
  }

  private normalizeText(text: string): string {
    return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
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
          if (err?.response?.status === 429) {
            this.logger.warn('ML 429, повтор через 3с...');
            return timer(3000);
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

  async predict(text: string): Promise<PredictionResponse> {
    const keyText = this.normalizeText(text);
    if (!keyText) {
      throw new HttpException('Пустой текст для предсказания', HttpStatus.BAD_REQUEST);
    }

    const modelVersion = await this.getModelVersion();
    const redisKey = this.predictionCache.buildKey(modelVersion, keyText);

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
      const prediction = await this.callMlPredict(text);
      await this.predictionCache.setPrediction(redisKey, prediction, CACHE_TTL_SEC);
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
}
