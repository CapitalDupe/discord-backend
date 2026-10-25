import { HttpException, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { PresenceStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { getEnv } from '../config/env';
import { isId } from '../common/ids';
import { PrismaService } from '../common/prisma.service';
import { RateLimitService } from '../common/rate-limit';
import { TokenService } from '../common/token.service';
import { Perm, has } from '../permissions/permissions';
import { PermissionsService } from '../permissions/permissions.service';
import { RealtimeService, rooms, SocketCtx } from './realtime.service';

const MAX_SOCKETS_PER_USER = 10;
const EVENTS_PER_WINDOW = 60; // per socket per 10 s
const REVOCATION_RECHECK_MS = 30_000;

const PRESENCE_VALUES: PresenceStatus[] = ['ONLINE', 'IDLE', 'BUSY', 'INVISIBLE'];

/**
 * Connection lifecycle:
 *   1. middleware (afterInit): origin check -> JWT verify -> session-not-revoked -> per-user socket cap.
 *   2. handleConnection: join user/session/server rooms, wire up registered event handlers, emit `ready`.
 *   3. events: each goes through a per-socket budget, periodic revocation re-check, then the registered handler.
 * Set LOG_LEVEL=debug to see each step (user ids only, never IPs or tokens).
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private server!: Server;

  constructor(
    private readonly rt: RealtimeService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimitService,
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.rt.server = server;

    // Authenticate BEFORE the connection is established; unauthenticated sockets never receive anything.
    server.use(async (socket, next) => {
      try {
        const origin = socket.handshake.headers.origin;
        if (origin && !getEnv().ALLOWED_ORIGINS.includes(origin)) {
          this.log.debug(`handshake rejected: origin ${origin} not allowed`);
          return next(new Error('forbidden_origin'));
        }
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string') {
          this.log.debug('handshake rejected: no token');
          return next(new Error('unauthenticated'));
        }
        const claims = await this.tokens.verifyAccess(token);
        if (await this.tokens.isSessionRevoked(claims.sid)) {
          this.log.debug(`handshake rejected: session ${claims.sid} revoked`);
          return next(new Error('unauthenticated'));
        }
        const existing = await server.in(rooms.user(claims.sub)).fetchSockets();
        if (existing.length >= MAX_SOCKETS_PER_USER) {
          this.log.debug(`handshake rejected: user ${claims.sub} already has ${existing.length} sockets`);
          return next(new Error('too_many_connections'));
        }
        socket.data.userId = claims.sub;
        socket.data.sid = claims.sid;
        socket.data.checkedAt = Date.now();
        next();
      } catch (e) {
        this.log.debug(`handshake rejected: ${(e as Error).message}`);
        next(new Error('unauthenticated'));
      }
    });

    this.registerBuiltins();
    setInterval(() => void this.heartbeat(), 30_000).unref();
  }

  async handleConnection(socket: Socket): Promise<void> {
    const { userId, sid } = socket.data as { userId: string; sid: string };
    const ctx: SocketCtx = { userId, sid, socketId: socket.id };
    this.log.debug(`connect user=${userId} socket=${socket.id}`);
    await socket.join([rooms.user(userId), rooms.session(sid)]);

    // Every server the user belongs to; channel rooms are joined later, after a permission check.
    const memberships = await this.prisma.member.findMany({
      where: { userId },
      select: { serverId: true, server: { select: { id: true, name: true, iconKey: true } } },
    });
    for (const m of memberships) await socket.join(rooms.server(m.serverId));
    socket.data.serverIds = memberships.map((m) => m.serverId);

    // Per-socket event budget: protects handlers from floods.
    let count = 0;
    const reset = setInterval(() => { count = 0; }, 10_000);
    socket.on('disconnect', () => clearInterval(reset));

    for (const [event, handler] of this.rt.getHandlers()) {
      socket.on(event, async (payload: unknown, ack?: (r: unknown) => void) => {
        if (++count > EVENTS_PER_WINDOW) {
          this.log.warn(`flood: user=${userId} socket=${socket.id} exceeded ${EVENTS_PER_WINDOW} events/10s, disconnecting`);
          socket.emit('error', { code: 'RATE_LIMITED' });
          socket.disconnect(true);
          return;
        }
        try {
          // Access tokens are short-lived, but a revoked session must stop working on live sockets too.
          if (Date.now() - socket.data.checkedAt > REVOCATION_RECHECK_MS) {
            socket.data.checkedAt = Date.now();
            if (await this.tokens.isSessionRevoked(sid)) {
              socket.emit('session:revoked', {});
              socket.disconnect(true);
              return;
            }
          }
          const data = await handler(ctx, payload);
          if (typeof ack === 'function') ack({ ok: true, data });
        } catch (e) {
          const err = this.toError(e);
          this.log.debug(`event "${event}" failed for user=${userId}: ${err.code}`);
          if (typeof ack === 'function') ack({ ok: false, error: err });
        }
      });
    }

    await this.rt.presenceConnected(userId, socket.id);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarKey: true, accentColor: true, presence: true, showPresence: true, customStatus: true },
    });
    if (user) {
      socket.emit('ready', { user, servers: memberships.map((m) => m.server) });
      await this.broadcastPresence(userId, socket.data.serverIds);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const userId: string | undefined = socket.data?.userId;
    if (!userId) return;
    this.log.debug(`disconnect user=${userId} socket=${socket.id}`);
    await this.rt.presenceDisconnected(userId, socket.id);
    // Small grace period so page reloads do not flap presence.
    setTimeout(() => void this.broadcastPresence(userId, socket.data.serverIds ?? []), 5_000).unref();
  }

  /** Tell members of the user's servers about their (privacy-filtered) status. */
  private async broadcastPresence(userId: string, serverIds: string[]): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, presence: true, showPresence: true } });
    if (!user) return;
    const status = await this.rt.publicStatus(user);
    for (const sid of serverIds) this.rt.toServer(sid, 'presence:update', { userId, status });
  }

  private async heartbeat(): Promise<void> {
    for (const s of this.server.sockets.sockets.values()) {
      if (s.data?.userId) await this.rt.presenceBeat(s.data.userId, s.id).catch(() => undefined);
    }
  }

  /** Convert any thrown value into the {code,message} shape acked to clients; unexpected errors are logged, not leaked. */
  private toError(e: unknown): { code: string; message: string } {
    if (e instanceof HttpException) {
      const r = e.getResponse() as any;
      return { code: r?.error?.code ?? String(e.getStatus()), message: r?.error?.message ?? e.message };
    }
    this.log.error(e instanceof Error ? e.stack || e.message : String(e));
    return { code: 'INTERNAL', message: 'Something went wrong' };
  }

  /** Built-in events. Feature modules add theirs through RealtimeService.registerHandler. */
  private registerBuiltins(): void {
    this.rt.registerHandler('channel:subscribe', async (ctx, p) => {
      if (!p || !isId(p.channelId)) throw new HttpException({ error: { code: 'BAD_REQUEST', message: 'channelId required' } }, 400);
      const access = await this.permissions.getChannelAccess(ctx.userId, p.channelId);
      if (!access || !has(access.perms, Perm.VIEW_CHANNEL | Perm.READ_HISTORY)) {
        this.log.debug(`subscribe denied user=${ctx.userId} channel=${p.channelId}`);
        // Same answer for hidden and missing channels so existence does not leak.
        throw new HttpException({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      }
      const socket = this.server.sockets.sockets.get(ctx.socketId);
      await socket?.join(rooms.channel(p.channelId));
      this.log.debug(`subscribed user=${ctx.userId} channel=${p.channelId}`);
      return { subscribed: true };
    });

    this.rt.registerHandler('channel:unsubscribe', async (ctx, p) => {
      if (p && isId(p.channelId)) this.server.sockets.sockets.get(ctx.socketId)?.leave(rooms.channel(p.channelId));
      return { subscribed: false };
    });

    this.rt.registerHandler('typing:start', async (ctx, p) => {
      if (!p || !isId(p.channelId)) return;
      const r = await this.limiter.hit('typing', `${ctx.userId}:${p.channelId}`, 1, 3); // at most one indicator per 3 s
      if (!r.allowed) return;
      const access = await this.permissions.getChannelAccess(ctx.userId, p.channelId);
      if (!access || !has(access.perms, Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES)) return;
      this.server.sockets.sockets.get(ctx.socketId)?.to(rooms.channel(p.channelId)).emit('typing', { channelId: p.channelId, userId: ctx.userId });
    });

    this.rt.registerHandler('presence:set', async (ctx, p) => {
      if (!p || !PRESENCE_VALUES.includes(p.status)) throw new HttpException({ error: { code: 'BAD_REQUEST', message: 'invalid status' } }, 400);
      const user = await this.prisma.user.update({ where: { id: ctx.userId }, data: { presence: p.status }, select: { id: true, presence: true, showPresence: true } });
      const socket = this.server.sockets.sockets.get(ctx.socketId);
      await this.broadcastPresence(user.id, socket?.data.serverIds ?? []);
      return { status: p.status };
    });
  }
}
