'use strict';

// Helpers for creating servers and validating channels.

const { newId, clip, isId } = require('../lib/util');
const { DEFAULT_PERMS } = require('../permissions/bits');

// Validates one channel object sent by a client.
// Returns { id, name, type } or null if it is not acceptable.
function cleanChannel(channel) {
  const name = channel && clip(channel.name, 50).trim();
  if (!channel || !isId(channel.id) || !name) return null;
  return { id: channel.id, name, type: channel.type === 'voice' ? 'voice' : 'text' };
}

// Inserts a server, its @everyone role, its owner as the first member, and its
// channels. `client` must be a transaction client (see db/pool.js) so that a
// failure part-way leaves nothing half-created.
async function insertServer(client, ownerId, server) {
  await client.query('insert into servers(id,name,owner_id) values($1,$2,$3)', [server.id, server.name, ownerId]);
  await client.query(
    `insert into roles(id,server_id,name,perms,position,is_default) values($1,$2,'@everyone',$3,0,true)`,
    [newId(), server.id, DEFAULT_PERMS]
  );
  await client.query('insert into members(server_id,user_id) values($1,$2)', [server.id, ownerId]);
  for (const channel of server.channels) {
    await client.query(
      'insert into channels(id,server_id,name,type) values($1,$2,$3,$4)',
      [channel.id, server.id, channel.name, channel.type]
    );
  }
}

module.exports = { cleanChannel, insertServer };
