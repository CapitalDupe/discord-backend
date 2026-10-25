'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ACCESS_TOKEN || '';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';   // e.g. https://capitaldupe.github.io
const FILE = path.join(process.env.DATA_DIR || './data', 'state.json');
const MAX_MSGS = 5000;

const seed = () => ({
  user: { id: 'me', name: 'You', color: '#5865f2' }, members: [],
  servers: [{ id: 's1', name: 'Home', channels: [
    { id: 'c1', name: 'general', type: 'text' }, { id: 'c2', name: 'random', type: 'text' }, { id: 'c3', name: 'Lounge', type: 'voice' }] }],
  messages: { c1: [{ id: 'welcome', uid: 'bot', name: 'Server', color: '#3ba55d', ts: Date.now(), text: 'Connected to your backend. Messages now persist and sync across devices.' }] }
});

// ---------- storage: Postgres if DATABASE_URL is set, otherwise a JSON file ----------
function fileStore() {
  return {
    async load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } },
    async save(s) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, FILE); }
  };
}
function pgStore() {
  const { Pool } = require('pg'), url = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  return {
    async load() {
      await pool.query('create table if not exists kv(k text primary key, v jsonb not null)');
      const r = await pool.query("select v from kv where k='state'"); return r.rows[0]?.v || null;
    },
    async save(s) { await pool.query("insert into kv(k,v) values('state',$1) on conflict (k) do update set v=excluded.v", [JSON.stringify(s)]); }
  };
}
const store = process.env.DATABASE_URL ? pgStore() : fileStore();
let S, timer;
const persist = () => { clearTimeout(timer); timer = setTimeout(() => store.save(S).catch(e => console.error('save failed', e)), 300); };

// ---------- validation + state changes (mirrors the frontend reducer, but trusts nothing) ----------
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const isId = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
const hasChan = cid => S.servers.some(s => s.channels.some(c => c.id === cid));
const cleanCh = c => { const name = c && str(c.name, 50).trim(); return c && isId(c.id) && name ? { id: c.id, name, type: c.type === 'voice' ? 'voice' : 'text' } : null; };
const findMsg = e => isId(e.cid) && isId(e.id) ? (S.messages[e.cid] || []).find(m => m.id === e.id) : null;

function apply(e) {
  if (!e || typeof e.t !== 'string') return null;
  const U = S.user;
  switch (e.t) {
    case 'msg.new': {
      if (!isId(e.cid) || !e.m || !isId(e.m.id) || !hasChan(e.cid)) return null;
      const text = str(e.m.text, 4000).trim(); const a = (S.messages[e.cid] ??= []);
      if (!text || a.some(m => m.id === e.m.id)) return null;
      const m = { id: e.m.id, uid: U.id, name: U.name, color: U.color, ts: Date.now(), text };
      a.push(m); if (a.length > MAX_MSGS) a.splice(0, a.length - MAX_MSGS);
      return { t: e.t, cid: e.cid, m };
    }
    case 'msg.edit': {
      const m = findMsg(e), text = str(e.text, 4000).trim();
      if (!m || m.uid !== U.id || !text) return null;
      m.text = text; m.edited = 1; return { t: e.t, cid: e.cid, id: e.id, text };
    }
    case 'msg.del': {
      const m = findMsg(e); if (!m || m.uid !== U.id) return null;
      S.messages[e.cid] = S.messages[e.cid].filter(x => x.id !== e.id); return { t: e.t, cid: e.cid, id: e.id };
    }
    case 'msg.react': {
      const m = findMsg(e), emoji = str(e.emoji, 8); if (!m || !emoji) return null;
      const a = ((m.r ??= {})[emoji] ??= []), i = a.indexOf(U.id); i < 0 ? a.push(U.id) : a.splice(i, 1);
      if (!a.length) delete m.r[emoji]; return { t: e.t, cid: e.cid, id: e.id, emoji, uid: U.id };
    }
    case 'srv.new': {
      const s = e.s, name = s && str(s.name, 50).trim();
      if (!s || !isId(s.id) || !name || S.servers.some(x => x.id === s.id)) return null;
      const channels = (Array.isArray(s.channels) ? s.channels : []).slice(0, 20).map(cleanCh).filter(c => c && !hasChan(c.id));
      const out = { id: s.id, name, channels }; S.servers.push(out); return { t: e.t, s: out };
    }
    case 'srv.del': {
      const sv = S.servers.find(x => x.id === e.sid); if (!sv) return null;
      sv.channels.forEach(c => delete S.messages[c.id]); S.servers = S.servers.filter(x => x !== sv); return { t: e.t, sid: e.sid };
    }
    case 'ch.new': {
      const sv = S.servers.find(x => x.id === e.sid), c = cleanCh(e.c);
      if (!sv || !c || hasChan(c.id) || sv.channels.length >= 50) return null; sv.channels.push(c); return { t: e.t, sid: e.sid, c };
    }
    case 'ch.del': {
      const sv = S.servers.find(x => x.id === e.sid); if (!sv || !sv.channels.some(c => c.id === e.cid)) return null;
      sv.channels = sv.channels.filter(c => c.id !== e.cid); delete S.messages[e.cid]; return { t: e.t, sid: e.sid, cid: e.cid };
    }
    case 'user.set': {
      const u = e.u || {}, name = str(u.name, 32).trim();
      if (name) U.name = name; if (typeof u.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color)) U.color = u.color;
      return { t: e.t, u: { id: U.id, name: U.name, color: U.color } };
    }
  }
  return null;
}

// ---------- auth + HTTP ----------
const h = x => crypto.createHash('sha256').update(String(x)).digest();
const authed = t => !TOKEN || (!!t && crypto.timingSafeEqual(h(t), h(TOKEN)));

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  if (p === '/healthz') return res.writeHead(200).end('ok');
  if (p === '/state' && req.method === 'GET') {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!authed(t)) return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
    return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(S));
  }
  res.writeHead(404).end('not found');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server, maxPayload: 32 * 1024,
  verifyClient: (info, cb) => {
    if (ORIGIN !== '*' && info.origin !== ORIGIN) return cb(false, 403, 'Forbidden origin');
    const t = new URL(info.req.url, 'http://x').searchParams.get('token');
    authed(t) ? cb(true) : cb(false, 401, 'Unauthorized');
  }
});
wss.on('connection', ws => {
  ws.alive = true; ws.n = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    if (++ws.n > 20) return;                       // 20 events/second per socket
    let e; try { e = JSON.parse(raw); } catch { return; }
    const out = apply(e); if (!out) return;
    persist();
    const msg = JSON.stringify(out);               // sender already applied it locally, so skip them
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(msg);
  });
});
setInterval(() => wss.clients.forEach(c => { c.n = 0; }), 1000);
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);

const flush = async () => { clearTimeout(timer); try { await store.save(S); } catch (e) { console.error(e); } process.exit(0); };
process.on('SIGTERM', flush); process.on('SIGINT', flush);

(async () => {
  S = (await store.load()) || seed(); S.members ??= []; S.messages ??= {};
  if (!TOKEN) console.warn('WARNING: ACCESS_TOKEN is not set, anyone who finds this URL can read and write.');
  server.listen(PORT, () => console.log(`Listening on :${PORT} (${process.env.DATABASE_URL ? 'postgres' : 'file'} storage)`));
})();
