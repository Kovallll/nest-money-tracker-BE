import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

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

interface PredictResponse {
  success: boolean;
  primary?: PredictionResult;
  alternatives?: PredictionResult[];
  needs_confirmation?: boolean;
  source?: string;
  error?: string;
  is_training?: boolean;
}

@Injectable()
export class CategorizerService {
  private readonly logger = new Logger(CategorizerService.name);
  private readonly baseUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8080';
    this.logger.log(`HTTP ML сервис: ${this.baseUrl}`);
  }

  private handleError(error: AxiosError, context: string): never {
    this.logger.error(`${context}: ${error.message}`);

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

  async predict(text: string): Promise<Prediction> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<PredictResponse>(`${this.baseUrl}/predict`, { text }),
      );

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
