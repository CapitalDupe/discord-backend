'use strict';

// POST /register and POST /login (public).

const config = require('../../config');
const { limit } = require('../../lib/rateLimit');
const { newId, clip, safeEqual, fail } = require('../../lib/util');
const { queryOne, transaction } = require('../../db/pool');
const { hashPassword, verifyPassword } = require('../../auth/passwords');
const { createSession } = require('../../auth/sessions');
const { insertServer } = require('../../services/servers');
const { OFFICIAL_SRV, RESERVED } = require('../../services/official');
const { sendJson, readJsonBody } = require('../respond');

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

const HOUR = 36e5;
const QUARTER_HOUR = 9e5;

async function register(ctx) {
  const { req, res, ip } = ctx;

  // Abuse limits are checked before any expensive work (like hashing).
  if (!limit('reg:' + ip, 5, HOUR)) fail(429, 'Too many sign-ups, try later');
  if (!limit('reg:all', config.maxSignupsPerHour, HOUR)) fail(429, 'Sign-ups are very busy, try again later');

  const body = await readJsonBody(req);
  if (config.signupCode && !safeEqual(body.code, config.signupCode)) fail(403, 'Invalid signup code');

  const username = clip(body.username, 32).trim();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_PATTERN.test(username)) fail(400, 'Username: 3-32 letters, numbers, _ . -');
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) fail(400, 'Password must be 10-128 characters');
  if (RESERVED.test(username) || /official/i.test(username)) fail(400, 'That username is reserved');

  const passHash = await hashPassword(password);
  const userId = newId();

  try {
    // One transaction: the account, its personal Home server, and membership of the Official server.
    await transaction(async client => {
      await client.query(
        'insert into users(id,username,display_name,pass_hash) values($1,$2,$2,$3)',
        [userId, username, passHash]
      );
      await insertServer(client, userId, {
        id: newId(),
        name: 'Home',
        channels: [
          { id: newId(), name: 'general', type: 'text' },
          { id: newId(), name: 'random', type: 'text' },
        ],
      });
      await client.query('insert into members(server_id,user_id) values($1,$2) on conflict do nothing', [OFFICIAL_SRV, userId]);
    });
  } catch (err) {
    if (err.code === '23505') fail(409, 'Username already taken'); // unique violation
    throw err;
  }

  sendJson(res, 201, { token: await createSession(userId, req.headers['user-agent']) });
}

async function login(ctx) {
  const { req, res, ip } = ctx;

  const body = await readJsonBody(req);
  const username = clip(body.username, 32).trim().toLowerCase();
  if (!limit('login-ip:' + ip, 30, QUARTER_HOUR) || !limit('login-user:' + username, 10, QUARTER_HOUR)) {
    fail(429, 'Too many attempts, try again later');
  }

  const user = await queryOne('select id,pass_hash from users where lower(username)=$1', [username]);
  // Always verify (against a dummy hash if the user is unknown) so timing does not reveal which usernames exist.
  const passwordOk = await verifyPassword(user && user.pass_hash, body.password);
  if (!user || !passwordOk) fail(401, 'Wrong username or password');

  sendJson(res, 200, { token: await createSession(user.id, req.headers['user-agent']) });
}

module.exports = async function authRoutes(ctx) {
  if (ctx.method === 'POST' && ctx.path === '/register') {
    await register(ctx);
    return true;
  }
  if (ctx.method === 'POST' && ctx.path === '/login') {
    await login(ctx);
    return true;
  }
  return false;
};
