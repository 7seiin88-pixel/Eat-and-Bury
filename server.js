// Eat & Bury online server.
// - Serves the game page (public/index.html).
// - Connects players in rooms over WebSockets and relays their messages.
// The server runs every online game itself (game.js), so no player's phone is in charge.
// No extra packages needed: uses only what comes with Node.js.
const STATS = require('./stats'); // first: it also counts server errors
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game } = require('./game');
const ACC = require('./accounts');
const DW = require('./diwan');
const SO = require('./social');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const GZ = new Map(), RATE = new Map();
setInterval(() => RATE.clear(), 10 * 60e3).unref();
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/health') { res.end('ok'); return; }
  if (url.startsWith('/api/dw/')) { let b = ''; req.on('data', d => { b += d; if (b.length > 20000) req.destroy() }); req.on('end', () => { let body = {}; try { body = b ? JSON.parse(b) : {} } catch (e) {} DW.http(req, res, url, body, live) }); return; }
  if (url.startsWith('/api/so/')) { let b = ''; req.on('data', d => { b += d; if (b.length > 20000) req.destroy() }); req.on('end', () => { let body = {}; try { body = b ? JSON.parse(b) : {} } catch (e) {} SO.http(req, res, url, body, live) }); return; }
  // statistics: phones send a ping, game start/end and errors; the owner reads the report
  if (url === '/api/stat' || url === '/api/err') { if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
    let q = RATE.get(ip); if (!q || now - q.t > 60e3) { q = { t: now, n: 0 }; RATE.set(ip, q) } if (++q.n > 40) { res.writeHead(429); return res.end() }
    let b = ''; req.on('data', d => { b += d; if (b.length > 4000) req.destroy() }); req.on('end', () => { let o = {}; try { o = JSON.parse(b || '{}') } catch (e) {}
      const id = /^[a-z0-9]{6,40}$/i.test(String(o.id || '')) ? 'd:' + o.id : null;
      if (url === '/api/err') STATS.err('phone', { msg: o.msg, where: o.where, ver: o.ver, dev: o.dev });
      else if (o.ev === 'ping') STATS.ping(id); else if (o.ev === 'start') { STATS.gameStart('offline'); STATS.player(id); STATS.addGame({ kind: 'ضد الكمبيوتر', mode: String(o.mode || '').slice(0, 5), names: [String(o.name || '')], bots: 0 }) } else if (o.ev === 'end') STATS.gameEnd('offline', +o.ms || 0); else if (o.ev === 'kit') STATS.used(o.items); else if (o.ev === 'fire') STATS.fired(o.item, o.n);
      res.writeHead(204); res.end() }); return }
  if (url === '/api/admin/stats') { if (!STATS.okKey(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"err":"no"}') }
    const started = [...rooms.values()].filter(r => r.started), inRooms = started.reduce((n, r) => n + r.members.filter(m => !m.watch && !m.away).length, 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(STATS.report({ connected: clients.size, rooms: started.length, waiting: rooms.size - started.length, playingOnline: inRooms, watching: [...rooms.values()].reduce((n, r) => n + r.members.filter(m => m.watch).length, 0) }))) }
  // voice relay (TURN) for players on mobile data: set TURN_URLS (comma separated), TURN_USER, TURN_PASS in the hosting settings
  if (url.split('?')[0] === '/api/ice') { const urls = String(process.env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
    const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]; if (urls.length) ice.push({ urls, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ice, relay: urls.length > 0 })) }
  if (url.startsWith('/api/')) return ACC.http(req, res, url.split('?')[0]);
  if (url === '/rooms') { // live rooms list for the "rooms now" screen
    const list = [...rooms.values()].filter(r => !r.priv && !r.dw).map(r => {
      const players = r.members.filter(m => !m.watch), host = r.members.find(m => m.sid === r.host);
      return { code: r.code, host: host ? host.name : '', players: players.map(m => m.name), watchers: r.members.filter(m => m.watch).length, started: !!r.started, free: r.started && r.n ? Math.max(0, r.n - players.length) : 0, away: players.filter(m => m.away).length, quick: !!r.quick };
    }).sort((a, b) => (b.started - a.started) || (b.players.length - a.players.length)).slice(0, 50);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(list)); return;
  }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  // The game page can also sit next to server.js (easier to upload from a phone or iPad)
  if ((url === '/' || url === '/index.html') && !fs.existsSync(file)) file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream', head = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    // text files go out compressed (about half the size); each file is compressed once and kept until it changes
    if (/html|javascript|json|css|svg/.test(type) && data.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      try { const st = fs.statSync(file), key = file + ':' + st.mtimeMs + ':' + st.size; let z = GZ.get(file);
        if (!z || z.key !== key) { z = { key, buf: require('zlib').gzipSync(data, { level: 6 }) }; GZ.set(file, z) }
        head['Content-Encoding'] = 'gzip'; head['Vary'] = 'Accept-Encoding'; res.writeHead(200, head); res.end(z.buf); return } catch (e) {}
    }
    res.writeHead(200, head);
    res.end(data);
  });
});

