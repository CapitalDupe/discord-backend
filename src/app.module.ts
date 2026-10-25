import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module';
import { CsrfMiddleware } from './common/http';
import { HealthModule } from './health/health.module';
import { PermissionsModule } from './permissions/permissions.module';
import { RealtimeModule } from './realtime/realtime.module';

/**
 * Only modules that exist in this branch are registered. As each feature module from docs/API.md is written
 * (auth, users, community, messaging, moderation, security, storage, notifications, voice, bots, admin, mail),
 * add it to the `imports` list below.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        // Structured JSON logs. Credentials are redacted and client addresses are deliberately NOT logged here
        // (IPs live only in the restricted SecurityEvent table).
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-step-up"]', 'res.headers["set-cookie"]'],
        serializers: {
          req: (r: any) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }),
          res: (r: any) => ({ statusCode: r.statusCode }),
        },
        autoLogging: { ignore: (req: any) => String(req.url).startsWith('/health') || String(req.url).startsWith('/metrics') },
      },
    }),
    CommonModule,
    PermissionsModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
