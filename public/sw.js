// Replaced with the commit sha at deploy time. Without this the worker's
// bytes never change between deploys, so the browser never notices there is
// a new version and keeps serving the old cached app forever.
const BUILD_ID = '__BUILD_ID__';
const CACHE_NAME = `calorie-counter-${BUILD_ID}`;
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './foods-db.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Only the app's own files are cached. Food-search lookups go to another
  // origin and must not be served from (or fill up) the app cache.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Opening the app goes to the network first so a new version shows up as
  // soon as there is a connection, falling back to the cache when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