// ---------- Minimal WebSocket support ----------
let nextId = 1;
const clients = new Map();

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { id: 'c' + (nextId++), socket, buf: Buffer.alloc(0), parts: [], room: null, alive: true, miss: 0 };
  clients.set(c.id, c);
  socket.on('data', d => { c.alive = true; c.buf = Buffer.concat([c.buf, d]); readFrames(c); });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function readFrames(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 8e6) { c.socket.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let payload = c.buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const m = c.buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(need);
    if (op === 8) { c.socket.end(); drop(c); return; }
    if (op === 9) { sendFrame(c, payload, 10); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 2 || op === 0) {
      c.parts.push(Buffer.from(payload));
      if (fin) { const text = Buffer.concat(c.parts).toString('utf8'); c.parts = []; let msg; try { msg = JSON.parse(text); } catch (e) { continue; } onMessage(c, msg); }
    }
  }
}
function sendFrame(c, data, op = 1) {
  if (c.socket.destroyed) return;
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let head;
  if (p.length < 126) { head = Buffer.from([0x80 | op, p.length]); }
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  c.socket.write(Buffer.concat([head, p]));
}
const send = (c, type, data) => c && sendFrame(c, JSON.stringify({ type, data }));
setInterval(() => { try { STATS.peak(STATS.seen.size, [...rooms.values()].filter(r => r.started).length) } catch (e) {} }, 60e3).unref();
// Keep connections alive behind hosting proxies
setInterval(() => { for (const c of clients.values()) { if (c.alive) c.miss = 0; else if (++c.miss >= 3) { c.socket.destroy(); continue; } c.alive = false; sendFrame(c, Buffer.alloc(0), 9); } }, 25000); // a phone on a weak network gets three chances (about a minute) before it counts as gone

// ---------- Who is online (for diwaniyas) ----------
const online = new Map(); // account id -> set of connections
function goOnline(c, aid) { try { SO.seenNow(aid) } catch (e) {} if (c.aid === aid) return; goOffline(c); c.aid = aid; if (!online.has(aid)) online.set(aid, new Set()); online.get(aid).add(c.id) }
function goOffline(c) { if (!c.aid) return; const s = online.get(c.aid); if (s) { s.delete(c.id); if (!s.size) online.delete(c.aid) } c.aid = null }
const live = {
  push(aid, type, data) { const s = online.get(aid); if (s) for (const id of s) send(clients.get(id), type, data) },
  room(aid) { for (const r of rooms.values()) { if (r.dw) continue; const m = r.members.find(x => x.aid === aid && !x.away); if (!m) continue; const pl = r.members.filter(x => !x.watch), host = r.members.find(x => x.sid === r.host);
      return { code: r.code, host: host ? host.name : '', started: !!r.started, priv: !!r.priv, n: r.n || 4, players: pl.length, free: r.started && r.n ? Math.max(0, r.n - pl.length) : Math.max(0, 4 - pl.length) } } return null },
  status(aid) { for (const r of rooms.values()) if (r.started && r.members.some(m => m.aid === aid && !m.watch && !m.away)) return 'play'; return online.has(aid) || DW.recent(aid) ? 'on' : 'off' },
  tables(dw) { return [...rooms.values()].filter(r => r.dw === dw).map(r => { const pl = r.members.filter(m => !m.watch); return { code: r.code, players: pl.map(m => ({ name: m.name, av: m.prof && /^p:/.test(m.prof.av || '') ? m.prof.av : 'p:0' })), started: !!r.started, n: r.n || 4, free: r.started && r.n ? Math.max(0, r.n - pl.length) : Math.max(0, 4 - pl.length), watchers: r.members.length - pl.length } }) }
};

