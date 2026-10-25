'use strict';

// Builds the full snapshot a client loads after logging in (GET /api/state) or
// after the server tells it to resync: its servers, their channels, the last 50
// messages per channel, reactions, and everyone it shares a server with.

const { query } = require('../db/pool');
const { publicUser } = require('../lib/util');

const MESSAGES_PER_CHANNEL = 50;

async function loadState(user) {
  const servers = await query(
    'select s.id,s.name from servers s join members m on m.server_id=s.id where m.user_id=$1 order by m.joined_at',
    [user.id]
  );
  const serverIds = servers.map(s => s.id);

  const channels = serverIds.length
    ? await query('select id,server_id,name,type from channels where server_id=any($1) order by pos', [serverIds])
    : [];
  const channelIds = channels.map(c => c.id);

  // Newest N messages per channel, returned oldest-first.
  const messageRows = channelIds.length
    ? await query(
        `select * from (
           select m.id, m.channel_id, m.user_id, m.text, m.edited,
                  floor(extract(epoch from m.ts)*1000)::float8 ts,
                  coalesce(u.display_name,'Deleted user') name,
                  coalesce(u.color,'#949ba4') color,
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

  const members = serverIds.length
    ? await query(
        'select distinct u.id,u.display_name as name,u.color,u.is_official as official from members m join users u on u.id=m.user_id where m.server_id=any($1) and u.id<>$2',
        [serverIds, user.id]
      )
    : [];

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
    messagesByChannel[m.channel_id].push({
      id: m.id,
      uid: m.user_id,
      name: m.name,
      color: m.color,
      ts: m.ts,
      text: m.text,
      ...(m.official ? { official: 1 } : {}),
      ...(m.edited ? { edited: 1 } : {}),
      ...(reactionsByMessage[m.id] ? { r: reactionsByMessage[m.id] } : {}),
    });
  }

  return {
    user: publicUser(user),
    members,
    messages: messagesByChannel,
    servers: servers.map(server => ({
      ...server,
      channels: channels
        .filter(c => c.server_id === server.id)
        .map(({ id, name, type }) => ({ id, name, type })),
    })),
  };
}

module.exports = { loadState };
