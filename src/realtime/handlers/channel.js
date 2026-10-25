'use strict';

// WebSocket events about channels. Result contract: see handlers/message.js.

const { query, queryOne } = require('../../db/pool');
const { isId } = require('../../lib/util');
const { P } = require('../../permissions/bits');
const { getAccess, need } = require('../../permissions/access');
const { cleanChannel } = require('../../services/servers');

const MAX_CHANNELS_PER_SERVER = 50;

module.exports = {
  // Add a channel (needs MANAGE_CHANNELS).
  'ch.new': async (user, e) => {
    if (!isId(e.sid)) return null;
    need(await getAccess(user.id, e.sid), P.MANAGE_CHANNELS); // throws 403 if not allowed

    const channel = cleanChannel(e.c);
    if (!channel) return null;

    const count = await queryOne('select count(*)::int n from channels where server_id=$1', [e.sid]);
    if (count.n >= MAX_CHANNELS_PER_SERVER) return null;

    await query(
      'insert into channels(id,server_id,name,type) values($1,$2,$3,$4)',
      [channel.id, e.sid, channel.name, channel.type]
    );
    return { sid: e.sid, ev: { t: 'ch.new', sid: e.sid, c: channel } };
  },

  // Delete a channel (needs MANAGE_CHANNELS).
  'ch.del': async (user, e) => {
    if (!isId(e.sid) || !isId(e.cid)) return null;
    need(await getAccess(user.id, e.sid), P.MANAGE_CHANNELS);

    const deleted = await queryOne('delete from channels where id=$1 and server_id=$2 returning id', [e.cid, e.sid]);
    return deleted ? { sid: e.sid, ev: { t: 'ch.del', sid: e.sid, cid: e.cid } } : null;
  },
};
