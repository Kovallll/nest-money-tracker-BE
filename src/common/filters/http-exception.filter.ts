import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/** Единый формат ответа об ошибке */
export interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  details?: unknown;
  path?: string;
  timestamp?: string;
}

/** Краткие подсказки для типичных ошибок валидации (рус.) */
const VALIDATION_HINTS: Record<string, string> = {
  'isEmail': 'Укажите корректный email, например: user@example.com',
  'isNotEmpty': 'Поле обязательно для заполнения',
  'minLength': 'Увеличьте длину значения',
  'maxLength': 'Уменьшите длину значения',
  'isString': 'Ожидается текст',
  'isNumber': 'Ожидается число',
  'isUUID': 'Укажите корректный UUID',
  'isInt': 'Ожидается целое число',
  'min': 'Значение не должно быть меньше указанного',
  'max': 'Значение не должно быть больше указанного',
  'isBoolean': 'Ожидается true или false',
  'isDateString': 'Укажите дату в формате ISO (YYYY-MM-DD)',
  'isOptional': '',
};

function getErrorName(statusCode: number): string {
  const names: Record<number, string> = {
    400: 'Ошибка запроса',
    401: 'Требуется авторизация',
    403: 'Доступ запрещён',
    404: 'Не найдено',
    409: 'Конфликт данных',
    422: 'Ошибка валидации',
    503: 'Сервис недоступен',
  };
  return names[statusCode] ?? 'Ошибка сервера';
}

function formatValidationMessage(raw: string): { message: string; hint?: string } {
  const lower = raw.toLowerCase();
  let hint: string | undefined;
  for (const [key, value] of Object.entries(VALIDATION_HINTS)) {
    if (value && (lower.includes(key.toLowerCase()) || raw.includes(key))) {
      hint = value;
      break;
    }
  }
  if (!hint) {
    if (lower.includes('email')) hint = 'Проверьте формат email';
    else if (lower.includes('password')) hint = 'Пароль обычно от 6 символов, с буквами и цифрами';
    else if (lower.includes('uuid')) hint = 'Идентификатор должен быть в формате UUID';
  }
  return { message: raw, hint };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isDev = process.env.NODE_ENV !== 'production';
    let statusCode: number;
    let message: string;
    let error: string;
    let details: unknown;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      error = getErrorName(statusCode);
      const res = exception.getResponse();
      const resObj = typeof res === 'object' ? (res as Record<string, unknown>) : { message: res };

      const rawMessage = resObj.message;
      if (Array.isArray(rawMessage) && rawMessage.length > 0) {
        const items = (rawMessage as string[]).map((m) => formatValidationMessage(m));
        message = items.length === 1
          ? items[0].message
          : `Ошибки валидации (${items.length}): ${items.map((i) => i.message).join('; ')}`;
        details = items.map((i) => (i.hint ? { message: i.message, hint: i.hint } : { message: i.message }));
      } else if (typeof rawMessage === 'string') {
        message = rawMessage;
      } else {
        message = (resObj as { message?: string }).message ?? error;
      }
      const unauthDefault =
        'Требуется авторизация. Войдите или передайте корректный JWT в заголовке Authorization.';
      if (statusCode === 401 && (!message || message === 'Unauthorized' || message.toLowerCase() === 'unauthorized')) {
        message = unauthDefault;
      }
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      error = getErrorName(statusCode);
      message = 'Внутренняя ошибка сервера. Повторите запрос позже.';
      if (isDev && exception instanceof Error) {
        details = { stack: exception.stack, name: exception.name };
        this.logger.error(exception.message, exception.stack);
      } else if (exception instanceof Error) {
        this.logger.error(exception.message);
      }
    }

    const body: ErrorResponse = {
      statusCode,
      message,
      error,
      path: request.url,
      timestamp: new Date().toISOString(),
    };
    if (details !== undefined) body.details = details;

    response.status(statusCode).json(body);
  }
}
