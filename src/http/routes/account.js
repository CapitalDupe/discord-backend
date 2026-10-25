'use strict';

// Routes about the logged-in account (private):
//   POST /logout   end this session
//   GET  /me       who am I
//   GET  /state    everything the client needs to render (servers, channels, recent messages)

const { publicUser } = require('../../lib/util');
const { deleteSession } = require('../../auth/sessions');
const { loadState } = require('../../services/state');
const { sendJson } = require('../respond');

module.exports = async function accountRoutes(ctx) {
  const { res, method, path, user, token } = ctx;

  if (method === 'POST' && path === '/logout') {
    await deleteSession(token);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (method === 'GET' && path === '/me') {
    sendJson(res, 200, publicUser(user));
    return true;
  }
  if (method === 'GET' && path === '/state') {
    sendJson(res, 200, await loadState(user));
    return true;
  }
  return false;
};
