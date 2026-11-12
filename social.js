// حفر ودفن: friends, private messages and reports.
// Each player has a small social record: friends, friend requests (in and out), who they blocked, who may message them, when they were last seen.
// Private chats are kept per pair of players (last 60 messages). Reports are kept in a list the owner reads with ADMIN_KEY.
'use strict';
const fs = require('fs'), path = require('path');
const ACC = require('./accounts');
const FRIENDS_MAX = 200, DM_KEEP = 60, DM_LEN = 300, REPORTS_KEEP = 2000;
const REASONS = ['abuse', 'cheat', 'name', 'spam', 'quit', 'harass', 'other'];
const short = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
const isId = v => /^[0-9a-f]{12}$/.test(String(v || ''));

// ---------- storage (same idea as the diwaniyas: memory + Postgres or a file) ----------
const rec = new Map(), dms = new Map(); let reports = [];
let save = async () => {};
const dirty = new Set(); let timer = null;
const ready = (async () => {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg'); const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: (process.env.PGSSL === 'on' || /\.render\.com/.test(url)) ? { rejectUnauthorized: false } : false, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS social (k TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const r of (await pool.query('SELECT k, data FROM social')).rows) load1(r.k, r.data);
    save = async keys => { for (const k of keys) { const v = val(k); if (v == null) await pool.query('DELETE FROM social WHERE k=$1', [k]); else await pool.query('INSERT INTO social (k,data,updated) VALUES ($1,$2,now()) ON CONFLICT (k) DO UPDATE SET data=$2, updated=now()', [k, JSON.stringify(v)]) } };
  } else {
    const file = path.join(__dirname, 'data', 'social.json');
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); for (const k in o) load1(k, o[k]) } catch (e) {}
    save = async () => { const o = {}; for (const [k, v] of rec) o['u:' + k] = v; for (const [k, v] of dms) o['d:' + k] = v; o.reports = reports; o.feedback = feedback; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)) };
  }
  console.log('social:', rec.size, 'players,', dms.size, 'chats,', reports.length, 'reports');
})().catch(e => console.error('social store', e));
function load1(k, v) { if (k.startsWith('u:')) rec.set(k.slice(2), v); else if (k.startsWith('d:')) dms.set(k.slice(2), v); else if (k === 'reports') reports = Array.isArray(v) ? v : []; else if (k === 'feedback') feedback = Array.isArray(v) ? v : [] }
function val(k) { if (k.startsWith('u:')) return rec.get(k.slice(2)) || null; if (k.startsWith('d:')) return dms.get(k.slice(2)) || null; if (k === 'reports') return reports; if (k === 'feedback') return feedback; return null }
function touch(k) { dirty.add(k); if (timer) return; timer = setTimeout(() => { timer = null; const ks = [...dirty]; dirty.clear(); Promise.resolve(save(ks)).catch(e => console.error('social put', e)) }, 800) }

const R = id => { let r = rec.get(id); if (!r) { r = { friends: {}, inReq: {}, outReq: {}, blocked: {}, dm: 'friends', seen: 0, read: {} }; rec.set(id, r) } return r };
const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
const card = a => ({ id: a.id, name: a.prof.name || 'لاعب', av: /^p:/.test(a.prof.av || '') ? a.prof.av : (a.prof.av || 'p:0'), frame: a.prof.frame || '', flag: a.prof.flag || '',
  rp: a.st.rp || 0, vip: ACC.isVip(a), verified: !!a.verified, title: ACC.titleOf(a) });
const cache = new Map(); // account id -> {card, at}
async function cardOf(id) { const c = cache.get(id); if (c && Date.now() - c.at < 60000) return c.card; const a = await ACC.byId(id); if (!a) return null; const k = card(a); cache.set(id, { card: k, at: Date.now() }); return k }
const canDm = (from, to) => { const t = R(to); if (t.blocked[from] || R(from).blocked[to]) return false; if (t.dm === 'all') return true; if (t.dm === 'none') return false; return !!t.friends[from] };

