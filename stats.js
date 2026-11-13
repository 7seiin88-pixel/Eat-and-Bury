// حفر ودفن: game statistics for the owner (games, players, errors). Read with ADMIN_KEY or STATS_KEY (read only).
// One record per day (Kuwait time). Kept in PostgreSQL when DATABASE_URL is set, otherwise in data/stats.json.
// Nothing personal is kept: players are counted by a hashed id, errors by their message and place.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const days = new Map(); const dirty = new Set(); let save = async () => {}, timer = null;
const DAY = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10); // Kuwait = UTC+3
const HOUR = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(11, 13);
const H = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
function day(k = DAY()) { let d = days.get(k); if (!d) { d = { games: { online: 0, quick: 0, offline: 0 }, done: { online: 0, offline: 0 }, durS: 0, durN: 0, players: [], newAcc: 0, fire: 0, gifts: 0, spent: 0, drops: 0, back: 0, peak: 0, peakRooms: 0, cerr: {}, serr: {}, rooms: 0, h: {}, list: [], buy: {}, use: {}, fire: 0, fireU: {}, nm: {} }; days.set(k, d) } d.h = d.h || {}; d.list = d.list || []; d.rooms = d.rooms || 0; d.buy = d.buy || {}; d.use = d.use || {}; d.fireU = d.fireU || {}; d.nm = d.nm || {}; return d }
function touch(k = DAY()) { dirty.add(k); if (timer) return; timer = setTimeout(() => { timer = null; const ks = [...dirty]; dirty.clear(); Promise.resolve(save(ks)).catch(e => origErr('stats save', e)) }, 5000) }
const ready = (async () => {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg'); const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: (process.env.PGSSL === 'on' || /\.render\.com/.test(url)) ? { rejectUnauthorized: false } : false, max: 2 });
    await pool.query('CREATE TABLE IF NOT EXISTS stats (day TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const r of (await pool.query("SELECT day, data FROM stats WHERE day >= $1", [DAY(Date.now() - 95 * 864e5)])).rows) days.set(r.day, Object.assign(day(r.day), r.data));
    save = async ks => { for (const k of ks) { const v = days.get(k); if (v) await pool.query('INSERT INTO stats (day,data,updated) VALUES ($1,$2,now()) ON CONFLICT (day) DO UPDATE SET data=$2, updated=now()', [k, JSON.stringify(v)]) } };
  } else {
    const file = path.join(__dirname, 'data', 'stats.json');
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); for (const k in o) days.set(k, Object.assign(day(k), o[k])) } catch (e) {}
    save = async () => { const o = {}; for (const [k, v] of days) o[k] = v; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)) };
  }
})().catch(e => origErr('stats store', e));
// keep the last 95 days only
setInterval(() => { const cut = DAY(Date.now() - 95 * 864e5); for (const k of days.keys()) if (k < cut) days.delete(k) }, 6 * 3600e3).unref();

// ---------- counting ----------
function bump(field, n = 1, sub) { const d = day(); if (sub) d[field][sub] = (d[field][sub] || 0) + n; else d[field] = (d[field] || 0) + n; touch() }
function player(id) { if (!id) return; const d = day(), h = H(id); if (d.players.length < 20000 && !d.players.includes(h)) { d.players.push(h); touch() } }
function gameStart(kind) { bump('games', 1, kind); hourBump('g') }
function gameEnd(kind, ms) { const d = day(); d.done[kind] = (d.done[kind] || 0) + 1; if (ms > 30e3 && ms < 3 * 3600e3) { d.durS += Math.round(ms / 1000); d.durN++ } touch() }
// errors: grouped by message + place, newest version and phone kept
function err(side, e) { try { const d = day(), box = side === 'server' ? d.serr : d.cerr; const msg = String(e.msg || '').slice(0, 160), where = String(e.where || '').slice(0, 120); if (!msg) return;
    const k = H(msg + '|' + where); let x = box[k]; if (!x) { if (Object.keys(box).length >= 150) return; x = box[k] = { msg, where, n: 0, first: Date.now() } }
    x.n++; x.last = Date.now(); if (e.ver) x.ver = String(e.ver).slice(0, 20); if (e.dev) x.dev = String(e.dev).slice(0, 60); touch() } catch (_) {} }

