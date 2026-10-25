'use strict';

// Invites (private):
//   POST /servers/:serverId/invites   create an invite (needs INVITE)
//   POST /invites/:code/join          join a server with an invite code

const crypto = require('crypto');
const { limit } = require('../../lib/rateLimit');
const { fail } = require('../../lib/util');
const log = require('../../lib/log');
const { query, queryOne, transaction } = require('../../db/pool');
const { P } = require('../../permissions/bits');
const { getAccess, need } = require('../../permissions/access');
const { sendToServerMembers } = require('../../realtime/connections');
const { sendJson, readJsonBody } = require('../respond');

const CREATE_INVITE = /^\/servers\/([A-Za-z0-9_-]+)\/invites$/;
const JOIN_INVITE = /^\/invites\/([A-Za-z0-9_-]+)\/join$/;

async function createInvite(ctx, serverId) {
  const { req, res, user } = ctx;
  need(await getAccess(user.id, serverId), P.INVITE);

  const body = await readJsonBody(req);
  const code = crypto.randomBytes(6).toString('base64url');
  const days = Math.min(Math.max(+body.days || 7, 1), 30);
  const maxUses = Math.min(Math.max(+body.maxUses || 10, 1), 100);

  await query(
    `insert into invites(code,server_id,created_by,expires_at,max_uses) values($1,$2,$3,now()+($4||' days')::interval,$5)`,
    [code, serverId, user.id, String(days), maxUses]
  );
  sendJson(res, 201, { code });
}

async function joinWithInvite(ctx, code) {
  const { res, user, ip } = ctx;
  if (!limit('join:' + ip, 20, 9e5)) fail(429, 'Too many attempts');

  const invite = await queryOne(
    'select server_id from invites where code=$1 and (expires_at is null or expires_at>now()) and (max_uses is null or uses<max_uses)',
    [code]
  );
  if (!invite) fail(404, 'Invite is invalid or expired');

  const joined = await transaction(async client => {
    const inserted = await client.query(
      'insert into members(server_id,user_id) values($1,$2) on conflict do nothing',
      [invite.server_id, user.id]
    );
    if (!inserted.rowCount) return false; // already a member: do not use up an invite

    // Claim one use atomically. Concurrent joins queue on this row, so max_uses can never be exceeded.
    const claimed = await client.query(
      'update invites set uses=uses+1 where code=$1 and (expires_at is null or expires_at>now()) and (max_uses is null or uses<max_uses)',
      [code]
    );
    if (!claimed.rowCount) throw Object.assign(new Error('Invite is invalid or expired'), { status: 404 }); // rolls back the member insert
    return true;
  });

  if (joined) {
    sendToServerMembers(invite.server_id, {
      t: 'member.new',
      sid: invite.server_id,
      user: { id: user.id, name: user.display_name, color: user.color },
    }).catch(err => log.error('member.new broadcast failed', err));
  }
  sendJson(res, 200, { ok: true });
}

module.exports = async function inviteRoutes(ctx) {
  const createMatch = ctx.method === 'POST' && ctx.path.match(CREATE_INVITE);
  if (createMatch) {
    await createInvite(ctx, createMatch[1]);
    return true;
  }
  const joinMatch = ctx.method === 'POST' && ctx.path.match(JOIN_INVITE);
  if (joinMatch) {
    await joinWithInvite(ctx, joinMatch[1]);
    return true;
  }
  return false;
};