// ---------- what a phone may ask ----------
const invites = new Map();
let feedback = []; // suggestions and messages to the owner
async function http(req, res, url, body, live) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) };
  await ready;
  const act = url.slice('/api/so/'.length).split('?')[0];
  if (act === 'feedbacks') { // the owner reads suggestions and messages: same ADMIN_KEY
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return send(403, { err: 'no' });
    return send(200, { n: feedback.length, list: feedback.slice(-500).reverse() });
  }
  if (act === 'reports') { // the owner reads reports: ADMIN_KEY on Render, sent as the x-admin-key header
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return send(403, { err: 'no' });
    const list = await Promise.all(reports.slice(-300).reverse().map(async x => ({ ...x, byName: ((await cardOf(x.by)) || {}).name, whoName: ((await cardOf(x.who)) || {}).name })));
    return send(200, { n: reports.length, list });
  }
  const a = await ACC.load(String(req.headers.authorization || '').replace(/^Bearer /, '')); if (!a) return send(401, { err: 'auth' });
  const me = R(a.id), now = Date.now(); if (now - me.seen > 30000) { me.seen = now; touch('u:' + a.id) } cache.set(a.id, { card: card(a), at: now });
  const status = id => { const s = live && live.status ? live.status(id) : 'off'; return s !== 'off' ? s : (now - (R(id).seen || 0) < 60000 ? 'on' : 'off') };
  try {
    if (act === 'ping') { // badge numbers for the home page
      let unread = 0; for (const f of new Set([...Object.keys(me.friends), ...Object.keys(me.read)])) { const d = dms.get(pairKey(a.id, f)); if (d && d.length) { const last = d[d.length - 1]; if (last.f !== a.id && last.ts > (me.read[f] || 0)) unread++ } }
      const iv = invites.get(a.id); const inv = iv && now - iv.ts < 180000 ? iv : null; if (iv && !inv) invites.delete(a.id);
      return send(200, { req: Object.keys(me.inReq).length, unread, inv });
    }
    if (act === 'list') {
      const ids = [...new Set([...Object.keys(me.friends), ...Object.keys(me.inReq), ...Object.keys(me.outReq), ...Object.keys(me.read)])];
      const cards = {}; await Promise.all(ids.map(async id => { const c = await cardOf(id); if (c) cards[id] = c }));
      const row = id => { const c = cards[id]; if (!c) return null; const d = dms.get(pairKey(a.id, id)) || [], last = d[d.length - 1];
        return { ...c, st: status(id), room: live && live.room ? live.room(id) : null, seen: R(id).seen || 0, last: last ? { t: last.t.slice(0, 60), ts: last.ts, mine: last.f === a.id } : null, unread: !!(last && last.f !== a.id && last.ts > (me.read[id] || 0)), canDm: canDm(a.id, id) } };
      const friends = Object.keys(me.friends).map(row).filter(Boolean).sort((x, y) => (y.st !== 'off') - (x.st !== 'off') || (y.last ? y.last.ts : 0) - (x.last ? x.last.ts : 0) || y.seen - x.seen);
      const chats = Object.keys(me.read).filter(id => !me.friends[id] && dms.has(pairKey(a.id, id))).map(row).filter(Boolean);
      return send(200, { me: a.id, dm: me.dm, friends, chats, inReq: Object.keys(me.inReq).map(row).filter(Boolean), outReq: Object.keys(me.outReq).map(row).filter(Boolean), blocked: Object.keys(me.blocked).length });
    }
    if (act === 'find') { const id = String(body.id || '').toLowerCase().replace(/[^0-9a-f]/g, ''); if (!isId(id) || id === a.id) return send(200, { err: 'nf' }); const c = await cardOf(id); if (!c) return send(200, { err: 'nf' });
      return send(200, { ...c, friend: !!me.friends[id], sent: !!me.outReq[id], got: !!me.inReq[id] }) }
    if (act === 'request') { const id = String(body.id || ''); if (!isId(id) || id === a.id) return send(200, { err: 'nf' }); const t = await ACC.byId(id); if (!t) return send(200, { err: 'nf' });
      const tr = R(id); if (me.friends[id]) return send(200, { ok: true, friend: true }); if (tr.blocked[a.id] || me.blocked[id]) return send(200, { err: 'blocked' });
      if (Object.keys(me.friends).length >= FRIENDS_MAX) return send(200, { err: 'max' });
      if (me.inReq[id]) { delete me.inReq[id]; delete tr.outReq[a.id]; me.friends[id] = now; tr.friends[a.id] = now; touch('u:' + a.id); touch('u:' + id); live && live.push && live.push(id, 'social', { k: 'accepted', from: a.id, name: a.prof.name }); return send(200, { ok: true, friend: true }) }
      me.outReq[id] = now; tr.inReq[a.id] = now; touch('u:' + a.id); touch('u:' + id); live && live.push && live.push(id, 'social', { k: 'request', from: a.id, name: a.prof.name }); return send(200, { ok: true, sent: true }) }
    if (act === 'answer') { const id = String(body.id || ''); const tr = R(id); if (!me.inReq[id]) return send(200, { err: 'nf' }); delete me.inReq[id]; delete tr.outReq[a.id];
      if (body.yes) { me.friends[id] = now; tr.friends[a.id] = now; live && live.push && live.push(id, 'social', { k: 'accepted', from: a.id, name: a.prof.name }) } touch('u:' + a.id); touch('u:' + id); return send(200, { ok: true }) }
    if (act === 'cancel') { const id = String(body.id || ''); delete me.outReq[id]; delete R(id).inReq[a.id]; touch('u:' + a.id); touch('u:' + id); return send(200, { ok: true }) }
    if (act === 'unfriend') { const id = String(body.id || ''); delete me.friends[id]; delete R(id).friends[a.id]; touch('u:' + a.id); touch('u:' + id); return send(200, { ok: true }) }
    if (act === 'block') { const id = String(body.id || ''); if (!isId(id) || id === a.id) return send(200, { err: 'nf' }); const tr = R(id);
      if (body.on === false) delete me.blocked[id]; else { me.blocked[id] = now; delete me.friends[id]; delete tr.friends[a.id]; delete me.inReq[id]; delete me.outReq[id]; delete tr.inReq[a.id]; delete tr.outReq[a.id] }
      touch('u:' + a.id); touch('u:' + id); return send(200, { ok: true }) }
    if (act === 'blocked') { const list = (await Promise.all(Object.keys(me.blocked).map(cardOf))).filter(Boolean); return send(200, { list }) }
    if (act === 'privacy') { if (['all', 'friends', 'none'].includes(body.dm)) { me.dm = body.dm; touch('u:' + a.id) } return send(200, { ok: true, dm: me.dm }) }
    if (act === 'chat') { // open a private chat: the messages, and whether you may write
      const id = String(body.id || ''); if (!isId(id)) return send(200, { err: 'nf' }); const c = await cardOf(id); if (!c) return send(200, { err: 'nf' });
      const d = dms.get(pairKey(a.id, id)) || [], after = +body.after || 0; me.read[id] = now; touch('u:' + a.id);
      const theirRead = R(id).read[a.id] || 0;
      return send(200, { who: { ...c, st: status(id), seen: R(id).seen || 0, friend: !!me.friends[id] }, canDm: canDm(a.id, id), why: canDm(a.id, id) ? '' : (me.blocked[id] ? 'blockedByMe' : R(id).blocked[a.id] ? 'blocked' : R(id).dm === 'none' ? 'closed' : 'friendsOnly'),
        msgs: d.filter(m => m.ts > after).map(m => ({ t: m.t, ts: m.ts, mine: m.f === a.id })), seenUpTo: theirRead });
    }
    if (act === 'invite') { // invite a friend to my room: he gets a pop-up with a "join" button (kept 3 minutes, in memory only)
      const id = String(body.id || ''), code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!isId(id) || !code || !me.friends[id]) return send(200, { err: 'nf' }); if (R(id).blocked[a.id]) return send(200, { err: 'closed' });
      const old = invites.get(id); if (old && old.from === a.id && now - old.ts < 5000) return send(200, { err: 'slow' });
      invites.set(id, { from: a.id, name: a.prof.name, code, ts: now }); live && live.push && live.push(id, 'social', { k: 'invite', from: a.id, name: a.prof.name, code });
      return send(200, { ok: true, st: status(id) }) }
    if (act === 'invdone') { invites.delete(a.id); return send(200, { ok: true }) }
    if (act === 'send') { const id = String(body.id || ''); const t = short(body.text, DM_LEN); if (!isId(id) || !t) return send(200, { err: 'empty' });
      if (!canDm(a.id, id)) return send(200, { err: 'closed' });
      const k = pairKey(a.id, id); const d = dms.get(k) || []; const last = d.filter(m => m.f === a.id).slice(-5);
      if (last.length === 5 && now - last[0].ts < 8000) return send(200, { err: 'slow' });
      d.push({ f: a.id, t, ts: now }); if (d.length > DM_KEEP) d.splice(0, d.length - DM_KEEP); dms.set(k, d); me.read[id] = now; const tr = R(id); if (!tr.read[a.id]) tr.read[a.id] = 0;
      touch('d:' + k); touch('u:' + a.id); touch('u:' + id); live && live.push && live.push(id, 'social', { k: 'dm', from: a.id, name: a.prof.name, t: t.slice(0, 60) });
      return send(200, { ok: true, ts: now }) }
    if (act === 'feedback') { const kind = ['idea', 'bug', 'contact'].includes(body.kind) ? body.kind : 'idea', t = short(body.text, 600), c = short(body.contact, 80);
      if (!t || t.length < 3) return send(200, { err: 'empty' }); const mine = feedback.filter(x => x.by === a.id && now - x.ts < 3600e3); if (mine.length >= 5) return send(200, { err: 'slow' });
      feedback.push({ ts: now, by: a.id, name: a.prof.name || '', kind, text: t, contact: c, ver: short(body.ver, 16), ua: short(req.headers['user-agent'], 120) }); if (feedback.length > 2000) feedback.splice(0, feedback.length - 2000);
      touch('feedback'); return send(200, { ok: true }) }
    if (act === 'report') { const id = String(body.id || ''); if (!isId(id) || id === a.id) return send(200, { err: 'nf' }); const why = REASONS.includes(body.reason) ? body.reason : 'other';
      const recent = reports.filter(x => x.by === a.id && x.who === id && now - x.ts < 3600e3); if (recent.length) return send(200, { ok: true, dup: true });
      const ctx = { room: short(body.room, 8), where: short(body.where, 12) };
      const d = dms.get(pairKey(a.id, id)); if (d) ctx.dm = d.slice(-10).map(m => ({ from: m.f === a.id ? 'reporter' : 'reported', t: m.t, ts: m.ts }));
      if (Array.isArray(body.chat)) ctx.chat = body.chat.slice(-10).map(x => short(x, 80));
      reports.push({ by: a.id, who: id, reason: why, note: short(body.note, 300), ts: now, ctx }); if (reports.length > REPORTS_KEEP) reports.splice(0, reports.length - REPORTS_KEEP); touch('reports');
      if (body.block) { me.blocked[id] = now; delete me.friends[id]; delete R(id).friends[a.id]; touch('u:' + a.id); touch('u:' + id) }
      console.log('REPORT', why, a.id, '->', id); return send(200, { ok: true }) }
    return send(404, { err: 'nf' });
  } catch (e) { console.error('so', e); return send(500, { err: 'server' }) }
}
// the server tells us someone is online (websocket) so "last seen" stays right while they play
function seenNow(id) { if (!isId(id)) return; const r = R(id), now = Date.now(); if (now - r.seen > 30000) { r.seen = now; touch('u:' + id) } }
module.exports = { http, seenNow, ready };
