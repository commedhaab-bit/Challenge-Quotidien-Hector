const CACHE_NAME = 'defi-du-jour-v41';
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
  // Ignore tout ce qui n'est pas une requête http(s) classique (ex: chrome-extension://
  // injectée par une extension du navigateur — Grammarly, gestionnaire de mots de passe,
  // devtools...). Cache.put() ne supporte QUE http(s) et lève une exception non
  // interceptée sur ces schémas, d'où les "Uncaught TypeError: Request scheme
  // chrome-extension is unsupported" observés en prod : rien à voir avec l'appli
  // elle-même, juste ce SW qui tentait de mettre en cache une requête qui ne lui
  // était pas destinée.
  if (!event.request.url.startsWith('http')) return;

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

  // Autres fichiers statiques (icônes, manifest, et surtout les images d'exercices,
  // de loin les assets les plus lourds de l'appli) : cache d'abord, réseau en secours —
  // et on alimente le cache à la volée sur un miss (sans ça, ces fichiers n'étaient
  // JAMAIS mis en cache : chaque affichage d'une fiche défi retéléchargeait l'image
  // en entier, même en 2ème visite, et l'appli était inutilisable hors-ligne pour
  // tout ce qui n'était pas dans le pré-cache ASSETS ci-dessus).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
