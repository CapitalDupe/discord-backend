'use strict';

// POST /dms  { userId }  (private)
// Opens (or finds) the direct-message conversation with another user.
// You can only message friends or people who share a server with you (everyone is in the
// Official server, so that one does not count).

const { newId, isId, fail, publicUser } = require('../../lib/util');
const { OFFICIAL_SRV } = require('../../services/official');
const { limit } = require('../../lib/rateLimit');
const { queryOne, transaction } = require('../../db/pool');
const { sendToUser } = require('../../realtime/connections');
const { sendJson, readJsonBody } = require('../respond');

const person = row => ({ id: row.id, username: row.username, name: row.name, color: row.color, avatar: row.avatar || null });

module.exports = async function dmRoutes(ctx) {
  if (ctx.method !== 'POST' || ctx.path !== '/dms') return false;
  const { req, res, user } = ctx;
  if (!limit('dm-open:' + user.id, 30, 36e5)) fail(429, 'Too many new conversations, try later');

  const body = await readJsonBody(req);
  if (!isId(body.userId) || body.userId === user.id) fail(400, 'Bad user');

  const target = await queryOne(
    'select id,username,display_name name,color,avatar,is_official from users where id=$1',
    [body.userId]
  );
  if (!target) fail(404, 'User not found');
  if (target.is_official) fail(403, "This account can't receive messages");

  const allowed = await queryOne(
    `select 1 x from friends where status='accepted' and ((a=$1 and b=$2) or (a=$2 and b=$1))
     union all
     select 1 from members m1 join members m2 on m2.server_id=m1.server_id
     where m1.user_id=$1 and m2.user_id=$2 and m1.server_id<>$3
     limit 1`,
    [user.id, target.id, OFFICIAL_SRV]
  );
  if (!allowed) fail(403, 'You can only message friends or people who share a server with you');

  let dm = await queryOne(
    `select c.id from channels c
     join dm_members a on a.channel_id=c.id and a.user_id=$1
     join dm_members b on b.channel_id=c.id and b.user_id=$2
     where c.type='dm'`,
    [user.id, target.id]
  );
  if (!dm) {
    dm = { id: newId() + newId() };
    await transaction(async client => {
      await client.query(`insert into channels(id,server_id,name,type) values($1,null,'dm','dm')`, [dm.id]);
      await client.query('insert into dm_members(channel_id,user_id) values($1,$2),($1,$3)', [dm.id, user.id, target.id]);
    });
    // Their open clients show the new conversation straight away.
    sendToUser(target.id, { t: 'dm.new', dm: { id: dm.id, user: person({ ...publicUser(user) }) } });
  }
  sendJson(res, 200, { id: dm.id, user: person(target) });
  return true;
};
