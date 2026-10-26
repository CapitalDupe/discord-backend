'use strict';

// Login sessions. The client holds a random token; the database only ever stores
// the SHA-256 of it, so a leaked database does not leak usable tokens.

const crypto = require('crypto');
const { query, queryOne } = require('../db/pool');
const { sha256, clip } = require('../lib/util');

const MAX_SESSIONS_PER_USER = 20;

async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `insert into sessions(id,user_id,expires_at,user_agent) values($1,$2,now()+interval '30 days',$3)`,
    [sha256(token), userId, clip(userAgent, 200)]
  );
  // Keep only the newest sessions for this user.
  await query(
    'delete from sessions where user_id=$1 and id not in (select id from sessions where user_id=$1 order by created_at desc limit ' + MAX_SESSIONS_PER_USER + ')',
    [userId]
  );
  return token;
}

// token -> { id, username, display_name, color }, or null if the token is missing,
// unknown or expired. Always returns a promise.
async function findUserByToken(token) {
  if (!token) return null;
  const user = await queryOne(
    'select u.id,u.username,u.display_name,u.color,u.avatar from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now()',
    [sha256(token)]
  );
  return user || null;
}

async function deleteSession(token) {
  await query('delete from sessions where id=$1', [sha256(token)]);
}

// Run hourly from src/index.js.
async function purgeExpired() {
  await query('delete from sessions where expires_at<now()');
  await query('delete from invites where expires_at<now()');
}

module.exports = { createSession, findUserByToken, deleteSession, purgeExpired };
