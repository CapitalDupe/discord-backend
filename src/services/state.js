'use strict';

// Builds the full snapshot a client loads after logging in (GET /api/state) or
// after the server tells it to resync: its servers, their channels, the last 50
// messages per channel and per direct message, reactions, who is in each server,
// its friends, and who is online.

const { query } = require('../db/pool');
const { publicUser } = require('../lib/util');
const { friendLists } = require('./friends');
const { statusOf, audienceOf } = require('../realtime/connections');
const { OFFICIAL_SRV } = require('./official');

const MESSAGES_PER_CHANNEL = 50;

const personRow = row => ({ id: row.id, username: row.username, name: row.name, color: row.color, avatar: row.avatar || null });

async function loadState(user) {
  const servers = await query(
    'select s.id,s.name from servers s join members m on m.server_id=s.id where m.user_id=$1 order by m.joined_at',
    [user.id]
  );
  const serverIds = servers.map(s => s.id);

  const channels = serverIds.length
    ? await query('select id,server_id,name,type from channels where server_id=any($1) order by pos', [serverIds])
    : [];

  // Direct messages: one channel per conversation, plus who is on the other end.
  const dmRows = await query(
    `select c.id, o.id uid, o.username, o.display_name name, o.color, o.avatar
     from channels c
     join dm_members me on me.channel_id=c.id and me.user_id=$1
     join dm_members other on other.channel_id=c.id and other.user_id<>$1
     join users o on o.id=other.user_id
     where c.type='dm'`,
    [user.id]
  );
  const dms = dmRows.map(row => ({ id: row.id, user: personRow({ ...row, id: row.uid }) }));

  const channelIds = channels.map(c => c.id).concat(dms.map(d => d.id));

  // Newest N messages per channel, returned oldest-first.
  const messageRows = channelIds.length
    ? await query(
        `select * from (
           select m.id, m.channel_id, m.user_id, m.text, m.edited, m.reply_to, m.att,
                  floor(extract(epoch from m.ts)*1000)::float8 ts,
                  coalesce(u.display_name,'Deleted user') name,
                  coalesce(u.color,'#949ba4') color,
                  u.username un, u.avatar,
                  coalesce(u.is_official,false) official,
                  row_number() over(partition by m.channel_id order by m.ts desc, m.id) rn
           from messages m left join users u on u.id=m.user_id
           where m.channel_id=any($1)
         ) x
         where rn<=${MESSAGES_PER_CHANNEL}
         order by ts, id`,
        [channelIds]
      )
    : [];

  const reactionRows = messageRows.length
    ? await query(
        'select message_id,emoji,array_agg(user_id) users from reactions where message_id=any($1) group by 1,2',
        [messageRows.map(m => m.id)]
      )
    : [];

  // The message each reply points at (it may be older than the 50 we loaded).
  const replyIds = [...new Set(messageRows.map(m => m.reply_to).filter(Boolean))];
  const replyRows = replyIds.length
    ? await query(
        `select m.id, left(m.text,120) text, coalesce(u.display_name,'Deleted user') name
         from messages m left join users u on u.id=m.user_id where m.id=any($1)`,
        [replyIds]
      )
    : [];
  const repliesById = Object.fromEntries(replyRows.map(r => [r.id, r]));

  // Everyone you share a server with, and which server each of them is in. Every account is in the
  // Official server, so only the Official account itself is listed there (no directory of all users).
  const memberRows = serverIds.length
    ? await query(
        `select m.server_id sid, u.id, u.display_name as name, u.color, u.is_official as official, u.username, u.avatar
         from members m join users u on u.id=m.user_id
         where m.server_id=any($1) and u.id<>$2 and (m.server_id<>$3 or u.is_official)`,
        [serverIds, user.id, OFFICIAL_SRV]
      )
    : [];
  const members = [...new Map(memberRows.map(r => [r.id, { ...personRow(r), official: r.official }])).values()];
  const serverMembers = {};
  for (const row of memberRows) (serverMembers[row.sid] ??= []).push(row.id);

  // reactionsByMessage[messageId][emoji] = [userId, ...]
  const reactionsByMessage = {};
  for (const row of reactionRows) {
    if (!reactionsByMessage[row.message_id]) reactionsByMessage[row.message_id] = {};
    reactionsByMessage[row.message_id][row.emoji] = row.users;
  }

  // messagesByChannel[channelId] = [message, ...] in the compact shape the frontend expects.
  const messagesByChannel = {};
  for (const m of messageRows) {
    if (!messagesByChannel[m.channel_id]) messagesByChannel[m.channel_id] = [];
    const reply = m.reply_to && (repliesById[m.reply_to] || { id: m.reply_to, name: 'Unknown', text: '' });
    messagesByChannel[m.channel_id].push({
      id: m.id,
      uid: m.user_id,
      un: m.un || null,
      avatar: m.avatar || null,
      name: m.name,
      color: m.color,
      ts: m.ts,
      text: m.text,
      ...(m.official ? { official: 1 } : {}),
      ...(m.edited ? { edited: 1 } : {}),
      ...(reply ? { reply } : {}),
      ...(m.att ? { att: m.att } : {}),
      ...(reactionsByMessage[m.id] ? { r: reactionsByMessage[m.id] } : {}),
    });
  }

  // Who is online right now, among everyone this user can see.
  const presence = {};
  for (const id of await audienceOf(user.id)) {
    const status = statusOf(id);
    if (id !== user.id && status !== 'offline') presence[id] = status;
  }

  return {
    user: publicUser(user),
    members,
    sm: serverMembers,
    messages: messagesByChannel,
    dms,
    friends: await friendLists(user.id),
    presence,
    servers: servers.map(server => ({
      ...server,
      channels: channels
        .filter(c => c.server_id === server.id)
        .map(({ id, name, type }) => ({ id, name, type })),
    })),
  };
}

module.exports = { loadState };
