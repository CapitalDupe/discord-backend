'use strict';

// POST /official/announce - post as the Official account.
// Needs the X-Admin-Key header to equal ADMIN_KEY. If ADMIN_KEY is unset the
// route answers 404, as if it did not exist.

const config = require('../../config');
const { limit } = require('../../lib/rateLimit');
const { newId, clip, safeEqual, fail } = require('../../lib/util');
const { queryOne } = require('../../db/pool');
const { sendToServerMembers } = require('../../realtime/connections');
const { OFFICIAL_ID, OFFICIAL_SRV, OFFICIAL_ANN } = require('../../services/official');
const { sendJson, readJsonBody } = require('../respond');

module.exports = async function officialRoutes(ctx) {
  if (ctx.method !== 'POST' || ctx.path !== '/official/announce') return false;
  const { req, res, ip } = ctx;

  if (!config.adminKey || !safeEqual(req.headers['x-admin-key'], config.adminKey)) fail(404, 'Not found');
  if (!limit('announce:' + ip, 10, 36e5)) fail(429, 'Too many requests');

  const body = await readJsonBody(req);
  const text = clip(body.text, 4000).trim();
  if (!text) fail(400, 'Text required');

  const id = newId();
  const row = await queryOne(
    'insert into messages(id,channel_id,user_id,text) values($1,$2,$3,$4) returning floor(extract(epoch from ts)*1000)::float8 as ts',
    [id, OFFICIAL_ANN, OFFICIAL_ID, text]
  );
  await sendToServerMembers(OFFICIAL_SRV, {
    t: 'msg.new',
    cid: OFFICIAL_ANN,
    m: { id, uid: OFFICIAL_ID, un: 'official', name: 'Official', color: '#5865f2', ts: row.ts, text, official: 1 },
  });

  sendJson(res, 201, { id });
  return true;
};
