'use strict';

// Decides which route file handles a request.
//
// Every route file exports  async (ctx) => boolean  and returns true once it has
// sent a response, false if the request is not one of its routes.
//   ctx = { req, res, method, path, ip }       always
//   ctx also has { user, token }               for the private routes below
//
// To add an endpoint: add it to a file in ./routes (or create a new file and list it here).

const { fail } = require('../lib/util');
const { clientIp } = require('../lib/clientIp');
const { findUserByToken } = require('../auth/sessions');

// No login needed.
const PUBLIC_ROUTES = [
  require('./routes/health'),
  require('./routes/auth'),
  require('./routes/official'),
];

// Login required (Authorization: Bearer <token>).
const PRIVATE_ROUTES = [
  require('./routes/account'),
  require('./routes/invites'),
  require('./routes/roles'),
  require('./routes/members'),
];

async function route(req, res, path) {
  const ctx = { req, res, method: req.method, path, ip: clientIp(req) };

  for (const handler of PUBLIC_ROUTES) {
    if (await handler(ctx)) return;
  }

  const token = (req.headers.authorization || '').replace(/^bearer +/i, '');
  const user = await findUserByToken(token);
  if (!user) fail(401, 'Not signed in');
  ctx.token = token;
  ctx.user = user;

  for (const handler of PRIVATE_ROUTES) {
    if (await handler(ctx)) return;
  }

  fail(404, 'Not found');
}

module.exports = { route };
