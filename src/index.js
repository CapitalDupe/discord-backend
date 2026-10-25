'use strict';

// Entry point: `node src/index.js`
// Order matters: check the config first, then prepare the database, then listen.

const config = require('./config');
config.validate();

const fs = require('fs');
const path = require('path');
const log = require('./lib/log');
const { pool } = require('./db/pool');
const { purgeExpired } = require('./auth/sessions');
const { ensureOfficial } = require('./services/official');
const { createApp } = require('./http/app');
const { attachGateway } = require('./realtime/gateway');

process.on('unhandledRejection', err => log.error('unhandled rejection', err));

async function main() {
  // 1. Create/upgrade tables (idempotent).
  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  log.info('database schema is ready');

  // 2. Make sure the Official account and server exist.
  await ensureOfficial();

  // 3. Start HTTP + WebSocket.
  const server = createApp();
  attachGateway(server);
  setInterval(() => purgeExpired().catch(err => log.warn('cleanup failed', err)), 36e5).unref();

  server.listen(config.port, () => log.info('Listening on :' + config.port));

  // 4. Shut down cleanly when Docker/Render asks us to stop.
  const shutdown = signal => {
    log.info('received ' + signal + ', shutting down');
    server.close();
    pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  log.error('startup failed', err);
  process.exit(1);
});
