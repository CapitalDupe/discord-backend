'use strict';

// DELETE /servers/:serverId/members/:userId (private)
//   - your own id  = leave the server
//   - someone else = kick them (needs KICK, and they must not outrank you)
// The owner can never be removed.

const { fail } = require('../../lib/util');
const { query } = require('../../db/pool');
const { P } = require('../../permissions/bits');
const { getAccess, need } = require('../../permissions/access');
const { sendToUser } = require('../../realtime/connections');
const { sendJson } = require('../respond');

const MEMBER = /^\/servers\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)$/;

module.exports = async function memberRoutes(ctx) {
  const match = ctx.method === 'DELETE' && ctx.path.match(MEMBER);
  if (!match) return false;

  const { res, user } = ctx;
  const serverId = match[1];
  const targetId = match[2];

  const me = await getAccess(user.id, serverId);
  const target = await getAccess(targetId, serverId);
  if (!me || !target) fail(404, 'Not found');
  if (target.owner) fail(403, 'The owner cannot be removed');

  if (targetId !== user.id) {
    need(me, P.KICK);
    if (!me.owner && target.top >= me.top) fail(403, 'Target outranks you');
  }

  await query('delete from members where server_id=$1 and user_id=$2', [serverId, targetId]);
  sendToUser(targetId, { t: 'srv.del', sid: serverId }); // tell their open clients to drop the server
  sendJson(res, 200, { ok: true });
  return true;
};
