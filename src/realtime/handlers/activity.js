'use strict';

// Ephemeral WebSocket events: typing indicators and idle/online status.
// Nothing here is stored. Result contract: see handlers/message.js.

const { limit } = require('../../lib/rateLimit');
const { P } = require('../../permissions/bits');
const { getChannelContext } = require('../../permissions/access');
const { setIdle } = require('../connections');

module.exports = {
  // "X is typing" in a channel or DM. Rate limited; silently ignored when not allowed
  // (returning null would make the client reload its state).
  typing: async (user, e) => {
    if (!limit('typing:' + user.id, 8, 10000)) return 'ok';
    const { serverId, users, access } = await getChannelContext(user.id, e.cid);
    if (!access || !(access.perms & P.SEND)) return 'ok';
    return { sid: serverId, users, ev: { t: 'typing', cid: e.cid, uid: user.id, name: user.display_name } };
  },

  // The client reports 'idle' after a few minutes of no activity and 'online' when you come back.
  presence: async (user, e) => {
    if (limit('presence:' + user.id, 10, 60000)) setIdle(user.id, e.s === 'idle');
    return 'ok';
  },
};
