import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit.service';
import { JwtAuthGuard, SiteRolesGuard, StepUpGuard } from './auth';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';
import { RateLimitGuard, RateLimitService } from './rate-limit';
import { RedisService } from './redis.service';
import { SecurityEventsService } from './security-events.service';
import { TokenService } from './token.service';

/** Cross-cutting services every feature module may inject. */
@Global()
@Module({
  providers: [
    PrismaService, RedisService, CryptoService, TokenService, AuditService, SecurityEventsService, RateLimitService,
    // Guard order matters: authenticate, then site-role / step-up checks, then rate limits (which may key on the user).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SiteRolesGuard },
    { provide: APP_GUARD, useClass: StepUpGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [PrismaService, RedisService, CryptoService, TokenService, AuditService, SecurityEventsService, RateLimitService],
})
export class CommonModule {}
