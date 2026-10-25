'use strict';

// Permission bits. A member's permissions are the OR of the bits of the
// @everyone role plus every role they hold. The server owner and anyone with
// ADMIN get everything.

const P = {
  VIEW: 1,
  SEND: 2,
  MANAGE_MESSAGES: 4,
  MANAGE_CHANNELS: 8,
  MANAGE_SERVER: 16,
  MANAGE_ROLES: 32,
  INVITE: 64,
  KICK: 128,
  ADMIN: 1 << 30,
};

const ALL = 0x7fffffff;

// What the @everyone role starts with in a new server.
const DEFAULT_PERMS = P.VIEW | P.SEND | P.INVITE;

module.exports = { P, ALL, DEFAULT_PERMS };
