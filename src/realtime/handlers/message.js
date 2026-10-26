'use strict';

// WebSocket events about messages.
//
// Every handler is  async (user, event) => result  where result is one of:
//   { sid, ev }     broadcast `ev` to every member of server `sid` (except the sender)
//   { users, ev }   broadcast `ev` to these users (a direct-message conversation)
//   'ok'            handled, nothing to broadcast
//   null            rejected; the gateway tells the client to resync its state

const { query, queryOne } = require('../../db/pool');
const { clip, isId } = require('../../lib/util');
const { P } = require('../../permissions/bits');
const { getChannelContext } = require('../../permissions/access');

const MAX_MESSAGE_LENGTH = 4000;
const MAX_EMOJI_LENGTH = 8;
const MAX_ATTACHMENTS = 5;

// Only files this user uploaded can be attached (the client sends ids, we look up the rest).
async function ownedUploads(userId, list) {
  if (!Array.isArray(list)) return [];
  const ids = [...new Set(list.map(item => item && item.id).filter(isId))].slice(0, MAX_ATTACHMENTS);
  if (!ids.length) return [];
  return query('select id,name,mime,size from uploads where id=any($1) and user_id=$2', [ids, userId]);
}

// The message being replied to must be in the same channel; we send a short snippet of it.
async function replySnippet(reply, channelId) {
  if (!reply || !isId(reply.id)) return null;
  return queryOne(
    `select m.id, left(m.text,120) text, coalesce(u.display_name,'Deleted user') name
     from messages m left join users u on u.id=m.user_id where m.id=$1 and m.channel_id=$2`,
    [reply.id, channelId]
  );
}

module.exports = {
  // Post a new message. The client picks the message id, so resending after a
  // reconnect cannot create a duplicate (ON CONFLICT DO NOTHING).
  'msg.new': async (user, e) => {
    if (!e.m || !isId(e.m.id)) return null;
    const text = clip(e.m.text, MAX_MESSAGE_LENGTH).trim();

    const { serverId, users, access } = await getChannelContext(user.id, e.cid);
    if (!access || !(access.perms & P.SEND)) return null;

    const attachments = await ownedUploads(user.id, e.m.att);
    if (!text && !attachments.length) return null;
    const reply = await replySnippet(e.m.reply, e.cid);

    const row = await queryOne(
      'insert into messages(id,channel_id,user_id,text,reply_to,att) values($1,$2,$3,$4,$5,$6) on conflict do nothing returning floor(extract(epoch from ts)*1000)::float8 as ts',
      [e.m.id, e.cid, user.id, text, reply ? reply.id : null, attachments.length ? JSON.stringify(attachments) : null]
    );
    if (!row) return null;

    return {
      sid: serverId,
      users,
      ev: {
        t: 'msg.new',
        cid: e.cid,
        m: {
          id: e.m.id,
          uid: user.id,
          un: user.username,
          avatar: user.avatar || null,
          name: user.display_name,
          color: user.color,
          ts: row.ts,
          text,
          ...(reply ? { reply } : {}),
          ...(attachments.length ? { att: attachments } : {}),
        },
      },
    };
  },

  // Edit your own message.
  'msg.edit': async (user, e) => {
    const text = clip(e.text, MAX_MESSAGE_LENGTH).trim();
    const { serverId, users, access } = await getChannelContext(user.id, e.cid);
    if (!text || !access || !isId(e.id)) return null;

    const row = await queryOne(
      'update messages set text=$1,edited=true where id=$2 and channel_id=$3 and user_id=$4 returning id',
      [text, e.id, e.cid, user.id]
    );
    return row ? { sid: serverId, users, ev: { t: 'msg.edit', cid: e.cid, id: e.id, text } } : null;
  },

  // Delete your own message, or any message if you have MANAGE_MESSAGES.
  'msg.del': async (user, e) => {
    const { serverId, users, access } = await getChannelContext(user.id, e.cid);
    if (!access || !isId(e.id)) return null;

    const canModerate = !!(access.perms & P.MANAGE_MESSAGES);
    const row = await queryOne(
      'delete from messages where id=$1 and channel_id=$2 and (user_id=$3 or $4) returning id',
      [e.id, e.cid, user.id, canModerate]
    );
    return row ? { sid: serverId, users, ev: { t: 'msg.del', cid: e.cid, id: e.id } } : null;
  },

  // Toggle a reaction: add it, or remove it if you already reacted with that emoji.
  'msg.react': async (user, e) => {
    const emoji = clip(e.emoji, MAX_EMOJI_LENGTH);
    const { serverId, users, access } = await getChannelContext(user.id, e.cid);
    if (!emoji || !access || !(access.perms & P.VIEW) || !isId(e.id)) return null;

    const exists = await queryOne('select 1 x from messages where id=$1 and channel_id=$2', [e.id, e.cid]);
    if (!exists) return null;

    const removed = await queryOne(
      'delete from reactions where message_id=$1 and user_id=$2 and emoji=$3 returning 1 x',
      [e.id, user.id, emoji]
    );
    if (!removed) {
      await query('insert into reactions(message_id,user_id,emoji) values($1,$2,$3)', [e.id, user.id, emoji]);
    }
    return { sid: serverId, users, ev: { t: 'msg.react', cid: e.cid, id: e.id, emoji, uid: user.id } };
  },
};
