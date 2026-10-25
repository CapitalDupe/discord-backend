'use strict';

// The WebSocket server: authenticates the connection, applies flood limits,
// passes each event to events.js, and broadcasts the result.

const { WebSocketServer } = require('ws');
const config = require('../config');
const log = require('../lib/log');
const { findUserByToken } = require('../auth/sessions');
const connections = require('./connections');
const { handleEvent } = require('./events');

const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_EVENTS_PER_SECOND = 20;
const HEARTBEAT_MS = 30000;

// Sent to a client whose event was rejected so it reloads the real state.
const RESYNC = JSON.stringify({ t: 'resync' });

function safeSend(ws, payload) {
  if (ws.readyState === 1) ws.send(payload);
}

// Runs before the connection opens. The token arrives as ?token=... (browsers
// cannot set headers on WebSocket requests).
function authenticate(info, done) {
  if (config.allowedOrigin !== '*' && info.origin !== config.allowedOrigin) {
    return done(false, 403, 'Forbidden origin');
  }
  const token = new URL(info.req.url, 'http://x').searchParams.get('token');
  findUserByToken(token)
    .then(user => {
      if (!user) return done(false, 401, 'Unauthorized');
      info.req.user = user;
      done(true);
    })
    .catch(err => {
      log.error('websocket auth failed', err);
      done(false, 500);
    });
}

async function onMessage(ws, raw) {
  ws.eventCount += 1;
  if (ws.eventCount > MAX_EVENTS_PER_SECOND) {
    log.debug('websocket flood: dropped event from user ' + ws.user.id);
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    const result = await handleEvent(ws.user, event);
    if (result && result !== 'ok') {
      await connections.sendToServerMembers(result.sid, result.ev, ws); // the sender already applied it locally
    }
    if (!result) {
      log.debug('websocket event rejected: ' + (event && event.t) + ' from user ' + ws.user.id);
      safeSend(ws, RESYNC);
    }
  } catch (err) {
    if (err.status !== 403) log.error('websocket event failed: ' + (event && event.t), err);
    safeSend(ws, RESYNC);
  }
}

function onConnection(ws, req) {
  ws.user = req.user;
  ws.alive = true;
  ws.eventCount = 0;
  connections.add(ws);
  log.debug('websocket connected: user ' + ws.user.id);

  ws.on('close', () => connections.remove(ws));
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => onMessage(ws, raw));
}

function startTimers(wss) {
  // Reset every connection's per-second event counter.
  setInterval(() => wss.clients.forEach(ws => { ws.eventCount = 0; }), 1000).unref();

  // Ping everyone; drop connections that did not answer the previous ping.
  setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      ws.ping();
    });
  }, HEARTBEAT_MS).unref();
}

// Call once with the Node http server.
function attachGateway(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: authenticate,
  });
  wss.on('connection', onConnection);
  startTimers(wss);
  return wss;
}

module.exports = { attachGateway };