// ---------- per hour and the list of games (names as the players wrote them; guests show as their typed name or 'ضيف') ----------
function hr(t = Date.now()) { const d = day(DAY(t)), k = HOUR(t); let h = d.h[k]; if (!h) h = d.h[k] = { g: 0, r: 0, p: [] }; return h }
function hourPlayer(id) { if (!id) return; const h = hr(), x = H(id); if (h.p.length < 2000 && !h.p.includes(x)) { h.p.push(x); touch() } }
function hourBump(f) { hr()[f]++; touch() }
function roomMade(priv) { const d = day(); d.rooms++; hourBump('r') }
const clean = s => String(s || '').replace(/[<>\n\r\t]/g, '').trim().slice(0, 24) || 'ضيف';
function addGame(g) { const d = day(); if (d.list.length >= 400) d.list.shift(); d.list.push({ t: Date.now(), kind: g.kind, mode: g.mode || '', names: (g.names || []).map(clean).slice(0, 6), bots: g.bots || 0, end: 0, won: '', min: 0, fire: 0 }); touch(); return d.list.length - 1 }
function endGameRec(day0, idx, r) { const d = days.get(day0); if (!d || !d.list[idx]) return; Object.assign(d.list[idx], r); touch(day0) }

// ---------- what people buy and what they actually use (to decide what to keep) ----------
const okId = id => /^[a-z0-9_-]{1,40}$/i.test(String(id || ''));
function nameOf(d, id, nm) { if (nm && Object.keys(d.nm).length < 600) d.nm[id] = String(nm).replace(/[<>]/g, '').slice(0, 40) }
function bought(id, nm) { if (!okId(id)) return; const d = day(); d.buy[id] = (d.buy[id] || 0) + 1; nameOf(d, id, nm); touch() }
function used(items) { if (!Array.isArray(items)) return; const d = day(); items.slice(0, 12).forEach(x => { const id = x && x.id; if (!okId(id)) return; d.use[id] = (d.use[id] || 0) + 1; nameOf(d, id, x.n) }); touch() }
function fired(id, nm) { if (!okId(id)) return; const d = day(); d.fireU[id] = (d.fireU[id] || 0) + 1; nameOf(d, id, nm); touch() }
// live: who has the game open (a ping every minute from each phone)
const seen = new Map();
function ping(id) { if (!id) return; seen.set(H(id), Date.now()); player(id); hourPlayer(id) }
setInterval(() => { const t = Date.now() - 3 * 60e3; for (const [k, v] of seen) if (v < t) seen.delete(k) }, 60e3).unref();

// server errors are counted too (without changing what is printed)
const origErr = console.error.bind(console);
console.error = (...a) => { origErr(...a); try { const e = a.find(x => x instanceof Error); err('server', { msg: (typeof a[0] === 'string' ? a[0] + ': ' : '') + (e ? e.message : a.slice(1).map(String).join(' ')), where: e && e.stack ? (e.stack.split('\n')[1] || '').trim() : '' }) } catch (_) {} };
process.on('uncaughtException', e => { origErr('uncaught', e); err('server', { msg: 'uncaught: ' + e.message, where: (String(e.stack || '').split('\n')[1] || '').trim() }) });
process.on('unhandledRejection', e => { origErr('unhandled', e); err('server', { msg: 'unhandled: ' + (e && e.message || String(e)), where: (String(e && e.stack || '').split('\n')[1] || '').trim() }) });

