// Eat & Bury online server.
// - Serves the game page (public/index.html).
// - Connects players in rooms over WebSockets and relays their messages.
// The room creator's browser runs the game rules; this server only connects people.
// No extra packages needed: uses only what comes with Node.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/health') { res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  // The game page can also sit next to server.js (easier to upload from a phone or iPad)
  if ((url === '/' || url === '/index.html') && !fs.existsSync(file)) file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
  const c = { id: 'c' + (nextId++), socket, buf: Buffer.alloc(0), parts: [], room: null, alive: true };
  clients.set(c.id, c);
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); readFrames(c); });
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
// Keep connections alive behind hosting proxies
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.socket.destroy(); continue; } c.alive = false; sendFrame(c, Buffer.alloc(0), 9); } }, 25000);

// ---------- Rooms ----------
const rooms = new Map();
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'لاعب';
function newCode() { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(c)); return c; }
const pub = r => ({ code: r.code, host: r.host, started: r.started, members: r.members.map(m => ({ sid: m.sid, name: m.name, seat: m.seat, mic: m.mic, away: !!m.away })) });
const GRACE = 3 * 60 * 1000; // keep a player's seat this long after they lose connection
const token = () => crypto.randomBytes(12).toString('hex');
const toRoom = (r, type, data) => r.members.forEach(m => send(clients.get(m.sid), type, data));

function onMessage(c, { type, data = {}, rid }) {
  const reply = res => sendFrame(c, JSON.stringify({ type: 'reply', rid, data: res }));
  const r = rooms.get(c.room);
  switch (type) {
    case 'create': {
      const tk = token();
      const room = { code: newCode(), host: c.id, started: false, members: [{ sid: c.id, name: clean(data.name), seat: 0, mic: false, token: tk }] };
      rooms.set(room.code, room); c.room = room.code;
      return reply({ ok: true, room: pub(room), me: c.id, token: tk });
    }
    case 'join': {
      const room = rooms.get(String(data.code || '').toUpperCase().trim());
      if (!room) return reply({ ok: false, err: 'notfound' });
      if (room.started) return reply({ ok: false, err: 'started' });
      if (room.members.length >= 6) return reply({ ok: false, err: 'full' });
      const used = new Set(room.members.map(m => m.seat)); let seat = 1; while (used.has(seat)) seat++;
      const tk = token();
      room.members.push({ sid: c.id, name: clean(data.name), seat, mic: false, token: tk }); c.room = room.code;
      reply({ ok: true, room: pub(room), me: c.id, token: tk });
      return toRoom(room, 'room', pub(room));
    }
    case 'swap': { // host moves players between seats in the lobby
      if (!r || r.host !== c.id || r.started) return;
      const a = r.members.find(m => m.seat === data.a), b = r.members.find(m => m.seat === data.b);
      if (a) a.seat = data.b; if (b) b.seat = data.a;
      return toRoom(r, 'room', pub(r));
    }
    case 'start': if (!r || r.host !== c.id) return; r.started = true; toRoom(r, 'room', pub(r)); return toRoom(r, 'started', {});
    case 'reopen': if (!r || r.host !== c.id) return; r.started = false; return toRoom(r, 'room', pub(r));
    case 'up': // host sends each player their own view of the table
      if (!r || r.host !== c.id || !Array.isArray(data)) return;
      for (const { sid, view } of data) if (r.members.some(m => m.sid === sid)) send(clients.get(sid), 'up', view);
      return;
    case 'act': { // a player's move goes to the host
      if (!r) return; const m = r.members.find(x => x.sid === c.id); if (!m || m.sid === r.host) return;
      return send(clients.get(r.host), 'act', { ...data, seat: m.seat });
    }
    case 'mic': { if (!r) return; const m = r.members.find(x => x.sid === c.id); if (m) { m.mic = !!data.on; toRoom(r, 'room', pub(r)); } return; }
    case 'rtc': // voice chat signalling
      if (!r || !r.members.some(m => m.sid === data.to)) return;
      return send(clients.get(data.to), 'rtc', { from: c.id, data: data.data });
    case 'resume': { // come back after leaving the page (sharing on WhatsApp, a call, the screen locking)
      const room = rooms.get(String(data.code || '').toUpperCase().trim());
      const m = room && room.members.find(x => x.token && x.token === data.token);
      if (!m) return reply({ ok: false, err: 'gone' });
      const old = m.sid;
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      const oc = clients.get(old); if (oc && oc !== c) { oc.room = null; try { oc.socket.destroy(); } catch (e) {} clients.delete(old); }
      m.sid = c.id; m.away = false; m.mic = false; c.room = room.code;
      if (room.host === old) room.host = c.id;
      reply({ ok: true, room: pub(room), me: c.id });
      toRoom(room, 'room', pub(room));
      if (room.host !== c.id) send(clients.get(room.host), 'back', { seat: m.seat, sid: c.id, old });
      return;
    }
    case 'leave': return drop(c, true, true);
  }
}

function drop(c, keepSocket, now) {
  const r = rooms.get(c.room); c.room = null;
  if (!keepSocket) clients.delete(c.id);
  if (!r) return;
  const m = r.members.find(x => x.sid === c.id); if (!m) return;
  if (!now) { // lost connection: hold the seat for a while so they can come back
    m.away = true; m.mic = false;
    m.timer = setTimeout(() => remove(r, m), GRACE);
    return toRoom(r, 'room', pub(r));
  }
  remove(r, m);
}
function remove(r, m) {
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  if (!rooms.has(r.code)) return;
  if (r.host === m.sid) { toRoom(r, 'ended', {}); rooms.delete(r.code); return; }
  r.members = r.members.filter(x => x !== m);
  send(clients.get(r.host), 'left', { seat: m.seat, sid: m.sid });
  toRoom(r, 'room', pub(r));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Eat & Bury server running on port ' + PORT));
