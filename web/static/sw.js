const CACHE_NAME = 'radio-recorder-v9';
const STATIC_ASSETS = [
  '/',
  '/static/style.css',
  '/static/app.js?v=1.0.8',
  '/static/manifest.json',
  '/static/icon-192.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for API, Cache-first for static assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API 요청은 항상 네트워크 우선
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/stream/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