// ---------- Rooms ----------
const rooms = new Map();
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'لاعب';
function newCode() { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(c)); return c; }
const autoOf = a => { if (!a || typeof a !== 'object') return null; const k = v => { v = Math.floor(+v); return Number.isFinite(v) ? Math.max(-1, Math.min(300, v)) : -1; };
  const o = {}; for (const e of ['def', 'save', 'took', 'win', 'lost', 'winbig', 'tauf']) { o[e] = k(a[e]); o[e + '2'] = k(a[e + '2']); o[e + '3'] = k(a[e + '3']) }
  return { ...o, snd: String(a.snd || '').replace(/[^a-z]/g, '').slice(0, 12) }; };
const pub = r => ({ code: r.code, host: r.host, started: r.started, priv: !!r.priv, quick: !!r.quick, qIn: r.qAt && !r.started ? Math.max(0, r.qAt - Date.now()) : 0, dw: r.dw ? DW.name(r.dw) : '', members: r.members.map(m => ({ sid: m.sid, name: m.name, seat: m.seat, mic: m.mic, away: !!m.away, watch: !!m.watch, prof: m.prof || null })) });
const GRACE = 3 * 60 * 1000; // keep a player's seat this long after they lose connection
const token = () => crypto.randomBytes(12).toString('hex');
const toRoom = (r, type, data) => r.members.forEach(m => send(clients.get(m.sid), type, data));

