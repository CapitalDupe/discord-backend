'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws'), { Pool } = require('pg'), argon2 = require('argon2');

const E = process.env, PORT = E.PORT || 3000, ORIGIN = E.ALLOWED_ORIGIN || '*', SIGNUP_CODE = E.SIGNUP_CODE || '';
if (!E.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({ connectionString: E.DATABASE_URL, ssl: /localhost|127\.0\.0\.1|@postgres[:\/]/.test(E.DATABASE_URL) ? false : { rejectUnauthorized: false } });
const q = (s, p) => pool.query(s, p).then(r => r.rows), one = async (s, p) => (await q(s, p))[0];
const tx = async fn => { const c = await pool.connect(); try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };

// Permission bits. Owner and ADMIN get everything. Everyone has the @everyone role; extra roles add bits.
const P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 4, MANAGE_CHANNELS: 8, MANAGE_SERVER: 16, MANAGE_ROLES: 32, INVITE: 64, KICK: 128, ADMIN: 1 << 30 };
const ALL = 0x7fffffff, DEFAULT_PERMS = P.VIEW | P.SEND | P.INVITE;

const rid = () => crypto.randomBytes(6).toString('hex'), sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '', isId = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
const eq = (a, b) => typeof a === 'string' && crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
const pub = u => ({ id: u.id, name: u.display_name, color: u.color, username: u.username });

// ---------- rate limiting (in-memory, per instance) ----------
const hits = new Map();
const limit = (k, max, ms) => { const n = Date.now(), h = (hits.get(k) || []).filter(t => n - t < ms); h.push(n); hits.set(k, h); return h.length <= max; };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.length || n - v[v.length - 1] > 36e5) hits.delete(k); }, 6e5).unref();
// Only trust X-Forwarded-For when TRUST_PROXY is set (i.e. you are behind exactly one proxy, e.g. Render).
const ipOf = req => { const x = (req.headers['x-forwarded-for'] || '').split(',').pop().trim(); return ((E.TRUST_PROXY && x) || req.socket.remoteAddress || '').replace(/^::ffff:/, ''); };

// ---------- sessions ----------
async function newSession(uid, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q("insert into sessions(id,user_id,expires_at,user_agent) values($1,$2,now()+interval '30 days',$3)", [sha(token), uid, str(ua, 200)]);
  await q('delete from sessions where user_id=$1 and id not in (select id from sessions where user_id=$1 order by created_at desc limit 20)', [uid]);
  return token;
}
const userFor = token => token ? one('select u.id,u.username,u.display_name,u.color from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now()', [sha(token)]) : null;

// ---------- authorization ----------
async function access(uid, sid) {   // -> { perms, top, owner } or null when not a member
  const s = await one('select owner_id from servers where id=$1', [sid]); if (!s) return null;
  if (!await one('select 1 x from members where server_id=$1 and user_id=$2', [sid, uid])) return null;
  const r = await one('select coalesce(bit_or(perms),0)::int perms, coalesce(max(position),0)::int top from roles where server_id=$1 and (is_default or id in (select role_id from member_roles where server_id=$1 and user_id=$2))', [sid, uid]);
  const owner = s.owner_id === uid;
  return { perms: owner || (r.perms & P.ADMIN) ? ALL : r.perms, top: owner ? 1e9 : r.top, owner };
}
const need = (a, bit) => { if (!a || !(a.perms & bit)) fail(403, 'Missing permission'); return a; };
const chanCtx = async (uid, cid) => { const c = isId(cid) && await one('select server_id from channels where id=$1', [cid]); return c ? { sid: c.server_id, a: await access(uid, c.server_id) } : { sid: null, a: null }; };

// ---------- realtime fan-out ----------
const conns = new Map();
const sendTo = (uid, msg, skip) => conns.get(uid)?.forEach(w => w !== skip && w.readyState === 1 && w.send(typeof msg === 'string' ? msg : JSON.stringify(msg)));
async function toServer(sid, ev, skip) { const m = JSON.stringify(ev); for (const r of await q('select user_id from members where server_id=$1', [sid])) sendTo(r.user_id, m, skip); }

