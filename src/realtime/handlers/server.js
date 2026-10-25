'use strict';

// WebSocket events about servers. Result contract: see handlers/message.js.

const { query, queryOne, transaction } = require('../../db/pool');
const { clip, isId } = require('../../lib/util');
const { cleanChannel, insertServer } = require('../../services/servers');
const { sendToUser } = require('../connections');

const MAX_SERVERS_PER_USER = 10;
const MAX_CHANNELS_ON_CREATE = 20;
const MAX_SERVER_NAME_LENGTH = 50;

module.exports = {
  // Create a server. The client picks the server and channel ids.
  'srv.new': async (user, e) => {
    const s = e.s;
    const name = s && clip(s.name, MAX_SERVER_NAME_LENGTH).trim();
    if (!name || !isId(s.id)) return null;

    const owned = await queryOne('select count(*)::int n from servers where owner_id=$1', [user.id]);
    if (owned.n >= MAX_SERVERS_PER_USER) return null;

    const channels = (Array.isArray(s.channels) ? s.channels : [])
      .slice(0, MAX_CHANNELS_ON_CREATE)
      .map(cleanChannel)
      .filter(Boolean);

    await transaction(client => insertServer(client, user.id, { id: s.id, name, channels }));
    return { sid: s.id, ev: { t: 'srv.new', s: { id: s.id, name, channels } } };
  },

  // Delete a server you own. Every member is told to drop it.
  'srv.del': async (user, e) => {
    if (!isId(e.sid)) return null;

    // Look up members first: after the delete they are gone (cascade).
    const members = await query('select user_id from members where server_id=$1', [e.sid]);
    const deleted = await queryOne('delete from servers where id=$1 and owner_id=$2 returning id', [e.sid, user.id]);
    if (!deleted) return null;

    for (const member of members) sendToUser(member.user_id, { t: 'srv.del', sid: e.sid });
    return 'ok';
  },
};
