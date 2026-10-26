'use strict';

// Friend lists. The `friends` table has one row per relationship:
//   a = who sent the request, b = who received it, status = 'pending' | 'accepted'.

const { query } = require('../db/pool');

const person = row => ({ id: row.id, username: row.username, name: row.name, color: row.color, avatar: row.avatar || null });

// -> { accepted: [person], incoming: [person who asked me], outgoing: [person I asked] }
async function friendLists(userId) {
  const rows = await query(
    `select f.a, f.status, o.id, o.username, o.display_name name, o.color, o.avatar
     from friends f join users o on o.id = case when f.a=$1 then f.b else f.a end
     where f.a=$1 or f.b=$1
     order by lower(o.display_name)`,
    [userId]
  );
  const lists = { accepted: [], incoming: [], outgoing: [] };
  for (const row of rows) {
    if (row.status === 'accepted') lists.accepted.push(person(row));
    else if (row.a === userId) lists.outgoing.push(person(row));
    else lists.incoming.push(person(row));
  }
  return lists;
}

module.exports = { friendLists };