// ---------- data ----------
const cleanCh = c => { const name = c && str(c.name, 50).trim(); return c && isId(c.id) && name ? { id: c.id, name, type: c.type === 'voice' ? 'voice' : 'text' } : null; };
async function makeServer(c, uid, s) {
  await c.query('insert into servers(id,name,owner_id) values($1,$2,$3)', [s.id, s.name, uid]);
  await c.query("insert into roles(id,server_id,name,perms,position,is_default) values($1,$2,'@everyone',$3,0,true)", [rid(), s.id, DEFAULT_PERMS]);
  await c.query('insert into members(server_id,user_id) values($1,$2)', [s.id, uid]);
  for (const ch of s.channels) await c.query('insert into channels(id,server_id,name,type) values($1,$2,$3,$4)', [ch.id, s.id, ch.name, ch.type]);
}
async function stateFor(u) {
  const servers = await q('select s.id,s.name from servers s join members m on m.server_id=s.id where m.user_id=$1 order by m.joined_at', [u.id]);
  const sids = servers.map(s => s.id);
  const chans = sids.length ? await q('select id,server_id,name,type from channels where server_id=any($1) order by pos', [sids]) : [];
  const cids = chans.map(c => c.id);
  const msgs = cids.length ? await q(`select * from (select m.id,m.channel_id,m.user_id,m.text,m.edited,floor(extract(epoch from m.ts)*1000)::float8 ts,
      coalesce(u.display_name,'Deleted user') name,coalesce(u.color,'#949ba4') color,coalesce(u.is_official,false) official,row_number() over(partition by m.channel_id order by m.ts desc,m.id) rn
      from messages m left join users u on u.id=m.user_id where m.channel_id=any($1)) x where rn<=50 order by ts,id`, [cids]) : [];
  const rx = msgs.length ? await q('select message_id,emoji,array_agg(user_id) users from reactions where message_id=any($1) group by 1,2', [msgs.map(m => m.id)]) : [];
  const members = sids.length ? await q('select distinct u.id,u.display_name as name,u.color,u.is_official as official from members m join users u on u.id=m.user_id where m.server_id=any($1) and u.id<>$2', [sids, u.id]) : [];
  const byMsg = {}; for (const r of rx) (byMsg[r.message_id] ??= {})[r.emoji] = r.users;
  const messages = {};
  for (const m of msgs) (messages[m.channel_id] ??= []).push({ id: m.id, uid: m.user_id, name: m.name, color: m.color, ts: m.ts, text: m.text, ...(m.official ? { official: 1 } : {}), ...(m.edited ? { edited: 1 } : {}), ...(byMsg[m.id] ? { r: byMsg[m.id] } : {}) });
  return { user: pub(u), members, messages, servers: servers.map(s => ({ ...s, channels: chans.filter(c => c.server_id === s.id).map(({ id, name, type }) => ({ id, name, type })) })) };
}

