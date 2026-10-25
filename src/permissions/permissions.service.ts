import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Channel, Server } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  ALL_PERMISSIONS, canActOnMember, canGrantRole, computeBase, computeChannelPermissions, DM_PERMISSIONS, has, MemberContext, Perm,
} from './permissions';

const notFound = () => new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Not found' } });
const forbidden = () => new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Missing permission' } });

export interface ChannelAccess {
  channel: Channel;
  perms: bigint;
  member: MemberContext | null; // null for DMs
}

/**
 * Single authority for "may user X do Y". Everything is derived from the database; nothing the browser sends
 * (role names, ids, flags) is trusted. Unknown / hidden resources answer 404 so their existence does not leak.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMemberContext(serverId: string, userId: string): Promise<MemberContext | null> {
    const member = await this.prisma.member.findUnique({
      where: { serverId_userId: { serverId, userId } },
      include: { roles: { include: { role: true } }, server: { select: { ownerId: true } } },
    });
    if (!member) return null;
    const everyone = await this.prisma.role.findFirst({ where: { serverId, isDefault: true } });
    const roles = [...(everyone ? [everyone] : []), ...member.roles.map((r) => r.role)];
    const isOwner = member.server.ownerId === userId;
    return {
      userId,
      isOwner,
      base: computeBase(isOwner, roles),
      roleIds: roles.map((r) => r.id),
      topPosition: isOwner ? 1_000_000_000 : roles.reduce((m, r) => Math.max(m, r.position), 0),
      timeoutUntil: member.timeoutUntil,
    };
  }

  /** Effective permissions of `userId` in `channelId` (0n when the channel is not visible to them). */
  async getChannelAccess(userId: string, channelId: string): Promise<ChannelAccess | null> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return null;

    if (!channel.serverId) {
      const p = await this.prisma.channelParticipant.findUnique({ where: { channelId_userId: { channelId, userId } } });
      return { channel, perms: p && !p.leftAt ? DM_PERMISSIONS : 0n, member: null };
    }

    const server = await this.prisma.server.findUnique({ where: { id: channel.serverId } });
    if (!server) return null;
    const member = await this.getMemberContext(channel.serverId, userId);
    if (!member) return { channel, perms: 0n, member: null };

    // Threads inherit overwrites from their parent channel.
    const overwriteChannelId = channel.parentChannelId ?? channel.id;
    const overwrites = await this.prisma.channelOverwrite.findMany({ where: { channelId: overwriteChannelId } });
    const everyone = await this.prisma.role.findFirst({ where: { serverId: server.id, isDefault: true }, select: { id: true } });
    let perms = computeChannelPermissions(
      member, everyone?.id ?? '',
      overwrites.map((o) => ({ roleId: o.roleId, userId: o.userId, allow: o.allow, deny: o.deny })),
    );
    perms = this.applyServerState(server, member, perms);
    return { channel, perms, member };
  }

  private applyServerState(server: Server, member: MemberContext, perms: bigint): bigint {
    if (server.lockdownUntil && server.lockdownUntil > new Date() && !has(member.base, Perm.MANAGE_SERVER) && !member.isOwner) {
      perms &= ~(Perm.SEND_MESSAGES | Perm.ADD_REACTIONS | Perm.CREATE_THREADS);
    }
    return perms;
  }

  /** Throws 404 if the channel is invisible to the user, 403 if visible but the permission is missing. */
  async assertChannel(userId: string, channelId: string, required: bigint): Promise<ChannelAccess> {
    const access = await this.getChannelAccess(userId, channelId);
    if (!access || !has(access.perms, Perm.VIEW_CHANNEL)) throw notFound();
    if (!has(access.perms, required)) throw forbidden();
    return access;
  }

  /** Server-level permission (roles only, no channel overwrites). Non-members get 404. */
  async assertServer(userId: string, serverId: string, required: bigint = 0n): Promise<MemberContext> {
    const ctx = await this.getMemberContext(serverId, userId);
    if (!ctx) throw notFound();
    if (required !== 0n && !has(ctx.base, required)) throw forbidden();
    return ctx;
  }

  /** Visible channel ids in a server for a member. */
  async visibleChannelIds(userId: string, serverId: string): Promise<string[]> {
    const member = await this.getMemberContext(serverId, userId);
    if (!member) return [];
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return [];
    const everyone = await this.prisma.role.findFirst({ where: { serverId, isDefault: true }, select: { id: true } });
    const channels = await this.prisma.channel.findMany({ where: { serverId, parentChannelId: null }, include: { overwrites: true } });
    return channels
      .filter((c) => has(computeChannelPermissions(member, everyone?.id ?? '', c.overwrites.map((o) => ({ roleId: o.roleId, userId: o.userId, allow: o.allow, deny: o.deny }))), Perm.VIEW_CHANNEL))
      .map((c) => c.id);
  }

  /** Can `actor` kick / ban / timeout / re-role `targetUserId` in this server? */
  async assertCanActOn(serverId: string, actorId: string, targetUserId: string): Promise<{ actor: MemberContext; target: MemberContext }> {
    const actor = await this.assertServer(actorId, serverId);
    const target = await this.getMemberContext(serverId, targetUserId);
    if (!target) throw notFound();
    if (actorId === targetUserId || !canActOnMember(actor, target)) {
      throw new ForbiddenException({ error: { code: 'HIERARCHY', message: 'You cannot act on this member' } });
    }
    return { actor, target };
  }

  /** Can the actor create / edit / assign this role? (position below theirs AND no permissions they lack) */
  assertCanGrantRole(actor: MemberContext, role: { position: number; permissions: bigint }): void {
    if (!canGrantRole(actor, role)) {
      throw new ForbiddenException({ error: { code: 'HIERARCHY', message: 'Role is above your rank or grants permissions you lack' } });
    }
  }

  allPermissions(): bigint {
    return ALL_PERMISSIONS;
  }
}
