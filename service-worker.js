const CACHE_NAME = 'defi-du-jour-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ne jamais mettre en cache les appels Firebase/Google (données live)
  if (event.request.url.includes('firebaseio.com') ||
      event.request.url.includes('googleapis.com') ||
      event.request.url.includes('firestore') ||
      event.request.url.includes('gstatic.com') ||
      event.request.url.includes('accounts.google.com')) {
    return;
  }

  // Pages HTML : toujours essayer le réseau en premier (pour avoir la dernière version),
  // et ne se rabattre sur le cache que si hors-ligne.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Autres fichiers statiques (icônes, manifest) : cache d'abord, réseau en secours
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