// ---------- WebSocket events (same shapes the frontend already sends) ----------
// Returns { sid, ev } to broadcast, 'ok' if handled with no broadcast, or falsy if rejected.
async function handle(u, e) {
  if (!e || typeof e.t !== 'string') return null;
  switch (e.t) {
    case 'msg.new': {
      const text = e.m && str(e.m.text, 4000).trim(); if (!text || !isId(e.m.id)) return null;
      const { sid, a } = await chanCtx(u.id, e.cid); if (!a || !(a.perms & P.SEND)) return null;
      const r = await one('insert into messages(id,channel_id,user_id,text) values($1,$2,$3,$4) on conflict do nothing returning floor(extract(epoch from ts)*1000)::float8 as ts', [e.m.id, e.cid, u.id, text]);
      return r ? { sid, ev: { t: e.t, cid: e.cid, m: { id: e.m.id, uid: u.id, name: u.display_name, color: u.color, ts: r.ts, text } } } : null;
    }
    case 'msg.edit': {
      const text = str(e.text, 4000).trim(); const { sid, a } = await chanCtx(u.id, e.cid); if (!text || !a || !isId(e.id)) return null;
      const r = await one('update messages set text=$1,edited=true where id=$2 and channel_id=$3 and user_id=$4 returning id', [text, e.id, e.cid, u.id]);
      return r ? { sid, ev: { t: e.t, cid: e.cid, id: e.id, text } } : null;
    }
    case 'msg.del': {
      const { sid, a } = await chanCtx(u.id, e.cid); if (!a || !isId(e.id)) return null;
      const r = await one('delete from messages where id=$1 and channel_id=$2 and (user_id=$3 or $4) returning id', [e.id, e.cid, u.id, !!(a.perms & P.MANAGE_MESSAGES)]);
      return r ? { sid, ev: { t: e.t, cid: e.cid, id: e.id } } : null;
    }
    case 'msg.react': {
      const emoji = str(e.emoji, 8), { sid, a } = await chanCtx(u.id, e.cid); if (!emoji || !a || !(a.perms & P.VIEW) || !isId(e.id)) return null;
      if (!await one('select 1 x from messages where id=$1 and channel_id=$2', [e.id, e.cid])) return null;
      if (!await one('delete from reactions where message_id=$1 and user_id=$2 and emoji=$3 returning 1 x', [e.id, u.id, emoji])) await q('insert into reactions(message_id,user_id,emoji) values($1,$2,$3)', [e.id, u.id, emoji]);
      return { sid, ev: { t: e.t, cid: e.cid, id: e.id, emoji, uid: u.id } };
    }
    case 'srv.new': {
      const s = e.s, name = s && str(s.name, 50).trim(); if (!name || !isId(s.id)) return null;
      if ((await one('select count(*)::int n from servers where owner_id=$1', [u.id])).n >= 10) return null;
      const channels = (Array.isArray(s.channels) ? s.channels : []).slice(0, 20).map(cleanCh).filter(Boolean);
      await tx(c => makeServer(c, u.id, { id: s.id, name, channels }));
      return { sid: s.id, ev: { t: e.t, s: { id: s.id, name, channels } } };
    }
    case 'srv.del': {
      if (!isId(e.sid)) return null; const mem = await q('select user_id from members where server_id=$1', [e.sid]);
      if (!await one('delete from servers where id=$1 and owner_id=$2 returning id', [e.sid, u.id])) return null;
      mem.forEach(r => sendTo(r.user_id, { t: 'srv.del', sid: e.sid })); return 'ok';
    }
    case 'ch.new': {
      const a = need(await access(u.id, e.sid), P.MANAGE_CHANNELS), c = cleanCh(e.c); if (!c) return null;
      if ((await one('select count(*)::int n from channels where server_id=$1', [e.sid])).n >= 50) return null;
      await q('insert into channels(id,server_id,name,type) values($1,$2,$3,$4)', [c.id, e.sid, c.name, c.type]);
      return { sid: e.sid, ev: { t: e.t, sid: e.sid, c } };
    }
    case 'ch.del': {
      need(await access(u.id, e.sid), P.MANAGE_CHANNELS);
      return await one('delete from channels where id=$1 and server_id=$2 returning id', [e.cid, e.sid]) ? { sid: e.sid, ev: { t: e.t, sid: e.sid, cid: e.cid } } : null;
    }
    case 'user.set': {
      const x = e.u || {}, name = str(x.name, 32).trim(), color = /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : u.color;
      await q('update users set display_name=$1,color=$2 where id=$3', [name || u.display_name, color, u.id]);
      conns.get(u.id)?.forEach(w => { w.user.display_name = name || u.display_name; w.user.color = color; });
      sendTo(u.id, { t: 'user.set', u: { id: u.id, name: name || u.display_name, color } }); return 'ok';
    }
  }
  return null;
}

// ---------- REST ----------
const json = (res, code, o) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(o));
const readBody = req => new Promise((ok, no) => {
  let b = '', n = 0;
  req.on('data', d => { n += d.length; if (n > 16384) { no(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else b += d; });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
});
const DUMMY = argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });

