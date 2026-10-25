import { Injectable, Logger } from '@nestjs/common';
import { PresenceStatus } from '@prisma/client';
import type { RemoteSocket, Server } from 'socket.io';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { Perm, has } from '../permissions/permissions';
import { PermissionsService } from '../permissions/permissions.service';

export interface SocketCtx {
  userId: string;
  sid: string;
  socketId: string;
}
export type EventHandler = (ctx: SocketCtx, payload: any) => Promise<unknown>;

/** Room naming in one place so a typo cannot silently leak events to the wrong audience. */
export const rooms = {
  user: (id: string) => `user:${id}`,
  session: (id: string) => `session:${id}`,
  server: (id: string) => `server:${id}`,
  channel: (id: string) => `channel:${id}`,
};

/**
 * The only way feature modules push events to browsers. `toChannel` reaches ONLY sockets that were authorised for that
 * channel (VIEW_CHANNEL + READ_HISTORY), so private channels and DMs never leak to other users.
 */
@Injectable()
export class RealtimeService {
  private readonly log = new Logger(RealtimeService.name);

  /** Set by RealtimeGateway.afterInit(). Null before the HTTP server starts (e.g. in unit tests). */
  server: Server | null = null;
  private readonly handlers = new Map<string, EventHandler>();

  // Presence: a set of live sockets per user, each with an expiry refreshed by heartbeat.
  // Redis sorted set when available (shared across instances), otherwise an in-memory map.
  private readonly localPresence = new Map<string, Map<string, number>>();
  private static readonly PRESENCE_TTL_MS = 90_000;

  constructor(
    private readonly permissions: PermissionsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ───────────── inbound event registry ─────────────

  /** Feature modules register inbound socket events (acked). Call this from onModuleInit. */
  registerHandler(event: string, fn: EventHandler): void {
    if (this.handlers.has(event)) this.log.warn(`socket handler for "${event}" is being replaced`);
    this.handlers.set(event, fn);
    this.log.debug(`registered socket handler "${event}"`);
  }

  getHandlers(): ReadonlyMap<string, EventHandler> {
    return this.handlers;
  }

  // ───────────── outbound emit helpers ─────────────

  toUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(rooms.user(userId)).emit(event, payload);
  }

  toServer(serverId: string, event: string, payload: unknown): void {
    this.server?.to(rooms.server(serverId)).emit(event, payload);
  }

  toChannel(channelId: string, event: string, payload: unknown): void {
    this.server?.to(rooms.channel(channelId)).emit(event, payload);
  }

  async disconnectSession(sessionId: string): Promise<void> {
    if (!this.server) return;
    this.log.debug(`disconnecting sockets of session ${sessionId}`);
    this.server.to(rooms.session(sessionId)).emit('session:revoked', {});
    this.server.in(rooms.session(sessionId)).disconnectSockets(true);
  }

  // ───────────── room membership (authorisation) ─────────────

  /** Re-evaluate server + channel rooms for all of a user's sockets (after role / overwrite / membership changes). */
  async resyncUser(userId: string): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(rooms.user(userId)).fetchSockets();
    this.log.debug(`resync user ${userId}: ${sockets.length} socket(s)`);
    for (const s of sockets) await this.syncSocket(s);
  }

  /** Re-check everyone currently subscribed to a channel (after its overwrites change). */
  async resyncChannel(channelId: string): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(rooms.channel(channelId)).fetchSockets();
    this.log.debug(`resync channel ${channelId}: ${sockets.length} socket(s)`);
    for (const s of sockets) await this.syncSocket(s);
  }

  /** Remove a user from a server's rooms immediately (kick / ban / leave). */
  async evictFromServer(userId: string, serverId: string): Promise<void> {
    await this.resyncUser(userId);
    this.toUser(userId, 'member:remove', { serverId, userId });
  }

  /**
   * Bring one socket's rooms in line with the database: leave servers the user no longer belongs to, leave channels
   * they can no longer view, and join servers they were added to.
   */
  async syncSocket(s: RemoteSocket<any, any>): Promise<void> {
    const userId: string | undefined = s.data?.userId;
    if (!userId) return;
    try {
      const memberships = await this.prisma.member.findMany({ where: { userId }, select: { serverId: true } });
      const want = new Set(memberships.map((m) => rooms.server(m.serverId)));
      let lostChannel = false;
      for (const room of s.rooms) {
        if (room.startsWith('server:') && !want.has(room)) {
          s.leave(room);
          this.log.debug(`socket ${s.id} left ${room} (no longer a member)`);
        }
        if (room.startsWith('channel:')) {
          const access = await this.permissions.getChannelAccess(userId, room.slice('channel:'.length));
          if (!access || !has(access.perms, Perm.VIEW_CHANNEL | Perm.READ_HISTORY)) {
            s.leave(room);
            lostChannel = true;
            this.log.debug(`socket ${s.id} left ${room} (lost access)`);
          }
        }
      }
      for (const room of want) if (!s.rooms.has(room)) s.join(room);
      s.data.serverIds = [...want].map((r) => r.slice('server:'.length));
      if (lostChannel) this.server?.to(s.id).emit('resync', {});
    } catch (e) {
      this.log.warn(`syncSocket failed for user ${userId}: ${(e as Error).message}`);
    }
  }

  // ───────────── presence ─────────────

  async presenceConnected(userId: string, socketId: string): Promise<void> {
    await this.presenceBeat(userId, socketId);
  }

  async presenceBeat(userId: string, socketId: string): Promise<void> {
    const expiry = Date.now() + RealtimeService.PRESENCE_TTL_MS;
    if (this.redis.client) {
      await this.redis.client.multi().zadd(`presence:z:${userId}`, expiry, socketId).pexpire(`presence:z:${userId}`, RealtimeService.PRESENCE_TTL_MS * 2).exec();
    } else {
      let m = this.localPresence.get(userId);
      if (!m) this.localPresence.set(userId, (m = new Map()));
      m.set(socketId, expiry);
    }
  }

  async presenceDisconnected(userId: string, socketId: string): Promise<void> {
    if (this.redis.client) await this.redis.client.zrem(`presence:z:${userId}`, socketId);
    else this.localPresence.get(userId)?.delete(socketId);
  }

  async isOnline(userId: string): Promise<boolean> {
    const now = Date.now();
    if (this.redis.client) {
      await this.redis.client.zremrangebyscore(`presence:z:${userId}`, '-inf', now);
      return (await this.redis.client.zcard(`presence:z:${userId}`)) > 0;
    }
    const m = this.localPresence.get(userId);
    if (!m) return false;
    for (const [k, exp] of m) if (exp <= now) m.delete(k);
    return m.size > 0;
  }

  /** Status other people may see, honouring invisible mode and the user's presence-privacy setting. */
  async publicStatus(user: { id: string; presence: PresenceStatus; showPresence: boolean }): Promise<PresenceStatus> {
    if (user.presence === 'INVISIBLE' || !user.showPresence) return 'OFFLINE';
    return (await this.isOnline(user.id)) ? (user.presence === 'OFFLINE' ? 'ONLINE' : user.presence) : 'OFFLINE';
  }

  async publicStatuses(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, presence: true, showPresence: true } });
    const out: Record<string, PresenceStatus> = {};
    await Promise.all(users.map(async (u) => { out[u.id] = await this.publicStatus(u); }));
    return out;
  }
}