function onMessage(c, msg) { try { return onMessage2(c, msg) } catch (e) { console.error('message', msg && msg.type, e) } }
function onMessage2(c, { type, data = {}, rid }) {
  const reply = res => sendFrame(c, JSON.stringify({ type: 'reply', rid, data: res }));
  const r = rooms.get(c.room);
  switch (type) {
    case 'create': {
      return whenAuthed(c, () => {
        const dw = data.dw && c.aid && DW.isMember(String(data.dw), c.aid) ? String(data.dw) : null;
        if (data.dw && !dw) return reply({ ok: false, err: 'dw' });
        const tk = token();
        const room = { code: newCode(), host: c.id, started: false, members: [member(c, data.name, 0, tk)] };
        if (dw) { room.dw = dw; room.priv = true; }
        rooms.set(room.code, room); c.room = room.code; STATS.roomMade();
        reply({ ok: true, room: pub(room), me: c.id, token: tk });
      });
    }
    case 'join': {
      const room = rooms.get(String(data.code || '').toUpperCase().trim());
      if (!room) return reply({ ok: false, err: 'notfound' });
      return whenAuthed(c, () => { if (room.dw && !DW.isMember(room.dw, c.aid)) return reply({ ok: false, err: 'dw' }); joinRoom(c, room, data, reply) });
    }
    case 'quick': { // quick game: sit at a table that is waiting for players, or open one that starts by itself
      if (c.room) return reply({ ok: false, err: 'inroom' });
      return whenAuthed(c, () => {
        const avg = r => { const p = r.members.filter(m => !m.watch); return p.reduce((s, m) => s + ((m.prof && m.prof.rp) || 0), 0) / Math.max(1, p.length) }, my = c.rp || 0;
        const wait = [...rooms.values()].filter(r => r.quick && !r.started && r.members.filter(m => !m.watch).length < 4).sort((a, b) => (Math.abs(avg(a) - my) > 1500) - (Math.abs(avg(b) - my) > 1500) || a.qAt - b.qAt)[0];
        if (wait) { joinRoom(c, wait, data, reply); if (wait.members.filter(m => !m.watch).length >= 4) setTimeout(() => quickGo(wait), 1500); return; }
        const tk = token();
        const room = { code: newCode(), host: c.id, started: false, quick: true, qAt: Date.now() + QUICK_WAIT, members: [member(c, data.name, 0, tk)] };
        rooms.set(room.code, room); c.room = room.code; STATS.roomMade();
        room.qt = setTimeout(() => quickGo(room), QUICK_WAIT);
        reply({ ok: true, room: pub(room), me: c.id, token: tk });
      });
    }
    case 'swap': { // host moves players between seats in the lobby
      if (!r || r.host !== c.id || r.started) return;
      const a = r.members.find(m => m.seat === data.a), b = r.members.find(m => m.seat === data.b);
      if (a) a.seat = data.b; if (b) b.seat = data.a;
      return toRoom(r, 'room', pub(r));
    }
    case 'start': { if (!r || r.host !== c.id) return; return startGame(r, data.cfg || {}); }
    case 'reopen': if (!r || r.host !== c.id) return; if (r.game) { r.game.stop(); r.game = null; } r.started = false; return toRoom(r, 'room', pub(r));
    case 'up': return; // (old app versions) the server sends the table now
    case 'act': { // a player's move: the server checks it against the rules and plays it
      if (!r || !r.game) return; const m = r.members.find(x => x.sid === c.id); if (!m || m.watch) return;
      if (data && data.a === 'slam') { // the fire button: take the rupees first
        if (!m.atoken || Date.now() - (m.lastSlam || 0) < 1500) return; m.lastSlam = Date.now();
        ACC.load(m.atoken).then(a => a && ACC.spend(a, ACC.SLAM_COST)).then(me => { if (!me) return; STATS.bump('fire'); STATS.bump('spent', ACC.SLAM_COST); send(clients.get(m.sid), 'me', me); if (r.game) r.game.act(m.seat, { a: 'slam' }); }).catch(e => console.error('slam', e));
        return;
      }
      if (data && data.a === 'gift') STATS.bump('gifts'); return r.game.act(m.seat, data || {});
    }
    case 'mic': { if (!r) return; const m = r.members.find(x => x.sid === c.id); if (m) { m.mic = !!data.on && !!r.priv; toRoom(r, 'room', pub(r)); } return; }
    case 'rtc': // voice chat signalling
      if (!r || !r.priv || !r.members.some(m => m.sid === data.to)) return; // voice only in private rooms
      return send(clients.get(data.to), 'rtc', { from: c.id, data: data.data });
    case 'resume': { // come back after leaving the page (sharing on WhatsApp, a call, the screen locking)
      const room = rooms.get(String(data.code || '').toUpperCase().trim());
      const m = room && room.members.find(x => x.token && x.token === data.token);
      if (!m) return reply({ ok: false, err: 'gone' });
      const old = m.sid;
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      const oc = clients.get(old); if (oc && oc !== c) { oc.room = null; try { oc.socket.destroy(); } catch (e) {} clients.delete(old); }
      if (room.started && m.away) STATS.bump('back'); m.sid = c.id; m.away = false; m.mic = false; c.room = room.code; if (m.atoken && !c.atoken) c.atoken = m.atoken; if (m.aid && !c.aid) goOnline(c, m.aid);
      if (room.host === old) room.host = c.id;
      reply({ ok: true, room: pub(room), me: c.id, watch: !!m.watch });
      toRoom(room, 'room', pub(room));
      if (room.game && !m.watch && m.wasAway) { try { room.game.push({ t: 'say', s: m.seat, text: 'رجعت 👋' }) } catch (e) {} } m.wasAway = false;
      if (room.game) { room.game.changed(); room.game.flush(c.id); }
      return;
    }
    case 'prof': { // player profile: name, picture, flag, frame, level and a few stats
      if (!r) return; const m = r.members.find(x => x.sid === c.id); if (!m) return;
      if (m.atoken || c.atoken) { const tok = m.atoken || c.atoken; m.atoken = tok; ACC.load(tok).then(a => { if (!a) return; m.prof = ACC.pub(a); if (a.prof.name) m.name = clean(a.prof.name); if (r.game) r.game.syncSeats(); toRoom(r, 'room', pub(r)) }).catch(() => {}); return; }
      const p = data || {}, av = String(p.av || '');
      if (av.length > 40000 || !(/^p:\d{1,2}$/.test(av) || av.startsWith('data:image/jpeg;base64,'))) return;
      const short = (v, n) => String(v || '').replace(/[<>"]/g, '').slice(0, n);
      const num = v => Math.max(0, Math.min(1e7, Math.floor(+v || 0)));
      m.prof = { av, flag: short(p.flag, 8), frame: short(p.frame, 16), level: num(p.level), games: num(p.games), wins: num(p.wins), wars: num(p.wars), rp: num(p.rp), streak: num(p.streak), auto: autoOf(p.auto), efx: String(p.efx || '').replace(/[^a-z]/g, '').slice(0, 12), sfx: String(p.sfx || '').replace(/[^a-z]/g, '').slice(0, 12), bub: String(p.bub || '').replace(/[^a-z]/g, '').slice(0, 12) };
      if (p.name) m.name = clean(p.name);
      if (r.game) r.game.syncSeats();
      return toRoom(r, 'room', pub(r));
    }
    case 'auth': { // link this player to their account (rank, rupees and rewards come from the server)
      const tok = String(data.token || '').slice(0, 80); c.atoken = tok;
      c.authP = ACC.load(tok).then(a => { if (!a) { c.atoken = null; return } goOnline(c, a.id); c.rp = a.st.rp || 0; c.pubProf = ACC.pub(a); const rr = rooms.get(c.room); const m = rr && rr.members.find(x => x.sid === c.id);
        if (m) { m.atoken = tok; m.aid = a.id; m.prof = ACC.pub(a); if (a.prof.name) m.name = clean(a.prof.name); if (rr.game) rr.game.syncSeats(); toRoom(rr, 'room', pub(rr)) } }).catch(() => {});
      return reply && rid ? reply({ ok: true }) : undefined; }
    case 'priv': { if (!r || r.host !== c.id) return; r.priv = !!data.on; return toRoom(r, 'room', pub(r)); }
    case 'leave': return drop(c, true, true);
  }
}

function member(c, name, seat, tk, watch) { return { sid: c.id, name: clean(name), seat, mic: false, token: tk, atoken: c.atoken || null, aid: c.aid || null, prof: c.pubProf || null, ...(watch ? { watch: true } : {}) } }
function whenAuthed(c, fn) { const p = c.authP || Promise.resolve(); p.catch(() => {}).then(() => { try { fn() } catch (e) { console.error('room', e) } }) }
function joinRoom(c, room, data, reply) {
  if (c.room === room.code) return reply({ ok: true, room: pub(room), me: c.id });
  const players = room.members.filter(m => !m.watch).length;
  if (room.started && !data.watch && room.n) { // take a computer's seat in a game that already started
    const used = new Set(room.members.filter(m => !m.watch).map(m => m.seat)); let seat = 1; while (used.has(seat)) seat++;
    if (seat < room.n) { const tk = token();
      const mm = member(c, data.name, seat, tk); try { const S = room.game && room.game.S; if (S && room.d0) mm.lateFrac = Math.max(0, 1 - S.draw.length / room.d0) } catch (e) {} room.members.push(mm); c.room = room.code;
      reply({ ok: true, room: pub(room), me: c.id, token: tk, late: true });
      toRoom(room, 'room', pub(room)); if (room.game) { room.game.syncSeats(); room.game.flush(c.id); } return; }
  }
  if (room.started || players >= (room.quick ? 4 : 6) || data.watch) { // watch the game instead of playing
    if (room.members.filter(m => m.watch).length >= 30) return reply({ ok: false, err: 'full' });
    const tw = token();
    room.members.push(member(c, data.name, 99, tw, true)); c.room = room.code;
    reply({ ok: true, room: pub(room), me: c.id, token: tw, watch: true });
    toRoom(room, 'room', pub(room)); if (room.game) room.game.flush(c.id); return;
  }
  const used = new Set(room.members.map(m => m.seat)); let seat = 1; while (used.has(seat)) seat++;
  const tk = token();
  room.members.push(member(c, data.name, seat, tk)); c.room = room.code;
  reply({ ok: true, room: pub(room), me: c.id, token: tk });
  toRoom(room, 'room', pub(room));
}
// by the best rank in the room: newcomers meet normal computers, sergeants and up meet hard ones, majors and up the strongest
function botLevel(r) { let top = 0; for (const m of r.members || []) if (!m.watch && m.prof && m.prof.rp > top) top = m.prof.rp; return top >= 1900 ? 'pro' : top >= 400 ? 'hard' : 'normal' }
function startGame(r, cfg, ranked) {
  r.ranked = !!ranked;
  const safe = { mode: ['solo', '2v2', '3v3'].includes(cfg.mode) ? cfg.mode : '2v2', decks: Math.min(12, Math.max(1, +cfg.decks || 4)), timer: Math.min(15, Math.max(2, +cfg.timer || 3)), level: cfg.level === 'easy' ? 'easy' : botLevel(r) /* the computers that fill the seats play at the level of the people in the room */, hints: !!cfg.hints, lang: cfg.lang === 'en' ? 'en' : 'ar', fx: cfg.fx !== false };
  if (r.qt) { clearTimeout(r.qt); r.qt = null; }
  if (r.game) r.game.stop();
  try { r.game = new Game(r, safe, { send: (sid, type, d) => send(clients.get(sid), type, d), war: (seat, gain) => reward(r, seat, a => ACC.warWon(a, gain)), over: g => { STATS.gameEnd('online', Date.now() - (r.t0 || Date.now())); try { const S = g.S, E = g.ctx.__ctx(), sc = S.teams.map((t, k) => E.teamScore(k)), best = Math.max(...sc), wk = sc.indexOf(best), tie = sc.filter(x => x === best).length > 1; STATS.endGameRec(r.gDay, r.gIdx, { end: Date.now(), min: Math.round((Date.now() - r.t0) / 6000) / 10, won: tie ? 'تعادل' : S.players.filter(p => p.team === wk).map(p => p.name + (p.human ? '' : ' 🤖')).join(' + '), score: sc.join('-') }) } catch (e) {} const ranked = !!r.ranked, res = g.results(); const keyOf = seat => { const m = r.members.find(y => !y.watch && y.seat === seat); return m && m.atoken ? crypto.createHash('sha256').update(String(m.atoken)).digest('hex').slice(0, 12) : null };
      for (const x of res) { const partners = res.filter(y => y.team === x.team && y.seat !== x.seat).map(y => keyOf(y.seat)).filter(Boolean); const mm = r.members.find(m => !m.watch && m.seat === x.seat), late = !!(mm && mm.lateFrac >= .5); /* joined after half the deck was drawn: rupees and XP, but rank points neither go up nor down */ reward(r, x.seat, a => ACC.gameOver(a, { ...x, ranked: ranked && !late, partners })) } } }); } catch (e) { console.error('game start', e); r.game = null; return; }
  r.started = true; r.n = r.game.S.players.length; r.d0 = r.game.S.draw.length || 1; r.t0 = Date.now(); STATS.gameStart(r.ranked ? 'quick' : 'online'); { const hum = r.members.filter(m => !m.watch); r.gDay = STATS.DAY(); r.gIdx = STATS.addGame({ kind: r.ranked ? 'سريع' : (r.priv ? 'غرفة خاصة' : 'غرفة'), mode: safe.mode, names: hum.map(m => m.name), bots: Math.max(0, r.n - hum.length) }) } toRoom(r, 'room', pub(r)); toRoom(r, 'started', {}); r.game.flush();
}
const QUICK_WAIT = 15000;
function quickGo(r) { if (!rooms.has(r.code) || r.started || !r.members.some(m => !m.watch)) return; startGame(r, { mode: '2v2', decks: 4, timer: 3, level: 'normal' }, true); }

function reward(r, seat, fn) { const m = r.members.find(x => !x.watch && x.seat === seat); if (!m || !m.atoken) return;
  ACC.load(m.atoken).then(a => a && fn(a)).then(me => { if (!me) return; send(clients.get(m.sid), 'me', me); m.prof = { ...(m.prof || {}), level: me.st.level, rp: me.st.rp, streak: me.st.streak, wins: me.st.wins, games: me.st.games, wars: me.st.wars } }).catch(e => console.error('reward', e)); }
function drop(c, keepSocket, now) {
  const r = rooms.get(c.room); c.room = null;
  if (!keepSocket) { clients.delete(c.id); goOffline(c); }
  if (!r) return;
  const m = r.members.find(x => x.sid === c.id); if (!m) return;
  if (!now) { // lost connection: hold the seat for a while so they can come back
    if (r.started && !m.watch) STATS.bump('drops'); m.away = true; m.mic = false; m.wasAway = true; if (r.game && !m.watch) { try { r.game.push({ t: 'say', s: m.seat, text: 'طلع 🚪' }) } catch (e) {} }
    m.timer = setTimeout(() => remove(r, m), r.started ? 15 * 60 * 1000 : GRACE); // a game in progress keeps the seat 15 minutes
    if (r.game) r.game.changed();
    return toRoom(r, 'room', pub(r));
  }
  remove(r, m);
}
function remove(r, m) {
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  if (!rooms.has(r.code)) return;
  r.members = r.members.filter(x => x !== m);
  if (r.host === m.sid) { // the room carries on with someone else in charge; it closes only when nobody is left
    const next = r.members.find(x => !x.watch && !x.away) || r.members.find(x => !x.watch) || r.members[0];
    if (!next) { if (r.game) r.game.stop(); if (r.qt) clearTimeout(r.qt); rooms.delete(r.code); return; }
    r.host = next.sid;
  }
  if (!r.members.length) { if (r.game) r.game.stop(); if (r.qt) clearTimeout(r.qt); rooms.delete(r.code); return; }
  if (r.game) r.game.syncSeats();
  toRoom(r, 'room', pub(r));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Eat & Bury server running on port ' + PORT));
// keep the game server running even if one room hits an unexpected error
process.on('uncaughtException', e => console.error('uncaught', e));
process.on('unhandledRejection', e => console.error('unhandled', e));
// keep "last seen" fresh for everyone connected
setInterval(() => { for (const aid of online.keys()) try { SO.seenNow(aid) } catch (e) {} }, 60000);
