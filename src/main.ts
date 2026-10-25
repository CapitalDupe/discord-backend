// IMPORTANT: load-env must be the first import so .env is in process.env before any provider reads configuration.
import './config/load-env';
import 'reflect-metadata';
import { Logger as NestLogger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http';
import { getEnv } from './config/env';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // getEnv() throws a clear error if a required variable is missing, so config problems surface immediately.
  const env = getEnv();
  const boot = new NestLogger('Bootstrap');
  boot.log(`Starting in ${env.NODE_ENV} mode on port ${env.PORT}`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  // Trust exactly N reverse proxies; req.ip then ignores client-supplied X-Forwarded-For beyond that.
  // 0 means "trust none": req.ip is the socket address. Set TRUST_PROXY_HOPS=1 behind Caddy/nginx.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // This is a JSON API, so the CSP can be maximally strict.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());

  // Body size limits: protects against resource-exhaustion uploads. File uploads go straight to S3 via presigned URLs.
  app.useBodyParser('json', { limit: '256kb' });
  app.useBodyParser('urlencoded', { limit: '64kb', extended: false });

  app.enableCors({
    origin: env.ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Step-Up', 'Idempotency-Key'],
    maxAge: 600,
  });
  boot.log(`CORS allowed origins: ${env.ALLOWED_ORIGINS.join(', ')}`);

  // All REST routes live under /api/v1; health and metrics stay at the root for load balancers and Prometheus.
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'health/(.*)', method: RequestMethod.ALL }, { path: 'metrics', method: RequestMethod.GET }],
  });

  // whitelist + forbidNonWhitelisted = mass-assignment protection: unknown fields in a body are rejected, not ignored.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks(); // graceful: SIGTERM drains HTTP + sockets, closes Prisma / Redis

  // Socket.IO with a Redis adapter so several API instances act as one realtime cluster (no-op without REDIS_URL).
  const adapter = new RedisIoAdapter(app);
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);

  await app.listen(env.PORT, '0.0.0.0');
  boot.log(`Listening on :${env.PORT} (REST /api/v1, sockets /socket.io, health /health/ready)`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to start', e);
  process.exit(1);
});
