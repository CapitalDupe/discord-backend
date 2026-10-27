'use strict';

// Friends (private):
//   GET    /friends               my friends, incoming and outgoing requests, and who is online
//   POST   /friends               { username }  send a request (or accept if they already asked me)
//   POST   /friends/:id/accept    accept a request someone sent me
//   DELETE /friends/:id           remove a friend, decline a request, or cancel mine

const { limit } = require('../../lib/rateLimit');
const { clip, fail } = require('../../lib/util');
const { query, queryOne } = require('../../db/pool');
const { friendLists } = require('../../services/friends');
const { sendToUser, statusOf } = require('../../realtime/connections');
const { sendJson, readJsonBody } = require('../respond');

const ONE_FRIEND = /^\/friends\/([A-Za-z0-9_-]+)(\/accept)?$/;

const refresh = (...ids) => ids.forEach(id => sendToUser(id, { t: 'friends.update' })); // clients re-fetch GET /friends

async function list(ctx) {
  const lists = await friendLists(ctx.user.id);
  const presence = {};
  for (const person of lists.accepted) if (statusOf(person.id) !== 'offline') presence[person.id] = statusOf(person.id);
  sendJson(ctx.res, 200, { ...lists, presence });
}

async function sendRequest(ctx) {
  const { req, res, user } = ctx;
  if (!limit('friend-req:' + user.id, 20, 36e5)) fail(429, 'Too many friend requests, try later');

  const body = await readJsonBody(req);
  const name = clip(body.username, 33).trim().replace(/^@/, '').toLowerCase();
  const target = name && (await queryOne('select id from users where lower(username)=$1 and not is_official', [name]));
  if (!target) fail(404, 'No user with that username');
  if (target.id === user.id) fail(400, "You can't add yourself");

  const existing = await queryOne(
    'select a,status from friends where (a=$1 and b=$2) or (a=$2 and b=$1)',
    [user.id, target.id]
  );
  if (existing && existing.status === 'accepted') fail(409, 'You are already friends');
  if (existing && existing.a === user.id) fail(409, 'Request already sent');

  if (existing) {
    // They had already asked me: asking back makes us friends.
    await query(`update friends set status='accepted' where a=$1 and b=$2`, [target.id, user.id]);
  } else {
    await query(`insert into friends(a,b,status) values($1,$2,'pending')`, [user.id, target.id]);
  }
  refresh(user.id, target.id);
  sendJson(res, 200, { ok: true });
}

async function accept(ctx, requesterId) {
  const row = await queryOne(
    `update friends set status='accepted' where a=$1 and b=$2 and status='pending' returning a`,
    [requesterId, ctx.user.id]
  );
  if (!row) fail(404, 'No such request');
  refresh(ctx.user.id, requesterId);
  sendJson(ctx.res, 200, { ok: true });
}

async function remove(ctx, otherId) {
  await query('delete from friends where (a=$1 and b=$2) or (a=$2 and b=$1)', [ctx.user.id, otherId]);
  refresh(ctx.user.id, otherId);
  sendJson(ctx.res, 200, { ok: true });
}

module.exports = async function friendRoutes(ctx) {
  const { method, path } = ctx;
  if (path === '/friends') {
    if (method === 'GET') { await list(ctx); return true; }
    if (method === 'POST') { await sendRequest(ctx); return true; }
    return false;
  }
  const match = path.match(ONE_FRIEND);
  if (!match) return false;
  if (method === 'POST' && match[2]) { await accept(ctx, match[1]); return true; }
  if (method === 'DELETE' && !match[2]) { await remove(ctx, match[1]); return true; }
  return false;
};
