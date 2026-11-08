// حفر ودفن: lets the game be installed as an app. Always loads the newest version from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<meta charset="utf-8"><body style="background:#2a0507;color:#f2d27a;font-family:sans-serif;display:grid;place-items:center;height:100vh;text-align:center"><div><h1>حفر ودفن</h1><p>ما في اتصال بالإنترنت</p></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
