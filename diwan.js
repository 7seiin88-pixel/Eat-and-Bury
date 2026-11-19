// حفر ودفن: diwaniyas (clubs). A diwaniya has members, its own tables (private rooms) and a chat.
// Free players can be in one diwaniya; the subscription (later) will allow more.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ACC = require('./accounts');
const CLEAN = (() => { try { return require('./clean') } catch (e) { return { mask: x => x } } })();
const MEMBERS_MAX = 50, CHAT_KEEP = 80, DW_PRICE = 3000; // a new diwaniya costs rupees; VIP members get one free
const maxFor = a => ACC.isVip(a) ? 2 : 1; // how many diwaniyas a player can be in
const freeDw = a => ACC.isVip(a) && a.dwFree !== a.vipStart;
// if VIP ran out while in two: you can still look at both, but play and chat only in the first
const locked = new Map(); function lockOf(a) { const l = myDw(a).slice(maxFor(a)); locked.set(a.id, new Set(l)); return l }
const ICONS = ['🏛', '⚽', '🎓', '👨‍👩‍👦', '🦅', '🐪', '☕', '🌴', '⚓', '🔥', '👑', '🃏'];
const COLORS = ['#5a1a14', '#0d3a2a', '#13234f', '#4a1a3a', '#4a3a10', '#203a40'];
const short = (v, n) => String(v == null ? '' : v).replace(/[<>"]/g, '').trim().slice(0, n);

// ---------- storage: everything is kept in memory and saved on each change ----------
const all = new Map(), byCode = new Map();
let saveDw;
const ready = (async () => {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg'); const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: (process.env.PGSSL === 'on' || /\.render\.com/.test(url)) ? { rejectUnauthorized: false } : false, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS diwans (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const r of (await pool.query('SELECT data FROM diwans')).rows) add(r.data);
    saveDw = d => d.gone ? pool.query('DELETE FROM diwans WHERE id=$1', [d.id]) : pool.query('INSERT INTO diwans (id,data,updated) VALUES ($1,$2,now()) ON CONFLICT (id) DO UPDATE SET data=$2, updated=now()', [d.id, d]);
  } else {
    const file = path.join(__dirname, 'data', 'diwans.json'); let t = null;
    try { for (const d of JSON.parse(fs.readFileSync(file, 'utf8'))) add(d) } catch (e) {}
    saveDw = async () => { if (t) return; t = setTimeout(() => { t = null; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify([...all.values()])) } catch (e) { console.error('dw save', e) } }, 400) };
  }
  console.log('diwaniyas:', all.size);
})().catch(e => console.error('diwans store', e));
function add(d) { all.set(d.id, d); byCode.set(d.code, d.id) }
const persist = d => Promise.resolve(saveDw && saveDw(d)).catch(e => console.error('dw put', e));
function newCode() { let c; do { c = 'D' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5) } while (byCode.has(c)); return c }

// what we show about a member (refreshed whenever they open the diwaniya)
const snap = a => ({ name: a.prof.name || 'لاعب', av: a.prof.av, frame: a.prof.frame, rp: a.st.rp, vip: ACC.isVip(a), verified: !!a.verified, title: ACC.titleOf(a), games: a.st.games || 0, wins: a.st.wins || 0, wars: a.st.wars || 0, bstr: a.st.bestStreak || 0, ach: Object.keys(a.st.ach || {}).sort().join(','), level: 1 + Math.floor(Math.sqrt((a.st.xp || 0) / 40)) });
function touch(d, a) { const m = d.members[a.id]; if (!m) return; const s = snap(a); let ch = false; for (const k in s) if (m[k] !== s[k]) { m[k] = s[k]; ch = true } m.seen = Date.now(); if (ch) { d.ver++; persist(d) } }
const isMember = (id, aid) => { const d = all.get(id); return !!(d && aid && d.members[aid]) && !(locked.get(aid) || new Set()).has(id) };
const myDw = a => (a.dw || []).filter(id => all.has(id) && all.get(id).members[a.id]);

