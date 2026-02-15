import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

function safeStringify(obj: any, maxLen = 1000): string {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
  } catch (err) {
    return '[unserializable]';
  }
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method = req?.method;
    const url = req?.originalUrl ?? req?.url;
    const body = req?.body;
    const params = req?.params;
    const query = req?.query;
    const start = Date.now();

    this.logger.log(
      `${method} ${url} — body=${safeStringify(body)} params=${safeStringify(params)} query=${safeStringify(query)}`,
    );

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse();
        const status = res?.statusCode;
        const ms = Date.now() - start;
        this.logger.log(`${method} ${url} ${status} — ${ms}ms`);
      }),
      catchError((err) => {
        const res = context.switchToHttp().getResponse();
        const status = res?.statusCode ?? 500;
        const ms = Date.now() - start;
        this.logger.error(`${method} ${url} ${status} — ${ms}ms — error=${err?.message ?? err}`);
        return throwError(() => err);
      }),
    );
  }
}
