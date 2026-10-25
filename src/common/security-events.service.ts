import { Injectable, Logger } from '@nestjs/common';
import { SecurityEventType } from '@prisma/client';
import { newId } from './ids';
import { ipPrefix, normalizeIp } from './ip';
import { PrismaService } from './prisma.service';

export interface SecurityEventInput {
  userId?: string | null;
  ip: string;
  userAgent?: string | null;
  /** Never put secrets, tokens, passwords or other people's IPs in here. */
  metadata?: Record<string, unknown>;
}

/**
 * The ONLY place raw IP addresses are persisted (table `SecurityEvent`). Readable solely through endpoints restricted to
 * the SECURITY/ADMIN site roles, and purged after IP_RETENTION_DAYS.
 */
@Injectable()
export class SecurityEventsService {
  private readonly log = new Logger(SecurityEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(type: SecurityEventType, input: SecurityEventInput): Promise<void> {
    try {
      const ip = normalizeIp(input.ip);
      await this.prisma.securityEvent.create({
        data: {
          id: newId(),
          type,
          userId: input.userId ?? null,
          ip,
          ipPrefix: ipPrefix(ip),
          userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
          metadata: (input.metadata as any) ?? undefined,
        },
      });
    } catch (e) {
      // Security logging must never break the request path.
      this.log.error(`failed to record security event ${type}: ${(e as Error).message}`);
    }
  }

  /** A user's own history WITHOUT any IP data (what the account settings screen shows). */
  async listOwn(userId: string, limit = 50) {
    return this.prisma.securityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: { id: true, type: true, userAgent: true, createdAt: true },
    });
  }

  /** Count recent events for burst detection. Never returns IPs. */
  async countRecent(type: SecurityEventType, where: { ip?: string; ipPrefix?: string; userId?: string }, sinceMs: number): Promise<number> {
    return this.prisma.securityEvent.count({ where: { type, ...where, createdAt: { gte: new Date(Date.now() - sinceMs) } } });
  }
}
