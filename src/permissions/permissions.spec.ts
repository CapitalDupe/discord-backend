import {
  ALL_PERMISSIONS, canActOnMember, canGrantRole, computeBase, computeChannelPermissions, DEFAULT_EVERYONE, has, Perm, permsFromString,
} from './permissions';

const EVERYONE = 'role-everyone';
const member = (over: Partial<Parameters<typeof computeChannelPermissions>[0]> = {}) => ({
  userId: 'u1', base: DEFAULT_EVERYONE, roleIds: [EVERYONE], timeoutUntil: null, ...over,
});

describe('computeBase', () => {
  it('owner gets everything', () => expect(computeBase(true, [])).toBe(ALL_PERMISSIONS));
  it('administrator role gets everything', () => expect(computeBase(false, [{ permissions: Perm.ADMINISTRATOR }])).toBe(ALL_PERMISSIONS));
  it('ORs role permissions', () => {
    const b = computeBase(false, [{ permissions: Perm.VIEW_CHANNEL }, { permissions: Perm.SEND_MESSAGES }]);
    expect(has(b, Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES)).toBe(true);
    expect(has(b, Perm.KICK_MEMBERS)).toBe(false);
  });
});

describe('computeChannelPermissions', () => {
  it('denies everything when VIEW_CHANNEL is overwritten away for @everyone (hidden channel)', () => {
    const p = computeChannelPermissions(member(), EVERYONE, [{ roleId: EVERYONE, allow: 0n, deny: Perm.VIEW_CHANNEL }]);
    expect(p).toBe(0n);
  });

  it('a role overwrite can re-allow viewing a hidden channel', () => {
    const p = computeChannelPermissions(member({ roleIds: [EVERYONE, 'mods'] }), EVERYONE, [
      { roleId: EVERYONE, allow: 0n, deny: Perm.VIEW_CHANNEL },
      { roleId: 'mods', allow: Perm.VIEW_CHANNEL, deny: 0n },
    ]);
    expect(has(p, Perm.VIEW_CHANNEL)).toBe(true);
  });

  it('member overwrite wins over role overwrite', () => {
    const p = computeChannelPermissions(member({ roleIds: [EVERYONE, 'r'] }), EVERYONE, [
      { roleId: 'r', allow: 0n, deny: Perm.SEND_MESSAGES },
      { userId: 'u1', allow: Perm.SEND_MESSAGES, deny: 0n },
    ]);
    expect(has(p, Perm.SEND_MESSAGES)).toBe(true);
  });

  it('administrators and the owner bypass overwrites', () => {
    const p = computeChannelPermissions(member({ base: ALL_PERMISSIONS }), EVERYONE, [{ roleId: EVERYONE, allow: 0n, deny: Perm.VIEW_CHANNEL }]);
    expect(p).toBe(ALL_PERMISSIONS);
  });

  it('timeouts strip sending / speaking but keep reading', () => {
    const future = new Date(Date.now() + 60_000);
    const p = computeChannelPermissions(member({ timeoutUntil: future }), EVERYONE, []);
    expect(has(p, Perm.SEND_MESSAGES)).toBe(false);
    expect(has(p, Perm.SPEAK)).toBe(false);
    expect(has(p, Perm.READ_HISTORY)).toBe(true);
  });

  it('expired timeouts do nothing', () => {
    const p = computeChannelPermissions(member({ timeoutUntil: new Date(Date.now() - 1000) }), EVERYONE, []);
    expect(has(p, Perm.SEND_MESSAGES)).toBe(true);
  });

  it('ignores overwrites for roles the member does not hold', () => {
    const p = computeChannelPermissions(member(), EVERYONE, [{ roleId: 'other', allow: 0n, deny: Perm.VIEW_CHANNEL }]);
    expect(has(p, Perm.VIEW_CHANNEL)).toBe(true);
  });
});

describe('hierarchy', () => {
  const owner = { isOwner: true, topPosition: 1e9, userId: 'o' };
  const admin = { isOwner: false, topPosition: 10, userId: 'a' };
  const mod = { isOwner: false, topPosition: 5, userId: 'm' };
  const peer = { isOwner: false, topPosition: 5, userId: 'p' };

  it('nobody can act on the owner', () => {
    expect(canActOnMember(admin, owner)).toBe(false);
    expect(canActOnMember(owner, owner)).toBe(false);
  });
  it('owner can act on anyone else', () => expect(canActOnMember(owner, admin)).toBe(true));
  it('higher rank acts on lower rank only', () => {
    expect(canActOnMember(admin, mod)).toBe(true);
    expect(canActOnMember(mod, admin)).toBe(false);
    expect(canActOnMember(mod, peer)).toBe(false); // equal rank is not enough
  });
});

describe('canGrantRole (privilege-escalation guard)', () => {
  const actor = { isOwner: false, topPosition: 5, base: Perm.MANAGE_ROLES | Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES };
  it('rejects roles at or above own rank', () => {
    expect(canGrantRole(actor, { position: 5, permissions: Perm.VIEW_CHANNEL })).toBe(false);
    expect(canGrantRole(actor, { position: 6, permissions: Perm.VIEW_CHANNEL })).toBe(false);
  });
  it('rejects granting permissions the actor lacks', () => {
    expect(canGrantRole(actor, { position: 2, permissions: Perm.BAN_MEMBERS })).toBe(false);
    expect(canGrantRole(actor, { position: 2, permissions: Perm.ADMINISTRATOR })).toBe(false);
  });
  it('allows lower roles with a subset of own permissions', () => {
    expect(canGrantRole(actor, { position: 2, permissions: Perm.SEND_MESSAGES })).toBe(true);
  });
  it('owner can grant anything', () => {
    expect(canGrantRole({ isOwner: true, topPosition: 1e9, base: ALL_PERMISSIONS }, { position: 99, permissions: Perm.ADMINISTRATOR })).toBe(true);
  });
});

describe('permsFromString', () => {
  it('parses valid bitfields', () => expect(permsFromString('3')).toBe(3n));
  it('rejects non-numeric input', () => expect(() => permsFromString('abc')).toThrow());
  it('rejects unknown bits', () => expect(() => permsFromString((1n << 40n).toString())).toThrow());
});
