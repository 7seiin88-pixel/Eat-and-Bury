// حفر ودفن: game statistics for the owner (games, players, errors). Read with ADMIN_KEY or STATS_KEY (read only).
// One record per day (Kuwait time). Kept in PostgreSQL when DATABASE_URL is set, otherwise in data/stats.json.
// Nothing personal is kept: players are counted by a hashed id, errors by their message and place.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const days = new Map(); const dirty = new Set(); let save = async () => {}, timer = null;
const DAY = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10); // Kuwait = UTC+3
const H = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
function day(k = DAY()) { let d = days.get(k); if (!d) { d = { games: { online: 0, quick: 0, offline: 0 }, done: { online: 0, offline: 0 }, durS: 0, durN: 0, players: [], newAcc: 0, fire: 0, gifts: 0, spent: 0, drops: 0, back: 0, peak: 0, peakRooms: 0, cerr: {}, serr: {} }; days.set(k, d) } return d }
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
function gameStart(kind) { bump('games', 1, kind) }
function gameEnd(kind, ms) { const d = day(); d.done[kind] = (d.done[kind] || 0) + 1; if (ms > 30e3 && ms < 3 * 3600e3) { d.durS += Math.round(ms / 1000); d.durN++ } touch() }
// errors: grouped by message + place, newest version and phone kept
function err(side, e) { try { const d = day(), box = side === 'server' ? d.serr : d.cerr; const msg = String(e.msg || '').slice(0, 160), where = String(e.where || '').slice(0, 120); if (!msg) return;
    const k = H(msg + '|' + where); let x = box[k]; if (!x) { if (Object.keys(box).length >= 150) return; x = box[k] = { msg, where, n: 0, first: Date.now() } }
    x.n++; x.last = Date.now(); if (e.ver) x.ver = String(e.ver).slice(0, 20); if (e.dev) x.dev = String(e.dev).slice(0, 60); touch() } catch (_) {} }
// live: who has the game open (a ping every minute from each phone)
const seen = new Map();
function ping(id) { if (!id) return; seen.set(H(id), Date.now()); player(id) }
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
  return { now: { open: seen.size, ...live }, today: span(1), week: span(7), month: span(30), days: out, errors: { phone: errs('cerr'), server: errs('serr') }, at: Date.now() };
}
function summary(d) { return { games: (d.games.online || 0) + (d.games.quick || 0) + (d.games.offline || 0), online: (d.games.online || 0) + (d.games.quick || 0), quick: d.games.quick || 0, offline: d.games.offline || 0, finished: (d.done.online || 0) + (d.done.offline || 0), avgMin: d.durN ? Math.round(d.durS / d.durN / 6) / 10 : 0, players: d.players.length, newAcc: d.newAcc || 0, fire: d.fire || 0, gifts: d.gifts || 0, spent: d.spent || 0, drops: d.drops || 0, back: d.back || 0, peak: d.peak || 0, cerrN: Object.values(d.cerr).reduce((s, x) => s + x.n, 0), serrN: Object.values(d.serr).reduce((s, x) => s + x.n, 0) } }
function peak(open, rooms) { const d = day(); if (open > d.peak) { d.peak = open; touch() } if (rooms > d.peakRooms) { d.peakRooms = rooms; touch() } }
const okKey = req => { const k = req.headers['x-admin-key'] || req.headers['x-stats-key'] || ''; return !!k && ((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (process.env.STATS_KEY && k === process.env.STATS_KEY)) };

module.exports = { ready, bump, player, gameStart, gameEnd, err, ping, report, peak, okKey, seen };