// ---------- the report ----------
function report(live, n = 30) {
  const out = []; for (let i = 0; i < n; i++) { const k = DAY(Date.now() - i * 864e5), d = days.get(k); out.push({ day: k, ...(d ? summary(d) : summary(day(k))) }) }
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0), pl = arr => { const s = new Set(); arr.forEach(k => { const d = days.get(k.day); if (d) d.players.forEach(p => s.add(p)) }); return s.size };
  const span = m => { const a = out.slice(0, m); return { games: sum(a, x => x.games), online: sum(a, x => x.online), offline: sum(a, x => x.offline), players: pl(a), newAcc: sum(a, x => x.newAcc), fire: sum(a, x => x.fire), gifts: sum(a, x => x.gifts), spent: sum(a, x => x.spent), cerr: sum(a, x => x.cerrN), serr: sum(a, x => x.serrN) } };
  const errs = side => { const m = new Map(); out.slice(0, 7).forEach(o => { const d = days.get(o.day); if (!d) return; for (const x of Object.values(d[side])) { const k = x.msg + '|' + x.where, y = m.get(k); if (y) { y.n += x.n; y.last = Math.max(y.last, x.last); if (x.last >= y.last) { y.ver = x.ver || y.ver; y.dev = x.dev || y.dev } } else m.set(k, { ...x }) } }); return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 25) };
  // last 48 hours, newest first
  const hours = []; for (let i = 0; i < 48; i++) { const t = Date.now() - i * 3600e3, d = days.get(DAY(t)), h = d && d.h && d.h[HOUR(t)]; hours.push({ day: DAY(t), hour: HOUR(t), games: h ? h.g : 0, rooms: h ? h.r : 0, players: h ? h.p.length : 0 }) }
  const since = ms => { const t0 = Date.now() - ms, ps = new Set(); let g = 0, r = 0; for (let i = 0; i * 3600e3 < ms; i++) { const t = Date.now() - i * 3600e3, d = days.get(DAY(t)), h = d && d.h && d.h[HOUR(t)]; if (h) { g += h.g; r += h.r; h.p.forEach(x => ps.add(x)) } } return { games: g, rooms: r, players: ps.size } };
  const games = []; out.slice(0, 3).forEach(o => { const d = days.get(o.day); if (d && d.list) d.list.forEach(x => games.push(x)) }); games.sort((a, b) => b.t - a.t);
  const top = (field, m) => { const acc = {}, nms = {}; out.slice(0, m).forEach(o => { const d = days.get(o.day); if (!d) return; Object.assign(nms, d.nm || {}); for (const [k, v] of Object.entries(d[field] || {})) acc[k] = (acc[k] || 0) + v }); return Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, n]) => ({ id, n, name: nms[id] || id })) };
  const shop = { bought: top('buy', 30), used: top('use', 30), fire: top('fireU', 30) };
  return { shop, now: { open: seen.size, ...live }, last12: since(12 * 3600e3), last24: since(24 * 3600e3), today: { ...span(1), rooms: (days.get(DAY()) || {}).rooms || 0 }, week: span(7), month: span(30), hours, games: games.slice(0, 150), days: out, errors: { phone: errs('cerr'), server: errs('serr') }, at: Date.now() };
}
function summary(d) { return { games: (d.games.online || 0) + (d.games.quick || 0) + (d.games.offline || 0), online: (d.games.online || 0) + (d.games.quick || 0), quick: d.games.quick || 0, offline: d.games.offline || 0, finished: (d.done.online || 0) + (d.done.offline || 0), avgMin: d.durN ? Math.round(d.durS / d.durN / 6) / 10 : 0, players: d.players.length, newAcc: d.newAcc || 0, fire: d.fire || 0, gifts: d.gifts || 0, spent: d.spent || 0, drops: d.drops || 0, back: d.back || 0, peak: d.peak || 0, cerrN: Object.values(d.cerr).reduce((s, x) => s + x.n, 0), serrN: Object.values(d.serr).reduce((s, x) => s + x.n, 0) } }
function peak(open, rooms) { const d = day(); if (open > d.peak) { d.peak = open; touch() } if (rooms > d.peakRooms) { d.peakRooms = rooms; touch() } }
const okKey = req => { const k = req.headers['x-admin-key'] || req.headers['x-stats-key'] || ''; return !!k && ((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (process.env.STATS_KEY && k === process.env.STATS_KEY)) };

module.exports = { bought, used, fired, ready, bump, player, gameStart, gameEnd, err, ping, report, peak, okKey, seen, roomMade, addGame, endGameRec, DAY };