// ---------- actions ----------
async function create(a, b) {
  if (myDw(a).length >= maxFor(a)) return { err: 'limit' };
  const name = short(b.name, 22); if (name.length < 2) return { err: 'name' };
  const free = freeDw(a); if (!free && a.w.tokens < DW_PRICE) return { err: 'money' };
  if (free) a.dwFree = a.vipStart; else a.w.tokens -= DW_PRICE;
  const d = { id: crypto.randomBytes(6).toString('hex'), code: newCode(), name, icon: ICONS.includes(b.icon) ? b.icon : ICONS[0], color: COLORS.includes(b.color) ? b.color : COLORS[0],
    owner: a.id, created: Date.now(), ver: 1, members: {}, chat: [] };
  d.members[a.id] = { ...snap(a), role: 'owner', joined: Date.now(), seen: Date.now() };
  add(d); await persist(d); a.dw = [...myDw(a), d.id]; await ACC.save(a); return { ok: true, id: d.id };
}
async function join(a, code) {
  const d = all.get(byCode.get(short(code, 8).toUpperCase())); if (!d) return { err: 'notfound' };
  if (d.members[a.id]) return { ok: true, id: d.id };
  if (myDw(a).length >= maxFor(a)) return { err: 'limit' };
  if (Object.keys(d.members).length >= MEMBERS_MAX) return { err: 'full' };
  d.members[a.id] = { ...snap(a), role: '', joined: Date.now(), seen: Date.now() }; d.ver++; if (d.inv) delete d.inv[a.id];
  sys(d, (a.prof.name || 'لاعب') + ' دخل الديوانية'); await persist(d); a.dw = [...myDw(a), d.id]; await ACC.save(a); return { ok: true, id: d.id };
}
async function leave(a, id) {
  const d = all.get(id); a.dw = (a.dw || []).filter(x => x !== id); await ACC.save(a);
  if (!d || !d.members[a.id]) return { ok: true };
  delete d.members[a.id]; d.ver++;
  const rest = Object.entries(d.members);
  if (!rest.length) { all.delete(d.id); byCode.delete(d.code); d.gone = true; await persist(d); return { ok: true } }
  if (d.owner === a.id) { const next = rest.find(([, m]) => m.role === 'mod') || rest.sort((x, y) => x[1].joined - y[1].joined)[0]; d.owner = next[0]; next[1].role = 'owner' }
  sys(d, (a.prof.name || 'لاعب') + ' طلع من الديوانية'); await persist(d); return { ok: true };
}
async function kick(a, id, who) {
  const d = all.get(id); if (!d) return { err: 'notfound' }; const me = d.members[a.id], t = d.members[who];
  if (!me || !t || who === a.id || !(me.role === 'owner' || (me.role === 'mod' && !t.role))) return { err: 'no' };
  delete d.members[who]; d.ver++; sys(d, t.name + ' انطلع من الديوانية'); await persist(d); return { ok: true };
}
async function role(a, id, who, r) {
  const d = all.get(id); if (!d || d.owner !== a.id || !d.members[who] || who === a.id) return { err: 'no' };
  d.members[who].role = r === 'mod' ? 'mod' : ''; d.ver++; await persist(d); return { ok: true };
}
async function edit(a, id, b) {
  const d = all.get(id); if (!d || d.owner !== a.id) return { err: 'no' };
  const name = short(b.name, 22); if (name.length >= 2) d.name = name;
  if (ICONS.includes(b.icon)) d.icon = b.icon; if (COLORS.includes(b.color)) d.color = b.color; d.ver++; await persist(d); return { ok: true };
}
function sys(d, text) { d.chat.push({ s: 1, t: short(text, 80), ts: Date.now() }); if (d.chat.length > CHAT_KEEP) d.chat.splice(0, d.chat.length - CHAT_KEEP) }
const lastMsg = new Map(), seen = new Map(); // seen: the app was open in the last minute
async function chat(a, id, text) {
  const d = all.get(id); if (!d || !d.members[a.id]) return { err: 'no' }; if (lockOf(a).includes(id)) return { err: 'locked' };
  const t = CLEAN.mask(short(text, 200)); if (!t) return { ok: true };
  const now = Date.now(); if (now - (lastMsg.get(a.id) || 0) < 700) return { err: 'slow' }; lastMsg.set(a.id, now);
  d.chat.push({ a: a.id, n: a.prof.name || 'لاعب', t, ts: now }); if (d.chat.length > CHAT_KEEP) d.chat.splice(0, d.chat.length - CHAT_KEEP);
  await persist(d); return { ok: true };
}

