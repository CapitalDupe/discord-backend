'use strict';

// Tracks which WebSocket connections belong to which user and sends events to them.
// One user can have several connections (phone + laptop), so each user id maps to a Set.

const { query } = require('../db/pool');

const connections = new Map(); // userId -> Set of WebSocket

function add(ws) {
  const userId = ws.user.id;
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function remove(ws) {
  const sockets = connections.get(ws.user.id);
  if (!sockets) return;
  sockets.delete(ws);
  if (!sockets.size) connections.delete(ws.user.id);
}

// Send to every open connection of one user. `message` may be an object or an
// already-serialised string. `skipSocket` (optional) is left out, usually the sender.
function sendToUser(userId, message, skipSocket) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const ws of sockets) {
    if (ws !== skipSocket && ws.readyState === 1) ws.send(payload);
  }
}

// Send an event to every member of a server (used for messages, channel changes, joins).
async function sendToServerMembers(serverId, event, skipSocket) {
  const payload = JSON.stringify(event);
  const rows = await query('select user_id from members where server_id=$1', [serverId]);
  for (const row of rows) sendToUser(row.user_id, payload, skipSocket);
}

// Keep the cached name/colour on this user's open sockets in sync after a profile change.
function updateProfile(userId, displayName, color) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  for (const ws of sockets) {
    ws.user.display_name = displayName;
    ws.user.color = color;
  }
}

module.exports = { add, remove, sendToUser, sendToServerMembers, updateProfile };
