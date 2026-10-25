import {
  CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SiteRole } from '@prisma/client';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';
import { TokenService } from './token.service';

export interface AuthUser {
  id: string;
  sid: string; // session id ('bot' for bot tokens)
  role: SiteRole;
  isBot: boolean;
  botId?: string;
}

export const IS_PUBLIC = 'isPublic';
export const ALLOW_BOT = 'allowBot';
export const SITE_ROLES = 'siteRoles';
export const REQUIRE_STEP_UP = 'requireStepUp';

/** Route does not require authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route may be called with `Authorization: Bot <token>` (all other routes reject bot principals). */
export const AllowBot = () => SetMetadata(ALLOW_BOT, true);
/** Route requires one of these site roles, re-checked against the database on every call. */
export const SiteRoles = (...roles: SiteRole[]) => SetMetadata(SITE_ROLES, roles);
/** Route requires a fresh step-up token in the `X-Step-Up` header. */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } });
    }

    if (scheme === 'Bot') {
      const allowBot = this.reflector.getAllAndOverride<boolean>(ALLOW_BOT, [ctx.getHandler(), ctx.getClass()]);
      if (!allowBot && !isPublic) throw new ForbiddenException({ error: { code: 'BOT_NOT_ALLOWED', message: 'Bots cannot call this route' } });
      const bot = await this.prisma.bot.findUnique({ where: { tokenHash: this.crypto.sha256(token) } });
      if (!bot) {
        if (isPublic) return true;
        throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Invalid bot token' } });
      }
      req.user = { id: bot.userId, sid: 'bot', role: 'USER', isBot: true, botId: bot.id } satisfies AuthUser;
      return true;
    }

    if (scheme !== 'Bearer') {
      if (isPublic) return true;
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Unsupported authorization scheme' } });
    }
    try {
      const claims = await this.tokens.verifyAccess(token);
      if (await this.tokens.isSessionRevoked(claims.sid)) throw new UnauthorizedException();
      req.user = { id: claims.sub, sid: claims.sid, role: claims.role as SiteRole, isBot: false } satisfies AuthUser;
      return true;
    } catch (e) {
      if (isPublic) return true;
      throw e instanceof UnauthorizedException ? e : new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
    }
  }
}

@Injectable()
export class SiteRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const roles = this.reflector.getAllAndOverride<SiteRole[]>(SITE_ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!req.user) throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } });
    const u = await this.prisma.user.findUnique({ where: { id: req.user.id }, select: { siteRole: true, deletedAt: true } });
    if (!u || u.deletedAt || !roles.includes(u.siteRole)) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Insufficient privileges' } });
    }
    req.user.role = u.siteRole;
    return true;
  }
}

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    if (!this.reflector.getAllAndOverride<boolean>(REQUIRE_STEP_UP, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['x-step-up'];
    if (typeof header !== 'string' || !req.user) throw new ForbiddenException({ error: { code: 'STEP_UP_REQUIRED', message: 'Re-authentication required' } });
    try {
      const c = await this.tokens.verify<{ sid: string }>('stepup', header);
      if (c.sub !== req.user.id || c.sid !== req.user.sid) throw new Error('mismatch');
      return true;
    } catch {
      throw new ForbiddenException({ error: { code: 'STEP_UP_REQUIRED', message: 'Re-authentication required' } });
    }
  }
}