// the diwaniya screen: members (only when something changed), who is on, its tables and new chat messages
function view(a, id, q, live) {
  const d = all.get(id); if (!d || !d.members[a.id]) return { err: 'gone' };
  touch(d, a); if (roll(d)) { d.ver++; persist(d) } const isLocked = lockOf(a).includes(id);
  const st = {}; for (const k of Object.keys(d.members)) st[k] = live.status(k);
  const tables = live.tables(d.id);
  const after = +q.after || 0;
  return { locked: isLocked, id: d.id, code: d.code, name: d.name, icon: d.icon, color: d.color, owner: d.owner, me: a.id, ver: d.ver, max: MEMBERS_MAX,
    members: q.ver == d.ver ? null : Object.entries(d.members).map(([k, m]) => ({ id: k, ...m })),
    rank: q.ver == d.ver ? null : { w: d.rk.w, m: d.rk.m, star: d.star || '', starN: d.starN || {}, wp: Object.fromEntries(Object.keys(d.members).map(k => [k, partner(d, k)]).filter(x => x[1])) },
    inv: Object.keys(d.inv || {}), st, tables, chat: d.chat.filter(m => m.ts > after).slice(-40) };
}
// invite a friend from inside the game: he gets a question, and joins only if he says yes
async function invite(a, id, who, live) {
  const d = all.get(id); if (!d || !d.members[a.id]) return { err: 'no' }; who = String(who || '');
  if (d.members[who]) return { ok: true }; if (!(live && live.isFriend && live.isFriend(a.id, who))) return { err: 'no' };
  if (Object.keys(d.members).length >= MEMBERS_MAX) return { err: 'full' };
  d.inv = d.inv || {}; d.inv[who] = { by: a.id, n: a.prof.name || 'لاعب', ts: Date.now() }; d.ver++; await persist(d); return { ok: true };
}
const pend = a => { const out = []; for (const d of all.values()) { const v = d.inv && d.inv[a.id]; if (v && !d.members[a.id]) out.push({ id: d.id, name: d.name, icon: d.icon, by: v.n, ts: v.ts }) } return out };
async function invAnswer(a, id, yes) {
  const d = all.get(id); if (!d || !d.inv || !d.inv[a.id]) return { err: 'notfound' };
  delete d.inv[a.id]; d.ver++; await persist(d); if (!yes) return { ok: true }; return join(a, d.code);
}
// ---------- the diwaniya ranking: games played at its tables, this week and this month (Kuwait time, the week starts on Sunday) ----------
const KW = 3 * 3600e3;
const weekNo = t => Math.floor((Math.floor((t + KW) / 864e5) + 4) / 7);
const monthKey = t => { const x = new Date(t + KW); return x.getUTCFullYear() + '-' + (x.getUTCMonth() + 1) };
function roll(d) {
  const now = Date.now(), wk = weekNo(now), mk = monthKey(now); d.rk = d.rk || { w: {}, m: {} }; let ch = false;
  if (d.wk !== wk) { // a new week: the one who won most last week becomes the star of the week
    let star = null; if (d.wk === wk - 1) { const top = Object.entries(d.rk.w).filter(([k, v]) => d.members[k] && v.wn > 0).sort((x, y) => y[1].wn - x[1].wn || y[1].wars - x[1].wars || x[1].g - y[1].g)[0]; if (top) { star = top[0]; d.starN = d.starN || {}; d.starN[star] = (d.starN[star] || 0) + 1 } }
    d.star = star; d.rk.w = {}; d.wk = wk; ch = true; }
  if (d.mk !== mk) { d.rk.m = {}; d.mk = mk; ch = true }
  return ch;
}
function played(id, rows) {
  const d = all.get(id); if (!d) return; roll(d); rows = rows.filter(x => x && d.members[x.id]); if (!rows.length) return;
  for (const x of rows) { for (const p of ['w', 'm']) { const o = d.rk[p][x.id] = d.rk[p][x.id] || { g: 0, wn: 0, wars: 0 }; o.g++; if (x.won) o.wn++; o.wars += x.wars || 0 }
    for (const y of rows) if (y.id !== x.id && y.team === x.team) { d.with = d.with || {}; const w = d.with[x.id] = d.with[x.id] || {}; w[y.id] = (w[y.id] || 0) + 1 } }
  d.ver++; persist(d);
}
const partner = (d, id) => { const w = d.with && d.with[id]; if (!w) return ''; const t = Object.entries(w).filter(([k]) => d.members[k]).sort((x, y) => y[1] - x[1])[0]; return t ? t[0] : '' };
// a member opened a table: a line in the chat, and the list of members (the server tells the ones who are online)
function opened(id, name) { const d = all.get(id); if (!d) return []; sys(d, short(name, 20) + ' فتح طاولة 🃏'); persist(d); return Object.keys(d.members) }
function mine(a) { return myDw(a).map(id => { const d = all.get(id); return { id, name: d.name, icon: d.icon, color: d.color, code: d.code, n: Object.keys(d.members).length } }) }

async function http(req, res, url, body, live) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) };
  await ready;
  const a = await ACC.load(String(req.headers.authorization || '').replace(/^Bearer /, '')); if (!a) return send(401, { err: 'auth' });
  const act = url.slice('/api/dw/'.length); seen.set(a.id, Date.now());
  if (act === 'ping') return send(200, { ok: true, inv: pend(a) });
  try {
    if (act === 'mine') { lockOf(a); return send(200, { inv: pend(a), list: mine(a), max: maxFor(a), vip: ACC.isVip(a), free: freeDw(a), price: DW_PRICE, icons: ICONS, colors: COLORS }) }
    if (act === 'create') { const r = await create(a, body); if (r.ok) r.me = ACC.me(a); return send(200, r) }
    if (act === 'join') return send(200, await join(a, body.code));
    if (act === 'leave') return send(200, await leave(a, String(body.id)));
    if (act === 'kick') return send(200, await kick(a, String(body.id), String(body.who)));
    if (act === 'role') return send(200, await role(a, String(body.id), String(body.who), body.role));
    if (act === 'edit') return send(200, await edit(a, String(body.id), body));
    if (act === 'chat') return send(200, await chat(a, String(body.id), body.text));
    if (act === 'invite') return send(200, await invite(a, String(body.id), body.who, live));
    if (act === 'invanswer') return send(200, await invAnswer(a, String(body.id), !!body.yes));
    if (act === 'view') return send(200, view(a, String(body.id), body, live));
    return send(404, { err: 'nf' });
  } catch (e) { console.error('dw', e); return send(500, { err: 'server' }) }
}
module.exports = { http, isMember, opened, played, recent: aid => Date.now() - (seen.get(aid) || 0) < 45000, name: id => (all.get(id) || {}).name || '' };
