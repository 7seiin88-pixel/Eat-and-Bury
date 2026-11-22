// حفر ودفن: lets the game be installed as an app, and play against the computer without internet.
// Online, every file is fetched fresh from the server (so an update shows at once) and a copy is kept on the phone.
// Without internet, the kept copy is used. Online play, accounts and rooms always go to the server and are never kept.
const CACHE = 'eb-offline-1';
const CORE = ['/', '/shots.js', '/sounds.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/privacy.html'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => fetch(u, { cache: 'no-cache' }).then(r => { if (r.ok) return c.put(u, r) }).catch(() => {}))))) });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('eb-offline-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
const OFFLINE = () => new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#2a0507;color:#f2d27a;font-family:sans-serif;display:grid;place-items:center;height:100vh;text-align:center;margin:0"><div><h1>حفر ودفن</h1><p>ما في اتصال بالإنترنت.<br>افتح اللعبة مرة وحدة وإنت متصل، وبعدها تقدر تلعب ضد الكمبيوتر بدون نت.</p></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
// fresh from the network, keep a copy; if there is no network, the copy
async function fresh(req, key) {
  const c = await caches.open(CACHE);
  try { const r = await fetch(req); if (r && r.ok && r.type !== 'opaqueredirect') c.put(key || req, r.clone()); return r }
  catch (e) { const hit = await c.match(key || req, { ignoreSearch: !!key }); if (hit) return hit; throw e }
}
// fonts never change: the kept copy first
async function kept(req) { const c = await caches.open(CACHE); const hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r }
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/') || u.pathname === '/rooms' || u.pathname === '/health') return; // live data: never kept
    if (req.mode === 'navigate') { e.respondWith(fresh(req, u.pathname === '/' || u.pathname === '/index.html' ? '/' : null).catch(OFFLINE)); return } // any address of the game (a room link too) opens the kept game
    e.respondWith(fresh(req)); return;
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') { e.respondWith(kept(req).catch(() => new Response('', { status: 504 }))); return }
});
