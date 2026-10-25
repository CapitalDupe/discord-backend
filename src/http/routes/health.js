'use strict';

// GET /healthz - used by Docker, Render and uptime checks. No login, no database.

module.exports = async function healthRoutes(ctx) {
  if (ctx.path !== '/healthz') return false;
  ctx.res.writeHead(200).end('ok');
  return true;
};
