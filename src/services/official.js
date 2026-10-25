'use strict';

// The built-in Official platform account and its read-only server.
//   - nobody can log in as it (its pass_hash is not a valid hash)
//   - its username is reserved (see RESERVED, used by registration)
//   - every account is auto-joined to its server
//   - only POST /api/official/announce (needs ADMIN_KEY) can post in it

const { transaction } = require('../db/pool');
const { P } = require('../permissions/bits');

const OFFICIAL_ID = 'official';
const OFFICIAL_SRV = 'official-hq';
const OFFICIAL_ANN = 'official-news';
const OFFICIAL_RULES = 'official-rules';

const RESERVED = /^(official|admin|administrator|system|staff|support|moderator|mod|everyone|here|discord|root|owner)$/i;

const SEED_MESSAGES = [
  [OFFICIAL_RULES, 'official-m1', 'Welcome! Be kind, no spam, no harassment. Server owners and moderators can remove members who break these rules.'],
  [OFFICIAL_ANN, 'official-m2', 'Official announcements appear here. Only the platform account can post in this server.'],
];

// Safe to run on every start: everything uses ON CONFLICT DO NOTHING.
async function ensureOfficial() {
  await transaction(async client => {
    await client.query(
      `insert into users(id,username,display_name,color,pass_hash,is_official) values($1,'official','Official','#5865f2','!',true) on conflict (id) do nothing`,
      [OFFICIAL_ID]
    );
    await client.query(
      `insert into servers(id,name,owner_id) values($1,'Official',$2) on conflict (id) do nothing`,
      [OFFICIAL_SRV, OFFICIAL_ID]
    );
    // Members of the Official server may only VIEW: nobody can post there.
    await client.query(
      `insert into roles(id,server_id,name,perms,position,is_default) values('official-everyone',$1,'@everyone',$2,0,true) on conflict (id) do nothing`,
      [OFFICIAL_SRV, P.VIEW]
    );
    await client.query('insert into members(server_id,user_id) values($1,$2) on conflict do nothing', [OFFICIAL_SRV, OFFICIAL_ID]);
    await client.query(
      `insert into channels(id,server_id,name,type) values($1,$3,'announcements','text'),($2,$3,'rules','text') on conflict (id) do nothing`,
      [OFFICIAL_ANN, OFFICIAL_RULES, OFFICIAL_SRV]
    );
    // Auto-join everyone who registered before this ran.
    await client.query(
      'insert into members(server_id,user_id) select $1::text,id from users where not is_official on conflict do nothing',
      [OFFICIAL_SRV]
    );
    // Seed one welcome message per channel, only if the channel is still empty.
    for (const [channelId, messageId, text] of SEED_MESSAGES) {
      await client.query(
        'insert into messages(id,channel_id,user_id,text) select $1::text,$2::text,$3::text,$4::text where not exists (select 1 from messages where channel_id=$2::text)',
        [messageId, channelId, OFFICIAL_ID, text]
      );
    }
  });
}

module.exports = { OFFICIAL_ID, OFFICIAL_SRV, OFFICIAL_ANN, OFFICIAL_RULES, RESERVED, ensureOfficial };
