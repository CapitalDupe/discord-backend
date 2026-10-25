import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../config/env';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

export type TokenType = 'access' | 'mfa' | 'stepup' | 'oauth';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  role: string; // site role at issue time (sensitive routes re-check the database)
}

@Injectable()
export class TokenService {
  private readonly secret = new TextEncoder().encode(getEnv().JWT_SECRET);
  private readonly localRevoked = new Map<string, number>();

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async sign(typ: TokenType, claims: Record<string, unknown>, ttlSec: number): Promise<string> {
    return new SignJWT({ ...claims, typ })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('chat-api')
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.secret);
  }

  async verify<T = Record<string, unknown>>(typ: TokenType, token: string): Promise<T & { sub: string }> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: 'chat-api', algorithms: ['HS256'] });
      if (payload.typ !== typ || !payload.sub) throw new Error('wrong token type');
      return payload as unknown as T & { sub: string };
    } catch {
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
    }
  }

  signAccess(c: AccessClaims): Promise<string> {
    return this.sign('access', { sid: c.sid, role: c.role, sub: c.sub }, getEnv().ACCESS_TOKEN_TTL_SEC);
  }

  verifyAccess(token: string): Promise<AccessClaims & { sub: string }> {
    return this.verify<AccessClaims>('access', token);
  }

  /** Mark a session dead immediately (access tokens are otherwise valid until they expire). */
  async revokeSession(sid: string): Promise<void> {
    const ttl = getEnv().ACCESS_TOKEN_TTL_SEC + 30;
    if (this.redis.client) await this.redis.client.set(`sess:revoked:${sid}`, '1', 'EX', ttl);
    else this.localRevoked.set(sid, Date.now() + ttl * 1000);
  }

  async isSessionRevoked(sid: string): Promise<boolean> {
    if (this.redis.client) {
      if (await this.redis.client.exists(`sess:revoked:${sid}`)) return true;
    } else {
      const until = this.localRevoked.get(sid);
      if (until && until > Date.now()) return true;
    }
    // Source of truth: database (covers instances that restarted or lost Redis state).
    const s = await this.prisma.session.findUnique({ where: { id: sid }, select: { revokedAt: true, expiresAt: true } });
    return !s || !!s.revokedAt || s.expiresAt < new Date();
  }
}
