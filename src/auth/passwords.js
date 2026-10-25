'use strict';

// Password hashing with Argon2id.

const argon2 = require('argon2');

const hashPassword = password => argon2.hash(password, { type: argon2.argon2id });

// Hashed once at startup (it is a promise). Verifying against it when a username
// does not exist keeps login timing similar for known and unknown usernames.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

// storedHash may be undefined (unknown user). Always resolves to a boolean and
// never throws, even if the stored value is not a valid hash (e.g. the Official account).
async function verifyPassword(storedHash, password) {
  const hash = storedHash || (await DUMMY_HASH);
  const attempt = typeof password === 'string' ? password : '';
  return argon2.verify(hash, attempt).catch(() => false);
}

module.exports = { hashPassword, verifyPassword };
