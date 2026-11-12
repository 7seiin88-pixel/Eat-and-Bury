// حفر ودفن: player accounts. The server keeps every player's rupees, items, rank and stats,
// so they survive a new phone and nobody can give themselves rupees by editing the page.
// Storage: PostgreSQL when DATABASE_URL is set (Render), otherwise a JSON file (for testing on a computer).
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const TEST_MODE = process.env.TEST_MODE !== 'off'; // test phase: everyone starts with 50,000 rupees
const START_RUPEES = TEST_MODE ? 50000 : 500;
const VIP_DAYS = 30, VIP_TEST_PRICE = 5000; // VIP: $4.99 a month in the App Store; while testing it is bought with rupees
const isVip = a => (a.vip || 0) > Date.now();
const DAILY = 50, OFFLINE_CAP = 60; // daily gift; rupees a day from games against the computer
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
  async byId(id) { const a = this.map.get(id); return a ? JSON.parse(JSON.stringify(a)) : null }
  async top(n) { return [...this.map.values()].sort((x, y) => (y.st.rp || 0) - (x.st.rp || 0)).slice(0, n) }
  async above(rp) { let k = 0; for (const a of this.map.values()) if ((a.st.rp || 0) > rp) k++; return k }
  async put(a) { this.map.set(a.id, JSON.parse(JSON.stringify(a))); this.tok.set(a.token, a.id); if (!this.t) this.t = setTimeout(() => { this.t = null; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.map.values()])) } catch (e) { console.error('save', e) } }, 500) }
}
class PgStore {
  constructor(url) { const { Pool } = require('pg'); this.pool = new Pool({ connectionString: url, ssl: (process.env.PGSSL === 'on' || /\.render\.com/.test(url)) ? { rejectUnauthorized: false } : false, max: 5 }) }
  async init() { await this.pool.query(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())`) }
  async byToken(h) { const r = await this.pool.query('SELECT data FROM accounts WHERE token=$1', [h]); return r.rows[0] ? r.rows[0].data : null }
  async byId(id) { const r = await this.pool.query('SELECT data FROM accounts WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null }
  async top(n) { const r = await this.pool.query("SELECT data FROM accounts ORDER BY COALESCE((data->'st'->>'rp')::int,0) DESC LIMIT $1", [n]); return r.rows.map(x => x.data) }
  async above(rp) { const r = await this.pool.query("SELECT count(*)::int AS n FROM accounts WHERE COALESCE((data->'st'->>'rp')::int,0) > $1", [rp]); return r.rows[0].n }
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
  const bb = String(p.bub || 'plain'); o.bub = bb === 'plain' || bb === 'royal' || own('bub-' + bb) ? bb : 'plain';
  const ht = String(p.hit || 'classic'); o.hit = /^[a-z0-9]{1,16}$/.test(ht) && (own('hit-' + ht) || CAT.items['hit-' + ht] === 0) ? ht : 'classic'; // the hit counter you chose
  const sf = String(p.sfx || 'plain'); o.sfx = own('sfx-' + sf) || CAT.items['sfx-' + sf] === 0 ? sf : 'plain';
  const ai = v => clamp(v, -1, CAT.emotes + 50);
  { const src = p.auto && typeof p.auto === 'object' ? p.auto : {}; o.auto = { snd: '' }; for (const e of ['def', 'save', 'took', 'win', 'lost', 'winbig', 'tauf']) { o.auto[e] = src[e] == null ? -1 : ai(src[e]); o.auto[e + '2'] = src[e + '2'] == null ? -1 : ai(src[e + '2']); o.auto[e + '3'] = src[e + '3'] == null ? -1 : ai(src[e + '3']) } }
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
// military ranks (rank points from ranked games: the quick game)
const RANK_MIN = [0, 150, 400, 800, 1300, 1900, 2600, 3400, 4300, 5300, 6500];
const rankIx = rp => { let i = 0; RANK_MIN.forEach((m, k) => { if ((rp || 0) >= m) i = k }); return i };
// a new season every month: rank points drop by half and everyone gets a prize for the best rank they reached
function season(a) { const m = new Date().toISOString().slice(0, 7), st = a.st;
  if (!st.season) { st.season = m; st.peak = st.rp; return null }
  if (st.season === m) return null;
  const peak = rankIx(Math.max(st.peak || 0, st.rp)), prize = peak * 300;
  a.w.tokens += prize; st.seasons = (st.seasons || []).concat({ m: st.season, r: peak }).slice(-24);
  st.rp = Math.floor(st.rp / 2); st.peak = st.rp; st.season = m; st.shield = 0; return { r: peak, prize, m: st.seasons[st.seasons.length - 1].m } }
// a title under your name, from your best badge

// Round 91: more achievement stats
const NEWST = ['fire', 'jk', 'pile', 'dig', 'gifts', 'lastw', 'comeback', 'tw', 'faz'];
function addStats(st, r, cap) { for (const k of NEWST) st[k] = (st[k] || 0) + clamp(r[k], 0, cap[k] || 60); st.bigwar = Math.max(st.bigwar || 0, clamp(r.bigwar, 0, 20)) }
const OFF_CAP = { fire: 40, jk: 30, pile: 30, dig: 5, gifts: 20, lastw: 15, comeback: 1, tw: 10, faz: 15 }, ON_CAP = { fire: 200, jk: 60, pile: 60, dig: 20, gifts: 60, lastw: 30, comeback: 1, tw: 30, faz: 30 };
function addPartners(st, r) { if (!r.won || !Array.isArray(r.partners)) return; st.pw = st.pw && typeof st.pw === 'object' ? st.pw : {};
  for (const k of r.partners.slice(0, 2)) { if (typeof k !== 'string' || !/^[0-9a-f]{12}$/.test(k)) continue; st.pw[k] = (st.pw[k] || 0) + 1 }
  const ks = Object.keys(st.pw); if (ks.length > 40) ks.sort((x, y) => st.pw[x] - st.pw[y]).slice(0, ks.length - 40).forEach(k => delete st.pw[k]) }
const palBest = st => Math.max(0, ...Object.values(st.pw || {}))
const TITLES = ['legend', 'w50', 's5', 'war100', 'g100', 'gold', 'war5', 'big200', 'comeback', 'pal10', 'dig', 'big', 'w10', 's3', 'war25', 'jk25', 'fire20', 'faz50', 'pile20', 'last10', 'faz10', 'fg10', 'tw5', 'lv10', 'g10', 'w1'];
const titleOf = a => TITLES.find(k => a.st.ach && a.st.ach[k]) || '';
const ACH = [['w1', s => s.wins >= 1, 50], ['w10', s => s.wins >= 10, 150], ['w50', s => s.wins >= 50, 500], ['g10', s => s.games >= 10, 100], ['g100', s => s.games >= 100, 600],
  ['war25', s => s.wars >= 25, 150], ['war100', s => s.wars >= 100, 400], ['big', s => s.best >= 100, 150], ['s3', s => s.bestStreak >= 3, 150], ['s5', s => s.bestStreak >= 5, 400],
  ['fire20', s => (s.fire || 0) >= 20, 150], ['war5', s => (s.bigwar || 0) >= 5, 300], ['jk25', s => (s.jk || 0) >= 25, 200],
  ['pile20', s => (s.pile || 0) >= 20, 150], ['big200', s => s.best >= 200, 300], ['dig', s => (s.dig || 0) >= 1, 200],
  ['fg10', s => (s.fg || 0) >= 10, 200], ['gift20', s => (s.gifts || 0) >= 20, 100], ['pal10', s => palBest(s) >= 10, 300],
  ['faz10', s => (s.faz || 0) >= 10, 200], ['faz50', s => (s.faz || 0) >= 50, 500], ['last10', s => (s.lastw || 0) >= 10, 200], ['comeback', s => (s.comeback || 0) >= 1, 300], ['tw5', s => (s.tw || 0) >= 5, 150],
  ['lv10', s => levelOf(s.xp) >= 10, 200], ['gold', s => s.rp >= 800, 300], ['legend', s => s.rp >= 4300, 2000]].map(([id, ok, r]) => ({ id, ok, r }));
function checkAch(a) { const got = []; for (const x of ACH) if (!a.st.ach[x.id] && x.ok(a.st)) { a.st.ach[x.id] = Date.now(); a.w.tokens += x.r; got.push({ id: x.id, r: x.r }) } return got }
function daily(a) { const d = today(); if (a.w.day !== d) { a.w.day = d; const g = DAILY * (isVip(a) ? 2 : 1); a.w.tokens += g; return g } return 0 }
// what the phone gets
function me(a, note) { return { verified: !!a.verified, title: titleOf(a), season: a.st.season || '', seasons: a.st.seasons || [], shield: !!a.st.shield, id: a.id, prof: a.prof, st: { ...a.st, level: levelOf(a.st.xp) }, wal: { tokens: a.w.tokens, owned: a.w.owned, slams: a.w.slams, boost: a.w.boost || 0 }, boostCost: BOOST_COST, boostGames: BOOST_GAMES, note: note || null, test: TEST_MODE, vip: isVip(a) ? a.vip : 0, vipPrice: '$4.99', vipTest: TEST_MODE ? VIP_TEST_PRICE : 0 } }
function pub(a) { return { id: a.id, name: a.prof.name, av: a.prof.av, flag: a.prof.flag, frame: a.prof.frame, efx: a.prof.efx, sfx: a.prof.sfx || 'plain', bub: a.prof.bub || 'plain', hit: a.prof.hit || 'classic', kit: { theme: (a.prof.prefs || {}).theme || '', back: (a.prof.prefs || {}).back || '', face: (a.prof.prefs || {}).face || '', joker: (a.prof.prefs || {}).joker || '' }, auto: a.prof.auto, level: levelOf(a.st.xp), games: a.st.games, wins: a.st.wins, wars: a.st.wars, rp: a.st.rp, streak: a.st.streak, tauf: a.st.tauf, vip: isVip(a), verified: !!a.verified, title: titleOf(a) } }

// ---------- what a phone may ask ----------
async function load(token) { await ready; if (!token) return null; return store.byToken(hash(token)) }
async function create(local) { await ready; const a = fresh(local), token = crypto.randomBytes(24).toString('base64url'); a.token = hash(token); daily(a); await store.put(a); try { require('./stats').bump('newAcc') } catch (e) {} return { token, a } }
// The phone sends what it thinks it has. Only buying (with rupees the server knows about) and spending are accepted;
// anything that would add rupees is ignored, because the server gives every reward itself.
async function sync(a, body) {
  const wal = body.wal || {}, notes = [];
  const want = Array.isArray(wal.owned) ? [...new Set(wal.owned)].filter(id => typeof id === 'string' && CAT.items[id] != null && !a.w.owned.includes(id)) : [];
  let tokens = a.w.tokens;
  // cards and jokers that match a theme the player owns cost less (same rule as the shop)
  const priceOf = id => { const c = CAT.items[id]; if (!c || !CAT.match) return c;
    for (const [th, m] of Object.entries(CAT.match)) { if (!m.includes(id)) continue; const vipT = (CAT.vipThemes || []).includes(th);
      if (vipT ? isVip(a) : (CAT.items[th] > 0 && a.w.owned.includes(th))) return Math.round(c * (1 - (CAT.off || 0)) / 10) * 10 }
    return c };
  want.sort((x, y) => (CAT.match && CAT.match[x] ? -1 : 0) - (CAT.match && CAT.match[y] ? -1 : 0));
  for (const id of want) { const c = priceOf(id); if (tokens >= c) { tokens -= c; a.w.owned.push(id) } else notes.push('cant:' + id) }
  // fire slams bought in packs, or used
  const sl = clamp(wal.slams, 0, 100000);
  if (sl > a.w.slams) { const add = sl - a.w.slams, pk = (CAT.slamPacks || []).find(([n]) => n === add), cost = pk ? pk[1] : Math.ceil(add * 8); if (tokens >= cost) { tokens -= cost; a.w.slams = sl } }
  else if (sl < a.w.slams) a.w.slams = sl;
  // other spending (gifts sent to the computer, etc.): accept only a decrease
  const claimed = clamp(wal.tokens, 0, 1e9); if (wal.tokens != null && claimed < tokens) tokens = claimed;
  try { const sp = a.w.tokens - tokens; if (sp > 0) require('./stats').bump('spent', sp) } catch (e) {}
  a.w.tokens = tokens;
  if (body.prof) { const own = id => a.w.owned.includes(id) || CAT.items[id] === 0; const n = cleanProf({ ...a.prof, ...body.prof, prefs: { ...a.prof.prefs, ...(body.prof.prefs || {}) } }, own); a.prof = n }
  await store.put(a); return me(a, notes.length ? { refused: notes } : null);
}
// a game against the computer (results come from the phone, so the reward is small and capped each day)
async function offline(a, r) {
  const won = !!r.won, wars = clamp(r.wars, 0, 60), best = clamp(r.best, 0, 2000), tauf = clamp(r.tauf, 0, 60);
  a.st.games++; if (won) a.st.wins++; a.st.wars += wars; a.st.best = Math.max(a.st.best, best); a.st.tauf += tauf; addStats(a.st, r, OFF_CAP); const pf = perf({ wars, best, bigwar: clamp(r.bigwar, 0, 20), tw: clamp(r.tw, 0, 10), faz: clamp(r.faz, 0, 15) }), bx = useBoost(a), xp = (10 + (won ? 25 : 0) + wars * 3 + Math.min(8, pf.total) * 2) * bx; a.st.xp += xp;
  const d = today(); if (a.w.offDay !== d) { a.w.offDay = d; a.w.offGot = 0 } const give = Math.max(0, Math.min(won ? 15 : 5, OFFLINE_CAP - a.w.offGot)); a.w.offGot += give; a.w.tokens += give;
  const got = checkAch(a); await store.put(a); return me(a, { offline: give, ach: got, xp, parts: pf.parts, boosted: bx > 1, won });
}
// online games: the server saw everything, so these are the real rewards and the real rank
async function warWon(a, gain) { const n = Math.max(1, Math.round(gain / 20)); a.w.tokens += n; await store.put(a); return me(a, { war: n }) }
async function gameOver(a, r) {
  const sz = season(a); const won = !!r.won, st = a.st, before = st.rp; let mult = 1, d = 0; const bx = useBoost(a), pf = perf(r);
  st.games++; st.wars += r.wars || 0; st.best = Math.max(st.best, r.best || 0); st.tauf += r.tauf || 0; addStats(st, r, ON_CAP); if (!r.ranked) st.fg = (st.fg || 0) + 1; addPartners(st, { ...r, won });
  if (won) { st.wins++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak); mult = 1 + Math.min(st.streak - 1, 4) * .25 } else st.streak = 0;
  let shielded = false;
  if (r.ranked) { // rank points move only in ranked games (the quick game), not in rooms with friends
    d = won ? (Math.round(20 * mult) + pf.total) * bx : -12 + Math.min(6, Math.floor(pf.total / 2)); // a win: 20 x streak + how you played; a loss costs less if you fought well
    let after = Math.max(0, before + d);
    if (!won && st.shield && rankIx(after) < rankIx(before)) { after = RANK_MIN[rankIx(before)]; shielded = true } // the first loss after a promotion never drops you
    if (!won) st.shield = 0; if (rankIx(after) > rankIx(before)) st.shield = 1;
    st.rp = after; st.peak = Math.max(st.peak || 0, after);
  }
  const xp = (Math.round((10 + (won ? 25 : 0) + (r.wars || 0) * 3) * mult) + pf.total * 3) * bx; st.xp += xp;
  const prize = won ? 20 : 5; a.w.tokens += prize;
  const got = checkAch(a); await store.put(a); return me(a, { game: { won, rp: st.rp - before, mult, prize, ranked: !!r.ranked, shielded, xp, parts: pf.parts, bonus: pf.total, base: won ? Math.round(20 * mult) : -12, boosted: bx > 1, streak: st.streak }, ach: got, season: sz });
}
// how you played, not only whether you won: every part is small and capped so nobody can farm one thing
function perf(r) { const parts = [], add = (k, n) => { if (n > 0) parts.push([k, n]) };
  add('wars', Math.min(5, Math.floor((r.wars || 0) / 2)));                                         // 1 for every two wars you won
  const b = r.best || 0; add('loot', b >= 200 ? 5 : b >= 150 ? 4 : b >= 100 ? 3 : b >= 50 ? 2 : 0); // your biggest loot in one war
  add('long', (r.bigwar || 0) >= 5 ? 2 : 0);                                                       // won a war with five cuts or more
  add('tw', Math.min(3, r.tw || 0));                                                               // skipped players who were waiting to draw
  add('faz', Math.min(3, r.faz || 0));                                                             // came to a teammate's rescue
  let total = parts.reduce((n, x) => n + x[1], 0); if (total > 12) total = 12; return { parts, total } }
// points booster: bought with rupees, doubles the XP and the rank points you win for the next few games
const BOOST_COST = 400, BOOST_GAMES = 5;
function useBoost(a) { if ((a.w.boost || 0) > 0) { a.w.boost--; return 2 } return 1 }
async function buyBoost(a) { if (a.w.tokens < BOOST_COST) return me(a, { refused: ['boost'] }); a.w.tokens -= BOOST_COST; a.w.boost = Math.min(50, (a.w.boost || 0) + BOOST_GAMES); await store.put(a); return me(a, { boost: a.w.boost }) }
async function save(a) { await store.put(a) }
const SLAM_COST = 50; // the fire button costs rupees each time
async function spend(a, n) { if (a.w.tokens < n) return null; a.w.tokens -= n; await store.put(a); return me(a) }

// ---------- HTTP: /api/... ----------
async function http(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) };
  const body = await new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 120000) req.destroy() }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}) } catch (e) { r({}) } }) });
  const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    if (url === '/api/guest' && req.method === 'POST') { const { token, a } = await create(body.local); return send(200, { token, me: me(a, { welcome: true }) }) }
    if (url === '/api/admin/verify' && req.method === 'POST') { // you give the blue check yourself: ADMIN_KEY on Render, then the player's account number
      if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return send(403, { err: 'no' });
      const t = await store.byId(String(body.id || '')); if (!t) return send(404, { err: 'nf' }); t.verified = body.on !== false; await store.put(t); return send(200, { ok: true, verified: t.verified }) }
    const a = await load(tok); if (!a) return send(401, { err: 'auth' });
    if (url === '/api/me') { const sz = season(a); const g = daily(a); const got = checkAch(a); if (g || got.length || sz) await store.put(a); return send(200, me(a, g || got.length || sz ? { daily: g, ach: got, season: sz } : null)) }
    if (url === '/api/top') { const list = await store.top(50); const mine = await store.above(a.st.rp || 0);
      return send(200, { me: { pos: mine + 1, rp: a.st.rp || 0 }, list: list.map((x, k) => ({ pos: k + 1, id: x.id === a.id ? 'me' : '', name: x.prof.name || 'لاعب', av: /^p:/.test(x.prof.av || '') ? x.prof.av : (x.prof.av && x.prof.av.length < 40000 ? x.prof.av : 'p:0'), flag: x.prof.flag, rp: x.st.rp || 0, vip: isVip(x), verified: !!x.verified, title: titleOf(x) })) }) }

    if (url === '/api/sync' && req.method === 'POST') return send(200, await sync(a, body));
    if (url === '/api/offline' && req.method === 'POST') return send(200, await offline(a, body));
    if (url === '/api/boost' && req.method === 'POST') return send(200, await buyBoost(a));
    if (url === '/api/vip/test' && req.method === 'POST') { // testing only: buy a month of VIP with rupees (the real one is bought in the App Store)
      if (!TEST_MODE) return send(403, { err: 'store' }); if (a.w.tokens < VIP_TEST_PRICE) return send(200, me(a, { refused: ['vip'] }));
      a.w.tokens -= VIP_TEST_PRICE; const now = Date.now(); if (!isVip(a)) a.vipStart = now; a.vip = Math.max(a.vip || 0, now) + VIP_DAYS * 864e5; await store.put(a); return send(200, me(a, { vip: true })) }
    return send(404, { err: 'nf' });
  } catch (e) { console.error('api', e); return send(500, { err: 'server' }) }
}
const byId = async id => { await ready; return /^[0-9a-f]{12}$/.test(String(id)) ? store.byId(String(id)) : null };
module.exports = { byId, titleOf, SLAM_COST, spend, isVip, http, load, pub, me, warWon, gameOver, save, CAT, ready };
