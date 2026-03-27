import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Pool } from 'pg';
import { firstValueFrom } from 'rxjs';
import FormData = require('form-data');
import { PG_POOL } from '@/pg/pg.module';

export type OcrLineDto = { text: string; confidence: number; box: number[][] };

export type OcrResponseDto = {
  full_text: string;
  lines: OcrLineDto[];
  meta?: { elapsed_ms?: number; line_count?: number; lang?: string };
};

@Injectable()
export class ReceiptOcrService {
  private readonly logger = new Logger(ReceiptOcrService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly http: HttpService,
  ) {}

  private ocrBaseUrl(): string {
    const raw = process.env.OCR_SERVICE_URL?.trim();
    if (!raw) {
      throw new ServiceUnavailableException(
        'OCR_SERVICE_URL не задан. Подключите сервис ocr-service (см. docker-compose).',
      );
    }
    return raw.replace(/\/$/, '');
  }

  async runOcrOnBuffer(params: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  }): Promise<OcrResponseDto> {
    const fileName = params.originalname || 'receipt.jpg';
    const form = new FormData();
    form.append('file', params.buffer, {
      filename: fileName,
      contentType: params.mimetype || 'application/octet-stream',
    });

    const headers: Record<string, string> = { ...form.getHeaders() } as Record<string, string>;
    const ocrSecret = process.env.OCR_INTERNAL_API_KEY?.trim();
    if (ocrSecret) {
      headers['X-OCR-Internal-Key'] = ocrSecret;
    }

    const url = `${this.ocrBaseUrl()}/ocr`;
    const started = Date.now();

    try {
      type OcrErrBody = { error?: string; message?: string };
      const res = await firstValueFrom(
        this.http.post<OcrResponseDto | OcrErrBody>(url, form, {
          headers,
          timeout: 120_000,
          maxBodyLength: 12 * 1024 * 1024,
          maxContentLength: 12 * 1024 * 1024,
          validateStatus: () => true,
        }),
      );

      if (res.status >= 500) {
        const body = res.data as OcrErrBody;
        throw new ServiceUnavailableException(
          body?.message || body?.error || 'Сервис OCR вернул ошибку сервера',
        );
      }

      if (res.status >= 400) {
        const body = res.data as OcrErrBody;
        if (body.error === 'file_too_large') {
          throw new BadRequestException('Файл слишком большой для OCR');
        }
        if (body.error === 'unsupported_media_type') {
          throw new BadRequestException(`Неподдерживаемый тип файла (${body.message ?? ''})`);
        }
        const msg = body.message ? `: ${body.message}` : '';
        throw new BadRequestException((body.error || 'Запрос к OCR отклонён') + msg);
      }

      const data = res.data as OcrResponseDto;
      this.logger.log(`OCR OK in ${Date.now() - started}ms (${data?.lines?.length ?? 0} lines)`);
      return data;
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof ServiceUnavailableException) {
        throw e;
      }
      const err = e as Error;
      this.logger.warn(`OCR request failed: ${err.message}`);
      throw new ServiceUnavailableException(
        'Сервис OCR недоступен или вернул ошибку. Проверьте контейнер ocr-service.',
      );
    }
  }

  /**
   * Вызывает PaddleOCR и при успехе создаёт запись transaction_drafts (source=ocr).
   */
  async parseReceiptToDraft(params: {
    userId: string;
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  }): Promise<{ draftId: string; ocr: OcrResponseDto }> {
    if (params.userId === 'server') {
      throw new BadRequestException(
        'Создание черновика по чеку недоступно для API-ключа: нужен JWT пользователя.',
      );
    }

    const ocr = await this.runOcrOnBuffer({
      buffer: params.buffer,
      originalname: params.originalname,
      mimetype: params.mimetype,
    });

    const raw_data = {
      ocr,
      originalName: params.originalname,
      mimeType: params.mimetype,
    };

    const descriptionPreview = ocr.full_text?.slice(0, 2000) ?? null;

    const { rows } = await this.pool.query(
      `INSERT INTO transaction_drafts (
          user_id, source, raw_data, status, description
       ) VALUES ($1, 'ocr', $2::jsonb, 'pending', $3)
       RETURNING id, created_at`,
      [params.userId, JSON.stringify(raw_data), descriptionPreview],
    );

    const row = rows[0] as { id: string; created_at: Date };
    return { draftId: row.id, ocr };
  }
}
