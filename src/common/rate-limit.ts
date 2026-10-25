import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { SecurityEventsService } from './security-events.service';
import { clientIp } from './ip';

export interface RateLimitOptions {
  /** Stable name; admins can override max/window per name through SystemSetting `rateLimits`. */
  name: string;
  max: number;
  windowSec: number;
  by?: 'ip' | 'user' | 'both';
}

export const RATE_LIMIT_KEY = 'rate-limit';
export const RateLimit = (...opts: RateLimitOptions[]) => SetMetadata(RATE_LIMIT_KEY, opts);

export interface HitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSec: number;
}

@Injectable()
export class RateLimitService {
  private mem = new Map<string, { count: number; resetAt: number }>();
  private overrides: Record<string, { max: number; windowSec: number }> = {};
  private overridesLoadedAt = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.mem) if (v.resetAt <= now) this.mem.delete(k);
    }, 60_000).unref();
  }

  /** Fixed-window counter keyed by `name:subject`. Works across instances when Redis is configured. */
  async hit(name: string, subject: string, max: number, windowSec: number): Promise<HitResult> {
    const o = await this.override(name);
    if (o) {
      max = o.max;
      windowSec = o.windowSec;
    }
    const key = `rl:${name}:${subject}`;
    let count: number;
    let ttl: number;
    if (this.redis.client) {
      const res = await this.redis.client.multi().incr(key).ttl(key).exec();
      count = Number(res?.[0]?.[1] ?? 1);
      ttl = Number(res?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.redis.client.expire(key, windowSec);
        ttl = windowSec;
      }
    } else {
      const now = Date.now();
      let e = this.mem.get(key);
      if (!e || e.resetAt <= now) e = { count: 0, resetAt: now + windowSec * 1000 };
      e.count++;
      this.mem.set(key, e);
      count = e.count;
      ttl = Math.ceil((e.resetAt - now) / 1000);
    }
    return { allowed: count <= max, count, remaining: Math.max(0, max - count), retryAfterSec: Math.max(1, ttl) };
  }

  /** Without consuming: has this subject already exceeded the limit? */
  async peek(name: string, subject: string, max: number): Promise<boolean> {
    const key = `rl:${name}:${subject}`;
    if (this.redis.client) return Number((await this.redis.client.get(key)) ?? 0) >= max;
    const e = this.mem.get(key);
    return !!e && e.resetAt > Date.now() && e.count >= max;
  }

  async reset(name: string, subject: string): Promise<void> {
    const key = `rl:${name}:${subject}`;
    if (this.redis.client) await this.redis.client.del(key);
    else this.mem.delete(key);
  }

  private async override(name: string) {
    if (Date.now() - this.overridesLoadedAt > 30_000) {
      this.overridesLoadedAt = Date.now();
      try {
        const row = await this.prisma.systemSetting.findUnique({ where: { key: 'rateLimits' } });
        this.overrides = (row?.value as any) ?? {};
      } catch {
        /* keep previous overrides */
      }
    }
    return this.overrides[name];
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly events: SecurityEventsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const opts = this.reflector.getAllAndOverride<RateLimitOptions[]>(RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!opts?.length) return true;
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const ip = clientIp(req);
    for (const o of opts) {
      const subjects: string[] = [];
      const by = o.by ?? 'ip';
      if (by === 'ip' || by === 'both') subjects.push(`ip:${ip}`);
      if ((by === 'user' || by === 'both') && req.user?.id) subjects.push(`u:${req.user.id}`);
      if (by === 'user' && !req.user?.id) subjects.push(`ip:${ip}`);
      for (const s of subjects) {
        const r = await this.limiter.hit(o.name, s, o.max, o.windowSec);
        if (!r.allowed) {
          if (r.count === o.max + 1) {
            void this.events.record('RATE_LIMITED', { userId: req.user?.id, ip, userAgent: req.headers['user-agent'], metadata: { limit: o.name } });
          }
          res.setHeader('Retry-After', String(r.retryAfterSec));
          throw new HttpException({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } }, HttpStatus.TOO_MANY_REQUESTS);
        }
      }
    }
    return true;
  }
}
