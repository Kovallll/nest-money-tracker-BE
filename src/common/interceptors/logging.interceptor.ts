import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

const MAX_LOG_LENGTH = 2000;

function safeStringify(obj: unknown, maxLen = MAX_LOG_LENGTH): string {
  if (obj === undefined) return 'undefined';
  if (obj === null) return 'null';
  try {
    const s = JSON.stringify(obj);
    return s && s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const method = req?.method ?? '?';
    const url = req?.originalUrl ?? req?.url ?? '?';
    const body = req?.body;
    const params = req?.params;
    const query = req?.query;
    const start = Date.now();

    this.logger.log(
      `→ IN  ${method} ${url} | body=${safeStringify(body)} | params=${safeStringify(params)} | query=${safeStringify(query)}`,
    );

    return next.handle().pipe(
      tap((data) => {
        const res = context.switchToHttp().getResponse();
        const status = res?.statusCode ?? 200;
        const ms = Date.now() - start;
        this.logger.log(
          `← OUT ${method} ${url} ${status} ${ms}ms | response=${safeStringify(data)}`,
        );
      }),
      catchError((err) => {
        const status = err?.status ?? err?.statusCode ?? 500;
        const ms = Date.now() - start;
        this.logger.error(
          `← ERR ${method} ${url} ${status} ${ms}ms | message=${err?.message ?? err}`,
        );
        return throwError(() => err);
      }),
    );
  }
}
