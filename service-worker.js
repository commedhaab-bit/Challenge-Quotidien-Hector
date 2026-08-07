const CACHE_NAME = 'defi-du-jour-v96';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './assets/sounds/success.mp3'
];

// Notifications push (Phase B) : un service worker a son propre scope global,
// aucun partage de code possible avec index.html - config dupliquee (valeurs
// PUBLIQUES par construction, comme apiKey partout ailleurs dans l'app, rien a
// proteger). Une fois la messagerie initialisee, la SDK compat affiche
// AUTOMATIQUEMENT la notification OS pour tout message recu avec un champ
// "notification" (voir sendPushToUser() dans functions/index.js) quand l'app
// n'est pas au premier plan - aucun handler onBackgroundMessage supplementaire
// necessaire pour ce cas simple (titre/corps fixes, pas d'action personnalisee).
// Volontairement dans un try/catch : un souci d'initialisation FCM (reseau qui
// bloque gstatic.com, navigateur/contexte sans support Push API, etc.) ne doit
// JAMAIS faire planter l'evaluation de CE script entier - sinon install/
// activate/fetch plus bas (le coeur du cache/offline de l'app) ne seraient
// plus jamais enregistres non plus. Le push resterait simplement indisponible
// dans ce cas, sans rien casser d'autre.
try {
  importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyBE0DL8Q6y8Md4R2aM0D1imx_cTUlHP5c4',
    authDomain: 'challenge-quotidien-hector.firebaseapp.com',
    projectId: 'challenge-quotidien-hector',
    storageBucket: 'challenge-quotidien-hector.firebasestorage.app',
    messagingSenderId: '613473786890',
    appId: '1:613473786890:web:c77ccf3c2d99857df9d3f3',
  });
  firebase.messaging();
} catch (e) {
  console.error('push notifications init failed in service worker', e);
}

// Focus l'onglet deja ouvert s'il y en a un, sinon en ouvre un nouveau - pas de
// deep-link precis vers le bon groupe/defi dans cette 1ere version (garder
// simple, ameliorable plus tard si demande).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

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
