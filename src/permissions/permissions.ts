/**
 * Permission bit flags (BigInt) and the pure channel-permission algorithm. No I/O here so it is exhaustively unit-testable.
 */
export const Perm = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  READ_HISTORY: 1n << 2n,
  ATTACH_FILES: 1n << 3n,
  EMBED_LINKS: 1n << 4n,
  ADD_REACTIONS: 1n << 5n,
  MENTION_EVERYONE: 1n << 6n,
  MANAGE_MESSAGES: 1n << 7n,
  CREATE_INVITE: 1n << 8n,
  MANAGE_CHANNELS: 1n << 9n,
  MANAGE_ROLES: 1n << 10n,
  MANAGE_SERVER: 1n << 11n,
  KICK_MEMBERS: 1n << 12n,
  BAN_MEMBERS: 1n << 13n,
  TIMEOUT_MEMBERS: 1n << 14n,
  VIEW_AUDIT_LOG: 1n << 15n,
  CONNECT: 1n << 16n,
  SPEAK: 1n << 17n,
  VIDEO: 1n << 18n,
  MUTE_MEMBERS: 1n << 19n,
  DEAFEN_MEMBERS: 1n << 20n,
  MOVE_MEMBERS: 1n << 21n,
  STREAM: 1n << 22n,
  RECORD: 1n << 23n,
  MANAGE_THREADS: 1n << 24n,
  CREATE_THREADS: 1n << 25n,
  MANAGE_WEBHOOKS: 1n << 26n,
  MANAGE_BOTS: 1n << 27n,
  USE_SLASH_COMMANDS: 1n << 28n,
  MANAGE_AUTOMOD: 1n << 29n,
  VIEW_MOD_NOTES: 1n << 30n,
  ADMINISTRATOR: 1n << 31n,
} as const;

export type PermName = keyof typeof Perm;

export const ALL_PERMISSIONS: bigint = Object.values(Perm).reduce((a, b) => a | b, 0n);

/** Default @everyone permissions for new servers. */
export const DEFAULT_EVERYONE: bigint =
  Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_HISTORY | Perm.ATTACH_FILES | Perm.EMBED_LINKS | Perm.ADD_REACTIONS |
  Perm.CREATE_INVITE | Perm.CONNECT | Perm.SPEAK | Perm.VIDEO | Perm.STREAM | Perm.CREATE_THREADS | Perm.USE_SLASH_COMMANDS;

/** What participants of a DM / group DM can do. */
export const DM_PERMISSIONS: bigint =
  Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.READ_HISTORY | Perm.ATTACH_FILES | Perm.EMBED_LINKS | Perm.ADD_REACTIONS |
  Perm.CONNECT | Perm.SPEAK | Perm.VIDEO | Perm.STREAM;

/** Removed from members under timeout (even administrators). */
export const TIMEOUT_REVOKED: bigint = Perm.SEND_MESSAGES | Perm.ADD_REACTIONS | Perm.SPEAK | Perm.VIDEO | Perm.STREAM | Perm.CREATE_THREADS | Perm.ATTACH_FILES;

export const has = (perms: bigint, p: bigint): boolean => (perms & p) === p;

export interface Overwrite {
  roleId?: string | null;
  userId?: string | null;
  allow: bigint;
  deny: bigint;
}

export interface MemberContext {
  userId: string;
  isOwner: boolean;
  /** OR of @everyone and all assigned roles (ALL_PERMISSIONS for owner / administrators). */
  base: bigint;
  roleIds: string[]; // includes the @everyone role id
  topPosition: number; // highest role position held (1e9 for the owner)
  timeoutUntil: Date | null;
}

/** Compute a role-based base permission set. */
export function computeBase(isOwner: boolean, roles: { permissions: bigint }[]): bigint {
  if (isOwner) return ALL_PERMISSIONS;
  const base = roles.reduce((a, r) => a | r.permissions, 0n);
  return has(base, Perm.ADMINISTRATOR) ? ALL_PERMISSIONS : base;
}

/**
 * Overwrite resolution: base -> @everyone overwrite -> aggregated role overwrites (deny then allow) -> member overwrite.
 * A channel the member cannot VIEW yields 0 (no information leakage); administrators/owner bypass overwrites.
 */
export function computeChannelPermissions(
  ctx: Pick<MemberContext, 'base' | 'roleIds' | 'userId' | 'timeoutUntil'>,
  everyoneRoleId: string,
  overwrites: Overwrite[],
  now: Date = new Date(),
): bigint {
  let perms = ctx.base;
  if (perms !== ALL_PERMISSIONS) {
    const ev = overwrites.find((o) => o.roleId === everyoneRoleId);
    if (ev) perms = (perms & ~ev.deny) | ev.allow;

    let allow = 0n;
    let deny = 0n;
    for (const o of overwrites) {
      if (o.roleId && o.roleId !== everyoneRoleId && ctx.roleIds.includes(o.roleId)) {
        allow |= o.allow;
        deny |= o.deny;
      }
    }
    perms = (perms & ~deny) | allow;

    const mine = overwrites.find((o) => o.userId === ctx.userId);
    if (mine) perms = (perms & ~mine.deny) | mine.allow;
  }
  if (ctx.timeoutUntil && ctx.timeoutUntil > now) perms &= ~TIMEOUT_REVOKED;
  if (!has(perms, Perm.VIEW_CHANNEL)) return 0n; // hidden channels reveal nothing
  return perms;
}

/** Hierarchy rule: act only on members whose top role is strictly below yours; nobody acts on the owner. */
export function canActOnMember(actor: Pick<MemberContext, 'isOwner' | 'topPosition' | 'userId'>, target: Pick<MemberContext, 'isOwner' | 'topPosition' | 'userId'>): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner) return true;
  return actor.topPosition > target.topPosition;
}

/** A member may assign/edit a role only if it ranks below their top role AND they hold every permission it grants. */
export function canGrantRole(
  actor: Pick<MemberContext, 'isOwner' | 'topPosition' | 'base'>,
  role: { position: number; permissions: bigint },
): boolean {
  if (actor.isOwner) return true;
  if (role.position >= actor.topPosition) return false;
  return (role.permissions & ~actor.base) === 0n;
}

export const permsToString = (p: bigint): string => p.toString();
export const permsFromString = (s: string): bigint => {
  if (!/^\d{1,20}$/.test(s)) throw new Error('invalid permission bitfield');
  const v = BigInt(s);
  if (v & ~ALL_PERMISSIONS) throw new Error('unknown permission bits');
  return v;
};
