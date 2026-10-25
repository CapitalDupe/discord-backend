'use strict';

// Roles (private):
//   POST /servers/:serverId/roles                  create a role (needs MANAGE_ROLES)
//   PUT  /servers/:serverId/members/:userId/roles  set a member's roles (needs MANAGE_ROLES)
//
// Anti-escalation rules enforced here:
//   - a role can only be created or handed out below your own highest role
//   - you cannot grant permission bits you do not have (the owner is exempt)
//   - you cannot change roles of someone who outranks you, or of the owner

const { newId, clip, isId, fail } = require('../../lib/util');
const { query, transaction } = require('../../db/pool');
const { P, ALL } = require('../../permissions/bits');
const { getAccess, need } = require('../../permissions/access');
const { sendJson, readJsonBody } = require('../respond');

const CREATE_ROLE = /^\/servers\/([A-Za-z0-9_-]+)\/roles$/;
const SET_MEMBER_ROLES = /^\/servers\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)\/roles$/;

const MAX_ROLES_PER_MEMBER = 20;

async function createRole(ctx, serverId) {
  const { req, res, user } = ctx;
  const me = need(await getAccess(user.id, serverId), P.MANAGE_ROLES);

  const body = await readJsonBody(req);
  const name = clip(body.name, 32).trim();
  const perms = (+body.perms | 0) & ALL;
  const position = Math.max(+body.position | 0, 1);

  if (!name) fail(400, 'Name required');
  if (position >= me.top) fail(403, 'Role must rank below your highest role');
  if (!me.owner && (perms & ~me.perms)) fail(403, 'You cannot grant permissions you lack');

  const id = newId();
  await query(
    'insert into roles(id,server_id,name,perms,position) values($1,$2,$3,$4,$5)',
    [id, serverId, name, perms, position]
  );
  sendJson(res, 201, { id });
}

async function setMemberRoles(ctx, serverId, targetId) {
  const { req, res, user } = ctx;
  const me = need(await getAccess(user.id, serverId), P.MANAGE_ROLES);

  const target = await getAccess(targetId, serverId);
  if (!target) fail(404, 'Not a member');
  if (!me.owner && (target.owner || target.top >= me.top)) fail(403, 'Target outranks you');

  const body = await readJsonBody(req);
  const ids = [...new Set((Array.isArray(body.roleIds) ? body.roleIds : []).filter(isId))].slice(0, MAX_ROLES_PER_MEMBER);

  const roles = ids.length
    ? await query('select id,perms,position from roles where server_id=$1 and id=any($2) and not is_default', [serverId, ids])
    : [];
  if (roles.length !== ids.length) fail(400, 'Unknown role');
  if (roles.some(role => role.position >= me.top || (!me.owner && (role.perms & ~me.perms)))) {
    fail(403, 'Role is above your rank');
  }

  // Replace the member's roles as one unit.
  await transaction(async client => {
    await client.query('delete from member_roles where server_id=$1 and user_id=$2', [serverId, targetId]);
    for (const role of roles) {
      await client.query('insert into member_roles values($1,$2,$3)', [serverId, targetId, role.id]);
    }
  });
  sendJson(res, 200, { ok: true });
}

module.exports = async function roleRoutes(ctx) {
  const createMatch = ctx.method === 'POST' && ctx.path.match(CREATE_ROLE);
  if (createMatch) {
    await createRole(ctx, createMatch[1]);
    return true;
  }
  const setMatch = ctx.method === 'PUT' && ctx.path.match(SET_MEMBER_ROLES);
  if (setMatch) {
    await setMemberRoles(ctx, setMatch[1], setMatch[2]);
    return true;
  }
  return false;
};
