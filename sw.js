const CACHE = 'meetingnote-v2';
const SHELL = ['/', '/index.html', '/app.js', '/db.js', '/summary.js', '/worker.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // 模型檔案（幾百MB）不走 SW cache，讓瀏覽器 HTTP cache 處理
  if (e.request.url.includes('cdn.jsdelivr.net') ||
      e.request.url.includes('huggingface.co')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
