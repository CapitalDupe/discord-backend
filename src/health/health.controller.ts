import { Controller, ForbiddenException, Get, Headers, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import * as client from 'prom-client';
import { Public } from '../common/auth';
import { CryptoService } from '../common/crypto.service';
import { clientIp, isPrivateIp } from '../common/ip';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { getEnv } from '../config/env';

client.collectDefaultMetrics({ prefix: 'chat_' });

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  /** Liveness: the process is up. Never touches dependencies, so a database outage does not cause restart loops. */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Used by orchestrators / load balancers to route traffic. */
  @Public()
  @Get('health/ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    checks.redis = (await this.redis.ping()) ? 'up' : 'down';
    const ok = Object.values(checks).every((v) => v === 'up');
    if (!ok) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }

  /**
   * Prometheus metrics. Allowed with a bearer METRICS_TOKEN; with no token configured only private-network callers
   * are allowed. Do not expose this route publicly through the reverse proxy.
   */
  @Public()
  @Get('metrics')
  async metrics(@Req() req: Request, @Headers('authorization') auth?: string) {
    const token = getEnv().METRICS_TOKEN;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const okToken = !!token && !!bearer && this.crypto.safeEqual(bearer, token);
    if (!okToken && !(isPrivateIp(clientIp(req)) && !token)) throw new ForbiddenException();
    req.res?.setHeader('Content-Type', client.register.contentType);
    return client.register.metrics();
  }
}
