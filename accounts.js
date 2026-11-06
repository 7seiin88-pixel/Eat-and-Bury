// حفر ودفن: player accounts. The server keeps every player's rupees, items, rank and stats,
// so they survive a new phone and nobody can give themselves rupees by editing the page.
// Storage: PostgreSQL when DATABASE_URL is set (Render), otherwise a JSON file (for testing on a computer).
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const TEST_MODE = process.env.TEST_MODE !== 'off'; // test phase: everyone starts with 50,000 rupees
const START_RUPEES = TEST_MODE ? 50000 : 500;
const DAILY = 50, OFFLINE_CAP = 100; // daily gift; rupees a day from games against the computer
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const levelOf = xp => 1 + Math.floor(Math.sqrt((xp || 0) / 40));
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.floor(+v || 0)));
const short = (v, n) => String(v == null ? '' : v).replace(/[<>"]/g, '').slice(0, n);

// ---------- storage ----------
class FileStore {
  constructor(file) { this.file = file; this.map = new Map(); this.tok = new Map(); try { for (const a of JSON.parse(fs.readFileSync(file, 'utf8'))) { this.map.set(a.id, a); this.tok.set(a.token, a.id) } } catch (e) {} this.t = null }
  async init() {}
  async byToken(h) { const id = this.tok.get(h); return id ? JSON.parse(JSON.stringify(this.map.get(id))) : null }
  async put(a) { this.map.set(a.id, JSON.parse(JSON.stringify(a))); this.tok.set(a.token, a.id); if (!this.t) this.t = setTimeout(() => { this.t = null; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.map.values()])) } catch (e) { console.error('save', e) } }, 500) }
}
class PgStore {
  constructor(url) { const { Pool } = require('pg'); this.pool = new Pool({ connectionString: url, ssl: (process.env.PGSSL === 'on' || /\.render\.com/.test(url)) ? { rejectUnauthorized: false } : false, max: 5 }) }
  async init() { await this.pool.query(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())`) }
  async byToken(h) { const r = await this.pool.query('SELECT data FROM accounts WHERE token=$1', [h]); return r.rows[0] ? r.rows[0].data : null }
  async put(a) { await this.pool.query('INSERT INTO accounts (id, token, data, updated) VALUES ($1,$2,$3,now()) ON CONFLICT (id) DO UPDATE SET data=$3, token=$2, updated=now()', [a.id, a.token, a]) }
}
const store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new FileStore(path.join(__dirname, 'data', 'accounts.json'));
const ready = store.init().then(() => console.log('accounts:', process.env.DATABASE_URL ? 'PostgreSQL' : 'file store')).catch(e => console.error('accounts store', e));

// ---------- the account ----------
function cleanProf(p, own) {
  p = p || {}; const o = {};
  const av = String(p.av || ''); o.av = (/^p:\d{1,2}$/.test(av) || (av.startsWith('data:image/jpeg;base64,') && av.length < 40000)) ? av : 'p:0';
  o.name = short(p.name, 16).trim(); o.flag = short(p.flag, 8) || '🇰🇼';
  const fr = String(p.frame || 'none'); o.frame = fr === 'none' || own('fr-' + fr) ? fr : 'none';
  const ef = String(p.efx || 'none'); o.efx = ef === 'none' || own('efx-' + ef) || (CAT.items['efx-' + ef] === 0) ? ef : 'none';
  const sf = String(p.sfx || 'blaze'); o.sfx = own('sfx-' + sf) || CAT.items['sfx-' + sf] === 0 ? sf : 'blaze';
  const ai = v => clamp(v, -1, CAT.emotes + 50);
  o.auto = p.auto && typeof p.auto === 'object' ? { def: ai(p.auto.def), save: ai(p.auto.save), took: ai(p.auto.took), win: ai(p.auto.win), snd: '' } : { def: -1, save: -1, took: -1, win: -1, snd: '' };
  o.qp = Array.isArray(p.qp) ? p.qp.map(v => clamp(v, 0, CAT.emotes + 50)).slice(0, 80) : null;
  o.prefs = {}; if (p.prefs && typeof p.prefs === 'object') for (const k of ['theme', 'back', 'face', 'joker', 'lang']) if (p.prefs[k] != null) o.prefs[k] = short(p.prefs[k], 24);
  return o;
}
function fresh(local) {
  local = local || {}; const lw = local.wal || {}, lp = local.prof || {};
  const a = { id: crypto.randomBytes(6).toString('hex'), token: '', created: Date.now(),
    st: { xp: clamp(lp.xp, 0, 1e7), games: clamp(lp.games, 0, 1e6), wins: clamp(lp.wins, 0, 1e6), wars: clamp(lp.wars, 0, 1e7), best: clamp(lp.best, 0, 1e5), tauf: clamp(lp.tauf, 0, 1e6), rp: clamp(lp.rp, 0, 1e6), streak: clamp(lp.streak, 0, 1e4), bestStreak: clamp(lp.bestStreak, 0, 1e4), ach: {} },
    w: { tokens: TEST_MODE ? Math.max(START_RUPEES, clamp(lw.tokens, 0, 1e6)) : START_RUPEES, owned: [], slams: clamp(lw.slams, 0, TEST_MODE ? 500 : 0), day: '', offDay: '', offGot: 0 } };
  // bring over what was bought on this phone before accounts existed
  if (Array.isArray(lw.owned)) a.w.owned = [...new Set(lw.owned.filter(id => typeof id === 'string' && CAT.items[id] != null))];
  if (lp.ach && typeof lp.ach === 'object') for (const k of Object.keys(lp.ach)) if (ACH.some(x => x.id === k)) a.st.ach[k] = 1;
  const own = id => a.w.owned.includes(id) || CAT.items[id] === 0;
  a.prof = cleanProf(lp, own);
  return a;
}
const ACH = [['w1', s => s.wins >= 1, 50], ['w10', s => s.wins >= 10, 150], ['w50', s => s.wins >= 50, 500], ['g10', s => s.games >= 10, 100], ['g100', s => s.games >= 100, 600],
  ['war25', s => s.wars >= 25, 150], ['war100', s => s.wars >= 100, 400], ['big', s => s.best >= 100, 150], ['s3', s => s.bestStreak >= 3, 150], ['s5', s => s.bestStreak >= 5, 400],
  ['tauf', s => s.tauf >= 5, 100], ['lv10', s => levelOf(s.xp) >= 10, 200], ['gold', s => s.rp >= 800, 300], ['legend', s => s.rp >= 4000, 2000]].map(([id, ok, r]) => ({ id, ok, r }));
function checkAch(a) { const got = []; for (const x of ACH) if (!a.st.ach[x.id] && x.ok(a.st)) { a.st.ach[x.id] = Date.now(); a.w.tokens += x.r; got.push({ id: x.id, r: x.r }) } return got }
function daily(a) { const d = today(); if (a.w.day !== d) { a.w.day = d; a.w.tokens += DAILY; return DAILY } return 0 }
// what the phone gets
function me(a, note) { return { id: a.id, prof: a.prof, st: { ...a.st, level: levelOf(a.st.xp) }, wal: { tokens: a.w.tokens, owned: a.w.owned, slams: a.w.slams }, note: note || null, test: TEST_MODE } }
function pub(a) { return { name: a.prof.name, av: a.prof.av, flag: a.prof.flag, frame: a.prof.frame, efx: a.prof.efx, sfx: a.prof.sfx || 'blaze', auto: a.prof.auto, level: levelOf(a.st.xp), games: a.st.games, wins: a.st.wins, wars: a.st.wars, rp: a.st.rp, streak: a.st.streak, tauf: a.st.tauf } }

// ---------- what a phone may ask ----------
async function load(token) { await ready; if (!token) return null; return store.byToken(hash(token)) }
async function create(local) { await ready; const a = fresh(local), token = crypto.randomBytes(24).toString('base64url'); a.token = hash(token); daily(a); await store.put(a); return { token, a } }
// The phone sends what it thinks it has. Only buying (with rupees the server knows about) and spending are accepted;
// anything that would add rupees is ignored, because the server gives every reward itself.
async function sync(a, body) {
  const wal = body.wal || {}, notes = [];
  const want = Array.isArray(wal.owned) ? [...new Set(wal.owned)].filter(id => typeof id === 'string' && CAT.items[id] != null && !a.w.owned.includes(id)) : [];
  let tokens = a.w.tokens;
  for (const id of want) { const c = CAT.items[id]; if (tokens >= c) { tokens -= c; a.w.owned.push(id) } else notes.push('cant:' + id) }
  // fire slams bought in packs, or used
  const sl = clamp(wal.slams, 0, 100000);
  if (sl > a.w.slams) { const add = sl - a.w.slams, pk = (CAT.slamPacks || []).find(([n]) => n === add), cost = pk ? pk[1] : Math.ceil(add * 8); if (tokens >= cost) { tokens -= cost; a.w.slams = sl } }
  else if (sl < a.w.slams) a.w.slams = sl;
  // other spending (gifts sent to the computer, etc.): accept only a decrease
  const claimed = clamp(wal.tokens, 0, 1e9); if (wal.tokens != null && claimed < tokens) tokens = claimed;
  a.w.tokens = tokens;
  if (body.prof) { const own = id => a.w.owned.includes(id) || CAT.items[id] === 0; const n = cleanProf({ ...a.prof, ...body.prof, prefs: { ...a.prof.prefs, ...(body.prof.prefs || {}) } }, own); a.prof = n }
  await store.put(a); return me(a, notes.length ? { refused: notes } : null);
}
// a game against the computer (results come from the phone, so the reward is small and capped each day)
async function offline(a, r) {
  const won = !!r.won, wars = clamp(r.wars, 0, 60), best = clamp(r.best, 0, 2000), tauf = clamp(r.tauf, 0, 60);
  a.st.games++; if (won) a.st.wins++; a.st.wars += wars; a.st.best = Math.max(a.st.best, best); a.st.tauf += tauf; a.st.xp += 10 + (won ? 25 : 0) + wars * 3;
  const d = today(); if (a.w.offDay !== d) { a.w.offDay = d; a.w.offGot = 0 } const give = Math.max(0, Math.min(won ? 25 : 10, OFFLINE_CAP - a.w.offGot)); a.w.offGot += give; a.w.tokens += give;
  const got = checkAch(a); await store.put(a); return me(a, { offline: give, ach: got });
}
// online games: the server saw everything, so these are the real rewards and the real rank
async function warWon(a, gain) { const n = Math.max(2, Math.round(gain / 10)); a.w.tokens += n; await store.put(a); return me(a, { war: n }) }
async function gameOver(a, r) {
  const won = !!r.won, st = a.st, before = st.rp; let mult = 1, d;
  st.games++; st.wars += r.wars || 0; st.best = Math.max(st.best, r.best || 0); st.tauf += r.tauf || 0;
  if (won) { st.wins++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak); mult = 1 + Math.min(st.streak - 1, 4) * .25; d = Math.round(20 * mult) } else { st.streak = 0; d = -12 }
  st.xp += Math.round((10 + (won ? 25 : 0) + (r.wars || 0) * 3) * mult); st.rp = Math.max(0, before + d);
  const prize = won ? 40 : 10; a.w.tokens += prize;
  const got = checkAch(a); await store.put(a); return me(a, { game: { won, rp: st.rp - before, mult, prize }, ach: got });
}
async function save(a) { await store.put(a) }

// ---------- HTTP: /api/... ----------
async function http(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) };
  const body = await new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 120000) req.destroy() }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}) } catch (e) { r({}) } }) });
  const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    if (url === '/api/guest' && req.method === 'POST') { const { token, a } = await create(body.local); return send(200, { token, me: me(a, { welcome: true }) }) }
    const a = await load(tok); if (!a) return send(401, { err: 'auth' });
    if (url === '/api/me') { const g = daily(a); const got = checkAch(a); if (g || got.length) await store.put(a); return send(200, me(a, g || got.length ? { daily: g, ach: got } : null)) }
    if (url === '/api/sync' && req.method === 'POST') return send(200, await sync(a, body));
    if (url === '/api/offline' && req.method === 'POST') return send(200, await offline(a, body));
    return send(404, { err: 'nf' });
  } catch (e) { console.error('api', e); return send(500, { err: 'server' }) }
}
module.exports = { http, load, pub, me, warWon, gameOver, save, CAT, ready };
