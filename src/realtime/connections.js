'use strict';

// Tracks which WebSocket connections belong to which user and sends events to them.
// One user can have several connections (phone + laptop), so each user id maps to a Set.

const { query } = require('../db/pool');
const log = require('../lib/log');
const { OFFICIAL_SRV } = require('../services/official');

const connections = new Map(); // userId -> Set of WebSocket
const idle = new Set();        // userIds that told us they are idle (only while connected)

function add(ws) {
  const userId = ws.user.id;
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
  if (connections.get(userId).size === 1) announcePresence(userId); // first device came online
}

function remove(ws) {
  const sockets = connections.get(ws.user.id);
  if (!sockets) return;
  sockets.delete(ws);
  if (!sockets.size) {
    connections.delete(ws.user.id);
    idle.delete(ws.user.id);
    announcePresence(ws.user.id); // last device went away
  }
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

// Send one event to a list of users (direct messages, typing in a DM).
function sendToUsers(userIds, event, skipSocket) {
  const payload = JSON.stringify(event);
  for (const id of userIds) sendToUser(id, payload, skipSocket);
}

// Keep the cached name/colour/avatar on this user's open sockets in sync after a profile change.
function updateProfile(userId, displayName, color, avatar) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  for (const ws of sockets) {
    ws.user.display_name = displayName;
    ws.user.color = color;
    ws.user.avatar = avatar;
  }
}

// ---- presence -------------------------------------------------------------
// 'online' while a user has a connection, 'idle' if their client said so, else 'offline'.
// Held in memory only (single container); it is never written to the database.

const statusOf = userId => (connections.has(userId) ? (idle.has(userId) ? 'idle' : 'online') : 'offline');

// Everyone who may see this user's profile and presence: people who share a server (not counting the
// Official server, which every account joins), accepted friends and direct-message partners.
// Always includes the user themself.
async function audienceOf(userId) {
  const rows = await query(
    `select distinct id from (
       select m2.user_id id from members m1 join members m2 on m2.server_id=m1.server_id where m1.user_id=$1 and m1.server_id<>$2
       union all select case when a=$1 then b else a end from friends where status='accepted' and (a=$1 or b=$1)
       union all select d2.user_id from dm_members d1 join dm_members d2 on d2.channel_id=d1.channel_id where d1.user_id=$1
       union all select $1::text
     ) t`,
    [userId, OFFICIAL_SRV]
  );
  return rows.map(row => row.id);
}

async function sendToAudience(userId, event, includeSelf) {
  const payload = JSON.stringify(event);
  for (const id of await audienceOf(userId)) {
    if (includeSelf || id !== userId) sendToUser(id, payload);
  }
}

function announcePresence(userId) {
  sendToAudience(userId, { t: 'presence', uid: userId, s: statusOf(userId) }, false).catch(err => log.warn('presence broadcast failed', err));
}

function setIdle(userId, isIdle) {
  if (isIdle === idle.has(userId)) return;
  if (isIdle) idle.add(userId); else idle.delete(userId);
  announcePresence(userId);
}

module.exports = { add, remove, sendToUser, sendToUsers, sendToServerMembers, sendToAudience, updateProfile, statusOf, audienceOf, setIdle };
