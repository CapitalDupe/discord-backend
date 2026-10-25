'use strict';

// Small helpers used everywhere. Keep this file free of database or HTTP code.

const crypto = require('crypto');

// 12-character random hex id (used for users, servers, roles...).
const newId = () => crypto.randomBytes(6).toString('hex');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// Cut a value down to at most n characters. Returns '' if it is not a string.
const clip = (value, n) => (typeof value === 'string' ? value.slice(0, n) : '');

// IDs come from clients, so only accept short strings of letters, digits, _ and -.
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);

// Constant-time comparison of two secrets. Hashing first makes both the same length.
const safeEqual = (a, b) =>
  typeof a === 'string' &&
  crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

// Throw an error that the HTTP layer (src/http/app.js) turns into a JSON error
// response with this status code.
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

// What other users are allowed to see about an account.
const publicUser = user => ({
  id: user.id,
  name: user.display_name,
  color: user.color,
  username: user.username,
});

module.exports = { newId, sha256, clip, isId, safeEqual, fail, publicUser };
