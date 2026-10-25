import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { getEnv } from '../config/env';

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE', 429: 'RATE_LIMITED',
};

/** Uniform `{ error: { code, message } }` bodies; internal details are logged, never returned. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { error: { code: string; message: string; details?: unknown } } = { error: { code: 'INTERNAL', message: 'Something went wrong' } };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      if (r?.error?.code) body = r;
      else {
        const msg = Array.isArray(r?.message) ? 'Validation failed' : r?.message || exception.message;
        body = { error: { code: CODES[status] || 'ERROR', message: String(msg), ...(Array.isArray(r?.message) ? { details: r.message } : {}) } };
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') { status = 409; body = { error: { code: 'CONFLICT', message: 'Already exists' } }; }
      else if (exception.code === 'P2025') { status = 404; body = { error: { code: 'NOT_FOUND', message: 'Not found' } }; }
      else this.log.error(`prisma ${exception.code}: ${exception.message}`);
    } else {
      this.log.error(exception instanceof Error ? exception.stack || exception.message : String(exception));
    }
    res.status(status).json(body);
  }
}

/**
 * CSRF defence for cookie-authenticated requests (the refresh cookie). Requests that carry the refresh cookie and no
 * Authorization header must come from an allowed Origin and include a custom header cross-site forms cannot set.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (safe || req.headers.authorization || !req.cookies?.['__Host-rt']) return next();
    const origin = req.headers.origin;
    const ok = typeof origin === 'string' && getEnv().ALLOWED_ORIGINS.includes(origin) && req.headers['x-requested-with'] === 'fetch';
    if (!ok) {
      res.status(403).json({ error: { code: 'CSRF', message: 'Cross-site request blocked' } });
      return;
    }
    next();
  }
}