async function route(req, res, p) {
  const m = req.method, addr = ipOf(req);
  if (p === '/healthz') return res.writeHead(200).end('ok');

  if (m === 'POST' && p === '/register') {
    if (!limit('reg:' + addr, 5, 36e5)) fail(429, 'Too many sign-ups, try later');
    if (!limit('reg:all', +E.MAX_SIGNUPS_PER_HOUR || 200, 36e5)) fail(429, 'Sign-ups are very busy, try again later');
    const b = await readBody(req);
    if (SIGNUP_CODE && !eq(b.code, SIGNUP_CODE)) fail(403, 'Invalid signup code');
    const username = str(b.username, 32).trim(), pw = typeof b.password === 'string' ? b.password : '';
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) fail(400, 'Username: 3-32 letters, numbers, _ . -');
    if (pw.length < 10 || pw.length > 128) fail(400, 'Password must be 10-128 characters');
    if (RESERVED.test(username) || /official/i.test(username)) fail(400, 'That username is reserved');
    const hash = await argon2.hash(pw, { type: argon2.argon2id }), id = rid();
    try {
      await tx(async c => {
        await c.query('insert into users(id,username,display_name,pass_hash) values($1,$2,$2,$3)', [id, username, hash]);
        await makeServer(c, id, { id: rid(), name: 'Home', channels: [{ id: rid(), name: 'general', type: 'text' }, { id: rid(), name: 'random', type: 'text' }] });
        await c.query('insert into members(server_id,user_id) values($1,$2) on conflict do nothing', [OFFICIAL_SRV, id]);
      });
    } catch (e) { if (e.code === '23505') fail(409, 'Username already taken'); throw e; }
    return json(res, 201, { token: await newSession(id, req.headers['user-agent']) });
  }
  if (m === 'POST' && p === '/login') {
    const b = await readBody(req), uname = str(b.username, 32).trim().toLowerCase();
    if (!limit('login-ip:' + addr, 30, 9e5) || !limit('login-user:' + uname, 10, 9e5)) fail(429, 'Too many attempts, try again later');
    const u = await one('select id,pass_hash from users where lower(username)=$1', [uname]);
    const ok = await argon2.verify(u ? u.pass_hash : await DUMMY, typeof b.password === 'string' ? b.password : '').catch(() => false);
    if (!u || !ok) fail(401, 'Wrong username or password');
    return json(res, 200, { token: await newSession(u.id, req.headers['user-agent']) });
  }

  if (m === 'POST' && p === '/official/announce') {   // post as the Official account; needs ADMIN_KEY
    if (!E.ADMIN_KEY || !eq(req.headers['x-admin-key'], E.ADMIN_KEY)) fail(404, 'Not found');
    if (!limit('announce:' + addr, 10, 36e5)) fail(429, 'Too many requests');
    const b = await readBody(req), text = str(b.text, 4000).trim(); if (!text) fail(400, 'Text required');
    const id = rid(), r = await one('insert into messages(id,channel_id,user_id,text) values($1,$2,$3,$4) returning floor(extract(epoch from ts)*1000)::float8 as ts', [id, OFFICIAL_ANN, OFFICIAL_ID, text]);
    await toServer(OFFICIAL_SRV, { t: 'msg.new', cid: OFFICIAL_ANN, m: { id, uid: OFFICIAL_ID, name: 'Official', color: '#5865f2', ts: r.ts, text, official: 1 } });
    return json(res, 201, { id });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''), u = await userFor(token);
  if (!u) fail(401, 'Not signed in');
  if (m === 'POST' && p === '/logout') { await q('delete from sessions where id=$1', [sha(token)]); return json(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/me') return json(res, 200, pub(u));
  if (m === 'GET' && p === '/state') return json(res, 200, await stateFor(u));

  let r;
  if (m === 'POST' && (r = p.match(/^\/servers\/([\w-]+)\/invites$/))) {
    need(await access(u.id, r[1]), P.INVITE); const b = await readBody(req), code = crypto.randomBytes(6).toString('base64url');
    const days = Math.min(Math.max(+b.days || 7, 1), 30), max = Math.min(Math.max(+b.maxUses || 10, 1), 100);
    await q("insert into invites(code,server_id,created_by,expires_at,max_uses) values($1,$2,$3,now()+($4||' days')::interval,$5)", [code, r[1], u.id, String(days), max]);
    return json(res, 201, { code });
  }
  if (m === 'POST' && (r = p.match(/^\/invites\/([\w-]+)\/join$/))) {
    if (!limit('join:' + addr, 20, 9e5)) fail(429, 'Too many attempts');
    const inv = await one('select server_id from invites where code=$1 and (expires_at is null or expires_at>now()) and (max_uses is null or uses<max_uses)', [r[1]]);
    if (!inv) fail(404, 'Invite is invalid or expired');
    const joined = await tx(async c => {
      const ins = await c.query('insert into members(server_id,user_id) values($1,$2) on conflict do nothing', [inv.server_id, u.id]);
      if (ins.rowCount) await c.query('update invites set uses=uses+1 where code=$1', [r[1]]); return ins.rowCount;
    });
    if (joined) toServer(inv.server_id, { t: 'member.new', sid: inv.server_id, user: { id: u.id, name: u.display_name, color: u.color } });
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && (r = p.match(/^\/servers\/([\w-]+)\/roles$/))) {
    const a = need(await access(u.id, r[1]), P.MANAGE_ROLES), b = await readBody(req), name = str(b.name, 32).trim();
    const perms = (+b.perms | 0) & ALL, pos = Math.max(+b.position | 0, 1);
    if (!name) fail(400, 'Name required');
    if (pos >= a.top) fail(403, 'Role must rank below your highest role');
    if (!a.owner && (perms & ~a.perms)) fail(403, 'You cannot grant permissions you lack');
    const id = rid(); await q('insert into roles(id,server_id,name,perms,position) values($1,$2,$3,$4,$5)', [id, r[1], name, perms, pos]);
    return json(res, 201, { id });
  }
  if (m === 'PUT' && (r = p.match(/^\/servers\/([\w-]+)\/members\/([\w-]+)\/roles$/))) {
    const a = need(await access(u.id, r[1]), P.MANAGE_ROLES), t = await access(r[2], r[1]); if (!t) fail(404, 'Not a member');
    if (!a.owner && (t.owner || t.top >= a.top)) fail(403, 'Target outranks you');
    const b = await readBody(req), ids = (Array.isArray(b.roleIds) ? b.roleIds : []).filter(isId).slice(0, 20);
    const roles = ids.length ? await q('select id,perms,position from roles where server_id=$1 and id=any($2) and not is_default', [r[1], ids]) : [];
    if (roles.length !== ids.length) fail(400, 'Unknown role');
    if (roles.some(x => x.position >= a.top || (!a.owner && (x.perms & ~a.perms)))) fail(403, 'Role is above your rank');
    await tx(async c => { await c.query('delete from member_roles where server_id=$1 and user_id=$2', [r[1], r[2]]); for (const x of roles) await c.query('insert into member_roles values($1,$2,$3)', [r[1], r[2], x.id]); });
    return json(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (r = p.match(/^\/servers\/([\w-]+)\/members\/([\w-]+)$/))) {
    const a = await access(u.id, r[1]), t = await access(r[2], r[1]); if (!a || !t) fail(404, 'Not found');
    if (t.owner) fail(403, 'The owner cannot be removed');
    if (r[2] !== u.id) { need(a, P.KICK); if (!a.owner && t.top >= a.top) fail(403, 'Target outranks you'); }
    await q('delete from members where server_id=$1 and user_id=$2', [r[1], r[2]]);
    sendTo(r[2], { t: 'srv.del', sid: r[1] }); return json(res, 200, { ok: true });
  }
  fail(404, 'Not found');
}

// ---------- official platform account ----------
// A system user nobody can log in as (pass_hash is not a valid hash), reserved username, and a read-only
// "Official" server that every account is auto-joined to. Announce via POST /api/official/announce (ADMIN_KEY).
const OFFICIAL_ID = 'official', OFFICIAL_SRV = 'official-hq', OFFICIAL_ANN = 'official-news', OFFICIAL_RULES = 'official-rules';
const RESERVED = /^(official|admin|administrator|system|staff|support|moderator|mod|everyone|here|discord|root|owner)$/i;
async function ensureOfficial() {
  await tx(async c => {
    await c.query("insert into users(id,username,display_name,color,pass_hash,is_official) values($1,'official','Official','#5865f2','!',true) on conflict (id) do nothing", [OFFICIAL_ID]);
    await c.query("insert into servers(id,name,owner_id) values($1,'Official',$2) on conflict (id) do nothing", [OFFICIAL_SRV, OFFICIAL_ID]);
    await c.query("insert into roles(id,server_id,name,perms,position,is_default) values('official-everyone',$1,'@everyone',$2,0,true) on conflict (id) do nothing", [OFFICIAL_SRV, P.VIEW]);
    await c.query('insert into members(server_id,user_id) values($1,$2) on conflict do nothing', [OFFICIAL_SRV, OFFICIAL_ID]);
    await c.query("insert into channels(id,server_id,name,type) values($1,$3,'announcements','text'),($2,$3,'rules','text') on conflict (id) do nothing", [OFFICIAL_ANN, OFFICIAL_RULES, OFFICIAL_SRV]);
    await c.query('insert into members(server_id,user_id) select $1,id from users where not is_official on conflict do nothing', [OFFICIAL_SRV]);
    const seed = [[OFFICIAL_RULES, 'official-m1', 'Welcome! Be kind, no spam, no harassment. Server owners and moderators can remove members who break these rules.'],
                  [OFFICIAL_ANN, 'official-m2', 'Official announcements appear here. Only the platform account can post in this server.']];
    for (const [ch, id, text] of seed) await c.query('insert into messages(id,channel_id,user_id,text) select $1::text,$2::text,$3::text,$4::text where not exists (select 1 from messages where channel_id=$2::text)', [id, ch, OFFICIAL_ID, text]);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  try { await route(req, res, new URL(req.url, 'http://x').pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/'); }
  catch (e) { if (e.status) return json(res, e.status, { error: e.message }); console.error(e); json(res, 500, { error: 'Server error' }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server, maxPayload: 32 * 1024,
  verifyClient: (info, cb) => {
    if (ORIGIN !== '*' && info.origin !== ORIGIN) return cb(false, 403, 'Forbidden origin');
    userFor(new URL(info.req.url, 'http://x').searchParams.get('token')).then(u => { if (!u) return cb(false, 401, 'Unauthorized'); info.req.user = u; cb(true); }).catch(() => cb(false, 500));
  }
});
wss.on('connection', (ws, req) => {
  ws.user = req.user; ws.alive = true; ws.n = 0;
  (conns.get(ws.user.id) || conns.set(ws.user.id, new Set()).get(ws.user.id)).add(ws);
  ws.on('close', () => { const s = conns.get(ws.user.id); s?.delete(ws); if (s && !s.size) conns.delete(ws.user.id); });
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async raw => {
    if (++ws.n > 20) return;
    let e; try { e = JSON.parse(raw); } catch { return; }
    try {
      const r = await handle(ws.user, e);
      if (r && r !== 'ok') await toServer(r.sid, r.ev, ws);   // sender already applied it locally
      if (!r) ws.send('{"t":"resync"}');                      // rejected: tell the client to reload real state
    } catch (err) { if (err.status !== 403) console.error(err); ws.send('{"t":"resync"}'); }
  });
});
setInterval(() => wss.clients.forEach(c => { c.n = 0; }), 1000).unref();
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000).unref();
setInterval(() => q('delete from sessions where expires_at<now()').then(() => q('delete from invites where expires_at<now()')).catch(() => {}), 36e5).unref();
process.on('unhandledRejection', e => console.error(e));

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await ensureOfficial();
  server.listen(PORT, () => console.log('Listening on :' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
