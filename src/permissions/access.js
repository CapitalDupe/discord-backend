'use strict';

// Authorization helpers. Every action that touches a server or channel calls
// into this file; the client is never trusted to say what it may do.

const { queryOne } = require('../db/pool');
const { fail, isId } = require('../lib/util');
const { P, ALL } = require('./bits');

// What can this user do in this server?
//   -> { perms, top, owner }   perms = permission bits, top = rank of their highest role
//   -> null                    the server does not exist or the user is not a member
async function getAccess(userId, serverId) {
  const server = await queryOne('select owner_id from servers where id=$1', [serverId]);
  if (!server) return null;

  const membership = await queryOne('select 1 x from members where server_id=$1 and user_id=$2', [serverId, userId]);
  if (!membership) return null;

  const roles = await queryOne(
    'select coalesce(bit_or(perms),0)::int perms, coalesce(max(position),0)::int top from roles where server_id=$1 and (is_default or id in (select role_id from member_roles where server_id=$1 and user_id=$2))',
    [serverId, userId]
  );

  const owner = server.owner_id === userId;
  const isAdmin = (roles.perms & P.ADMIN) !== 0;
  return {
    perms: owner || isAdmin ? ALL : roles.perms,
    top: owner ? 1e9 : roles.top,
    owner,
  };
}

// Throws 403 unless `access` includes the permission bit. Returns `access` so
// calls can be chained: const a = need(await getAccess(...), P.INVITE)
function need(access, bit) {
  if (!access || !(access.perms & bit)) fail(403, 'Missing permission');
  return access;
}

// Same as getAccess, but starting from a channel id.
//   -> { serverId, access }   both null if the channel id is invalid or unknown
async function getChannelContext(userId, channelId) {
  const channel = isId(channelId) && (await queryOne('select server_id from channels where id=$1', [channelId]));
  if (!channel) return { serverId: null, access: null };
  return { serverId: channel.server_id, access: await getAccess(userId, channel.server_id) };
}

module.exports = { getAccess, need, getChannelContext };
