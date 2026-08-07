// Harnais de test minimal pour valider a l'execution (pas seulement a la syntaxe)
// la refonte Bibliotheque/Aujourd'hui : migration, activeToday, accordeons, formulaire.
//
// Contrainte vm importante : les `const`/`let` de top-level du script applicatif
// (ex: CHALLENGE_LIBRARY) ne deviennent PAS des proprietes du contexte vm apres
// execution (contrairement a `var`/aux fonctions). Le code de test est donc
// concatene et execute DANS LE MEME script que l'appli, pour partager la meme
// portee lexicale de haut niveau (comme dans un vrai <script> de page).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Par defaut, cible index.html a la racine du repo (un niveau au-dessus de tests/) ;
// un chemin peut etre passe en argument pour tester une autre copie (ex: CI sur une
// version extraite/temporaire).
const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
let swSource = '';
try { swSource = fs.readFileSync(path.join(path.dirname(htmlPath), 'service-worker.js'), 'utf8'); } catch (e) { /* optionnel */ }
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length === 0) throw new Error('script inline introuvable');
const inlineAppCode = scripts.sort((a, b) => b.length - a.length)[0]; // le plus long = le script applicatif
// exercise-data.js / exercise-pictograms.js sont chargés en <script src="..."> CLASSIQUES
// (voir index.html <head>, PAS type=module/defer/async) : leur contenu n'apparait jamais
// dans un bloc <script> inline. Il faut le lire depuis les fichiers voisins et le
// concatener AVANT le script principal, exactement comme un navigateur les charge (ordre
// synchrone, même portée lexicale globale).
const htmlDir = path.dirname(htmlPath);
// styles.css : depuis la fusion CSS (#4), le bloc <style> n'existe plus dans index.html
// (remplace par <link rel="stylesheet">). Les regles CSS n'apparaissent donc plus dans
// __rawHtml (texte brut de index.html) : il faut les lire depuis ce fichier a part et
// les concatener a __rawHtml pour que les tests qui verifient du texte CSS continuent
// de fonctionner (voir cssText plus bas, meme principe que __externalClassicScripts).
let cssSource = '';
try { cssSource = fs.readFileSync(path.join(htmlDir, 'styles.css'), 'utf8'); } catch (e) { /* optionnel */ }
let externalClassicScripts = '';
for (const name of ['exercise-pictograms.js', 'exercise-data.js', 'locale-fr.js', 'locale-en.js', 'locale-es.js']) {
  const p = path.join(htmlDir, name);
  if (fs.existsSync(p)) externalClassicScripts += fs.readFileSync(p, 'utf8') + '\n';
}
const appCode = externalClassicScripts + inlineAppCode;

function makeCtx2D() {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'canvas') return makeEl();
      if (typeof prop === 'symbol') return undefined;
      return () => {}; // toute methode canvas (fillRect, save, translate...) devient un no-op
    },
    set() { return true; }, // fillStyle = '...' etc.
  });
}

let activeElement = null; // simule document.activeElement (voir focus() ci-dessous)
function makeEl(id) {
  const el = {
    id: id || '',
    _html: '',
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    addEventListener(){}, removeEventListener(){},
    appendChild(){}, remove(){}, closest(){ return null; },
    _attrs: {},
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return k in this._attrs ? this._attrs[k] : null; },
    _childrenById: new Map(),
    querySelector(selector) {
      // Ne gere que les selecteurs #id (seul cas utilise par l'appli, cf. confirmModal) :
      // recherche SCOPEE aux enfants issus du dernier innerHTML assigne a CET element
      // precis, contrairement a document.getElementById() (global, voir plus bas) — c'est
      // exactement cette portee qui permet de distinguer 2 popups simultanes avec les
      // memes id (voir le test de la collision confirmModal).
      if (typeof selector === 'string' && selector[0] === '#') {
        return el._childrenById.get(selector.slice(1)) || null;
      }
      return null;
    },
    querySelectorAll(){ return []; },
    focus(){ activeElement = el; }, click(){},
    getContext(){ return makeCtx2D(); },
    toBlob(cb){ cb(null); },
    offsetWidth: 0,
    width: 0, height: 0,
    textContent: '',
    dataset: {}, // comme un vrai element DOM : jamais undefined, meme sans attributs data-* reellement parses
    scrollTop: 0,
    selectionStart: 0,
    setSelectionRange(start){ this.selectionStart = start; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){
      el._html = v;
      el._childrenById = new Map();
      // Cree un mock enfant par id="..." trouve dans le HTML assigne : conserve aussi le
      // Portee STRICTEMENT LOCALE a cet element (contrairement a document.getElementById(),
      // jamais touche ici) : necessaire pour tester confirmModal() de facon realiste sans
      // perturber les tests existants qui dependent de la stabilite de document.getElementById()
      // a travers les re-renders de #app (ce mock ne recree pas de vrais noeuds DOM sur un
      // innerHTML global, seul confirmModal()/enqueuePopup() l'utilisent via querySelector).
      const idAttrRegex = / id="([^"]+)"/g;
      let m;
      while ((m = idAttrRegex.exec(v))) {
        el._childrenById.set(m[1], makeEl(m[1]));
      }
    },
  });
  return el;
}

const store = new Map(); // simule Firestore (ancien modele cle/valeur) : key -> JSON string
let dbGetDayCallCount = 0; // compte les lectures 'day:...' (voir loadHistoryEntries(), cache des jours passes)
let dbSetDayCallCount = 0; // compte les ecritures 'day:...' (voir saveState()/scheduleWorkoutWriteFlush())
// Simule localStorage (2 usages dans l'app, tous deux des preferences propres a CET
// appareil, jamais des donnees de compte : dismiss de la banniere d'installation PWA,
// et la langue preferee (i18n) -- cf. commentaires index.html).
const mockLocalStorageStore = new Map();
const mockLocalStorage = {
  getItem(key) { return mockLocalStorageStore.has(key) ? mockLocalStorageStore.get(key) : null; },
  setItem(key, value) { mockLocalStorageStore.set(key, String(value)); },
  removeItem(key) { mockLocalStorageStore.delete(key); },
  clear() { mockLocalStorageStore.clear(); },
};
const elementsById = new Map(); // simule le DOM : meme element retourne par id (ex: 'app')
const sandboxSpokenLog = []; // simule window.speechSynthesis : phrases prononcees, dans l'ordre
const mockLocation = { search: '', pathname: '/index.html' }; // simule window.location (raccourcis PWA, ?tab=...)
mockLocation.reload = function () { mockLocation.reloadCalled = true; };
mockLocation.reloadCalled = false;

// Simule le Cache Storage + les ServiceWorkerRegistration existantes, pour verifier
// forceAppUpdate() (#1 : desenregistre le SW + vide tous les caches + recharge).
const mockCacheKeys = ['defi-du-jour-v4'];
const mockCachesApi = {
  keys: async () => [...mockCacheKeys],
  delete: async (name) => {
    const idx = mockCacheKeys.indexOf(name);
    if (idx !== -1) mockCacheKeys.splice(idx, 1);
    return idx !== -1;
  },
};
const mockSwRegistrations = [
  { unregisterCalled: false, unregister: async function () { this.unregisterCalled = true; return true; } },
  { unregisterCalled: false, unregister: async function () { this.unregisterCalled = true; return true; } },
];

// Simule le document Firestore consolide users/{uid}/kv/appData (voir appDataDocRef()/
// saveAppField()/loadAppData() dans index.html). appDataDocRef() appelle db.collection(...)
// DIRECTEMENT (contrairement a dbGet/dbSet, remplaces plus bas par __dbGet/__dbSet) : il
// faut donc un vrai mock de la chaine collection('users').doc(uid).collection('kv').doc('appData').
const appDataStore = { exists: false, data: {} };
let appDataSetCallCount = 0; // compte les vrais appels .set() (regroupement des écritures, voir beginAppDataBatch())
function makeAppDataDocRef() {
  return {
    async get() {
      return { exists: appDataStore.exists, data: () => JSON.parse(JSON.stringify(appDataStore.data)) };
    },
    async set(fields, opts) {
      appDataSetCallCount++;
      if (opts && opts.merge) {
        Object.assign(appDataStore.data, fields);
      } else {
        appDataStore.data = fields;
      }
      appDataStore.exists = true;
    },
  };
}

// Mock Firestore générique pour les nouvelles collections communautaires top-level
// (leaderboard, community + sous-collections) : contrairement à la chaîne users/kv/appData
// ci-dessus (conservée telle quelle, inchangée), ce mock est scopé aux formes de requêtes
// réellement utilisées par les fonctionnalités communautaires (where/orderBy/limit/
// startAt/count/onSnapshot), PAS un émulateur Firestore complet.
function __mockFieldValueIncrement(n) { return { __increment: n }; }
function __applyMockMergeValue(current, incoming) {
  if (incoming && typeof incoming === 'object' && '__increment' in incoming) {
    return (typeof current === 'number' ? current : 0) + incoming.__increment;
  }
  return incoming;
}
// Memoise le wrapper par instance de `store` (une Map = une collection precise) :
// sans ca, un 3e niveau d'imbrication (ex: groups/{id}/challenges/{id}/participants,
// necessaire pour les Groupes - Phase 2) perdrait le suivi de SES PROPRES
// sous-collections a chaque nouvel appel de `.collection('challenges')` sur le meme
// doc parent (chaque appel recreait un wrapper avec un `subcollections` vide, donc
// invisible d'un appel a l'autre, meme si le contenu de `store` lui restait bien
// partage) - jamais rencontre avant les Groupes, aucune fonctionnalite precedente
// n'imbriquait plus de 2 niveaux (ex: community/{weekStart}/dailyContributors).
const mockCollectionWrapperCache = new Map();
function makeMockCollection(store) {
  if (mockCollectionWrapperCache.has(store)) return mockCollectionWrapperCache.get(store);
  const listenersByDoc = new Map();
  const subcollections = new Map();

  function notifyDoc(id) {
    const set = listenersByDoc.get(id);
    if (!set) return;
    const data = store.get(id);
    for (const cb of set) cb({ exists: data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), id });
  }

  function makeDocRef(id) {
    return {
      id,
      async get() {
        const data = store.get(id);
        return { exists: data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), id };
      },
      async set(fields, opts) {
        const current = store.get(id) || {};
        const next = (opts && opts.merge) ? { ...current } : {};
        for (const [k, v] of Object.entries(fields)) next[k] = __applyMockMergeValue(current[k], v);
        store.set(id, next);
        notifyDoc(id);
      },
      async delete() {
        store.delete(id);
        notifyDoc(id);
      },
      onSnapshot(cb) {
        if (!listenersByDoc.has(id)) listenersByDoc.set(id, new Set());
        listenersByDoc.get(id).add(cb);
        this.get().then((snap) => cb(snap));
        return () => listenersByDoc.get(id).delete(cb);
      },
      collection(subName) {
        if (!subcollections.has(id)) subcollections.set(id, new Map());
        const subMap = subcollections.get(id);
        if (!subMap.has(subName)) subMap.set(subName, new Map());
        return makeMockCollection(subMap.get(subName));
      },
    };
  }

  function makeQuery(filters, sort, limitN) {
    function evalFilter(data, f) {
      const val = data[f.field];
      if (f.op === '==') return val === f.value;
      if (f.op === '>') return val > f.value;
      if (f.op === '>=') return val >= f.value;
      if (f.op === '<') return val < f.value;
      if (f.op === '<=') return val <= f.value;
      // 'in' : utilisé par le fil d'activité filtré par amis (where('uid', 'in', mesAmisUids)).
      // Comme le vrai SDK, un tableau vide ne doit jamais être envoyé (l'appelant doit s'en
      // prémunir lui-même) — ici on se contente de ne matcher personne dans ce cas plutôt
      // que de lever une exception, pour ne pas complexifier le mock au-delà du besoin réel.
      if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(val);
      return true;
    }
    function results() {
      let arr = [...store.entries()].map(([id, data]) => ({ id, data }));
      for (const f of filters) arr = arr.filter(({ data }) => evalFilter(data, f));
      if (sort) {
        arr.sort((a, b) => {
          const av = a.data[sort.field], bv = b.data[sort.field];
          const cmp = av > bv ? 1 : (av < bv ? -1 : 0);
          return sort.dir === 'desc' ? -cmp : cmp;
        });
      }
      if (limitN != null) arr = arr.slice(0, limitN);
      return arr;
    }
    return {
      where(field, op, value) { return makeQuery([...filters, { field, op, value }], sort, limitN); },
      orderBy(field, dir) { return makeQuery(filters, { field, dir: dir || 'asc' }, limitN); },
      limit(n) { return makeQuery(filters, sort, n); },
      startAt(value) {
        if (!sort) return makeQuery(filters, sort, limitN);
        const op = sort.dir === 'desc' ? '<=' : '>=';
        return makeQuery([...filters, { field: sort.field, op, value }], sort, limitN);
      },
      async get() {
        const arr = results();
        // .ref sur chaque doc de requete (comme le vrai SDK - QueryDocumentSnapshot.ref) :
        // manquait jusqu'ici, jamais remarque car aucun test n'exercait deleteMyAccount()
        // de bout en bout (voir son commentaire dedie : db.batch()+doc.ref y est utilise
        // en prod sans AUCUNE couverture, pour cette raison exacte). reutilise makeDocRef()
        // (meme closure) pour pointer vers le VRAI doc du store, pas une copie figee.
        return {
          empty: arr.length === 0,
          size: arr.length,
          docs: arr.map(({ id, data }) => ({ id, data: () => JSON.parse(JSON.stringify(data)), ref: makeDocRef(id) })),
          forEach(cb) { arr.forEach(({ id, data }) => cb({ id, data: () => JSON.parse(JSON.stringify(data)), ref: makeDocRef(id) })); },
        };
      },
      count() {
        return {
          async get() {
            return { data: () => ({ count: results().length }) };
          },
        };
      },
      onSnapshot(cb) {
        this.get().then(cb);
        return () => {};
      },
    };
  }

  const wrapper = {
    doc(id) { return makeDocRef(id != null ? String(id) : 'auto_' + Math.random().toString(36).slice(2)); },
    async add(data) {
      const ref = makeDocRef('auto_' + Math.random().toString(36).slice(2));
      await ref.set(data, {});
      return ref;
    },
    where(field, op, value) { return makeQuery([{ field, op, value }], null, null); },
    orderBy(field, dir) { return makeQuery([], { field, dir: dir || 'asc' }, null); },
    // .get() direct sur la collection (sans where/orderBy) : valide en vrai Firestore
    // (renvoie tous les documents), jamais utilise avant les Groupes (Phase 2) - toutes
    // les fonctionnalites precedentes filtraient/triaient toujours avant de lire.
    get() { return makeQuery([], null, null).get(); },
  };
  mockCollectionWrapperCache.set(store, wrapper);
  return wrapper;
}
const mockTopCollections = new Map();
// Sous-collections sous users/{uid}/... (autres que kv, voir plus bas) : isolées PAR
// UTILISATEUR, contrairement à appDataStore (kv) qui reste volontairement un singleton
// partagé. Map(uid -> Map(subName -> Map(docId -> data))).
const usersSubcollections = new Map();
let leaderboardSetCallCount = 0;
let leaderboardGetCallCount = 0;
let leaderboardCacheGetCallCount = 0;

// Mock du Cloud Function Callable getMyRank() (Phase 1 : classement precalcule cote
// serveur, voir functions/index.js) : contrairement au reste du mock Firestore, on ne
// reimplemente PAS la logique de calcul du rang ici (deja testee en isolation dans
// functions/test/leaderboard.test.js) - le test controle directement la reponse
// attendue, comme n'importe quelle dependance externe mockee.
let mockGetMyRankResult = { rank: null, value: 0 };
let mockGetMyRankShouldFail = false;
let mockGetMyRankCallCount = 0;
let mockGetMyRankLastArgs = null;

// Mock du Cloud Function Callable logGroupChallengeContribution() (plafond exact +
// reglement instantane, voir functions/index.js) : meme principe que getMyRank
// ci-dessus - la logique de plafonnage/reglement est deja testee en isolation
// (computeCreditedAmount() dans functions/test/groups.test.js), le mock se contente
// d'enregistrer les appels pour verifier que le CLIENT delegue bien a la Cloud
// Function (au lieu d'ecrire directement dans participants/{uid} comme avant).
let mockLogGroupChallengeContributionCalls = [];
let mockLogGroupChallengeContributionResult = { credited: 0, reachedTarget: false };

// Mock du Cloud Function Callable applyGroupJoker() (Phase 4, jokers tactiques) :
// meme principe - la logique de plafonnage/reglement (rankForSettlement(),
// applyDoublonMultiplier()) est deja testee en isolation dans
// functions/test/groups.test.js, le mock enregistre juste l appel. Les tests
// simulent ensuite l effet serveur par une ecriture directe (jokerUsed/handicap/
// immune/doublonActiveUntil), pour verifier le rendu client (boutons, statuts,
// badges) independamment de la logique serveur elle-meme.
let mockApplyGroupJokerCalls = [];

// Mock du Cloud Function Callable deleteGroup() (retour utilisateur) : meme
// principe - la suppression recursive/le nettoyage des index myGroups des
// AUTRES membres n est testable qu avec un emulateur Firestore (voir
// functions/index.js), le mock enregistre juste l appel.
let mockDeleteGroupCalls = [];
let mockDeleteGroupShouldFail = false;

const sandbox = {
  console,
  Math, Date, JSON, Set, Map, Array, Object, Number, String, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL: { createObjectURL(){ return ''; }, revokeObjectURL(){} },
  Blob: function(parts, opts) { this.parts = parts; this.type = opts && opts.type; },
  SpeechSynthesisUtterance: function(text) { this.text = text; this.lang = ''; },
  __spokenLog: sandboxSpokenLog,
  document: {
    getElementById(id){
      if (!elementsById.has(id)) elementsById.set(id, makeEl(id));
      return elementsById.get(id);
    },
    createElement(tag){ return makeEl(); },
    addEventListener(){}, removeEventListener(){},
    body: makeEl(),
    documentElement: makeEl('html'), // pour document.documentElement.lang (i18n, setPreferredLanguage())
    visibilityState: 'visible',
    get activeElement(){ return activeElement; },
  },
  window: {
    addEventListener(){}, removeEventListener(){},
    innerWidth: 400, innerHeight: 800, scrollY: 0,
    caches: mockCachesApi, // pour le test `'caches' in window` de forceAppUpdate()
    // Simule (display-mode: standalone) : false par defaut (navigateur classique,
    // PWA pas encore installee) ; certains tests reassignent matchMedia entierement
    // pour simuler le mode standalone.
    matchMedia(query) { return { matches: false, media: query, addListener(){}, removeListener(){} }; },
    AudioContext: function(){ return { createOscillator(){ return { connect(){}, start(){}, stop(){}, frequency:{} }; }, createGain(){ return { connect(){}, gain:{ setValueAtTime(){}, linearRampToValueAtTime(){}, exponentialRampToValueAtTime(){} } }; }, currentTime: 0, state: 'running', resume(){} }; },
    // Element <audio> natif (playSuccessSound()) : inerte par defaut (play() resout
    // immediatement, jamais de vrai chargement/decodage reseau dans les tests) - les
    // tests qui doivent verifier un appel reel remplacent temporairement window.Audio,
    // meme pattern que window.AudioContext ci-dessus.
    Audio: function (src) { this.src = src; this.play = () => Promise.resolve(); },
    speechSynthesis: {
      cancel(){ /* no-op : le log ne garde que les phrases reellement prononcees */ },
      // simule une utterance reelle : onend se declenche un court instant plus tard
      // (asynchrone), jamais de maniere synchrone, pour exercer fidelement le
      // callback onEnd de speak() (cf. la synchronisation du decompte Hardcore).
      speak(utt){
        sandboxSpokenLog.push(utt.text);
        if (typeof utt.onend === 'function') setTimeout(() => utt.onend(), 50);
      },
    },
  },
  requestAnimationFrame(){ return 0; },
  cancelAnimationFrame(){},
  navigator: {
    vibrate(){ return true; },
    onLine: true,
    serviceWorker: { getRegistrations: async () => mockSwRegistrations },
    // Valeurs neutres par defaut (ni iOS ni "Mac tactile") : les tests qui simulent
    // un appareil precis reassignent ces champs directement (meme convention que
    // navigator.onLine ci-dessus).
    userAgent: 'Mozilla/5.0 (Linux; Android 10)',
    platform: 'Linux armv8l',
    maxTouchPoints: 0,
    standalone: undefined,
    // Neutre par defaut (francais, coherent avec le reste de l'appli jusqu'ici) : les
    // tests qui simulent un autre appareil/langue reassignent directement, meme
    // convention que navigator.onLine/userAgent ci-dessus.
    language: 'fr-FR',
  },
  caches: mockCachesApi,
  history: {
    pushState(){}, back(){},
    // Simule le lien reel entre history.replaceState(url) et location.search/pathname
    // (dans un vrai navigateur, changer l URL via replaceState met aussi a jour location) :
    // applyShortcutTabFromUrl() s en sert pour nettoyer ?tab=... apres l avoir lu.
    replaceState(state, title, url) {
      if (typeof url !== 'string') return;
      const qIdx = url.indexOf('?');
      if (qIdx === -1) { mockLocation.pathname = url; mockLocation.search = ''; }
      else { mockLocation.pathname = url.slice(0, qIdx); mockLocation.search = url.slice(qIdx); }
    },
  },
  URLSearchParams,
  location: mockLocation,
  firebase: {
    initializeApp(){},
    auth(){ return { onAuthStateChanged(cb){ /* pilote manuellement depuis le test */ }, signInWithPopup(){ return Promise.resolve(); }, GoogleAuthProvider: function(){} }; },
    // Mock de firebase.app().functions(region).httpsCallable(name) : voir
    // mockGetMyRankResult/__setMockGetMyRank et
    // mockLogGroupChallengeContributionCalls/__setMockLogGroupChallengeContributionResult
    // ci-dessus/plus bas pour chaque Callable mockee.
    app(){
      return {
        functions(_region){
          return {
            httpsCallable(name){
              return async (data) => {
                if (name === 'getMyRank') {
                  mockGetMyRankCallCount++;
                  mockGetMyRankLastArgs = data;
                  if (mockGetMyRankShouldFail) throw new Error('getMyRank : echec simule par le test');
                  return { data: mockGetMyRankResult };
                }
                if (name === 'logGroupChallengeContribution') {
                  mockLogGroupChallengeContributionCalls.push(data);
                  return { data: mockLogGroupChallengeContributionResult };
                }
                if (name === 'applyGroupJoker') {
                  mockApplyGroupJokerCalls.push(data);
                  return { data: { ok: true } };
                }
                if (name === 'deleteGroup') {
                  mockDeleteGroupCalls.push(data);
                  if (mockDeleteGroupShouldFail) throw new Error('deleteGroup : echec simule par le test');
                  return { data: { ok: true } };
                }
                throw new Error('Callable non mockee dans les tests : ' + name);
              };
            },
          };
        },
      };
    },
    firestore(){
      return {
        enablePersistence: () => Promise.resolve(),
        collection(name){
          if (name === 'users') {
            return {
              doc(uid){
                return {
                  collection(subName){
                    // kv/appData : comportement HISTORIQUE inchangé, un seul mock partagé
                    // sans distinction d'uid (voir appDataStore plus haut) — ne JAMAIS lui
                    // faire porter une isolation par utilisateur, ça casserait tous les
                    // tests existants qui simulent plusieurs comptes via de simples
                    // reassignations de currentUser.
                    if (subName === 'kv') {
                      // .get() (enumeration de la sous-collection, utilisee UNIQUEMENT par
                      // deleteMyAccount()) : renvoie volontairement toujours vide plutot que
                      // de modeliser un vrai document supprimable - appDataStore est un
                      // singleton PARTAGE par tout le fichier de test (voir plus haut), le
                      // vider depuis un seul test casserait silencieusement tous les tests
                      // sequentiels suivants qui dependent de son contenu deja en place.
                      return { doc: () => makeAppDataDocRef(), async get() { return { empty: true, size: 0, docs: [], forEach() {} }; } };
                    }
                    // Toute autre sous-collection (ex: notifications) : mock générique
                    // complet, isolé PAR UTILISATEUR (uid) — même mécanisme que les
                    // sous-collections de makeMockCollection.
                    if (!usersSubcollections.has(uid)) usersSubcollections.set(uid, new Map());
                    const subMap = usersSubcollections.get(uid);
                    if (!subMap.has(subName)) subMap.set(subName, new Map());
                    return makeMockCollection(subMap.get(subName));
                  },
                };
              },
            };
          }
          if (!mockTopCollections.has(name)) mockTopCollections.set(name, makeMockCollection(new Map()));
          const coll = mockTopCollections.get(name);
          // Compte les vraies écritures leaderboard/{uid} (voir syncLeaderboardEntry() /
          // pendingLeaderboardSync dans index.html) : sert à verifier qu'un seul evenement
          // (ex: 1ere completion du jour) ne produit plus qu'UNE ecriture, pas 2.
          if (name === 'leaderboard') {
            return { ...coll, doc(id) {
              const ref = coll.doc(id);
              return {
                ...ref,
                async set(fields, opts) { leaderboardSetCallCount++; return ref.set(fields, opts); },
                async get() { leaderboardGetCallCount++; return ref.get(); }, // voir fetchPublicProfile()
              };
            } };
          }
          // Compte les lectures du document precalcule leaderboardCache/{view} (Phase 1 :
          // classement precalcule cote serveur, voir fetchLeaderboardTop()) : sert a
          // verifier que le cache TTL cote client evite bien une relecture a chaque
          // visite/changement de vue.
          if (name === 'leaderboardCache') {
            return { ...coll, doc(id) {
              const ref = coll.doc(id);
              return {
                ...ref,
                async get() { leaderboardCacheGetCallCount++; return ref.get(); },
              };
            } };
          }
          return coll;
        },
        // batch() : les operations sont simplement appliquees dans l'ordre a commit()
        // (pas de vraie atomicite/rollback simulee - inutile ici, aucun test ne cree de
        // vrai conflit concurrent). Suffisant pour verifier qu'un ensemble d'ecritures
        // liees (ex: accepter une demande d'ami = creer friendships + supprimer
        // friendRequests) se produit bien EN UN SEUL appel commit().
        batch() {
          const ops = [];
          return {
            set(docRef, data, opts) { ops.push(() => docRef.set(data, opts)); return this; },
            update(docRef, data) { ops.push(() => docRef.set(data, { merge: true })); return this; },
            delete(docRef) { ops.push(() => docRef.delete()); return this; },
            async commit() { for (const op of ops) await op(); },
          };
        },
        // runTransaction() : meme simplification (pas de vraie isolation/retry sur
        // conflit) - transaction.get() lit l'etat courant, set/update/delete appliquent
        // immediatement (comme le batch ci-dessus). Suffit a tester la logique
        // "lire la preuve-de-kudos, avorter si deja presente, sinon ecrire" portee par
        // le CODE DE L'APPLICATION lui-meme (pas par le mock).
        async runTransaction(updateFunction) {
          const transaction = {
            get: (docRef) => docRef.get(),
            set(docRef, data, opts) { docRef.set(data, opts); return transaction; },
            update(docRef, data) { docRef.set(data, { merge: true }); return transaction; },
            delete(docRef) { docRef.delete(); return transaction; },
          };
          return updateFunction(transaction);
        },
      };
    },
  },
  __resetCommunityMocks: () => {
    mockTopCollections.clear();
    usersSubcollections.clear();
    // leaderboardTopCache/leaderboardNeighborsCache (index.html) sont des caches
    // APPLICATIFS qui survivent entre scenarios de test (un seul script vm partagé
    // pour toute la suite, voir en tête de ce fichier) — sans ce nettoyage, un cache
    // rempli par un scenario precedent pourrait fausser un scenario suivant qui
    // repart d'un mock vide.
    if (typeof sandbox.invalidateLeaderboardCache === 'function') sandbox.invalidateLeaderboardCache();
    sandbox.__resetMockGetMyRank();
    sandbox.__resetMockLogGroupChallengeContribution();
    sandbox.__resetMockApplyGroupJoker();
  },
  alert(msg){ console.log('  [alert]', msg); },
  confirm(msg){ return true; },
  prompt(msg, def){ return def; },
  localStorage: mockLocalStorage,
  __store: store,
  __mockLocalStorageStore: mockLocalStorageStore,
  __appDataStore: appDataStore, // { exists, data } du document consolide simule (voir plus haut)
  get __appDataSetCallCount() { return appDataSetCallCount; },
  __resetAppDataSetCallCount() { appDataSetCallCount = 0; },
  get __dbGetDayCallCount() { return dbGetDayCallCount; },
  __resetDbGetDayCallCount() { dbGetDayCallCount = 0; },
  get __dbSetDayCallCount() { return dbSetDayCallCount; },
  __resetDbSetDayCallCount() { dbSetDayCallCount = 0; },
  get __leaderboardSetCallCount() { return leaderboardSetCallCount; },
  __resetLeaderboardSetCallCount() { leaderboardSetCallCount = 0; },
  get __leaderboardGetCallCount() { return leaderboardGetCallCount; },
  __resetLeaderboardGetCallCount() { leaderboardGetCallCount = 0; },
  get __leaderboardCacheGetCallCount() { return leaderboardCacheGetCallCount; },
  __resetLeaderboardCacheGetCallCount() { leaderboardCacheGetCallCount = 0; },
  __setMockGetMyRank(result) { mockGetMyRankResult = result; },
  __setMockGetMyRankShouldFail(shouldFail) { mockGetMyRankShouldFail = shouldFail; },
  get __mockGetMyRankCallCount() { return mockGetMyRankCallCount; },
  get __mockGetMyRankLastArgs() { return mockGetMyRankLastArgs; },
  __resetMockGetMyRank() {
    mockGetMyRankResult = { rank: null, value: 0 };
    mockGetMyRankShouldFail = false;
    mockGetMyRankCallCount = 0;
    mockGetMyRankLastArgs = null;
  },
  get __mockLogGroupChallengeContributionCalls() { return mockLogGroupChallengeContributionCalls; },
  __setMockLogGroupChallengeContributionResult(result) { mockLogGroupChallengeContributionResult = result; },
  __resetMockLogGroupChallengeContribution() {
    mockLogGroupChallengeContributionCalls = [];
    mockLogGroupChallengeContributionResult = { credited: 0, reachedTarget: false };
  },
  get __mockApplyGroupJokerCalls() { return mockApplyGroupJokerCalls; },
  get __mockDeleteGroupCalls() { return mockDeleteGroupCalls; },
  __setMockDeleteGroupShouldFail(v) { mockDeleteGroupShouldFail = v; },
  __resetMockApplyGroupJoker() { mockApplyGroupJokerCalls = []; },
  __mockCacheKeys: mockCacheKeys, // Cache Storage simule (forceAppUpdate)
  __mockSwRegistrations: mockSwRegistrations, // ServiceWorkerRegistration simulees (forceAppUpdate)
  __rawHtml: html, // fichier source complet de index.html (le <style> a ete extrait dans styles.css, voir __cssSource)
  __cssSource: cssSource, // contenu de styles.css, a part depuis la fusion CSS (#4) : jamais dans __rawHtml
  __swSource: swSource, // contenu de service-worker.js (fichier a part, jamais execute par le vm)
  __externalClassicScripts: externalClassicScripts, // exercise-data.js + exercise-pictograms.js concatenes, pour verifier leur contenu (jamais dans __rawHtml, ce sont des fichiers a part)
  __dbGet: async (key) => {
    if (key.startsWith('day:')) dbGetDayCallCount++; // voir loadHistoryEntries() : verifie le cache des jours passes
    if (!store.has(key)) throw new Error('not found: ' + key);
    return { key, value: store.get(key) };
  },
  __dbSet: async (key, value) => {
    if (key.startsWith('day:')) dbSetDayCallCount++; // voir saveState()/scheduleWorkoutWriteFlush()
    store.set(key, value);
    return { key, value };
  },
  __assertOk(cond, msg) { if (!cond) throw new Error('ASSERT FAIL: ' + msg); },
  __assertEq(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`ASSERT FAIL: ${msg}\n  attendu: ${sb}\n  obtenu:  ${sa}`);
  },
};
// firebase.firestore.FieldValue.increment(...) est une propriete STATIQUE du namespace
// firestore (pas de l'instance renvoyee par firebase.firestore()) : attachee ici sur la
// fonction elle-meme, comme dans le vrai SDK compat.
sandbox.firebase.firestore.FieldValue = { increment: __mockFieldValueIncrement };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

const testDriver = `
// Remplace dbGet/dbSet (definis par l'appli au-dessus, lies a Firestore/currentUser)
// par la version en memoire injectee par le harnais de test.
dbGet = __dbGet;
dbSet = __dbSet;
// appDataDocRef() (contrairement a dbGet/dbSet) lit currentUser.uid directement : il faut
// un utilisateur factice des le debut, avant meme le premier test (plusieurs tests le
// re-assignent plus loin avec la meme forme, sans jamais lire .uid eux-memes).
currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };
// Garde-fou anti-spam humoristique (Kilito, retour utilisateur) : neutralise par
// defaut pour TOUTE la suite - le harnais enchaine legitimement de tres nombreux
// addSet() rapproches sur le meme exercice (bien plus vite qu un humain), ce qui
// declencherait a tort confirmModal() SANS jamais rien cliquer dessus (aucun test
// existant ne s attend a cette popup) et bloquerait la suite entiere en attente
// d une Promise jamais resolue. Reference d origine conservee
// (__realMaybeInterceptSpammyTaps) pour la restaurer ponctuellement dans le test
// dedie qui verifie le VRAI comportement du garde-fou.
const __realMaybeInterceptSpammyTaps = maybeInterceptSpammyTaps;
maybeInterceptSpammyTaps = async () => true;
// Depuis la fusion CSS (#4), les regles de style ne sont plus dans __rawHtml (index.html)
// mais dans styles.css (__cssSource) : les tests qui verifient du texte CSS doivent
// chercher dans cssText plutot que dans __rawHtml seul.
const cssText = __rawHtml + __cssSource;

(async () => {
  // --- 1. CHALLENGE_LIBRARY sanity ---
  __assertOk(CHALLENGE_LIBRARY.length > 20, 'CHALLENGE_LIBRARY devrait contenir >20 exercices');
  console.log('OK: CHALLENGE_LIBRARY chargee (' + CHALLENGE_LIBRARY.length + ' exercices)');

  // --- 1bis. i18n : helpers bas niveau (getNestedValue/interpolate), moteur t()/tn(),
  // detection/persistance de la langue. Fondations du chantier i18n (batch 1/7) :
  // aucun ecran encore migre a ce stade, uniquement le moteur lui-meme. ---
  __assertEq(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c'), 42, 'getNestedValue doit suivre un chemin pointe');
  __assertEq(getNestedValue({ a: { b: { c: 42 } } }, 'a.x.c'), undefined, 'getNestedValue doit renvoyer undefined si un segment intermediaire manque (jamais d exception)');
  __assertEq(interpolate('Bonjour {{name}} !', { name: 'Alice' }), 'Bonjour Alice !', 'interpolate doit remplacer {{cle}} par la valeur correspondante');
  __assertEq(interpolate('Bonjour {{name}} !', {}), 'Bonjour  !', 'un parametre absent doit etre remplace par une chaine vide, jamais planter');

  // t() : resolution dans les 3 langues supportees.
  const localeBefore = currentLocale;
  __assertEq(t('common.cancel'), 'Annuler', 't() doit resoudre une cle existante dans la langue active par defaut (francais, cf. navigator.language mocke)');
  currentLocale = 'en';
  __assertEq(t('common.cancel'), 'Cancel', 't() doit basculer de langue via currentLocale');
  currentLocale = 'es';
  __assertEq(t('common.cancel'), 'Cancelar', 't() doit fonctionner pour les 3 langues supportees');

  // Repli francais si la cle manque dans la langue active (jamais un ecran casse pour
  // une cle pas encore traduite partout).
  const savedEnConfirm = LOCALE_EN.common.confirm;
  delete LOCALE_EN.common.confirm;
  currentLocale = 'en';
  __assertEq(t('common.confirm'), 'Confirmer', 'une cle manquante dans la langue active doit retomber sur le francais');
  LOCALE_EN.common.confirm = savedEnConfirm;

  // Repli sur la cle brute si elle n existe dans AUCUNE langue (jamais undefined/vide).
  __assertEq(t('nonexistent.key.path'), 'nonexistent.key.path', 'une cle introuvable partout doit retomber sur elle-meme, jamais un ecran vide');

  // t() : interpolation de parametres.
  LOCALE_FR.common.testGreeting = 'Bonjour {{name}} !';
  __assertEq(t('common.testGreeting', { name: 'Bob' }), 'Bonjour Bob !', 't() doit interpoler les parametres fournis');
  delete LOCALE_FR.common.testGreeting;

  // tn() : pluriel singulier/other selon count.
  LOCALE_FR.common.testDays = { one: '{{n}} jour', other: '{{n}} jours' };
  currentLocale = 'fr';
  __assertEq(tn('common.testDays', 1), '1 jour', 'tn() doit choisir la forme singuliere pour count=1');
  __assertEq(tn('common.testDays', 3), '3 jours', 'tn() doit choisir la forme "other" sinon');
  delete LOCALE_FR.common.testDays;
  currentLocale = localeBefore;

  // detectPreferredLanguage() : ordre de repli exact -- localStorage > navigateur > anglais.
  __mockLocalStorageStore.clear();
  __mockLocalStorageStore.set('preferredLanguage', 'es');
  __assertEq(detectPreferredLanguage(), 'es', 'la preference deja enregistree doit primer sur tout le reste');
  __mockLocalStorageStore.clear();
  const navLangBefore = navigator.language;
  navigator.language = 'en-US';
  __assertEq(detectPreferredLanguage(), 'en', 'sans preference enregistree, la langue du navigateur doit etre utilisee');
  navigator.language = 'de-DE';
  __assertEq(detectPreferredLanguage(), 'en', 'une langue navigateur NON supportee (allemand) doit retomber sur l anglais');
  navigator.language = navLangBefore;

  // setPreferredLanguage() : met a jour currentLocale, persiste, met a jour <html lang>,
  // relance un rendu complet (necessite un etat minimal pour que render() ne plante pas).
  state = emptyDayState();
  activeToday = new Set();
  activeTab = 'today';
  currentChallengeId = null;
  setPreferredLanguage('en');
  __assertEq(currentLocale, 'en', 'setPreferredLanguage doit mettre a jour currentLocale');
  __assertEq(__mockLocalStorageStore.get('preferredLanguage'), 'en', 'doit persister la preference sur cet appareil');
  __assertEq(document.documentElement.lang, 'en', "doit mettre a jour l'attribut lang du document (accessibilite)");
  // Synchronisation Firestore (Phase A notifications push) : localStorage reste
  // la source de verite pour l UI (inchange), mais la preference est AUSSI
  // ecrite cote serveur - c est la seule facon pour une Cloud Function de
  // localiser le texte d une notification push (voir sendPushToUser()).
  await new Promise(r => setTimeout(r, 10));
  const appDataAfterLangChange = await appDataDocRef().get();
  __assertEq(appDataAfterLangChange.data().preferredLanguage, 'en', 'la langue preferee doit aussi etre synchronisee sur le document appData consolide (lisible cote serveur)');
  setPreferredLanguage('xx'); // langue non supportee
  __assertEq(currentLocale, 'en', 'une langue non supportee ne doit rien changer a la langue active');
  setPreferredLanguage('fr'); // restaure avant la suite des tests
  __mockLocalStorageStore.clear();
  console.log('OK: i18n - moteur t()/tn(), detection/persistance de la langue (fondations, aucun ecran encore migre)');

  // --- 2. rebuildChallenges / customChallenges ---
  customChallenges = [{ id: 9001, cat: 'Haut du corps', name: 'Test Custom', target: 50, unit: 'reps', hardcoreTarget: 100, isCustom: true }];
  rebuildChallenges();
  __assertEq(CHALLENGES.length, CHALLENGE_LIBRARY.length + 1, 'CHALLENGES = library + customChallenges');
  console.log('OK: rebuildChallenges fusionne CHALLENGE_LIBRARY + customChallenges');

  // --- 3. resolveChallenge (sans profil -> target inchange ; avec override manuel) ---
  userProfile = null;
  const pompes = CHALLENGE_LIBRARY.find(c => c.name === 'Pompes');
  const resolvedNoProfile = resolveChallenge(pompes);
  __assertEq(resolvedNoProfile.target, pompes.target, 'sans profil, target = valeur de base');
  manualTargetOverrides = { [pompes.id]: 999 };
  const resolvedOverride = resolveChallenge(pompes);
  __assertEq(resolvedOverride.target, 999, 'override manuel doit primer sur computeStandardTarget');
  __assertEq(resolvedOverride.hardcoreTarget, 1998, 'hardcoreTarget = target*2 pour un defi bibliotheque');
  const custom = CHALLENGES.find(c => c.id === 9001);
  const resolvedCustom = resolveChallenge(custom);
  __assertEq(resolvedCustom.target, 50, 'un defi personnalise garde son target tel quel');
  manualTargetOverrides = {};
  console.log('OK: resolveChallenge (bibliotheque + override + custom)');

  // --- 4. Migration depuis l'ancien modele 'userChallenges' ---
  const legacyCustomId = 9002;
  const legacyList = [
    { id: pompes.id, cat: pompes.cat, name: pompes.name, target: pompes.target, unit: pompes.unit, hardcoreTarget: pompes.target * 2 },
    { id: legacyCustomId, cat: 'Haut du corps', name: 'Ancien perso', target: 30, unit: 'reps', hardcoreTarget: 60 },
  ];
  __store.set('userChallenges', JSON.stringify(legacyList));
  customChallenges = [];
  CHALLENGES = [];
  migratedLegacyActiveIds = null;
  await loadChallenges();
  __assertEq(customChallenges.length, 1, 'seul le defi non-bibliotheque doit devenir un customChallenge');
  __assertEq(customChallenges[0].id, legacyCustomId, 'id du defi perso migre');
  __assertOk(CHALLENGES.some(c => c.id === pompes.id), 'Pompes doit rester dans le catalogue complet (via CHALLENGE_LIBRARY)');
  __assertOk(__appDataStore.exists && Array.isArray(__appDataStore.data.customChallenges), 'la migration doit persister customChallenges dans le document consolide appData');
  __assertEq([...migratedLegacyActiveIds].sort(), [pompes.id, legacyCustomId].sort(), 'ids repris pour activeToday');
  console.log('OK: migration userChallenges -> customChallenges + migratedLegacyActiveIds');

  // --- 5. loadActiveToday reprend la migration une seule fois, puis se comporte normalement ---
  todayKey = '2026-07-30';
  await loadActiveToday();
  __assertEq([...activeToday].sort(), [pompes.id, legacyCustomId].sort(), 'premier jour post-migration : reprise de l ancienne liste comme active');
  __assertEq(migratedLegacyActiveIds, null, 'la graine de migration ne doit servir qu une fois');
  __assertOk(__store.has('activeToday:2026-07-30'), 'activeToday doit etre persiste par date');
  console.log('OK: loadActiveToday seede depuis la migration puis se persiste');

  todayKey = '2026-07-31';
  await loadActiveToday();
  __assertEq(activeToday.size, 0, 'un nouveau jour sans selection doit demarrer vide (rituel quotidien)');
  console.log('OK: un nouveau jour sans activation demarre bien a vide (pas de report automatique)');

  // Comme au vrai demarrage (continueStartApp), state doit exister avant toute
  // interaction utilisateur : toggleActiveToday()/pickChallenge() appellent render()
  // qui dereference state.challenges sans garde (jamais null en usage reel).
  state = emptyDayState();

  // --- 6. toggleActiveToday persiste bien ---
  await toggleActiveToday(pompes.id);
  __assertOk(activeToday.has(pompes.id), 'toggle doit activer');
  const persisted = JSON.parse(__store.get('activeToday:2026-07-31'));
  __assertOk(persisted.includes(pompes.id), 'persistance apres activation');
  await toggleActiveToday(pompes.id);
  __assertOk(!activeToday.has(pompes.id), 'toggle doit desactiver');
  console.log('OK: toggleActiveToday active/desactive + persiste');

  // --- 7. Progression du jour preservee quel que soit l etat actif/inactif ---
  state = { challenges: { [pompes.id]: { sets: [10, 15], targetOverride: null, done: false, hardcoreDone: false } } };
  await toggleActiveToday(pompes.id);
  __assertEq(state.challenges[pompes.id].sets, [10, 15], 'activer ne doit pas toucher la progression existante');
  await toggleActiveToday(pompes.id);
  __assertEq(state.challenges[pompes.id].sets, [10, 15], 'desactiver ne doit pas effacer la progression existante');
  console.log('OK: la progression du jour est preservee au toggle actif/inactif');

  // --- 8. renderLibraryScreen : accordeons, compteur actifs, badge ACTIF ---
  editingChallengeId = null;
  libraryOpenCats = new Set(['Haut du corps']);
  activeToday = new Set([pompes.id]);
  const libHtml = renderLibraryScreen();
  __assertOk(libHtml.includes('accordion-header'), 'la biblio doit contenir des en-tetes d accordeon');
  __assertOk(libHtml.includes('Haut du corps'), 'categorie affichee');
  __assertOk(/Haut du corps[\\s\\S]*?accordion-count[^>]*>1 actif/.test(libHtml), 'compteur actif doit valoir 1 pour Haut du corps');
  __assertOk(libHtml.includes('picker-item'), 'la carte Défis doit reutiliser la classe .picker-item (identique a l accueil)');
  __assertOk(libHtml.includes('activate-toggle-btn active'), 'le bouton d activation doit etre marque actif pour un defi active');
  __assertOk(libHtml.includes('✓ Actif'), 'texte du bouton Actif');
  __assertOk(libHtml.includes('+ Activer'), 'les defis inactifs doivent afficher un bouton + Activer explicite');
  console.log('OK: renderLibraryScreen (accordeon ouvert, compteur, carte active)');

  libraryOpenCats = new Set();
  const libHtmlClosed = renderLibraryScreen();
  __assertOk(!libHtmlClosed.includes('accordion-body'), 'aucune categorie ouverte -> pas de corps d accordeon affiche');
  console.log('OK: accordeon ferme par defaut ne montre pas les cartes');

  // --- 9. Formulaire defi personnalise : creation/edition custom uniquement ---
  editingChallengeId = 'new';
  const formHtmlNew = renderLibraryScreen();
  __assertOk(formHtmlNew.includes('Nouveau défi'), 'formulaire de creation');
  editingChallengeId = legacyCustomId;
  const formHtmlEdit = renderLibraryScreen();
  __assertOk(formHtmlEdit.includes('Ancien perso'), 'le formulaire d edition doit pre-remplir le nom du custom');
  editingChallengeId = null;
  console.log('OK: formulaire creation/edition (defis personnalises)');

  // --- 10. renderTodayEmptyState ---
  const emptyHtml = renderTodayEmptyState();
  __assertOk(emptyHtml.includes("Aucun défi sélectionné pour aujourd'hui"), 'message ecran vide');
  __assertOk(emptyHtml.includes("switchTab('library')"), 'bouton de redirection vers la bibliotheque');
  console.log('OK: ecran vide Aujourd hui');

  // --- 11. deleteChallenge ne supprime que les customChallenges, nettoie activeToday/overrides ---
  manualTargetOverrides = { [legacyCustomId]: 77 };
  activeToday = new Set([legacyCustomId]);
  // deleteChallenge() passe maintenant par confirmModal() (Promise<boolean>, resolue
  // seulement au clic sur le bouton de confirmation) : on simule ce clic avant d attendre.
  const deleteChallengePromise = deleteChallenge(legacyCustomId);
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await deleteChallengePromise;
  __assertOk(!customChallenges.some(c => c.id === legacyCustomId), 'customChallenges nettoye');
  __assertOk(!activeToday.has(legacyCustomId), 'activeToday nettoye');
  __assertEq(manualTargetOverrides[legacyCustomId], undefined, 'manualTargetOverrides nettoye');
  console.log('OK: deleteChallenge nettoie customChallenges + activeToday + manualTargetOverrides');

  // --- 12. Parcours complet : activer un defi, l'ouvrir, valider une serie qui le complete ---
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await saveActiveToday();
  await pickChallenge(pompes.id);
  __assertEq(currentChallengeId, pompes.id, 'pickChallenge doit selectionner le defi');
  const cPicked = getChallenge();
  __assertOk(cPicked && cPicked.target > 0, 'getChallenge() doit resoudre un objectif valide');
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(cPicked.target); // complete le defi du jour
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  __assertOk(state.challenges[pompes.id].done, 'le defi doit etre marque termine apres avoir atteint l objectif');
  __assertEq(state.challenges[pompes.id].sets, [cPicked.target], 'la serie ajoutee doit etre enregistree');
  render(false); // vue detail (fiche active) ne doit pas lever d'exception
  currentChallengeId = null;
  console.log('OK: parcours pickChallenge -> addSet -> completion (via resolveChallenge) sans exception');

  // --- 13. render() complet sur les deux onglets ne doit pas lever d'exception ---
  activeTab = 'library';
  render(false);
  activeTab = 'today';
  currentChallengeId = null;
  activeToday = new Set();
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 };
  dailyActivity = {};
  weekData = {};
  render(false);
  console.log('OK: render() complet (Bibliotheque + Aujourd hui vide) sans exception');

  // --- 14. Tout nouvel utilisateur (aucune donnee Firestore) : pas d'ecran de
  // selection de defis, atterrit directement sur l'etat vide d'Aujourd'hui ---
  __store.clear();
  customChallenges = [];
  CHALLENGES = [];
  activeToday = new Set();
  migratedLegacyActiveIds = null;
  currentChallengeId = null;
  activeTab = 'today';
  await loadChallenges();
  __assertOk(typeof showOnboarding === 'undefined', 'showOnboarding ne doit plus exister (ecran de selection supprime)');
  await continueStartApp(); // Promise.all(loadWeights...) + loadState() + loadActiveToday()
  __assertEq(activeToday.size, 0, 'nouvel utilisateur : aucun defi actif sans action manuelle');
  const freshHtml = renderTodayEmptyState();
  __assertOk(freshHtml.includes("Aucun défi sélectionné pour aujourd'hui"), 'nouvel utilisateur voit direct l ecran vide');
  render(false); // simule le premier rendu reel de l'app : ne doit lever aucune exception
  console.log('OK: nouvel utilisateur sans donnees -> aucun onboarding de selection, ecran vide direct');

  // --- 15. Repro du bug de boucle : un rechargement (pull-to-refresh / refreshApp)
  // qui relance loadChallenges() ne doit JAMAIS faire reapparaitre un onboarding,
  // ni perdre la selection active du jour ---
  activeToday = new Set([pompes.id]);
  await saveActiveToday();
  activeTab = 'library';
  render(false); // l'utilisateur est sur l'onglet Bibliotheque
  await refreshApp(); // ex: un tir accidentel de pull-to-refresh en naviguant
  __assertOk(typeof showOnboarding === 'undefined', 'refreshApp ne doit jamais reintroduire un ecran d onboarding');
  __assertOk(activeToday.has(pompes.id), 'la selection active du jour doit survivre a un refreshApp');
  activeTab = 'today';
  render(false); // clic sur l'onglet Aujourd'hui : ne doit PAS relancer un onboarding
  console.log('OK: refreshApp() puis retour sur Aujourd hui ne relance pas de boucle onboarding');

  // --- 16. Fiche detail exercice : plus de header (date/streak) ni de bouton retour,
  // le PNG est le tout premier element de .active-card ---
  activeTab = 'today';
  activeToday = new Set([pompes.id]);
  state = emptyDayState();
  await pickChallenge(pompes.id);
  const app = document.getElementById('app');
  render(false);
  const rendered = app.innerHTML;
  __assertOk(!rendered.includes('change-btn'), 'le bouton Retour ne doit plus exister sur la fiche detail');
  __assertOk(!rendered.includes('class="header"'), 'le bandeau date/streak ne doit plus s afficher sur la fiche detail');
  const activeCardIdx = rendered.indexOf('active-card');
  const imgIdx = rendered.indexOf('exercise-hero-apng');
  __assertOk(activeCardIdx !== -1 && imgIdx !== -1 && imgIdx - activeCardIdx < 60, 'le PNG doit etre le tout premier element visuel de .active-card');
  currentChallengeId = null;
  console.log('OK: fiche detail compacte (pas de header/back-btn, PNG en premier)');

  // --- 17. Barre d'onglets : 5 onglets (Journal fusionne en sous-onglet de Profil,
  // plus un onglet separe de la barre du bas) ---
  const tabBarHtml = renderTabBar();
  const idxDefis = tabBarHtml.indexOf('Défis');
  const idxProfilTab = tabBarHtml.indexOf('Profil');
  __assertOk(idxDefis !== -1 && idxProfilTab !== -1 && idxDefis < idxProfilTab, 'Défis doit apparaitre avant Profil dans la barre du bas');
  __assertOk(tabBarHtml.includes('🎯'), 'icone cible 🎯 pour l onglet Défis');
  __assertOk(tabBarHtml.includes('🏋️‍♂️'), 'icone haltere pour Aujourd hui');
  __assertOk(!tabBarHtml.includes('Journal'), 'Journal ne doit plus apparaitre comme onglet separe dans la barre du bas (fusionne dans Profil)');
  __assertOk(!tabBarHtml.includes('📓'), 'l icone carnet ne doit plus apparaitre dans la barre du bas (fusionnee dans Profil)');
  __assertOk(!tabBarHtml.includes('📚'), 'ancienne icone livre 📚 ne doit plus apparaitre');
  __assertOk(!tabBarHtml.includes('>Bibliothèque<'), 'le libelle Bibliotheque ne doit plus apparaitre');
  __assertOk(!tabBarHtml.includes('>Historique<'), 'le libelle Historique ne doit plus apparaitre dans la barre');
  __assertOk(tabBarHtml.includes('>Profil<'), 'l onglet Compte doit maintenant s appeler Profil');
  const tabBtnCount = (tabBarHtml.match(/class="tab-btn/g) || []).length;
  __assertEq(tabBtnCount, 5, 'il ne doit plus y avoir que 5 onglets dans la barre du bas (Journal fusionne dans Profil)');
  console.log('OK: onglets renommes/reordonnes/regroupes (Aujourd hui / Défis / Commu / Groupes / Profil)');

  // Retour utilisateur : la barre verte glissante en haut de l onglet actif
  // ("pas esthetique, plutot genante") a ete retiree - un seul onglet porte la
  // classe "active" (fond pilule discret + halo sur l icone, voir styles.css),
  // jamais 0 ni plusieurs a la fois, et .tab-active-indicator n existe plus du tout.
  const activeTabBefore = activeTab;
  activeTab = 'today';
  let indicatorHtml = renderTabBar();
  __assertOk(!indicatorHtml.includes('tab-active-indicator'), 'la barre glissante retiree ne doit plus jamais apparaitre dans le HTML');
  __assertEq((indicatorHtml.match(/class="tab-btn active"/g) || []).length, 1, 'un seul onglet doit porter la classe active a la fois');
  __assertOk(indicatorHtml.indexOf('class="tab-btn active"') < indicatorHtml.indexOf('🏋️‍♂️'), 'l onglet actif doit etre celui d Aujourd hui');
  activeTab = 'groups';
  indicatorHtml = renderTabBar();
  __assertEq((indicatorHtml.match(/class="tab-btn active"/g) || []).length, 1, 'un seul onglet actif a la fois, meme apres changement d onglet');
  __assertOk(indicatorHtml.indexOf('class="tab-btn active"') < indicatorHtml.indexOf('👥'), 'l onglet actif doit avoir suivi le changement (Groupes)');
  activeTab = activeTabBefore;
  console.log('OK: barre glissante retiree, un seul onglet actif a la fois (fond pilule + halo sur l icone)');

  // --- 18. Journal fusionne en sous-onglet de Profil : trophées absents du sous-onglet
  // Journal, presents dans le sous-onglet Profil ---
  activeTab = 'account';
  profileView = 'journal';
  historyEntries = [];
  historyLoading = false;
  const historyHtml = renderAccountTabScreen();
  __assertOk(!historyHtml.includes('Trophées'), 'les trophees ne doivent plus apparaitre dans le sous-onglet Journal');
  __assertOk(historyHtml.includes('>Journal<'), 'le titre de page doit dire Journal quand ce sous-onglet est actif');
  currentUser = { displayName: 'Test', email: 't@test.com', photoURL: '' };
  profileView = 'profile';
  const accountHtml = renderAccountTabScreen();
  __assertOk(accountHtml.includes('Trophées'), 'les trophees doivent apparaitre dans le sous-onglet Profil');
  __assertOk(accountHtml.includes('>Profil<'), 'le titre de page doit dire Profil quand ce sous-onglet est actif');
  activeTab = 'today';
  console.log('OK: Journal fusionne en sous-onglet de Profil (trophees separees, titres corrects par sous-onglet)');

  // --- 19. Journal : plus de "Volume des 7 derniers jours", calendrier avant la heatmap ---
  __assertOk(!historyHtml.includes('Volume des 7 derniers jours'), 'la carte volume 7 jours doit avoir disparu du Journal');
  const idxCalendrier = historyHtml.indexOf('Calendrier du mois');
  const idxHeatmap = historyHtml.indexOf('Activité (6 derniers mois)');
  __assertOk(idxCalendrier !== -1 && idxHeatmap !== -1 && idxCalendrier < idxHeatmap, 'le calendrier du mois doit apparaitre avant la heatmap 6 mois');
  console.log('OK: Journal réorganisé (calendrier avant heatmap, volume 7j retiré)');

  // --- 19b. switchProfileView() : bascule le sous-onglet Profil/Journal, recharge
  // le Journal a la demande (meme comportement que l ancien switchTab('history')
  // dedie - voir CLAUDE.md) ---
  activeTab = 'account';
  profileView = 'profile';
  switchProfileView('profile'); // deja actif -> no-op (comme switchGroupDetailView())
  __assertEq(profileView, 'profile', 'rester sur le meme sous-onglet ne doit rien changer');
  switchProfileView('journal');
  __assertEq(profileView, 'journal', 'switchProfileView doit basculer sur le sous-onglet Journal');
  __assertOk(historyLoading, 'le Journal doit passer en chargement des le declenchement du switch, avant resolution de loadHistoryEntries()');
  await new Promise(r => setTimeout(r, 20));
  __assertOk(!historyLoading, 'historyLoading doit repasser a false une fois loadHistoryEntries() resolue');
  switchProfileView('profile');
  __assertEq(profileView, 'profile', 'switchProfileView doit revenir sur le sous-onglet Profil');
  activeTab = 'today';
  console.log('OK: switchProfileView() (bascule Profil/Journal, recharge le Journal a la demande)');

  // --- 20. Presse cubaine : objectif calculé identique à celui de Biceps ---
  userProfile = { age: 34, sex: 'homme', heightCm: 180, weightKg: 78, level: 'intermediaire' };
  const bicepsLib = CHALLENGE_LIBRARY.find(x => x.name === 'Biceps');
  const cubanLib = CHALLENGE_LIBRARY.find(x => x.name === 'Presse cubaine');
  const resolvedBiceps = resolveChallenge(bicepsLib);
  const resolvedCuban = resolveChallenge(cubanLib);
  __assertEq(resolvedCuban.target, resolvedBiceps.target, 'Presse cubaine doit avoir le meme objectif calcule que Biceps');
  userProfile = null;
  console.log('OK: Presse cubaine alignée sur Biceps (' + resolvedBiceps.target + ' reps)');

  // --- 21. Défis : quitter l'onglet referme tous les accordéons ---
  activeTab = 'library';
  libraryOpenCats = new Set(['Haut du corps', 'Haltères']);
  switchTab('today');
  __assertEq(libraryOpenCats.size, 0, 'quitter Défis doit vider libraryOpenCats');
  console.log('OK: les accordéons Défis se referment en quittant l onglet');

  // --- 22. Accueil : sous-titre retiré, poids affiché SOUS les reps (pas a cote) ---
  activeToday = new Set();
  state = emptyDayState();
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const homeAppHtml = document.getElementById('app').innerHTML;
  __assertOk(!homeAppHtml.includes("Choisis ton défi pour aujourd'hui"), 'le sous-titre doit avoir disparu de l accueil');
  const triceps = CHALLENGE_LIBRARY.find(x => x.name === 'Triceps'); // Haltères
  weights[triceps.id] = 12;
  activeToday = new Set([triceps.id]);
  const homeCardHtml = renderChallengeCard(triceps, 'today');
  __assertOk(homeCardHtml.includes('goal-weight'), 'la carte accueil doit inclure le poids sur sa propre ligne (.goal-weight)');
  __assertOk(homeCardHtml.includes('12kg'), 'le poids affiché doit correspondre a celui enregistre');
  __assertOk(!/reps[^<]*·[^<]*🏋️/.test(homeCardHtml), 'le poids ne doit pas être inline "a cote" des reps sur l accueil (contrairement a Défis)');
  console.log('OK: accueil sans sous-titre, poids affiché sous les reps pour les haltères');

  // --- 23. Bug de désync activeToday : continueStartApp() doit re-rendre avec
  // le activeToday FRAICHEMENT charge, pas celui (perime) vu par le render()
  // interne de loadState() ---
  const realTodayKey = dateKey(new Date());
  await dbSet('activeToday:' + realTodayKey, JSON.stringify([pompes.id])); // "vraie" valeur Firestore pour aujourd'hui
  activeToday = new Set([9999]); // simule un etat perime AVANT le chargement (ex: session precedente)
  activeTab = 'today';
  await continueStartApp();
  __assertEq([...activeToday], [pompes.id], 'apres continueStartApp(), activeToday doit refleter fidelement Firestore');
  const postLoadHtml = document.getElementById('app').innerHTML;
  __assertOk(!postLoadHtml.includes("Aucun défi sélectionné pour aujourd'hui"), 'le rendu final ne doit pas montrer l etat vide alors qu un defi est actif');
  console.log('OK: continueStartApp() re-rend avec le activeToday a jour (plus de désync)');

  // --- 24. Transition post-onboarding : loading -> confirm -> (tour ou app normale) ---
  profileDraft = { age: 28, sex: 'femme', heightCm: 165, weightKg: 60, level: 'debutant' };
  onboardingTransitionPhase = null;
  guidedTourStep = null;
  // Pseudo deja choisi (bypass volontaire du nouveau verrou obligatoire, teste separement
  // plus loin) : ce test-ci porte specifiquement sur la transition loading -> confirm.
  username = 'testuser24';
  const finishPromise = finishProfileOnboarding();
  // Marge volontairement large (> le defer de 140ms d applyContent(animate=true),
  // cf. CLAUDE.md) : un test precedent peut avoir laisse un render(true) EN ATTENTE
  // de son propre swap differe de 140ms (setTimeout reel, jamais annule entre tests) ;
  // sans cette marge, ce swap perime peut s appliquer PENDANT la verification de CE
  // test et ecraser a tort le contenu qu on veut observer ici. Reste tres en-dessous
  // des 1600ms de minDelay que ce test verifie justement ne pas etre encore ecoule.
  await new Promise(r => setTimeout(r, 300));
  __assertEq(onboardingTransitionPhase, 'loading', 'juste apres l appel, la phase doit etre "loading"');
  const loadingHtml = document.getElementById('app').innerHTML;
  __assertOk(loadingHtml.includes('Calcul de tes objectifs'), 'l ecran de chargement doit afficher le message de calcul');
  await finishPromise;
  __assertEq(onboardingTransitionPhase, 'confirm', 'apres le delai + chargement, la phase doit passer a "confirm"');
  await new Promise(r => setTimeout(r, 200)); // laisse le temps a l'animation differee (140ms, cf applyContent) de peindre le DOM
  const confirmHtml = document.getElementById('app').innerHTML;
  __assertOk(confirmHtml.includes('Objectifs calculés'), 'le message de confirmation attendu doit s afficher');
  __assertOk(confirmHtml.includes('preview-card') && confirmHtml.includes('preview-badge') && confirmHtml.includes('REPS'), 'une mini-carte de preview d objectif calcule doit remplacer le long paragraphe');
  __assertOk(confirmHtml.includes('preview-header-tag') && confirmHtml.includes("Exemple d'objectif") && confirmHtml.includes('exercise-name') && confirmHtml.includes('exercise-sub'), 'une etiquette EXEMPLE et un sous-libelle doivent rendre explicite que Pompes n est qu un exemple parmi d autres defis calcules');
  __assertOk(confirmHtml.includes('finishOnboardingTransition()'), 'un bouton doit permettre de lancer la suite');
  console.log('OK: écran de transition onboarding (loading -> confirm)');

  // --- 24bis. Pseudo public obligatoire : sanitisation, verrous (nouveau compte /
  // compte existant), verification de disponibilite en direct, reservation/liberation,
  // et les 3 routages de finishUsernameSetup() selon le contexte d origine. ---
  // Ce test appelle le VRAI startApp() (pour tester le verrou "compte existant" tel
  // qu il se declenche reellement) -- or startApp() appelle loadAppData(), qui ECRASE
  // en memoire tous les globals ci-dessous avec l etat le plus recemment PERSISTE dans
  // le document consolide simule (__appDataStore, partage par TOUT le fichier de test),
  // potentiellement perime par rapport aux mutations directes faites par des tests
  // precedents qui n appellent pas systematiquement saveX() a chaque etape. Sans ce
  // snapshot/restore, ce test contaminerait silencieusement l etat des tests suivants
  // (deja observe : un test XP plus loin recevait un bonus de trophee inattendu).
  const snap24bis = {
    userProfile: JSON.parse(JSON.stringify(userProfile)),
    customChallenges: JSON.parse(JSON.stringify(customChallenges)),
    manualTargetOverrides: JSON.parse(JSON.stringify(manualTargetOverrides)),
    streakCount, lastCompletedDate, hasShield, lastShieldResetWeek,
    xpTotal, xpWeekly, xpWeekStart, leaderboardOptOut, voiceCoachEnabled, hasSeenTour,
    lastCompleted: JSON.parse(JSON.stringify(lastCompleted)),
    stats: JSON.parse(JSON.stringify(stats)),
    badges: JSON.parse(JSON.stringify(badges)),
    dailyActivity: JSON.parse(JSON.stringify(dailyActivity)),
    weights: JSON.parse(JSON.stringify(weights)),
    username,
    appData: JSON.parse(JSON.stringify(__appDataStore.data)),
    appDataExists: __appDataStore.exists,
  };
  __resetCommunityMocks();

  // Sanitisation a la frappe : minuscules, [a-z0-9_] uniquement, tronque a 20.
  updateUsernameDraft('H3llo_World!! 42');
  __assertEq(usernameDraft, 'h3llo_world42', 'la saisie doit etre nettoyee en direct (minuscules, [a-z0-9_] uniquement)');
  updateUsernameDraft('a'.repeat(30));
  __assertEq(usernameDraft.length, 20, 'le pseudo doit etre tronque a 20 caracteres');

  // Verrou "nouveau compte" : finishProfileOnboarding() ne doit PAS enchainer sur
  // l ecran de transition si aucun pseudo n est encore choisi.
  username = null;
  onboardingTransitionPhase = null;
  usernameSetupMode = null;
  profileDraft = { age: 25, sex: 'homme', heightCm: 178, weightKg: 75, level: 'intermediaire' };
  await finishProfileOnboarding();
  __assertEq(usernameSetupMode, 'onboarding', 'sans pseudo, un nouveau compte doit etre bloque sur l ecran de choix de pseudo');
  __assertEq(onboardingTransitionPhase, null, 'l ecran de transition ne doit PAS demarrer tant que le pseudo n est pas choisi');
  // render(true) differe le swap DOM de 140ms (cf. applyContent()/CLAUDE.md) : marge large
  // et deja etablie ailleurs dans ce fichier pour laisser ce swap se produire avant lecture.
  await new Promise(r => setTimeout(r, 300));
  const gateHtmlNew = document.getElementById('app').innerHTML;
  __assertOk(gateHtmlNew.includes('Choisis ton pseudo') && !gateHtmlNew.includes('nav-back-btn'), 'le verrou "nouveau compte" doit etre infranchissable (aucun bouton retour)');

  // Verrou "compte existant" (cree avant cette fonctionnalite) : startApp() doit
  // bloquer de la meme facon, sans jamais appeler proceedAfterProfile().
  usernameSetupMode = null;
  await dbSet('activeToday:' + dateKey(new Date()), JSON.stringify([]));
  await startApp();
  __assertEq(usernameSetupMode, 'gate', 'un compte deja onboarde mais sans pseudo doit etre bloque au demarrage (verrou "gate")');
  const gateHtmlExisting = document.getElementById('app').innerHTML;
  __assertOk(gateHtmlExisting.includes('Choisis ton pseudo') && !gateHtmlExisting.includes('nav-back-btn'), 'le verrou "gate" doit lui aussi etre infranchissable');

  // Verification de disponibilite en direct (debounce reel de 400ms).
  await usernamesCollRef().doc('alice').set({ uid: 'uid-alice' });
  updateUsernameDraft('alice');
  await new Promise(r => setTimeout(r, 500));
  __assertEq(usernameAvailability, 'taken', 'un pseudo deja reserve doit etre signale "taken" apres verification');
  updateUsernameDraft('unpseudolibre');
  await new Promise(r => setTimeout(r, 500));
  __assertEq(usernameAvailability, 'available', 'un pseudo libre doit etre signale "available" apres verification');

  // finishUsernameSetup() ne doit RIEN faire tant que la disponibilite n est pas confirmee.
  usernameAvailability = 'checking';
  await finishUsernameSetup();
  __assertOk(usernameSetupMode !== null, 'finishUsernameSetup() ne doit rien valider tant que la disponibilite n est pas "available"');

  // Contexte 'gate' : doit reprendre exactement la suite de startApp() (proceedAfterProfile).
  usernameDraft = 'gateduser';
  usernameAvailability = 'available';
  await finishUsernameSetup();
  __assertEq(username, 'gateduser', 'le pseudo doit etre persiste apres validation');
  __assertEq(usernameSetupMode, null, 'le verrou doit se refermer une fois le pseudo valide');
  const gateClaimDoc = await usernamesCollRef().doc('gateduser').get();
  __assertOk(gateClaimDoc.exists && gateClaimDoc.data().uid === currentUser.uid, 'le pseudo doit etre reserve dans usernames/{pseudo}');
  const afterGateHtml = document.getElementById('app').innerHTML;
  __assertOk(!afterGateHtml.includes('Choisis ton pseudo'), 'contexte "gate" : proceedAfterProfile() doit avoir repris la main (retour a l app normale)');

  // Contexte 'onboarding' : doit reprendre exactement la suite de
  // finishProfileOnboarding() (beginOnboardingTransition -> loading puis confirm).
  username = null;
  usernameSetupMode = 'onboarding';
  usernameDraft = 'onboardeduser';
  usernameAvailability = 'available';
  onboardingTransitionPhase = null;
  const finishUsernamePromise = finishUsernameSetup();
  await new Promise(r => setTimeout(r, 300));
  __assertEq(onboardingTransitionPhase, 'loading', 'contexte "onboarding" : doit enchainer sur l ecran de transition (loading)');
  await finishUsernamePromise;
  __assertEq(onboardingTransitionPhase, 'confirm', 'contexte "onboarding" : doit terminer sur l ecran de confirmation, comme un choix de pseudo deja fait');
  __assertEq(username, 'onboardeduser', 'le pseudo du contexte onboarding doit etre persiste');

  // Contexte 'rename' (Parametres) : cree le nouveau pseudo, LIBERE l ancien, ferme
  // simplement l ecran (pas de chainage vers l onboarding/proceedAfterProfile).
  usernameSetupMode = 'rename';
  usernameDraft = 'renameduser';
  usernameAvailability = 'available';
  await finishUsernameSetup();
  __assertEq(username, 'renameduser', 'le renommage doit remplacer le pseudo courant');
  const oldClaimAfterRename = await usernamesCollRef().doc('onboardeduser').get();
  __assertOk(!oldClaimAfterRename.exists, 'l ancien pseudo doit etre libere (supprime de usernames/) apres un renommage');
  const newClaimAfterRename = await usernamesCollRef().doc('renameduser').get();
  __assertOk(newClaimAfterRename.exists, 'le nouveau pseudo doit etre reserve apres un renommage');

  // goBackOneLevel() : seul le mode 'rename' est dismissible.
  usernameSetupMode = 'onboarding';
  goBackOneLevel();
  __assertEq(usernameSetupMode, 'onboarding', 'le verrou "onboarding" ne doit jamais etre dismissible via le bouton retour');
  usernameSetupMode = 'gate';
  goBackOneLevel();
  __assertEq(usernameSetupMode, 'gate', 'le verrou "gate" ne doit jamais etre dismissible via le bouton retour');
  usernameSetupMode = 'rename';
  goBackOneLevel();
  __assertEq(usernameSetupMode, null, 'le mode "rename" (depuis Parametres), lui, doit etre dismissible');

  // Ligne Parametres : affiche le pseudo courant + bouton de modification.
  username = 'monpseudo';
  const settingsHtmlWithUsername = renderSettingsSection();
  __assertOk(settingsHtmlWithUsername.includes('@monpseudo') && settingsHtmlWithUsername.includes('openUsernameRename()'), 'Parametres doit afficher le pseudo courant avec un moyen de le modifier');

  usernameSetupMode = null;
  usernameDraft = '';
  usernameAvailability = null;
  __resetCommunityMocks();
  // Restauration complete (voir commentaire de snapshot ci-dessus).
  userProfile = snap24bis.userProfile;
  customChallenges = snap24bis.customChallenges;
  manualTargetOverrides = snap24bis.manualTargetOverrides;
  streakCount = snap24bis.streakCount;
  lastCompletedDate = snap24bis.lastCompletedDate;
  hasShield = snap24bis.hasShield;
  lastShieldResetWeek = snap24bis.lastShieldResetWeek;
  xpTotal = snap24bis.xpTotal;
  xpWeekly = snap24bis.xpWeekly;
  xpWeekStart = snap24bis.xpWeekStart;
  leaderboardOptOut = snap24bis.leaderboardOptOut;
  voiceCoachEnabled = snap24bis.voiceCoachEnabled;
  hasSeenTour = snap24bis.hasSeenTour;
  lastCompleted = snap24bis.lastCompleted;
  stats = snap24bis.stats;
  badges = snap24bis.badges;
  dailyActivity = snap24bis.dailyActivity;
  weights = snap24bis.weights;
  username = snap24bis.username;
  rebuildChallenges();
  __appDataStore.data = snap24bis.appData;
  __appDataStore.exists = snap24bis.appDataExists;
  console.log('OK: pseudo public obligatoire (sanitisation, verrous nouveau/compte-existant, disponibilite en direct, renommage, dismissible seulement en mode rename)');

  // --- 25. Tour guidé : carte 0 = bienvenue neutre (meme onglet que la carte 1),
  // puis visite des 4 onglets, se marque comme vu ---
  __store.delete('hasSeenTour');
  hasSeenTour = false;
  activeTab = 'today';
  await finishOnboardingTransition();
  __assertEq(guidedTourStep, 0, 'le tour doit demarrer a l etape 0 (carte de bienvenue) si jamais vu');
  __assertEq(GUIDED_TOUR_STEPS.length, 4, 'le tour doit desormais compter 4 cartes (bienvenue + 3 onglets - Journal fusionne dans Profil, plus d etape dediee)');
  let overlay = renderGuidedTourOverlay();
  __assertOk(overlay.includes('Bienvenue dans Défi du Jour !'), 'la carte 0 doit etre une bienvenue neutre dediee');
  __assertOk(overlay.includes('tour-overlay intro'), 'la carte 0 doit avoir le fond assombri/floute (intro)');
  __assertOk(overlay.includes('tour-bubble-avatar') && overlay.includes('kilo-idle'), 'Kilo doit presenter chaque carte du tour guide (retour utilisateur : mascotte tout au long de l onboarding)');
  guidedTourNext(); // carte 0 -> carte 1 : MEME onglet ('today') -> teste le correctif du bug de re-render
  __assertEq(guidedTourStep, 1);
  __assertEq(activeTab, 'today', "la carte 1 (explication de l'accueil) reste sur l onglet Aujourd hui");
  overlay = renderGuidedTourOverlay();
  __assertOk(overlay.includes("Aujourd'hui") && overlay.includes('défis que tu as activés'), 'meme sans changement d onglet, la bulle doit bien se mettre a jour (carte 1)');
  __assertOk(!overlay.includes('tour-overlay intro'), 'des la carte 1, le fond ne doit plus etre assombri/floute');
  guidedTourNext();
  __assertEq(activeTab, 'library', 'l etape suivante doit basculer sur l onglet Défis');
  __assertEq(guidedTourStep, 2);
  guidedTourNext();
  __assertEq(activeTab, 'account', 'puis directement sur Profil (plus d etape Journal separee, fusionnee en sous-onglet)');
  overlay = renderGuidedTourOverlay();
  __assertOk(overlay.includes('Terminer'), 'le dernier bouton doit dire Terminer');
  guidedTourNext(); // termine le tour (endGuidedTour() est async : on laisse la chaine se resoudre)
  __assertEq(guidedTourStep, null, 'le tour doit se terminer (plus d etape active), deja vrai de facon synchrone');
  await new Promise(r => setTimeout(r, 10));
  __assertEq(hasSeenTour, true, 'hasSeenTour doit passer a true');
  __assertEq(__appDataStore.data.hasSeenTour, true, 'hasSeenTour doit etre persiste dans le document consolide appData');
  __assertEq(activeTab, 'today', 'le tour termine doit ramener sur Aujourd hui');
  __assertEq(renderGuidedTourOverlay(), '', 'aucune bulle ne doit plus s afficher apres la fin du tour');
  console.log('OK: tour guidé (4 cartes dont bienvenue dediee, marqué vu, ne se relance pas)');

  // --- 26. Un utilisateur qui a déjà vu le tour ne le revoit pas après l'onboarding ---
  onboardingTransitionPhase = 'confirm';
  guidedTourStep = null;
  await finishOnboardingTransition();
  __assertEq(guidedTourStep, null, 'hasSeenTour=true -> pas de relance automatique du tour');
  console.log('OK: le tour ne se relance pas pour un utilisateur qui l a déjà vu');

  // --- 27. XP : seuils entiers/arrondis en dur, 2 defis Hardcore -> au plus niveau 2/debut niveau 3 ---
  __assertEq(xpForLevel(1), 0, 'niveau 1 = 0 XP');
  __assertEq(xpForLevel(2), 150, 'niveau 2 = 150 XP (seuil rond impose)');
  __assertEq(xpForLevel(3), 350, 'niveau 3 = 350 XP (seuil rond impose)');
  __assertEq(xpForLevel(4), 700, 'niveau 4 = 700 XP (seuil rond impose)');
  __assertEq(xpForLevel(5), 1200, 'niveau 5 = 1200 XP (seuil rond impose)');
  __assertOk(Number.isInteger(xpForLevel(6)) && xpForLevel(6) % 50 === 0, 'les seuils au-dela de la table geree en dur restent des multiples ronds (50/100/250 selon l ordre de grandeur)');
  __assertOk(xpForLevel(48) > xpForLevel(20), 'la progression continue de croitre tres largement au-dela de la table de seuils imposee');
  __assertEq(computeLevel(0), 1, '0 XP -> niveau 1');
  __assertEq(computeLevel(149), 1, '149 XP -> encore niveau 1');
  __assertEq(computeLevel(150), 2, '150 XP -> niveau 2');
  __assertEq(computeLevel(349), 2, 'juste avant le seuil du niveau 3 -> encore niveau 2');
  __assertEq(computeLevel(350), 3, 'au seuil exact -> niveau 3');
  // Le vrai scenario signale : "Niveau 4 apres 2 defis" ne doit plus se produire.
  // Un defi Hardcore rapporte xpForChallenge(...) + HARDCORE_XP_BONUS (~150-225 XP
  // selon l'exercice) ; 2 defis Hardcore doivent plafonner au niveau 2, ou tout
  // debut du niveau 3 (jamais niveau 4 comme avant ce correctif).
  const pompesForXp = CHALLENGE_LIBRARY.find(c => c.name === 'Pompes');
  const xpPerHardcoreChallenge = xpForChallenge(pompesForXp, pompesForXp.target) + HARDCORE_XP_BONUS;
  const levelAfterTwoHardcore = computeLevel(xpPerHardcoreChallenge * 2);
  __assertOk(levelAfterTwoHardcore <= 3, '2 defis Hardcore ne doivent plus amener au-dela du niveau 3 (avant : niveau 4 des 2 defis)');
  __assertOk(levelAfterTwoHardcore >= 2, '2 defis Hardcore doivent tout de meme faire progresser d au moins un niveau');
  __assertEq(athleteTitle(1), 'Recrue 🥉');
  __assertEq(athleteTitle(5), 'Recrue 🥉');
  __assertEq(athleteTitle(6), 'Initié 🎖️');
  __assertEq(athleteTitle(10), 'Initié 🎖️');
  __assertEq(athleteTitle(11), 'Motivé 🥈');
  __assertEq(athleteTitle(15), 'Motivé 🥈');
  __assertEq(athleteTitle(16), 'Régulier 📅');
  __assertEq(athleteTitle(20), 'Régulier 📅');
  __assertEq(athleteTitle(21), 'Athlète 🥇');
  __assertEq(athleteTitle(26), 'Athlète 🥇');
  __assertEq(athleteTitle(27), 'Guerrier ⚔️');
  __assertEq(athleteTitle(32), 'Guerrier ⚔️');
  __assertEq(athleteTitle(33), 'Expert ⚡');
  __assertEq(athleteTitle(38), 'Expert ⚡');
  __assertEq(athleteTitle(39), 'Titan 🏆');
  __assertEq(athleteTitle(43), 'Titan 🏆');
  __assertEq(athleteTitle(44), 'Demi-Dieu 🌌');
  __assertEq(athleteTitle(47), 'Demi-Dieu 🌌');
  __assertEq(athleteTitle(48), 'Légende Immortelle 👑');
  __assertEq(athleteTitle(999), 'Légende Immortelle 👑', 'le titre plafonne au dernier palier au-dela');
  console.log('OK: seuils XP ronds/entiers en dur (150/350/700/1200...), 2 defis Hardcore <= niveau 3, 10 titres d athlete');

  // --- 28. Gain d'XP a la validation d'un defi (popup immersive avec carte XP) ---
  xpTotal = 0;
  await saveXp();
  popupQueue = []; popupOpen = false;
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  dailyActivity = { [todayKey]: 1 }; // pas la 1ere validation du jour : isole ce test du systeme de serie
  const cForXp = getChallenge();
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: cForXp.target, date: todayKey }, recordStreak: 0 }; // evite le chemin "nouveau record"
  const expectedXp = xpForChallenge(cForXp, cForXp.target);
  await addSet(cForXp.target);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  __assertEq(xpTotal, expectedXp, 'xpTotal doit augmenter du montant calcule par xpForChallenge');
  __assertEq(__appDataStore.data.xpTotal, expectedXp, 'xpTotal doit etre persiste dans le document consolide appData');
  __assertOk(popupOpen, 'une popup immersive doit s afficher immediatement a la validation');
  __assertOk(currentPopupHtml.includes('Défi complété'), 'la popup doit annoncer la completion du defi');
  __assertOk(currentPopupHtml.includes('+' + expectedXp + ' XP'), 'la popup doit afficher la carte XP gagnee');
  __assertOk(currentPopupHtml.includes('kilo-success'), 'la mascotte Kilo (etat success) doit accompagner la validation d un defi');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: XP attribue (+' + expectedXp + ') et popup immersive (carte XP + Kilo) affichee a la validation d un defi');

  // Retour utilisateur "effet waouh" : une petite salve de confettis LOCALISEE
  // (pas l ecran plein, reserve aux vrais grands moments) doit accompagner
  // l atteinte de l objectif du jour, une seule fois (jamais rejouee sur un
  // re-rendu ulterieur du meme etat "termine").
  __assertOk(document.getElementById('app').innerHTML.includes('exercise-mini-confetti'), 'une petite salve de confettis localisee doit accompagner l atteinte de l objectif du jour');
  render(false);
  __assertOk(!document.getElementById('app').innerHTML.includes('exercise-mini-confetti'), 'un re-rendu ulterieur du meme etat termine ne doit jamais rejouer la salve de confettis');
  console.log('OK: mini confettis localises a l atteinte de l objectif du jour (jamais rejoues sur un re-rendu ulterieur)');
  currentChallengeId = null;

  // --- 29. Serie quotidienne : 1ere validation du jour incremente le streak ; la popup de
  // serie s'affiche APRES celle de completion (elle est enfilee derriere, 900ms plus tard) ---
  // reset defensif : d'anciens addSet() (tests precedents) ont pu programmer un popup differe
  // (setTimeout 900ms) qui a le temps de se declencher entretemps et de polluer la file.
  popupQueue = []; popupOpen = false;
  streakCount = 0; lastCompletedDate = null; hasShield = true; lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  xpTotal = 5000; await saveXp(); // loin de tout seuil de niveau : isole ce test d'une popup Level Up qui s'intercalerait sinon entre la popup de completion et celle de serie
  dailyActivity = {}; // aucune validation aujourd'hui : la prochaine sera la 1ere
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  const cForStreak = getChallenge();
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: cForStreak.target, date: todayKey }, recordStreak: 0 };
  __resetAppDataSetCallCount();
  __resetLeaderboardSetCallCount();
  await addSet(cForStreak.target);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  // Optimisation quota Firestore : cette 1ere validation du jour touche stats/
  // lastCompleted/dailyActivity/badges/xpTotal/xpWeeklyData/streakData (7 champs) ET
  // appelle syncLeaderboardEntry() 2 fois (awardXp() + registerDailyStreak()) - un seul
  // ecrit Firestore doit resulter de chaque groupe (regroupement/deduplication, voir
  // beginAppDataBatch()/pendingLeaderboardSync dans index.html), jamais 7+2.
  __assertEq(__appDataSetCallCount, 1, 'une completion qui touche 7 champs du document consolide ne doit produire qu UNE SEULE ecriture Firestore (regroupement)');
  __assertEq(__leaderboardSetCallCount, 1, 'awardXp() et registerDailyStreak() appellent tous deux syncLeaderboardEntry() pour le meme evenement : une seule ecriture reelle doit en resulter (deduplication)');
  __assertEq(streakCount, 1, 'la 1ere validation du jour doit porter la serie a 1');
  __assertEq(lastCompletedDate, todayKey, 'lastCompletedDate doit passer a aujourd hui');
  __assertEq(__appDataStore.data.streakData.streakCount, 1, 'streakCount doit etre persiste dans le document consolide appData');
  __assertOk(popupOpen, 'la popup de completion doit s afficher immediatement');
  __assertOk(currentPopupHtml.includes('Défi complété'), 'la 1ere popup affichee doit etre celle de completion');
  document.getElementById('appPopupCloseBtn').onclick(); // ferme la popup de completion
  await new Promise(r => setTimeout(r, 950)); // laisse le temps a la popup de serie (differee 900ms) d etre enfilee puis affichee
  __assertOk(popupOpen, 'le popup de serie doit s afficher a son tour apres la popup de completion');
  __assertOk(currentPopupHtml.includes('+1 Jour de série'), 'le popup doit annoncer +1 jour de serie');
  __assertOk(currentPopupHtml.includes("d'affilée"), 'le popup doit afficher le decompte de la serie');
  document.getElementById('appPopupCloseBtn').onclick(); // simule le clic sur "Continuer"
  __assertOk(!popupOpen, 'le popup doit se fermer apres le clic sur Continuer');
  currentChallengeId = null;
  console.log('OK: 1ere validation du jour -> popup completion puis popup de serie (Duolingo), toutes deux fermables');

  // --- 30. Bouclier : un jour manque (gap >= 2) avec bouclier disponible sauve la serie ---
  streakCount = 5;
  const threeDaysAgoA = new Date(); threeDaysAgoA.setDate(threeDaysAgoA.getDate() - 3);
  lastCompletedDate = dateKey(threeDaysAgoA);
  hasShield = true;
  lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  popupQueue = []; popupOpen = false;
  await evaluateStreakOnLoad();
  __assertEq(streakCount, 5, 'le bouclier doit preserver la serie (pas de reset)');
  __assertEq(hasShield, false, 'le bouclier doit etre consomme');
  __assertOk(popupOpen, 'le popup Bouclier active doit s afficher');
  __assertOk(currentPopupHtml.includes('Bouclier activé'), 'titre du popup bouclier');
  __assertOk(currentPopupHtml.includes('sauvé la série'), 'texte exact du popup bouclier');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: bouclier disponible sauve la serie apres un jour manque + popup affiche');

  // --- 31. Sans bouclier, un jour manque (gap >= 2) remet la serie a 0 ---
  streakCount = 5;
  const threeDaysAgoB = new Date(); threeDaysAgoB.setDate(threeDaysAgoB.getDate() - 3);
  lastCompletedDate = dateKey(threeDaysAgoB);
  hasShield = false;
  lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  popupQueue = []; popupOpen = false;
  await evaluateStreakOnLoad();
  __assertEq(streakCount, 0, 'sans bouclier, un jour manque doit remettre la serie a 0');
  // Retour utilisateur "effet waouh" (mascotte Kilo) : bug reel signale - avant ce
  // correctif, une serie perdue sans bouclier disponible etait totalement
  // SILENCIEUSE (aucun popup bouclier, MAIS aucun autre signal non plus). Kilo en
  // etat 'lost' comble ce trou.
  __assertOk(popupOpen, 'un popup doit desormais signaler la serie perdue (Kilo en etat lost), meme sans bouclier');
  __assertOk(currentPopupHtml.includes(t('popups.streakLost.title')), 'titre du popup serie perdue');
  __assertOk(currentPopupHtml.includes('kilo-lost'), 'la mascotte Kilo doit apparaitre en etat "lost" (triste) dans ce popup');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: sans bouclier disponible, la serie retombe a 0 apres un jour manque + Kilo (lost) signale la perte (bug reel corrige : c etait silencieux avant)');

  // --- 32. Hier (gap = 1) : la serie est maintenue sans intervention ---
  streakCount = 4;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  lastCompletedDate = dateKey(yesterday);
  hasShield = true;
  lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  popupQueue = []; popupOpen = false;
  await evaluateStreakOnLoad();
  __assertEq(streakCount, 4, 'un gap de 1 jour (hier) ne doit pas toucher la serie');
  __assertEq(hasShield, true, 'le bouclier ne doit pas etre consomme pour un gap de 1 jour');
  __assertOk(!popupOpen, 'aucun popup ne doit s afficher quand la serie est simplement maintenue');
  console.log('OK: un gap d un jour (hier) maintient la serie sans consommer le bouclier');

  // --- 33. Le bouclier se recharge automatiquement au debut de chaque semaine ---
  hasShield = false;
  const oldWeek = new Date(); oldWeek.setDate(oldWeek.getDate() - 9); // semaine precedente
  lastShieldResetWeek = mondayOfWeek(oldWeek);
  streakCount = 0;
  lastCompletedDate = null;
  await saveStreakData();
  await evaluateStreakOnLoad();
  __assertEq(hasShield, true, 'le bouclier doit se recharger automatiquement sur une nouvelle semaine');
  __assertEq(lastShieldResetWeek, mondayOfWeek(new Date()), 'lastShieldResetWeek doit etre mis a jour a la semaine courante');
  console.log('OK: le bouclier se recharge automatiquement 1x/semaine');

  // --- 34. Coach vocal : toggle + persistance + speak() respecte le toggle ---
  voiceCoachEnabled = true;
  await saveVoiceCoachEnabled();
  __spokenLog.length = 0;
  speak('test actif');
  __assertEq(__spokenLog[__spokenLog.length - 1], 'test actif', 'speak() doit parler quand le coach vocal est actif');
  await toggleVoiceCoach();
  __assertEq(voiceCoachEnabled, false, 'toggleVoiceCoach doit inverser l etat');
  __assertEq(__appDataStore.data.voiceCoachEnabled, false, 'le nouvel etat doit etre persiste dans le document consolide appData');
  __spokenLog.length = 0;
  speak('ne doit pas parler');
  __assertEq(__spokenLog.length, 0, 'speak() ne doit rien dire quand le coach vocal est desactive');
  await toggleVoiceCoach();
  __assertEq(voiceCoachEnabled, true, 'un second toggle doit reactiver');
  console.log('OK: coach vocal (toggle persiste, speak() respecte le toggle)');

  // Retour utilisateur "effet waouh" : playSuccessSound() (deja existante,
  // jouait JUSQU'ICI de facon INCONDITIONNELLE a chaque completion, sans aucun
  // moyen de la couper) devient enfin OPTIONNELLE. Decouverte en cours de route :
  // la demande initiale supposait qu'aucun son n'existait encore - defaut choisi
  // en consequence : ACTIVE par defaut (ne coupe rien silencieusement chez les
  // utilisateurs existants qui l'entendent deja), la vraie nouveaute est de
  // pouvoir la desactiver.
  __assertEq(soundEffectsEnabled, true, 'le son de reussite (deja existant) doit rester ACTIVE par defaut - ne pas couper silencieusement un comportement deja en place');
  let audioPlayCalls = [];
  const originalAudio = window.Audio;
  window.Audio = function (src) { audioPlayCalls.push(src); this.play = () => Promise.resolve(); };
  playSuccessSound();
  __assertEq(audioPlayCalls, ['./assets/sounds/success.mp3'], 'par defaut (active), playSuccessSound() doit jouer le vrai fichier audio enregistre (plus de synthese Web Audio)');
  await toggleSoundEffects();
  __assertEq(soundEffectsEnabled, false, 'toggleSoundEffects doit inverser l etat');
  __assertEq(__appDataStore.data.soundEffectsEnabled, false, 'le nouvel etat doit etre persiste dans le document consolide appData');
  __assertEq(audioPlayCalls.length, 1, 'desactiver le reglage ne doit jouer aucun apercu (rien a previsualiser en le coupant)');
  playSuccessSound();
  __assertEq(audioPlayCalls.length, 1, 'une fois desactive, playSuccessSound() ne doit plus jouer aucun son');
  await toggleSoundEffects();
  __assertEq(soundEffectsEnabled, true, 'un second toggle doit reactiver');
  __assertEq(audioPlayCalls.length, 2, 'reactiver le reglage doit jouer un apercu immediat du son');
  window.Audio = originalAudio;
  const settingsHtmlSound = renderSettingsSection();
  __assertOk(settingsHtmlSound.includes('onclick="toggleSoundEffects()"'), 'le reglage doit etre visible dans Parametres');
  console.log('OK: son de reussite (fichier audio reel .mp3, plus de synthese Web Audio) rendu optionnel - actif par defaut, desactivable, apercu immediat a la reactivation');

  // Retour utilisateur "effet waouh" : mascotte "Kilo" (halterophile humanise),
  // composant SVG reutilisable a 6 etats (idle/success/warning/beer/lost/level_up).
  // Refonte visuelle (2e ronde) : traces repris directement d'une reference
  // validee par l'utilisateur plutot que d'une geometrie unique parametree par
  // angle - donc plus de couleur/etat partages via une constante commune
  // (KILO_NEON/KILO_DULL n'existent plus), chaque etat porte ses propres
  // couleurs litterales.
  for (const kiloState of ['idle', 'success', 'warning', 'beer', 'lost', 'level_up']) {
    const svg = renderKilo(kiloState);
    __assertOk(svg.includes('kilo-' + kiloState), 'renderKilo(\\'' + kiloState + '\\') doit porter la classe kilo-' + kiloState);
    __assertOk(svg.includes('<svg') && svg.includes('</svg>'), 'renderKilo(\\'' + kiloState + '\\') doit produire un SVG complet');
  }
  __assertOk(renderKilo('success').includes('kilo-spark'), 'l etat success doit afficher des etincelles');
  __assertOk(!renderKilo('idle').includes('kilo-spark'), 'les autres etats ne doivent jamais afficher d etincelles');
  __assertOk(renderKilo('warning').includes('kilo-sweat'), 'l etat warning doit afficher une goutte de sueur');
  __assertOk(renderKilo('beer').includes('kilo-arm-cheers'), 'l etat beer doit avoir un bras qui trinque (groupe anime bras+choppe)');
  __assertOk(renderKilo('beer').includes('kilo-mug-clink'), 'l etat beer doit avoir une choppe (groupe anime dedie)');
  __assertOk(renderKilo('lost').includes('#64748b'), 'l etat lost doit utiliser la couleur terne (gris rouille), pas le cyan neon habituel');
  __assertOk(!renderKilo('idle').includes('#64748b') && renderKilo('idle').includes('#06b6d4'), 'les autres etats doivent garder le cyan neon habituel');
  __assertOk(renderKilo('level_up').includes('kilo-trophy') && renderKilo('level_up').includes('kilo-trophy-pump'), 'l etat level_up doit brandir un trophee (avec sa propre boucle d animation)');
  __assertOk(renderKilo('idle', { clickable: true }).includes('onclick="kiloTap(this)"'), 'clickable:true doit poser le gestionnaire de tap');
  __assertOk(!renderKilo('idle').includes('onclick="kiloTap'), 'sans clickable, aucun gestionnaire de tap ne doit etre pose (ex: dans un popup deja fermable autrement)');
  console.log('OK: mascotte Kilo (6 etats distincts, etincelles/sueur/couleur ternie/trophee selon l etat, tap optionnel)');

  // Bugs reels signales : Kilito n etait ni assez visible sur l accueil, ni centre
  // horizontalement dans les popups (SVG en display:block, ignore le text-align du
  // popup contrairement aux icones emoji).
  __assertOk(__rawHtml.includes("renderKilo(kiloHomeMood, { size: 72 })"), 'Kilito doit etre nettement plus grand sur l accueil (etait a peine visible a 44px)');
  __assertOk(__rawHtml.includes("renderKilo(next.kiloState, { size: 118, clickable: true })"), 'Kilito doit aussi etre agrandi dans les popups');
  __assertOk(cssText.includes('.app-popup-icon.kilo-icon') && cssText.includes('justify-content: center'), 'Kilito doit etre explicitement centre horizontalement dans les popups (un SVG display:block ignore le text-align du parent)');
  console.log('OK: Kilito agrandi sur l accueil + dans les popups, et correctement centre (bugs reels corriges)');

  // computeKiloMood() : moteur d'humeur global de l'accueil (chantier
  // gamification Phase 2) - remplace l'ancien computeKiloHomeState(). Fonction
  // PURE (toutes les donnees temporelles/derivees sont des parametres, jamais
  // new Date()/Date.now() lu en interne) pour rester testable de facon
  // deterministe.
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 20 }), 'idle', 'aucun defi actif -> idle, meme tard le soir (rien a reprocher)');
  __assertEq(computeKiloMood({ activeIds: [1], stateChallenges: {}, hour: 20 }), 'warning', 'un seul defi actif non valide + 18h passees -> warning (0% valide, largement sous la moitie)');
  __assertEq(computeKiloMood({ activeIds: [1], stateChallenges: {}, hour: 14 }), 'idle', 'un defi actif non valide mais AVANT 18h -> idle (pas encore urgent)');
  __assertEq(computeKiloMood({ activeIds: [1], stateChallenges: { 1: { done: true } }, hour: 20 }), 'idle', 'defi actif deja valide -> idle, meme apres 18h');
  __assertEq(computeKiloMood({ activeIds: [1, 2], stateChallenges: { 1: { done: true }, 2: { done: false } }, hour: 20 }), 'idle', 'retour utilisateur : la moitie des defis actifs deja valides ne doit PLUS stresser (contrairement a l ancien comportement "un seul non fait suffit")');
  __assertEq(computeKiloMood({ activeIds: [1, 2, 3], stateChallenges: { 1: { done: true }, 2: { done: false }, 3: { done: false } }, hour: 20 }), 'warning', 'moins de la moitie des defis actifs valides (1/3) -> warning');
  console.log('OK: computeKiloMood() - warning (18h, cote personnel, ratio "moins de la moitie" plutot que "un seul non fait")');

  // Priorite : 'teasing' (inactivite >= 2 jours) domine tout le reste - le
  // signal le plus fort, documente explicitement dans le code.
  __assertEq(computeKiloMood({ activeIds: [1], stateChallenges: {}, hour: 20, daysSinceLastActivity: 2 }), 'teasing', 'inactivite >= 2 jours doit dominer meme un retard personnel evident');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, daysSinceLastActivity: 3 }), 'teasing', 'inactivite declenchee meme sans aucun defi actif ni en fin de journee');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, daysSinceLastActivity: 1 }), 'idle', '1 seul jour d ecart ne doit pas encore declencher teasing (seuil >= 2)');
  console.log('OK: computeKiloMood() - teasing (inactivite >= 2 jours, priorite maximale)');

  // Priorite : 'hype' (juste sous teasing) - grosse serie venant d etre loguee
  // (ephemere) OU palier de serie de 7 jours.
  __assertEq(computeKiloMood({ activeIds: [1], stateChallenges: {}, hour: 20, justLoggedHugeSet: true }), 'hype', 'une enorme serie qui vient d etre loguee doit declencher hype, meme en pleine situation de retard personnel');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, streakCount: 7 }), 'hype', 'un palier de serie de 7 jours doit declencher hype');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, streakCount: 14 }), 'hype', 'chaque multiple de 7 jours declenche de nouveau hype');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, streakCount: 8 }), 'idle', 'une serie hors palier (8 jours) ne declenche pas hype');
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 10, streakCount: 7, daysSinceLastActivity: 2 }), 'teasing', 'teasing (inactivite) doit dominer un palier de serie - priorite documentee dans le code');
  console.log('OK: computeKiloMood() - hype (grosse serie venant d etre loguee OU palier de serie de 7 jours, priorite sous teasing)');

  // Retard cote defi de GROUPE (nouvelle donnee, myActiveGroupChallenges enrichi
  // de endDate/currentTotal - voir refreshMyGroupsAndActiveChallenges()).
  const nowForGroupTest = Date.now();
  const groupLateSoonBehind = [{ endDate: nowForGroupTest + 10 * 3600000, targetTotal: 100, currentTotal: 20 }]; // 10h restantes, 20% atteint
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 20, groupChallenges: groupLateSoonBehind, nowMs: nowForGroupTest }), 'warning', 'un defi de groupe a moins de 24h de son echeance et loin de la cible (< 70%) doit declencher warning, meme sans aucun defi personnel actif');
  const groupPlentyOfTime = [{ endDate: nowForGroupTest + 5 * 86400000, targetTotal: 100, currentTotal: 20 }]; // 5 jours restants
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 20, groupChallenges: groupPlentyOfTime, nowMs: nowForGroupTest }), 'idle', 'un defi de groupe loin de la cible mais avec largement le temps (5 jours) ne doit pas stresser');
  const groupAlmostDoneNearDeadline = [{ endDate: nowForGroupTest + 10 * 3600000, targetTotal: 100, currentTotal: 80 }]; // 80% atteint
  __assertEq(computeKiloMood({ activeIds: [], stateChallenges: {}, hour: 20, groupChallenges: groupAlmostDoneNearDeadline, nowMs: nowForGroupTest }), 'idle', 'un defi de groupe proche de l echeance mais deja bien avance (>= 70%) ne doit pas stresser');
  console.log('OK: computeKiloMood() - warning declenche aussi par un defi de GROUPE proche de son echeance et loin de la cible collective');

  // computeDaysSinceLastActivity() : petit helper reutilisable extrait du calcul
  // deja fait en interne par evaluateStreakOnLoad() pour la perte de serie.
  __assertEq(computeDaysSinceLastActivity(null, '2026-01-10'), 0, 'aucune activite jamais enregistree -> 0 (jamais traite comme inactif, compte tout neuf)');
  __assertEq(computeDaysSinceLastActivity('2026-01-10', '2026-01-10'), 0, 'activite aujourd hui meme -> 0');
  __assertEq(computeDaysSinceLastActivity('2026-01-08', '2026-01-10'), 2, 'ecart de 2 jours calcule correctement');
  console.log('OK: computeDaysSinceLastActivity() (repli a 0 si jamais actif, reutilise daysBetween())');

  // Les 2 nouveaux etats SVG (chantier gamification Phase 2, dessines a la main
  // dans le meme style que les 6 existants).
  for (const kiloState of ['hype', 'teasing']) {
    const svg = renderKilo(kiloState);
    __assertOk(svg.includes('kilo-' + kiloState), 'renderKilo(\\'' + kiloState + '\\') doit porter la classe kilo-' + kiloState);
    __assertOk(svg.includes('<svg') && svg.includes('</svg>'), 'renderKilo(\\'' + kiloState + '\\') doit produire un SVG complet');
  }
  __assertOk(renderKilo('hype').includes('kilo-lightning'), '"Full Muscu / Eclairs" doit afficher des eclairs (groupes animes dedies)');
  __assertOk(renderKilo('teasing').includes('kilo-foot-tap'), '"Taquin / Decu" doit afficher un pied qui tape du sol (groupe anime dedie)');
  __assertOk(renderKilo('teasing').includes('#06b6d4') && !renderKilo('teasing').includes('#64748b'), '"Taquin" doit rester dans les couleurs habituelles de Kilo (cyan), distinct de "lost" (triste/grise)');
  console.log('OK: 2 nouveaux etats SVG "hype" (Full Muscu/Eclairs) et "teasing" (Taquin/Decu), dessines a la main comme les 6 existants');

  // Integration : Kilo doit apparaitre sur l accueil.
  activeTab = 'today';
  currentChallengeId = null;
  activeToday = new Set([pompes.id]);
  state = emptyDayState();
  render(false);
  __assertOk(document.getElementById('app').innerHTML.includes('kilo-home-slot'), 'Kilo doit apparaitre dans l en-tete de l accueil');
  console.log('OK: Kilo integre dans l en-tete de l accueil (idle/warning selon l heure et l avancement du jour)');

  // Bulle d'accueil (chantier gamification Phase 2) : doit afficher une replique
  // valide pour l humeur affichee, et NE PAS changer sur un re-rendu qui ne
  // change pas l humeur (evite le clignotement/re-randomisation). Etat remis a
  // zero explicitement pour garantir 'idle' quelle que soit l heure REELLE
  // d execution des tests (computeKiloMood() lit today.getHours() en interne
  // dans render(), non mockable ici) - aucun defi actif = 'idle' garanti.
  streakCount = 0;
  lastCompletedDate = todayKey;
  kiloHomeHugeSetUntil = 0;
  myActiveGroupChallenges = [];
  activeToday = new Set();
  currentChallengeId = null;
  kiloHomeBubbleMood = null;
  render(false);
  let kiloHomeAppHtml = document.getElementById('app').innerHTML;
  __assertEq(kiloHomeBubbleMood, 'idle', 'pre-requis : aucun defi actif doit garantir l humeur idle, independamment de l heure reelle');
  __assertOk(kiloHomeAppHtml.includes('kilo-home-bubble'), 'une bulle doit accompagner Kilo sur l accueil');
  const firstHomeBubbleText = kiloHomeBubbleText;
  const idleVariants = t('kilo.home.idle').map((v) => interpolate(v, {}));
  __assertOk(idleVariants.includes(firstHomeBubbleText), 'le texte affiche doit correspondre a une variante valide de l humeur idle');
  render(false); // re-rendu sans rapport : l humeur n a pas change -> le texte ne doit pas bouger
  __assertEq(kiloHomeBubbleText, firstHomeBubbleText, 'la bulle ne doit pas se re-randomiser sur un re-rendu qui ne change pas l humeur');
  console.log('OK: bulle d accueil de Kilo (replique valide pour l humeur actuelle, stable tant que l humeur ne change pas)');

  // Tap sur Kilo (accueil, "effet Tamagotchi") : rebond (classe .tapped,
  // pilotee par horodatage - jamais une manipulation DOM directe, voir
  // kiloHomeTap()) + nouvelle phrase d encouragement dans la bulle, par-dessus
  // l humeur affichee.
  kiloHomeTap();
  kiloHomeAppHtml = document.getElementById('app').innerHTML;
  const kiloSlotIdxHome = kiloHomeAppHtml.indexOf('kilo-home-slot');
  __assertOk(kiloHomeAppHtml.slice(kiloSlotIdxHome, kiloSlotIdxHome + 60).includes('tapped'), 'le tap doit declencher le rebond (classe .tapped)');
  const tapEncouragementVariants = t('kilo.home.tapEncouragement').map((v) => interpolate(v, {}));
  __assertOk(tapEncouragementVariants.includes(kiloHomeBubbleText), 'le tap doit afficher une phrase d encouragement aleatoire dans la bulle');
  kiloHomeTapBounceUntil = 0; // simule l expiration du rebond (sans attendre reellement 400ms)
  render(false);
  kiloHomeAppHtml = document.getElementById('app').innerHTML;
  const kiloSlotIdxHomeAfter = kiloHomeAppHtml.indexOf('kilo-home-slot');
  __assertOk(!kiloHomeAppHtml.slice(kiloSlotIdxHomeAfter, kiloSlotIdxHomeAfter + 60).includes('tapped'), 'le rebond doit disparaitre une fois expire');
  console.log('OK: tap sur Kilo (accueil) declenche le rebond + une phrase d encouragement aleatoire dans la bulle');

  // --- 35. Compte a rebours de preparation : 3, 2, 1, puis "C'est parti !" et demarrage reel du chrono ---
  voiceCoachEnabled = true;
  __spokenLog.length = 0;
  state = emptyDayState();
  customChallenges.push({ id: 9003, cat: 'Gainage', name: 'Planche test', target: 30, unit: 'sec', hardcoreTarget: 60, isCustom: true });
  rebuildChallenges();
  activeToday = new Set([9003]);
  await pickChallenge(9003);
  __assertEq(timerRunning, false, 'le chrono ne doit pas etre lance avant la fin du compte a rebours');
  beginPrepCountdown();
  __assertEq(prepCountdownValue, 3, 'le compte a rebours doit demarrer a 3');
  __assertEq(__spokenLog[__spokenLog.length - 1], '3', 'le coach vocal doit annoncer 3');
  await new Promise(r => setTimeout(r, 1100));
  __assertEq(prepCountdownValue, 2, 'apres ~1s, le compte a rebours doit afficher 2');
  __assertEq(__spokenLog[__spokenLog.length - 1], '2', 'le coach vocal doit annoncer 2');
  await new Promise(r => setTimeout(r, 1100));
  __assertEq(prepCountdownValue, 1, 'apres ~2s, le compte a rebours doit afficher 1');
  __assertEq(__spokenLog[__spokenLog.length - 1], '1', 'le coach vocal doit annoncer 1');
  await new Promise(r => setTimeout(r, 1100));
  __assertEq(prepCountdownValue, null, 'le compte a rebours doit disparaitre une fois termine');
  __assertEq(timerRunning, true, 'le chrono reel doit demarrer une fois le compte a rebours termine');
  __assertEq(__spokenLog[__spokenLog.length - 1], "C'est parti !", 'le coach vocal doit annoncer C est parti a la fin');
  clearTimerState();
  console.log('OK: compte a rebours de preparation (3-2-1 + voix) puis demarrage reel du chrono');

  // --- 36. Annonces vocales de fin de defi (approche + atteinte de l objectif) ---
  voiceCoachEnabled = true;
  state = emptyDayState();
  await pickChallenge(9003); // Planche test, target=30 sec
  lastVoiceCueSecond = null;
  __spokenLog.length = 0;
  announceTimerVoiceCues(27); // reste 3s
  __assertEq(__spokenLog[__spokenLog.length - 1], '3', 'a 3s de la fin, le coach doit annoncer 3');
  announceTimerVoiceCues(27); // meme seconde restante : ne doit pas re-annoncer
  __assertEq(__spokenLog.length, 1, 'la meme seconde restante ne doit pas etre re-annoncee');
  announceTimerVoiceCues(28); // reste 2s
  __assertEq(__spokenLog[__spokenLog.length - 1], '2');
  announceTimerVoiceCues(29); // reste 1s
  __assertEq(__spokenLog[__spokenLog.length - 1], '1');
  announceTimerVoiceCues(30); // objectif atteint
  __assertEq(__spokenLog[__spokenLog.length - 1], 'Défi terminé ! Bravo !', 'objectif atteint -> annonce de fin');
  announceTimerVoiceCues(31); // ne doit pas re-annoncer la fin en boucle
  __assertEq(__spokenLog[__spokenLog.length - 1], 'Défi terminé ! Bravo !');
  __assertEq(__spokenLog.filter(s => s === 'Défi terminé ! Bravo !').length, 1, 'l annonce de fin ne doit se produire qu une seule fois');
  currentChallengeId = null;
  console.log('OK: annonces vocales 3-2-1 puis Défi terminé a l approche/atteinte de l objectif');

  // --- 37. Onglet Profil : carte athlete cliquable (niveau/titre/XP) + parametre coach vocal
  // + reorganisation demandee (Compte et Parametres tout en bas, apres athlete+trophees) ---
  xpTotal = 320;
  streakCount = 6; hasShield = true;
  const athleteHtml = renderAthleteCard();
  __assertOk(athleteHtml.includes('Niveau'), 'la carte doit afficher le niveau');
  __assertOk(!athleteHtml.includes('🔥 6 j'), 'la serie ne doit plus etre affichee dans la carte XP (deplacee dans l en-tete Profil)');
  __assertOk(athleteHtml.includes('XP'), 'la carte doit afficher la progression XP');
  __assertOk(athleteHtml.includes('onclick="openLevelRoadmap()"'), 'la carte athlete doit etre cliquable (parcours de niveau)');
  voiceCoachEnabled = true;
  let settingsHtml = renderSettingsSection();
  __assertOk(settingsHtml.includes('Coach vocal'), 'la section parametres doit proposer le coach vocal');
  // Isole le bloc du switch Coach vocal (une autre ligne de reglages, le classement
  // communautaire, utilise aussi la classe .switch juste apres dans le meme HTML) :
  // du label Coach vocal jusqu au prochain settings-row-label (debut de la ligne suivante).
  function extractVoiceRow(html) {
    const start = html.indexOf('Coach vocal');
    const nextRow = html.indexOf('settings-row-label', start + 1);
    return html.slice(start, nextRow === -1 ? html.length : nextRow);
  }
  let voiceRowHtml = extractVoiceRow(settingsHtml);
  __assertOk(voiceRowHtml.includes('switch on'), 'le switch doit apparaitre actif quand voiceCoachEnabled=true');
  voiceCoachEnabled = false;
  settingsHtml = renderSettingsSection();
  voiceRowHtml = extractVoiceRow(settingsHtml);
  __assertOk(!voiceRowHtml.includes('switch on'), 'le switch ne doit pas apparaitre actif quand voiceCoachEnabled=false');
  voiceCoachEnabled = true;

  // Retour utilisateur : le switch manuel "Notifications push" de Parametres a
  // ete retire (doublon confus avec la popup systeme native de permission -
  // seul Notification.permission fait desormais foi). Verifie qu il n apparait
  // plus DANS AUCUN cas (support inconnu/non supporte/supporte), et que les
  // fonctions dediees a ce switch (desormais sans plus aucun appelant) ont bien
  // disparu du code plutot que d etre laissees mortes.
  const pushSupportedBefore = pushNotificationsSupported;
  for (const supportState of [null, false, true]) {
    pushNotificationsSupported = supportState;
    const html = renderSettingsSection();
    __assertOk(!html.includes('Notifications push') && !html.includes('Push notifications') && !html.includes('Notificaciones push'), 'le reglage push (toutes langues) ne doit plus jamais apparaitre dans Parametres, quel que soit le support (' + supportState + ')');
    __assertOk(!html.includes('togglePushNotifications'), 'aucun toggle push ne doit plus etre propose');
  }
  pushNotificationsSupported = pushSupportedBefore;
  __assertOk(typeof togglePushNotifications === 'undefined', 'togglePushNotifications() doit avoir ete entierement retiree (plus aucun appelant)');
  __assertOk(typeof disablePushNotifications === 'undefined', 'disablePushNotifications() doit avoir ete entierement retiree (plus aucun appelant)');
  __assertOk(typeof isPushNotificationsEnabledOnThisDevice === 'undefined', 'isPushNotificationsEnabledOnThisDevice() doit avoir ete entierement retiree (plus aucun appelant)');
  console.log('OK: reglage "Notifications push" retire de Parametres (doublon avec la permission systeme native), fonctions mortes nettoyees');

  // Retour utilisateur explicite : redemander la permission a CHAQUE demarrage
  // tant que l utilisateur n a pas encore tranche (comme la plupart des grandes
  // apps), jamais si deja acceptee (inutile) ni si deja refusee (le navigateur
  // ignore silencieusement toute nouvelle demande une fois 'denied' - aucun
  // moyen cote code de re-afficher le prompt natif dans ce cas).
  __assertEq(shouldAutoPromptPushNotifications(true, 'default'), true, 'support confirme + aucune decision prise -> redemander');
  __assertEq(shouldAutoPromptPushNotifications(true, 'granted'), false, 'deja accepte -> ne rien redemander');
  __assertEq(shouldAutoPromptPushNotifications(true, 'denied'), false, 'deja refuse -> ne jamais retenter (le navigateur l ignorerait de toute facon)');
  __assertEq(shouldAutoPromptPushNotifications(false, 'default'), false, 'navigateur non supporte -> ne jamais demander, quelle que soit la permission');
  __assertEq(shouldAutoPromptPushNotifications(null, 'default'), false, 'support pas encore determine -> ne pas demander avant de savoir');
  console.log('OK: shouldAutoPromptPushNotifications() (redemande a chaque demarrage tant qu aucune decision n a ete prise, jamais si deja tranche)');

  // Regression du bug reel signale par l utilisateur : un token FCM peut
  // devenir invalide (ex: "Forcer la mise a jour de l appli" desinscrit le
  // service worker) sans que Notification.permission ne change - la Cloud
  // Function supprime alors silencieusement le doc pushTokens correspondant,
  // et RIEN ne le regenerait avant ce correctif (le reglage restait affiche
  // "actif" indefiniment). shouldRefreshPushToken() doit redeclencher un
  // rafraichissement silencieux a CHAQUE demarrage tant que la permission est
  // deja accordee (jamais un nouveau prompt natif, deja gere par enablePushNotifications()).
  __assertEq(shouldRefreshPushToken(true, 'granted'), true, 'permission deja accordee -> rafraichir silencieusement le token a chaque demarrage');
  __assertEq(shouldRefreshPushToken(true, 'default'), false, 'aucune decision prise -> pas de rafraichissement (c est shouldAutoPromptPushNotifications qui gere ce cas)');
  __assertEq(shouldRefreshPushToken(true, 'denied'), false, 'refusee -> rien a rafraichir');
  __assertEq(shouldRefreshPushToken(false, 'granted'), false, 'navigateur non supporte -> jamais de rafraichissement');
  console.log('OK: shouldRefreshPushToken() (rafraichit silencieusement le token a chaque demarrage si deja accorde - corrige un token invalide sans que la permission ne change)');

  currentUser = { displayName: 'Test', email: 't@test.com', photoURL: '' };
  settingsScreenOpen = false;
  const fullAccountHtml = renderAccountTabScreen();
  const idxAthlete = fullAccountHtml.indexOf('athlete-card');
  const idxTrophies = fullAccountHtml.indexOf('Trophées');
  const idxAccountCard = fullAccountHtml.indexOf('account-card');
  const idxSettingsNavBtn = fullAccountHtml.indexOf('openSettingsScreen()');
  __assertOk(idxAthlete !== -1 && idxTrophies !== -1 && idxAthlete < idxTrophies, 'la carte athlete doit apparaitre avant les trophees');
  __assertOk(idxTrophies < idxAccountCard, 'les trophees doivent apparaitre avant la carte Compte (reorganisation demandee)');
  // Depuis la creation de l ecran Parametres dedie, l onglet Profil principal ne
  // montre plus la carte settings-card ni les boutons deconnexion/suppression :
  // uniquement un bouton de navigation vers l ecran Parametres, tout en bas.
  __assertOk(idxAccountCard < idxSettingsNavBtn, 'la carte Compte doit preceder le bouton de navigation vers les Parametres, tout en bas de la page');
  __assertOk(!fullAccountHtml.includes('settings-card'), 'la carte parametres (coach vocal) ne doit plus apparaitre directement sur l ecran Profil principal');
  __assertOk(!fullAccountHtml.includes('signout-btn" onclick="signOutUser()'), 'le bouton de deconnexion ne doit plus apparaitre directement sur l ecran Profil principal (relocalise dans Parametres)');
  __assertOk(fullAccountHtml.includes('class="header"'), 'l onglet Profil doit desormais avoir un en-tete');
  __assertOk(fullAccountHtml.includes('onclick="showStreakInfoModal()">🔥 6 j'), 'la pastille de serie interactive doit etre dans l en-tete du Profil');
  __assertOk(fullAccountHtml.indexOf('class="header"') < idxAthlete, 'l en-tete doit precede la carte athlete');
  console.log('OK: onglet Profil (en-tete avec pastille serie, carte athlete cliquable, bouton Parametres tout en bas)');

  // Retour utilisateur "effet waouh" : la carte athlete doit porter .tilt-card
  // (effet de profondeur au toucher, voir initTiltCards() - delegation globale,
  // aucune re-attache necessaire aux re-renders).
  __assertOk(fullAccountHtml.includes('class="athlete-card tilt-card"'), 'la carte athlete doit etre une carte "tilt" (effet de profondeur au toucher)');
  __assertOk(__rawHtml.includes("matchMedia('(prefers-reduced-motion: reduce)').matches) return;") && __rawHtml.includes('function initTiltCards()'), 'l effet tilt ne doit jamais s activer si prefers-reduced-motion est demande');
  console.log('OK: cartes hero "tilt" (effet de profondeur au toucher, jamais actif sous prefers-reduced-motion)');

  // Retour utilisateur "effet waouh" : legere parallaxe sur l image de
  // demonstration de l exercice (.parallax-img) au defilement.
  __assertOk(__rawHtml.includes('class="exercise-hero-apng parallax-img"'), 'l image de demonstration de l exercice doit porter la classe .parallax-img');
  __assertOk(__rawHtml.includes("matchMedia('(prefers-reduced-motion: reduce)').matches) return;") && __rawHtml.includes('function initParallax()'), 'la parallaxe ne doit jamais s activer si prefers-reduced-motion est demande');
  console.log('OK: parallaxe sur l image de l exercice (jamais active sous prefers-reduced-motion)');

  // Retour utilisateur "effet waouh" : le gros chiffre de progression doit defiler
  // vers sa nouvelle valeur (pas sauter instantanement) a chaque serie loguee -
  // mais UNIQUEMENT en cas de vrai changement (jamais rejoue "pour rien" sur un
  // re-rendu sans changement, ni sur le tout premier affichage).
  const countUpTestEl = document.getElementById('countUpTestTarget');
  countUpTestEl.textContent = '';
  animateCountUp('countUpTestTarget', 'countup-test-key', 42);
  __assertEq(countUpTestEl.textContent, 42, 'le tout premier affichage doit ecrire la valeur directement (aucune valeur precedente connue, rien a animer depuis)');
  animateCountUp('countUpTestTarget', 'countup-test-key', 42);
  __assertEq(countUpTestEl.textContent, 42, 'un re-rendu SANS changement de valeur ne doit jamais relancer d animation (juste re-ecrire la meme valeur)');
  animateCountUp('countUpTestTarget', 'countup-test-key', 55);
  __assertEq(countUpTestEl.textContent, 42, 'un VRAI changement de valeur doit passer par l animation differee (requestAnimationFrame) plutot qu un saut instantane - le mock de test n execute jamais les frames, donc le texte doit rester a l ancienne valeur ici (preuve que le chemin "instantane" n a pas ete pris a tort)');
  console.log('OK: animateCountUp() (defilement uniquement sur un vrai changement, jamais sur le premier affichage ni un re-rendu identique)');

  // Retour utilisateur "effet waouh" : les panneaux (parcours de niveau, fiche
  // d ami, info groupe) sont desormais de VRAIES feuilles a glisser - le mock
  // DOM du harnais ne simule pas de vrais evenements tactiles (querySelector
  // limite aux #id, voir plus haut dans ce fichier), donc ce test appelle
  // attachSheetBehavior() directement avec des objets synthetiques pour
  // verifier sa LOGIQUE (seuil de fermeture vs retour a plat, tap sur le fond).
  {
    const fakeSheet = { scrollTop: 0, style: {}, _listeners: {}, addEventListener(type, cb) { this._listeners[type] = cb; } };
    const fakeOverlay = { onclick: null, querySelector(sel) { return sel === '.level-roadmap-sheet' ? fakeSheet : null; } };
    let closeCalls = 0;
    const fakeClose = () => { closeCalls++; };
    attachSheetBehavior(fakeOverlay, fakeClose);
    __assertOk(typeof fakeOverlay.onclick === 'function', 'un gestionnaire de clic doit etre pose sur le fond (backdrop)');
    fakeOverlay.onclick({ target: {} }); // clic sur un ENFANT (la feuille elle-meme), jamais le fond
    __assertEq(closeCalls, 0, 'un clic sur le contenu de la feuille ne doit jamais la fermer');
    fakeOverlay.onclick({ target: fakeOverlay }); // clic sur le fond lui-meme
    __assertEq(closeCalls, 1, 'un clic sur le fond (backdrop) doit fermer le panneau, comme tout bottom sheet natif');

    // Glissement COURT (sous le seuil de 120px) : doit revenir a plat, jamais fermer.
    fakeSheet._listeners.touchstart({ touches: [{ clientY: 100 }] });
    fakeSheet._listeners.touchmove({ touches: [{ clientY: 160 }] });
    __assertEq(fakeSheet.style.transform, 'translateY(60px)', 'la feuille doit suivre le doigt en temps reel pendant le glissement');
    fakeSheet._listeners.touchend({ changedTouches: [{ clientY: 160 }] });
    __assertEq(fakeSheet.style.transform, '', 'un glissement sous le seuil doit revenir a plat (transform vide), jamais fermer');
    __assertEq(closeCalls, 1, 'un glissement sous le seuil ne doit jamais appeler la fermeture');

    // Glissement LONG (au-dessus du seuil de 120px) : doit fermer (apres le delai d animation).
    fakeSheet._listeners.touchstart({ touches: [{ clientY: 100 }] });
    fakeSheet._listeners.touchmove({ touches: [{ clientY: 300 }] });
    fakeSheet._listeners.touchend({ changedTouches: [{ clientY: 300 }] });
    __assertEq(fakeSheet.style.transform, 'translateY(100%)', 'un glissement au-dessus du seuil doit animer la sortie de la feuille');
    await new Promise((r) => setTimeout(r, 250));
    __assertEq(closeCalls, 2, 'un glissement au-dessus du seuil doit appeler la fermeture (apres le delai d animation de sortie)');

    // Glisser depuis une liste deja scrollee (scrollTop > 0) : ne doit jamais s engager
    // (sinon impossible de faire defiler une longue liste sans fermer la feuille par erreur).
    fakeSheet.scrollTop = 40;
    fakeSheet.style.transform = '';
    fakeSheet._listeners.touchstart({ touches: [{ clientY: 100 }] });
    fakeSheet._listeners.touchmove({ touches: [{ clientY: 300 }] });
    __assertEq(fakeSheet.style.transform, '', 'le glisser-pour-fermer ne doit jamais s engager si la feuille n est pas deja scrollee tout en haut');
  }
  console.log('OK: attachSheetBehavior() (feuilles a glisser : tap sur le fond ferme, seuil de glissement pour fermer vs revenir a plat, jamais depuis une liste scrollee)');

  // --- 38. Pastille de serie cliquable : modal explicative style Duolingo (titre neutre,
  // badge bouclier explicite, croix de fermeture, message d accroche a 0 jour) ---
  popupQueue = []; popupOpen = false;
  streakCount = 9; hasShield = true;
  showStreakInfoModal();
  __assertOk(popupOpen, 'le clic sur la pastille de serie doit ouvrir une popup');
  __assertOk(currentPopupHtml.includes('Série Actuelle'), 'le titre doit etre neutre, sans repeter le nombre de jours');
  __assertOk(!currentPopupHtml.includes('Série de 9'), 'l ancien titre redondant avec le gros chiffre ne doit plus apparaitre');
  __assertOk(currentPopupHtml.includes('>9<'), 'le gros chiffre doit toujours afficher la serie en cours');
  __assertOk(currentPopupHtml.includes('Jours'), 'le libelle Jour/Jours doit accompagner le gros chiffre');
  __assertOk(currentPopupHtml.includes('Bouclier : Disponible'), 'un badge doit indiquer explicitement que le bouclier est disponible');
  __assertOk(currentPopupHtml.includes('appPopupCloseX'), 'une croix de fermeture doit etre presente sur cette modale');
  document.getElementById('appPopupCloseX').onclick();
  __assertOk(!popupOpen, 'la croix de fermeture doit fermer la popup sans passer par le bouton Continuer');
  streakCount = 3; hasShield = false;
  showStreakInfoModal();
  __assertOk(currentPopupHtml.includes('Bouclier : Inactif'), 'sans bouclier disponible, le badge doit clairement indiquer Inactif');
  document.getElementById('appPopupCloseBtn').onclick();
  streakCount = 0;
  showStreakInfoModal();
  __assertOk(currentPopupHtml.includes('Aucune série en cours'), 'a 0 jour, un message d accroche doit remplacer le message de felicitations');
  __assertOk(!currentPopupHtml.includes('Félicitations'), 'a 0 jour, le message de felicitations/maintien ne doit pas s afficher');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: pastille de serie cliquable -> modal redessinee (titre neutre, badge bouclier, croix de fermeture, message 0 jour)');

  // --- 39. Carte "Parcours de niveau" : page complete (niveau, XP manquant, tous les titres) ---
  xpTotal = xpForLevel(21) + 40; // en plein niveau 21 (Athlète)
  openLevelRoadmap();
  __assertOk(levelRoadmapOpen, 'openLevelRoadmap doit marquer la page comme ouverte');
  const roadmapHtml = renderLevelRoadmapSheet();
  __assertOk(roadmapHtml.includes('Niveau 21'), 'la page doit afficher le niveau courant');
  __assertOk(roadmapHtml.includes('Athlète 🥇'), 'la page doit afficher le titre courant');
  for (const tier of ['Recrue 🥉', 'Initié 🎖️', 'Motivé 🥈', 'Régulier 📅', 'Athlète 🥇', 'Guerrier ⚔️', 'Expert ⚡', 'Titan 🏆', 'Demi-Dieu 🌌', 'Légende Immortelle 👑']) {
    __assertOk(roadmapHtml.includes(tier), 'tous les titres doivent figurer dans le parcours : ' + tier);
  }
  __assertOk(/class="roadmap-row[^"]*\\bcurrent\\b/.test(roadmapHtml), 'le palier courant doit etre visuellement marque');
  closeLevelRoadmap();
  __assertOk(!levelRoadmapOpen, 'closeLevelRoadmap doit refermer la page');
  console.log('OK: carte "Parcours de niveau" (niveau courant, XP manquant, tous les titres listes)');

  // --- 40. Popups Level Up et Nouveau Titre (epique), declenchees par un gain d'XP ---
  popupQueue = []; popupOpen = false;
  xpTotal = xpForLevel(6) - 10; // juste avant le niveau 6 (encore dans le meme titre "Recrue")
  await saveXp();
  let res = await awardXp(20); // franchit le niveau 6, meme titre (Recrue -> toujours Recrue jusqu'a 5... verifions)
  enqueueLevelPopups(res.levelBefore, res.levelAfter);
  __assertOk(res.levelAfter > res.levelBefore, 'le gain d XP doit avoir fait passer un palier de niveau');
  __assertOk(popupOpen, 'une popup doit s afficher au level up');
  if (athleteTitle(res.levelBefore) === athleteTitle(res.levelAfter)) {
    __assertOk(currentPopupHtml.includes('Niveau supérieur'), 'meme titre -> popup de level up simple');
  } else {
    __assertOk(currentPopupHtml.includes('NOUVEAU TITRE'), 'changement de titre -> popup epique de titre');
  }
  document.getElementById('appPopupCloseBtn').onclick();

  // Cas explicite : passage du niveau 5 (Recrue, dernier niveau du palier) au niveau 6 (Initié)
  popupQueue = []; popupOpen = false;
  enqueueLevelPopups(5, 6);
  __assertOk(popupOpen, 'un changement de titre doit ouvrir une popup');
  __assertOk(currentPopupHtml.includes('NOUVEAU TITRE'), 'popup epique attendue pour un changement de titre');
  __assertOk(currentPopupHtml.includes('Initié 🎖️'), 'la popup doit nommer le nouveau titre debloque');
  __assertOk(currentPopupHtml.includes('kilo-level_up'), 'la popup epique de nouveau titre affiche desormais Kilo dans son etat dedie (couronne + trophee), pas l etat success generique');
  __assertOk(!currentPopupHtml.includes('kilo-success'), 'ce n est pas l etat success generique qui s affiche ici, mais level_up (etat dedie a ce moment epique)');
  document.getElementById('appPopupCloseBtn').onclick();

  // Cas explicite : level up SANS changement de titre (niveau 2 -> 3, toujours Recrue)
  popupQueue = []; popupOpen = false;
  enqueueLevelPopups(2, 3);
  __assertOk(currentPopupHtml.includes('Niveau supérieur'), 'popup simple attendue quand le titre ne change pas');
  __assertOk(!currentPopupHtml.includes('NOUVEAU TITRE'), 'pas de popup epique quand le titre est inchange');
  __assertOk(currentPopupHtml.includes('kilo-success'), 'la mascotte Kilo (etat success) doit accompagner un simple level up (retour utilisateur "effet waouh")');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: popups Level Up (simple, Kilo etat success) et Nouveau Titre (epique, Kilo etat dedie level_up) selon le changement de palier');

  // --- 41. Refonte UI du chrono : disque double-anneau cliquable, plus de bouton
  // rectangulaire / texte "en cours" / hints / mode plein ecran / ajout manuel ---
  state = emptyDayState();
  activeToday = new Set([9003]);
  await pickChallenge(9003); // Planche test (unit='sec', target=30, hardcoreTarget=60)
  render(false);
  let detailHtml = document.getElementById('app').innerHTML;
  __assertOk(detailHtml.includes('timer-ring-wrap'), 'le disque du chrono (anneau) doit etre present');
  __assertOk(detailHtml.includes('bar-track') && !detailHtml.includes('progress-ring-wrap'), 'un exercice en secondes doit garder la barre horizontale pour l objectif du jour (deja un riche double-anneau via le chronometre, un 2e anneau serait redondant)');
  __assertOk(detailHtml.includes('progress-pct'), 'le pourcentage textuel doit etre affiche a cote de la barre');
  __assertOk(detailHtml.includes('onclick="toggleTimer()"'), 'tout le disque doit etre cliquable (toggle play/pause)');
  __assertOk(detailHtml.includes('timer-play-icon'), 'la petite icone play/pause epuree doit etre presente sous le temps');
  __assertOk(!detailHtml.includes('timer-play-btn'), 'l ancien gros bouton circulaire colore ne doit plus exister');
  __assertOk(!detailHtml.includes('timer-btn start') && !detailHtml.includes('timer-btn stop'), 'l ancien gros bouton rectangulaire Demarrer/Stop ne doit plus exister');
  __assertOk(!detailHtml.includes('en cours'), 'le texte "en cours" a l interieur du cercle ne doit plus apparaitre');
  __assertOk(!detailHtml.includes('timer-hint') && !detailHtml.includes('Appuie sur'), 'les textes explicatifs sous le chrono ne doivent plus apparaitre');
  __assertOk(!detailHtml.includes('Mode plein écran') && !detailHtml.includes('focus-btn'), 'le mode plein ecran doit avoir disparu de la fiche');
  __assertOk(!detailHtml.includes('ou ajoute un temps manuellement') && !detailHtml.includes('or-divider'), 'la section "ou ajoute un temps manuellement" doit avoir disparu');
  __assertOk(!detailHtml.includes('+15s') && !detailHtml.includes('+30s'), 'les boutons d ajout rapide en secondes ne doivent plus apparaitre');
  __assertOk(detailHtml.includes('customAddInput'), 'le champ de saisie manuelle generique (nombre personnalise) doit rester disponible');
  __assertOk(!detailHtml.includes('tally-wrap'), 'les traits de comptage (craie) ne doivent plus apparaitre, meme pour un exercice chronometre');
  __assertOk(typeof enterFocusMode === 'undefined' && typeof exitFocusMode === 'undefined' && typeof renderFocusScreen === 'undefined', 'le mode plein ecran doit avoir ete entierement retire du code (fonctions supprimees)');
  __assertOk(typeof focusMode === 'undefined', 'la variable focusMode ne doit plus exister');
  __assertOk(typeof renderTally === 'undefined', 'renderTally() doit avoir ete entierement retiree (traits de comptage supprimes definitivement)');
  __assertEq(TIMER_RING_OUTER_RADIUS - TIMER_RING_INNER_RADIUS, 10, 'l ecart de rayon doit donner ~1px d ecart visuel une fois les demi-epaisseurs de trait retirees (78->88, traits 10+8)');

  // icone Valider (✓) a la place de Pause pendant que le chrono tourne
  toggleTimer(); // demarre le decompte de preparation (pas encore le chrono)
  clearPrepCountdown();
  startTimer();
  render(false);
  detailHtml = document.getElementById('app').innerHTML;
  __assertOk(detailHtml.includes('timer-play-icon confirm">✓<'), 'pendant que le chrono tourne, l icone doit devenir un checkmark (Valider), plus une pause');
  __assertOk(!detailHtml.includes('❚❚'), 'l ancien symbole de pause ne doit plus jamais apparaitre');
  clearTimerState();
  currentChallengeId = null;

  const pompesLib = CHALLENGE_LIBRARY.find(c => c.name === 'Pompes');
  activeToday = new Set([pompesLib.id]);
  state = emptyDayState();
  await pickChallenge(pompesLib.id); // unit='reps'
  render(false);
  detailHtml = document.getElementById('app').innerHTML;
  __assertOk(!detailHtml.includes('tally-wrap'), 'les traits de comptage doivent aussi avoir disparu pour un exercice en repetitions (carte "Ajouter une serie" fixe)');
  // Retour utilisateur : l anneau de progression pour les exercices en repetitions
  // ("occupe beaucoup trop d espace vertical") a ete retire - retour a la meme barre
  // horizontale + pourcentage que les exercices en secondes, sans distinction d unite.
  __assertOk(!detailHtml.includes('progress-ring-wrap'), 'l anneau de progression ne doit plus jamais apparaitre (retire, retour a la barre lineaire)');
  __assertOk(detailHtml.includes('bar-track') && detailHtml.includes('progress-pct'), 'un exercice en repetitions doit afficher la meme barre horizontale + pourcentage qu un exercice en secondes, plus de distinction d unite pour ce bloc');
  currentChallengeId = null;
  console.log('OK: disque double-anneau epure (plus de bouton/textes/plein ecran/ajout manuel en secondes)');

  // --- 42. computeTimerRingPct + renderDoubleTimerRingSVG : calcul et rendu des 2 anneaux ---
  let pcts = computeTimerRingPct(0, 30, 60);
  __assertEq(pcts.normalPct, 0, 'a 0s, anneau normal a 0%');
  __assertEq(pcts.hardcorePct, 0, 'a 0s, anneau hardcore a 0%');
  pcts = computeTimerRingPct(15, 30, 60);
  __assertEq(pcts.normalPct, 0.5, 'a 15/30s, anneau normal a 50%');
  __assertEq(pcts.hardcorePct, 0, 'avant d atteindre l objectif normal, l anneau hardcore reste a 0%');
  pcts = computeTimerRingPct(30, 30, 60);
  __assertEq(pcts.normalPct, 1, 'objectif normal atteint -> anneau normal a 100%');
  __assertEq(pcts.hardcorePct, 0, 'objectif normal tout juste atteint -> hardcore encore a 0%');
  pcts = computeTimerRingPct(45, 30, 60);
  __assertEq(pcts.normalPct, 1, 'anneau normal reste plafonne a 100% pendant la phase hardcore');
  __assertEq(pcts.hardcorePct, 0.5, 'a mi-chemin du hardcore (45 = 30 + 15/30), anneau hardcore a 50%');
  pcts = computeTimerRingPct(60, 30, 60);
  __assertEq(pcts.hardcorePct, 1, 'objectif hardcore atteint -> anneau hardcore a 100%');
  const ringSvg = renderDoubleTimerRingSVG(0.5, 0.25, 220);
  __assertOk(ringSvg.includes('id="timerRingFill"'), 'l anneau interieur (normal) doit avoir son id pour les mises a jour de tick');
  __assertOk(ringSvg.includes('id="timerRingHardcoreFill"'), 'l anneau exterieur (hardcore) doit avoir son propre id');
  __assertOk((ringSvg.match(/<circle/g) || []).length === 4, 'le SVG doit contenir 4 cercles (fond+remplissage x2)');
  console.log('OK: computeTimerRingPct (normal plafonne a 100%, hardcore calcule sur la plage restante) + rendu SVG double anneau');

  // Retour utilisateur "effet waouh" : mini-graphique (sparkline) des 7 derniers
  // jours d'activite sur l'exercice courant, affiche a cote du total a vie.
  __assertEq(renderExerciseSparkline([0, 0, 0, 0, 0, 0, 0]), '', 'aucune activite sur les 7 derniers jours -> rien a afficher (pas un graphique plat inutile)');
  __assertOk(renderExerciseSparkline([5, 0, 10, 0, 0, 0, 20]).includes('<polyline points="'), 'une activite recente doit produire un mini-graphique en courbe');

  // todayKey peut avoir ete fige a une date fictive par un test precedent (voir
  // le meme piege documente pour loadHistoryEntries()) - loadExerciseSparkline()
  // calcule sa fenetre depuis le VRAI new Date(), donc todayKey doit correspondre
  // a la vraie date du jour ici, sinon "aujourd hui" ne matche plus le bon index.
  todayKey = dateKey(new Date());
  exerciseSparklineCache = {};
  historyDayCache = {}; // evite de lire une entree perimee/etrangere en cache depuis un test precedent (meme cle relative "il y a N jours")
  const sparkPastDate = new Date();
  sparkPastDate.setDate(sparkPastDate.getDate() - 3);
  const sparkPastKey = dateKey(sparkPastDate);
  __store.set('day:' + sparkPastKey, JSON.stringify({ challenges: { [pompes.id]: { sets: [7, 8], targetOverride: null, done: true, hardcoreDone: false, hardcoreAnnounced: false } } }));
  state = emptyDayState();
  await pickChallenge(pompes.id);
  await loadExerciseSparkline(pompes.id); // le fire-and-forget de pickChallenge() n est pas attendu ici : relance directe pour un test deterministe
  __assertEq(exerciseSparklineCache[pompes.id].length, 7, 'la sparkline doit couvrir exactement 7 jours');
  __assertEq(exerciseSparklineCache[pompes.id][3], 15, 'le jour seede (J-3, 4e position en partant du plus ancien) doit refleter le total reel (7+8)');
  __assertEq(exerciseSparklineCache[pompes.id][6], 0, 'aujourd hui (dernier point) doit partir de 0 (aucune serie loguee pour l instant)');
  await addSet(5);
  __assertEq(exerciseSparklineCache[pompes.id][6], 5, 'chaque serie loguee doit incrementer OPTIMISTEMENT le dernier point (aujourd hui) de la sparkline, sans attendre un rechargement');
  currentChallengeId = null;
  console.log('OK: sparkline 7 jours (renderExerciseSparkline() + loadExerciseSparkline(), mise a jour optimiste a chaque serie loguee)');

  // --- 43. toggleTimer() : clic sur le disque bascule play (decompte) / pause (banque le temps) ---
  popupQueue = []; popupOpen = false;
  state = emptyDayState();
  await pickChallenge(9003);
  __assertEq(timerRunning, false);
  toggleTimer(); // pas encore done -> decompte de preparation (pas de demarrage direct)
  __assertEq(prepCountdownValue, 3, 'un clic alors qu aucun objectif n est atteint doit lancer le decompte de preparation');
  __assertEq(timerRunning, false, 'le chrono reel ne doit pas encore tourner pendant le decompte');
  clearPrepCountdown();
  startTimer(); // simule la fin du decompte sans attendre reellement les 3s
  __assertEq(timerRunning, true);
  timerStartMs = Date.now() - 5000; // simule 5s ecoulees
  toggleTimer(); // re-clic pendant que ca tourne -> pause (banque le temps ecoule)
  __assertEq(timerRunning, false, 'un clic pendant que le chrono tourne doit mettre en pause');
  await new Promise(r => setTimeout(r, 30)); // laisse le temps a addSet() (asynchrone, non attendu par toggleTimer/stopTimer) de se resoudre
  __assertOk(getEntry(9003).sets.length === 1 && getEntry(9003).sets[0] >= 4 && getEntry(9003).sets[0] <= 6, 'le temps ecoule doit etre banque (~5s) via la pause manuelle');
  __assertEq(getEntry(9003).done, false, 'objectif normal (30s) pas encore atteint apres seulement ~5s');
  currentChallengeId = null;
  console.log('OK: toggleTimer() alterne decompte->demarrage et pause selon l etat du chrono');

  // --- 44. Arret automatique a l objectif NORMAL : coach vocal "Defi termine !", XP/serie/popup ---
  popupQueue = []; popupOpen = false;
  streakCount = 0; lastCompletedDate = null; hasShield = true; lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  xpTotal = 5000; await saveXp(); // loin d un seuil de niveau, cf. le meme correctif applique au test 29
  dailyActivity = {};
  state = emptyDayState();
  activeToday = new Set([9003]);
  await pickChallenge(9003); // target=30 sec
  voiceCoachEnabled = true;
  __spokenLog.length = 0;
  startTimer();
  timerStartMs = Date.now() - 30000; // simule 30s ecoulees sans attendre reellement
  tickTimer();
  await new Promise(r => setTimeout(r, 30)); // laisse le temps a stopTimer()/addSet() (asynchrone, non attendu par tickTimer) de se resoudre
  __assertEq(getEntry(9003).done, true, 'l objectif normal atteint doit marquer le defi comme termine automatiquement');
  __assertEq(timerRunning, false, 'le chrono doit s arreter automatiquement (plus besoin d un Stop manuel)');
  __assertOk(__spokenLog.includes('Défi terminé ! Bravo !'), 'le coach vocal doit annoncer la fin du defi normal');
  __assertOk(popupOpen, 'la popup de fin de defi (XP/trophee) doit s afficher automatiquement');
  __assertOk(streakCount === 1, 'la serie du jour doit etre incrementee suite a cet arret automatique');
  console.log('OK: arret automatique a l objectif normal (voix + XP + serie + popup)');

  // --- 45. Reprise en mode Hardcore par un re-clic sur Play : annonce PUIS decompte 3-2-1
  // (revirement assume : la version precedente demarrait instantanement, sans decompte) ---
  document.getElementById('appPopupCloseBtn').onclick(); // ferme la popup de completion (et celle de serie en attente, cf. test 29)
  await new Promise(r => setTimeout(r, 950));
  if (popupOpen) document.getElementById('appPopupCloseBtn').onclick();
  __spokenLog.length = 0;
  __assertEq(timerRunning, false);
  __assertEq(getEntry(9003).done, true, 'prerequis : objectif normal deja atteint (test precedent)');
  __assertEq(getEntry(9003).hardcoreDone, false);
  toggleTimer(); // objectif normal deja atteint -> annonce puis decompte avant de demarrer
  __assertEq(timerRunning, false, 'le chrono ne doit plus demarrer instantanement : un decompte precede desormais la reprise Hardcore');
  __assertEq(prepCountdownValue, 3, 'le decompte doit etre arme a 3 des le clic');
  __assertOk(__spokenLog.includes('Mode Hardcore enclenché !'), 'le coach vocal doit d abord annoncer le lancement du mode Hardcore');
  __assertOk(!__spokenLog.includes('3'), 'le decompte audible (3-2-1) ne doit pas demarrer immediatement, pour ne pas couper la phrase d annonce en cours');
  await new Promise(r => setTimeout(r, 1400)); // laisse le temps a la phrase de s achever puis au "3" du decompte d etre prononce
  __assertOk(__spokenLog.includes('3'), 'le decompte doit demarrer par "3" une fois la phrase d annonce terminee');
  __assertEq(timerRunning, false, 'le chrono ne demarre encore qu une fois le decompte complet');
  clearPrepCountdown();
  startTimer(); // simule la fin du decompte sans attendre les 2 secondes restantes
  __assertEq(timerRunning, true, 'le chrono demarre reellement une fois le decompte termine');
  console.log('OK: reprise en mode Hardcore precedee d une annonce vocale puis d un decompte 3-2-1 (plus de demarrage instantane)');

  // --- 46. Arret automatique (definitif) a l objectif HARDCORE : voix "Un vrai Titan !" ---
  timerStartMs = Date.now() - 30000; // encore 30s (total cumule 30+30=60 = objectif hardcore de 60s)
  tickTimer();
  await new Promise(r => setTimeout(r, 30)); // laisse le temps a stopTimer()/addSet() de se resoudre
  __assertEq(getEntry(9003).hardcoreDone, true, 'l objectif hardcore atteint doit marquer le hardcore comme reussi automatiquement');
  __assertEq(timerRunning, false, 'le chrono doit s arreter definitivement');
  __assertOk(__spokenLog.includes('Mode Hardcore réussi ! Un vrai Titan !'), 'le coach vocal doit annoncer la reussite du mode Hardcore');
  __assertOk(popupOpen, 'une popup Hardcore (XP/trophee) doit s afficher automatiquement');
  document.getElementById('appPopupCloseBtn').onclick();
  toggleTimer(); // hardcore deja reussi -> plus rien a demarrer
  __assertEq(timerRunning, false, 'un clic une fois tout termine ne doit rien declencher');
  currentChallengeId = null;
  console.log('OK: arret automatique et definitif a l objectif Hardcore (voix + XP + popup), disque inerte ensuite');

  // --- 47. Poids des halteres affiche SOUS les reps, identique sur Défis et Aujourd'hui ---
  const triceps2 = CHALLENGE_LIBRARY.find(x => x.name === 'Triceps'); // Haltères
  weights[triceps2.id] = 14;
  activeToday = new Set([triceps2.id]);
  const libCardHtml = renderChallengeCard(triceps2, 'library');
  __assertOk(libCardHtml.includes('goal-weight'), 'la carte Défis doit afficher le poids sur sa propre ligne (.goal-weight)');
  __assertOk(libCardHtml.includes('14kg'), 'le poids affiche doit correspondre a celui enregistre');
  __assertOk(!/reps[^<]*·[^<]*🏋️/.test(libCardHtml), 'le poids ne doit plus etre inline "a cote" des reps sur Défis (comportement desormais identique a Aujourd hui)');
  console.log('OK: poids des halteres affiche sous les reps sur Défis, comme sur Aujourd hui');

  // --- 48. Rouleaux de selection (wheel pickers) : rendu + lecture/ecriture + clamp anti-rebond ---
  const wpHtml = renderWheelPicker('pfAge', 12, 100, 1, 'ans');
  __assertOk(wpHtml.includes('id="pfAge"'), 'le rouleau doit porter l id attendu');
  __assertOk(wpHtml.includes('data-min="12"') && wpHtml.includes('data-max="100"') && wpHtml.includes('data-step="1"'), 'les bornes doivent etre exposees en data-attributes');
  __assertEq((wpHtml.match(/wheel-picker-item/g) || []).length, 89, '89 valeurs (12 a 100 inclus)');
  __assertOk(wpHtml.includes('30 ans'), 'le suffixe doit etre accole a chaque valeur');

  const elAge = document.getElementById('pfAge');
  elAge.dataset = { min: '12', max: '100', step: '1', itemHeight: '44' };
  setWheelPickerValue('pfAge', 45);
  __assertEq(elAge.scrollTop, (45 - 12) * 44, 'setWheelPickerValue doit positionner le scroll au bon index');
  __assertEq(getWheelPickerValue('pfAge'), 45, 'getWheelPickerValue doit relire la meme valeur');
  elAge.scrollTop = -500; // rebond elastique negatif (overscroll iOS)
  __assertEq(getWheelPickerValue('pfAge'), 12, 'doit se clamper a la valeur minimale en cas de rebond negatif');
  elAge.scrollTop = 999999;
  __assertEq(getWheelPickerValue('pfAge'), 100, 'doit se clamper a la valeur maximale en cas de rebond positif');
  console.log('OK: rouleau de selection (rendu + lecture/ecriture + clamp anti-rebond)');

  // --- 49. Onboarding : rouleaux a la place des <input type="number"> pour age/taille/poids ---
  showProfileOnboarding = true;
  profileStep = 1;
  profileDraft = { age: null, sex: null, heightCm: null, weightKg: null, level: null };
  render(false);
  let onbHtml = document.getElementById('app').innerHTML;
  __assertOk(!onbHtml.includes('type="number"'), 'l etape age ne doit plus utiliser de <input type="number"> (clavier virtuel)');
  __assertOk(onbHtml.includes('wheel-picker'), 'l etape age doit afficher un rouleau de selection');
  // initWheelPickers() est appele automatiquement en afterRender par render(), mais le
  // mock ne parse pas reellement les data-attributes HTML en dataset (pas de vrai DOM) :
  // on le simule nous-memes, comme le ferait un vrai navigateur.
  document.getElementById('pfAge').dataset = { min: '12', max: '100', step: '1', itemHeight: '44' };
  setWheelPickerValue('pfAge', 27);
  profileNext();
  __assertEq(profileDraft.age, 27, 'profileNext() doit lire l age directement depuis le rouleau');
  __assertEq(profileStep, 2, 'doit passer a l etape suivante');

  profileStep = 3; // etape taille/poids (l etape sexe n est pas concernee par les rouleaux)
  render(false);
  onbHtml = document.getElementById('app').innerHTML;
  __assertOk(!onbHtml.includes('type="number"'), 'l etape taille/poids ne doit plus utiliser de <input type="number">');
  __assertEq((onbHtml.match(/class="wheel-picker"/g) || []).length, 2, 'deux rouleaux doivent etre affiches (taille et poids)');
  document.getElementById('pfHeight').dataset = { min: '100', max: '250', step: '1', itemHeight: '44' };
  document.getElementById('pfWeight').dataset = { min: '30', max: '300', step: '1', itemHeight: '44' };
  setWheelPickerValue('pfHeight', 182);
  setWheelPickerValue('pfWeight', 80);
  profileNext();
  __assertEq(profileDraft.heightCm, 182, 'profileNext() doit lire la taille depuis son rouleau');
  __assertEq(profileDraft.weightKg, 80, 'profileNext() doit lire le poids depuis son rouleau');
  __assertEq(profileStep, 4, 'doit passer a l etape suivante');

  // valeurs par defaut quand rien n a encore ete choisi (nouvel utilisateur)
  profileDraft = { age: null, sex: null, heightCm: null, weightKg: null, level: null };
  document.getElementById('pfAge').dataset = { min: '12', max: '100', step: '1', itemHeight: '44' };
  document.getElementById('pfHeight').dataset = { min: '100', max: '250', step: '1', itemHeight: '44' };
  document.getElementById('pfWeight').dataset = { min: '30', max: '300', step: '1', itemHeight: '44' };
  initWheelPickers();
  __assertEq(getWheelPickerValue('pfAge'), 30, 'valeur par defaut de l age (30 ans) si rien de renseigne');
  __assertEq(getWheelPickerValue('pfHeight'), 175, 'valeur par defaut de la taille (175cm)');
  __assertEq(getWheelPickerValue('pfWeight'), 75, 'valeur par defaut du poids (75kg)');
  showProfileOnboarding = false;
  profileStep = 0;
  console.log('OK: onboarding age/taille/poids via rouleaux de selection (plus de clavier virtuel)');

  // --- 50. Popup epique de trophee, desormais SEPAREE de la popup de completion du defi ---
  popupQueue = []; popupOpen = false;
  badges = { totalCompletions: 9, unlocked: [], totalHardcore: 0 }; // a 1 defi du trophee "10 defis completes"
  await saveBadges();
  xpTotal = 5000; await saveXp();
  streakCount = 0; lastCompletedDate = null; hasShield = true; lastShieldResetWeek = mondayOfWeek(new Date());
  await saveStreakData();
  dailyActivity = { [todayKey]: 1 }; // pas la 1ere validation du jour : isole du systeme de serie
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  const cForTrophy = getChallenge();
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: cForTrophy.target, date: todayKey }, recordStreak: 0 };
  await addSet(cForTrophy.target);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  __assertOk(popupOpen, 'la popup de completion doit s afficher immediatement');
  __assertOk(currentPopupHtml.includes('Défi complété'), 'la 1ere popup doit etre celle de completion');
  __assertOk(!currentPopupHtml.includes('trophy-chip'), 'la popup de completion ne doit plus integrer de carte trophee');
  document.getElementById('appPopupCloseBtn').onclick();
  __assertOk(popupOpen, 'une popup dediee au trophee doit s enchainer juste apres');
  __assertOk(currentPopupHtml.includes('Trophée débloqué'), 'la popup dediee au trophee doit avoir son propre titre epique');
  __assertOk(currentPopupHtml.includes('app-popup-card epic'), 'la popup de trophee doit utiliser le style epique (bordure doree, etc.)');
  let safetyCounter = 0;
  while (popupOpen && safetyCounter < 10) { document.getElementById('appPopupCloseBtn').onclick(); safetyCounter++; }
  __assertOk(!popupOpen, 'toutes les popups en cascade doivent pouvoir etre fermees');
  currentChallengeId = null;
  console.log('OK: popup epique de trophee separee de la popup de completion du defi');

  // --- 50bis. Bug reel signale : un trophee base sur un CUMUL A VIE (ex: "100
  // pompes cumulees") restait "gele" tant que l objectif personnel du JOUR
  // n etait pas atteint - meme si des repetitions loguees pour un defi de
  // groupe faisaient deja franchir le seuil. checkNewBadges() n etait appelee
  // que dans le bloc de completion (willComplete) ; desormais aussi juste apres
  // la mise a jour de lifetimeTotal, independamment de willComplete. ---
  popupQueue = []; popupOpen = false;
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 };
  await saveBadges();
  xpTotal = 0; await saveXp();
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  stats[pompes.id] = { lifetimeTotal: 75, bestDay: { total: 0, date: null }, recordStreak: 0 }; // a 25 pompes du trophee "100 pompes cumulees"
  await addSet(30); // serie partielle pour AUJOURD HUI (tres en dessous de l objectif du jour), mais 75+30=105 franchit le cumul de 100
  await flushWorkoutWrites();
  __assertOk(!getEntry(pompes.id).done, 'cette serie partielle ne doit PAS completer l objectif personnel du jour (30 tres en dessous de l objectif)');
  __assertEq(stats[pompes.id].lifetimeTotal, 105, 'le cumul a vie doit refleter la serie meme sans completion du jour (deja le cas avant ce correctif)');
  __assertOk(popupOpen, 'le trophee "cumul a vie" doit desormais s afficher IMMEDIATEMENT, sans attendre une completion du defi du jour');
  __assertOk(currentPopupHtml.includes('Trophée débloqué') && currentPopupHtml.includes(badgeLabel(BADGE_DEFS.find((b) => b.id === 'pushups_100'))), 'la popup doit bien annoncer le trophee "100 pompes cumulees"');
  __assertOk(badges.unlocked.includes('pushups_100'), 'le trophee doit etre marque debloque immediatement (persiste), pas seulement affiche');
  document.getElementById('appPopupCloseBtn').onclick();
  currentChallengeId = null;
  console.log('OK: un trophee "cumul a vie" se debloque des le seuil franchi, meme sans completer l objectif personnel du jour (bug reel corrige)');

  // --- 51. Bouton de l etat vide "Aujourd hui" renomme en "Choisir un defi" ---
  const emptyStateHtml = renderTodayEmptyState();
  __assertOk(emptyStateHtml.includes('Choisir un défi'), 'le bouton doit maintenant s appeler "Choisir un défi"');
  __assertOk(!emptyStateHtml.includes('Aller à la Bibliothèque'), 'l ancien libelle ne doit plus apparaitre');
  console.log('OK: bouton de l etat vide renomme en "Choisir un défi"');

  // --- 52. BADGE_DEFS : champs xp/progress/secondsBased pour la modal de detail ---
  const streak3Def = BADGE_DEFS.find(x => x.id === 'streak_3');
  __assertEq(streak3Def.xp, 50, 'recompense XP du 1er trophee de serie');
  streakCount = 2;
  __assertEq(streak3Def.progress().current, 2, 'progress() doit refleter l etat reel (computeStreak())');
  __assertEq(streak3Def.progress().target, 3);
  const comp10Def = BADGE_DEFS.find(x => x.id === 'comp_10');
  badges.totalCompletions = 7;
  __assertEq(comp10Def.progress().current, 7);
  const core15Def = BADGE_DEFS.find(x => x.id === 'core_15min');
  __assertOk(core15Def.secondsBased === true, 'les trophees de gainage cumule doivent etre marques secondsBased pour un affichage en minutes');
  __assertOk(BADGE_DEFS.every(b => typeof b.xp === 'number' && b.xp > 0), 'chaque trophee doit avoir une recompense XP strictement positive');
  console.log('OK: BADGE_DEFS expose xp/progress/secondsBased pour chaque trophee');

  // --- 53. Grille de trophees : icone toujours visible (grisee si verrouille) + badge cadenas + clic ---
  badges = { totalCompletions: 0, unlocked: ['comp_10'], totalHardcore: 0 };
  const trophyGridHtml = renderTrophiesGrid();
  __assertOk(trophyGridHtml.includes("showTrophyDetailModal('comp_10')"), 'chaque carte doit etre cliquable et ouvrir sa propre modal de detail');
  __assertOk(trophyGridHtml.includes('trophy-item unlocked'), 'un trophee debloque doit porter la classe unlocked');
  __assertOk(trophyGridHtml.includes('trophy-item locked'), 'un trophee verrouille doit porter la classe locked');
  __assertOk(trophyGridHtml.includes('lock-icon-svg'), 'un petit cadenas SVG (metallique/gris) doit accompagner les trophees verrouilles');
  __assertOk(!trophyGridHtml.includes('>🔒<'), 'le gros cadenas emoji ne doit plus remplacer l icone du trophee');
  // l icone du trophee (ex: 🏅 pour comp_10) doit rester visible meme verrouillee (juste grisee via CSS)
  const comp50Def = BADGE_DEFS.find(x => x.id === 'comp_50');
  __assertOk(trophyGridHtml.includes(comp50Def.icon), 'l icone specifique du trophee doit toujours etre affichee, meme verrouillee (grisee en CSS)');
  console.log('OK: grille de trophees (icone toujours visible, cadenas discret, cliquable)');

  // --- 54. Modal de detail d un trophee : icone, condition, barre de progression, XP ---
  popupQueue = []; popupOpen = false;
  badges = { totalCompletions: 3, unlocked: [], totalHardcore: 0 };
  showTrophyDetailModal('comp_10'); // verrouille : 3/10
  __assertOk(popupOpen, 'la modal doit s ouvrir au clic');
  __assertOk(currentPopupHtml.includes('Trophée verrouillé'), 'titre attendu pour un trophee non debloque');
  __assertOk(currentPopupHtml.includes('app-popup-icon locked'), 'l icone doit apparaitre grisee dans la modal tant que verrouille');
  __assertOk(currentPopupHtml.includes('3 / 10'), 'la barre de progression doit afficher les valeurs reelles en temps reel');
  __assertOk(currentPopupHtml.includes('+100 XP'), 'la recompense XP du trophee doit etre affichee');
  document.getElementById('appPopupCloseBtn').onclick();
  badges = { totalCompletions: 12, unlocked: ['comp_10'], totalHardcore: 0 };
  showTrophyDetailModal('comp_10'); // debloque : progression plafonnee a 10/10 (pas 12/10)
  __assertOk(currentPopupHtml.includes('Trophée débloqué'), 'titre attendu pour un trophee deja obtenu');
  __assertOk(!currentPopupHtml.includes('app-popup-icon locked'), 'l icone ne doit plus etre grisee une fois debloque');
  __assertOk(currentPopupHtml.includes('10 / 10'), 'la progression affichee doit se plafonner a l objectif une fois depasse');
  document.getElementById('appPopupCloseBtn').onclick();
  // trophee base sur des secondes (gainage cumule) : affichage en minutes/heures lisibles, pas en secondes brutes
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 };
  stats = { 9: { lifetimeTotal: 600 } }; // 10 min, sur un id fictif de la famille gainage — verifie juste le formatage
  showTrophyDetailModal('core_15min');
  __assertOk(!currentPopupHtml.includes(' sec /') , 'un trophee secondsBased ne doit pas afficher de secondes brutes dans la barre');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: modal de detail d un trophee (icone/condition/progression temps reel/XP), verrouille et debloque');

  // --- 55. XP d un trophee fraichement debloque : bien ajoutee au total (defi + trophee) ---
  popupQueue = []; popupOpen = false;
  badges = { totalCompletions: 9, unlocked: [], totalHardcore: 0 }; // a 1 defi du trophee "10 defis completes" (+100 XP)
  await saveBadges();
  xpTotal = 5000; await saveXp();
  dailyActivity = { [todayKey]: 1 };
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  const cFor55 = getChallenge();
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: cFor55.target, date: todayKey }, recordStreak: 0 };
  const expectedXp55 = xpForChallenge(cFor55, cFor55.target) + 100; // +100 = xp du trophee comp_10
  await addSet(cFor55.target);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  __assertEq(xpTotal, 5000 + expectedXp55, 'le total XP doit inclure a la fois le gain du defi ET la recompense du trophee debloque');
  let sc = 0; while (popupOpen && sc < 10) { document.getElementById('appPopupCloseBtn').onclick(); sc++; }
  currentChallengeId = null;
  console.log('OK: XP du trophee fraichement debloque bien cumulee avec celle du defi');

  // --- 56. Cartes de la liste (Défis/Aujourd hui) : plus AUCUNE icone ni mot de type
  // d'exercice (revirement assume : les icones ajoutees precedemment sont supprimees) ---
  const planche = CHALLENGE_LIBRARY.find(x => x.name === 'Planche'); // unit='sec'
  const cardSecHtml = renderChallengeCard(planche, 'library');
  __assertOk(!cardSecHtml.includes('unit-icon'), 'aucune icone de type ne doit plus apparaitre pour un defi chronometre');
  __assertOk(!cardSecHtml.includes('>Chrono<'), 'le mot "Chrono" ne doit pas apparaitre');
  __assertOk(!cardSecHtml.includes('class="cat"'), 'le conteneur du type d exercice doit avoir disparu entierement de la carte');
  const cardRepsHtml = renderChallengeCard(pompes, 'library');
  __assertOk(!cardRepsHtml.includes('unit-icon'), 'aucune icone de type ne doit plus apparaitre pour un defi en repetitions');
  __assertOk(!cardRepsHtml.includes('>Répétitions<'), 'le mot "Répétitions" ne doit pas apparaitre');
  __assertOk(typeof chronoUnitIconSVG === 'undefined' && typeof tallyUnitIconSVG === 'undefined', 'les fonctions d icones de type doivent avoir ete entierement retirees du code');
  console.log('OK: cartes de liste ultra-epurees, plus aucune icone/mot de type d exercice');

  // --- 57. Fiche detail : stats (Record/Cumul) toujours affichees (pas de saut de page), "Type d exercice" retire ---
  state = emptyDayState(); // aucune serie encore loguee aujourd'hui
  delete stats[pompes.id]; // et aucune stat a vie pour ce defi
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  render(false);
  const freshDetailHtml = document.getElementById('app').innerHTML;
  __assertOk(freshDetailHtml.includes('stats-row'), 'les badges Record/Cumul doivent etre presents des l ouverture, meme sans aucune serie');
  __assertOk(freshDetailHtml.includes('🏆 Record : 0'), 'le record doit afficher 0 par defaut plutot que de disparaitre');
  __assertOk(freshDetailHtml.includes('Σ 0 à vie'), 'le cumul a vie doit afficher 0 par defaut plutot que de disparaitre');
  __assertOk(!freshDetailHtml.includes('active-cat'), 'la mention du type d exercice sous l illustration doit avoir disparu');
  currentChallengeId = null;
  console.log('OK: stats Record/Cumul toujours affichees (plus de saut de page), mention "type d exercice" retiree');

  // --- 58. L annonce vocale "Mode Hardcore enclenché !" ne doit se produire qu une seule fois
  // par defi/jour, pas a chaque reprise du mode Hardcore ---
  voiceCoachEnabled = true;
  state = emptyDayState();
  activeToday = new Set([9003]);
  await pickChallenge(9003); // Planche test, target=30s, deja utilise dans les tests du chrono
  const entry58 = getEntry(9003);
  entry58.done = true; entry58.hardcoreDone = false; entry58.hardcoreAnnounced = false;
  __spokenLog.length = 0;
  toggleTimer(); // 1ere reprise Hardcore -> doit annoncer
  __assertOk(__spokenLog.includes('Mode Hardcore enclenché !'), '1ere reprise : l annonce doit se produire');
  __assertEq(entry58.hardcoreAnnounced, true, 'le flag doit passer a true des la 1ere reprise');
  clearPrepCountdown();
  startTimer();
  timerStartMs = Date.now() - 5000; // pause avant d avoir atteint l objectif hardcore
  toggleTimer(); // pause (banque ~5s)
  await new Promise(r => setTimeout(r, 30));
  __spokenLog.length = 0;
  toggleTimer(); // 2e reprise Hardcore -> ne doit PAS ré-annoncer
  __assertOk(!__spokenLog.includes('Mode Hardcore enclenché !'), '2e reprise : l annonce ne doit pas se repeter');
  __assertEq(prepCountdownValue, 3, 'le decompte 3-2-1 doit tout de meme se declencher (seule l annonce est concernee)');
  clearPrepCountdown();
  clearTimerState();
  currentChallengeId = null;
  console.log('OK: annonce "Mode Hardcore enclenché !" limitee a la toute premiere reprise (jamais repetee ensuite)');

  // --- 59. speak(text, onEnd) : le callback attend la fin REELLE de l utterance
  // (asynchrone), jamais une coupure mid-mot par un enchainement synchrone ---
  voiceCoachEnabled = true;
  __spokenLog.length = 0;
  let onEndCalled = false;
  let onEndCalledSync = true; // vrai seulement si onEnd() est appele avant meme que speak() ne rende la main
  speak('Mode Hardcore enclenché !', () => { onEndCalled = true; });
  onEndCalledSync = onEndCalled; // capture l etat juste apres l appel synchrone a speak()
  __assertEq(onEndCalledSync, false, 'onEnd ne doit PAS se declencher de maniere synchrone (sinon le decompte couperait la phrase)');
  __assertEq(onEndCalled, false, 'onEnd ne doit pas encore avoir ete appele juste apres speak()');
  await new Promise(r => setTimeout(r, 80)); // laisse le temps a l utterance simulee de se terminer (onend, cf. mock)
  __assertEq(onEndCalled, true, 'onEnd doit finir par se declencher une fois la phrase terminee');
  // coach vocal desactive : onEnd doit quand meme se declencher (immediatement), sinon
  // toute la sequence (decompte/timer) resterait bloquee indefiniment
  voiceCoachEnabled = false;
  let onEndCalledDisabled = false;
  speak('Mode Hardcore enclenché !', () => { onEndCalledDisabled = true; });
  __assertEq(onEndCalledDisabled, true, 'coach vocal desactive -> onEnd doit se declencher immediatement (rien a attendre)');
  voiceCoachEnabled = true;
  console.log('OK: speak(text, onEnd) attend la fin reelle de la phrase (jamais de coupure synchrone)');

  // --- 60. Retour haptique du wheel picker : 1 vibration par valeur franchie, pas de doublon ---
  let vibrateCallCount = 0;
  const realVibrate = navigator.vibrate;
  navigator.vibrate = (ms) => { vibrateCallCount++; return true; };
  document.getElementById('pfAge').dataset = { min: '12', max: '100', step: '1', itemHeight: '44' };
  document.getElementById('pfAge').scrollTop = 0; // valeur 12
  onWheelPickerScroll('pfAge');
  __assertEq(vibrateCallCount, 1, 'le tout 1er passage doit declencher un retour haptique');
  onWheelPickerScroll('pfAge'); // meme valeur (pas de scroll) -> pas de nouvelle vibration
  __assertEq(vibrateCallCount, 1, 'un evenement scroll sans changement de valeur ne doit pas re-vibrer');
  document.getElementById('pfAge').scrollTop = 44; // valeur 13 (1 cran plus loin)
  onWheelPickerScroll('pfAge');
  __assertEq(vibrateCallCount, 2, 'chaque nouveau cran franchi doit declencher exactement une vibration');
  navigator.vibrate = realVibrate;
  console.log('OK: retour haptique du wheel picker (1 vibration par cran, jamais de doublon sur la meme valeur)');

  // --- 61. Overlay du tutoriel : flou/assombrissement uniquement sur la 1ere carte ---
  hasSeenTour = false;
  guidedTourStep = 0;
  let tourOverlayHtml = renderGuidedTourOverlay();
  __assertOk(tourOverlayHtml.includes('tour-overlay intro'), 'la toute 1ere carte doit porter la classe "intro" (fond assombri + flou)');
  guidedTourStep = 1;
  tourOverlayHtml = renderGuidedTourOverlay();
  __assertOk(!tourOverlayHtml.includes('tour-overlay intro'), 'les cartes suivantes ne doivent plus avoir le fond assombri/floute');
  __assertOk(tourOverlayHtml.includes('class="tour-overlay"'), 'les cartes suivantes gardent un overlay (leger/transparent), juste sans la classe intro');
  guidedTourStep = null;
  console.log('OK: overlay du tutoriel assombri/floute uniquement sur la carte d introduction');

  // --- 62. Jauges de progression harmonisees : variable de fond dediee, bords totalement arrondis ---
  __assertOk(cssText.includes('--track-bg'), 'une variable CSS dediee au fond des jauges de progression doit exister');
  __assertOk(cssText.includes('border-radius: 9999px'), 'les jauges harmonisees doivent utiliser des bords totalement arrondis (pilule)');
  console.log('OK: jauges de progression (serie/XP/trophee) harmonisees sur un meme langage visuel');

  // --- 63. Hierarchie Hardcore : le compteur Hardcore devient principal une fois
  // l objectif normal atteint (objectif normal relegue en mention discrete) ---
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  const cFor63 = getChallenge();
  const entry63 = getEntry(pompes.id);
  entry63.sets = [cFor63.target]; // objectif normal atteint
  entry63.done = true;
  entry63.hardcoreDone = false;
  render(false);
  const detail63Html = document.getElementById('app').innerHTML;
  __assertOk(detail63Html.includes('normal-objective-recap'), 'l objectif normal termine doit passer en mention discrete');
  __assertOk(detail63Html.includes('Objectif normal'), 'texte de la mention discrete attendu');
  __assertOk(detail63Html.includes('hardcore-tag'), 'une etiquette Hardcore doit accompagner le nouveau compteur principal');
  __assertOk(detail63Html.includes('progress-row hardcore-primary'), 'le compteur Hardcore doit utiliser la mise en forme "primaire" (grande, orange)');
  const hcTarget63 = getHardcoreTarget(cFor63);
  __assertOk(detail63Html.includes('<span class="progress-current">' + cFor63.target + '</span><span class="progress-target"> / ' + hcTarget63 + '</span>'), 'le grand compteur mis en avant doit afficher la progression VERS l objectif Hardcore, pas l objectif normal');
  currentChallengeId = null;
  console.log('OK: une fois l objectif normal atteint, le compteur Hardcore devient principal (objectif normal relegue en mention discrete)');

  // --- 64. Wheel picker : calcul de l index actif (base de la mise en valeur du chiffre centre) ---
  const elAge64 = document.getElementById('pfAge');
  elAge64.dataset = { min: '12', max: '100', step: '1', itemHeight: '44' };
  elAge64.scrollTop = 0;
  __assertEq(computeWheelPickerActiveIndex('pfAge'), 0, 'index 0 attendu au tout debut du rouleau');
  elAge64.scrollTop = 44 * 5;
  __assertEq(computeWheelPickerActiveIndex('pfAge'), 5, 'index doit suivre le scrollTop (5 crans plus loin)');
  elAge64.scrollTop = 999999; // rebond elastique
  __assertEq(computeWheelPickerActiveIndex('pfAge'), 88, 'doit se clamper au dernier index valide (12 a 100 = 88 crans)');
  updateWheelPickerActiveItem('pfAge'); // ne doit lever aucune exception (mock sans enfants reels : no-op tolere)
  setWheelPickerValue('pfAge', 42);
  __assertEq(getWheelPickerValue('pfAge'), 42, 'setWheelPickerValue doit toujours positionner correctement le scroll apres le refactor');
  console.log('OK: wheel picker - calcul fiable de l index actif (mise en valeur du chiffre centre)');

  // --- 65. Bulle du tutoriel : relief "3D" (ombre + animation d entree) sans flou sur
  // les etapes 2+, flou renforce (6px) reserve a la carte de bienvenue ---
  __assertOk(cssText.includes('blur(6px)'), 'le flou de la carte de bienvenue doit etre passe a 6px');
  __assertOk(cssText.includes('tour-bubble-pop-in'), 'une animation d entree doit renforcer l effet de relief/3D de la bulle');
  console.log('OK: relief "3D" de la bulle du tutoriel (ombre + animation), flou reserve a la carte de bienvenue');

  // --- 66. Semaine calendaire (Lundi -> Dimanche) : remplace la fenetre glissante des
  // 7 derniers jours, numero du jour affiche dans le cercle tant qu il n est pas valide ---
  {
    const refDate = new Date('2026-07-31T12:00:00'); // vendredi 31 juillet 2026
    const weekDates = getCalendarWeekDates(refDate);
    __assertEq(weekDates.length, 7, 'la semaine calendaire doit contenir 7 dates');
    __assertEq(weekDates[0].getDay(), 1, 'le premier jour de la semaine doit etre un Lundi');
    __assertEq(weekDates[6].getDay(), 0, 'le dernier jour de la semaine doit etre un Dimanche');
    __assertEq(dateKey(weekDates[0]), '2026-07-27', 'le Lundi de cette semaine doit etre le 27 juillet 2026');
    __assertEq(dateKey(weekDates[6]), '2026-08-02', 'le Dimanche de cette semaine doit etre le 2 aout 2026');
  }
  activeToday = new Set();
  state = emptyDayState();
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const weekStripFullHtml = document.getElementById('app').innerHTML;
  const weekStripIdx = weekStripFullHtml.indexOf('week-strip');
  __assertOk(weekStripIdx !== -1, 'la bande de la semaine doit etre affichee sur Aujourd hui');
  const weekStripSlice = weekStripFullHtml.slice(weekStripIdx);
  const firstDowMatch = weekStripSlice.match(/class="dow">([^<]+)</);
  __assertOk(!!firstDowMatch, 'le libelle du premier jour doit etre present');
  __assertEq(firstDowMatch[1], 'L', 'le premier jour affiche doit etre Lundi (L), pas Dimanche');
  __assertOk(/class="week-dot[^"]*">[0-9]{1,2}</.test(weekStripSlice), 'un numero de jour doit s afficher dans un cercle non encore valide');
  console.log('OK: semaine calendaire Lundi -> Dimanche avec numero du jour dans le cercle');

  // --- 67. Teaser "prochains trophées à portée de main" : remplace la carte statique
  // vide quand aucun trophée n est encore débloqué ---
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 };
  const noTrophyHtml = renderBadgesStrip();
  __assertOk(noTrophyHtml.includes('Prochains trophées à portée de main'), 'le module teaser doit remplacer le message statique vide');
  __assertOk(!noTrophyHtml.includes('badges-empty'), 'l ancienne carte statique ne doit plus apparaitre');
  __assertOk(!noTrophyHtml.includes('Termine des défis pour débloquer'), 'l ancien message statique ne doit plus apparaitre');
  const nextTrophyCount = (noTrophyHtml.match(/next-trophy-card/g) || []).length;
  __assertOk(nextTrophyCount >= 2 && nextTrophyCount <= 3, 'le teaser doit afficher 2 a 3 trophees les plus proches');
  __assertOk(noTrophyHtml.includes('next-trophy-fill'), 'chaque carte teaser doit avoir sa propre barre de progression');
  __assertOk(noTrophyHtml.includes("showTrophyDetailModal('"), 'chaque carte teaser doit ouvrir la modal de detail du trophee au clic');
  console.log('OK: teaser des prochains trophées (2-3 cartes, icone + progression, cliquables)');

  // --- 67bis. Regression corrigee : le teaser doit s afficher meme quand des trophées
  // sont DÉJÀ débloqués (avant le correctif, seule la branche "0 débloqué" était
  // remplacée, donc l ancienne bande des trophées déjà réussis revenait dès le 1er badge) ---
  badges = { totalCompletions: 10, unlocked: ['streak_3', 'comp_10'], totalHardcore: 0 };
  const someUnlockedHtml = renderBadgesStrip();
  __assertOk(someUnlockedHtml.includes('Prochains trophées à portée de main'), 'le teaser doit s afficher meme avec des trophées deja debloques');
  __assertOk(!someUnlockedHtml.includes('badges-strip'), 'l ancienne bande des trophées deja reussis ne doit plus jamais s afficher sur Aujourd hui');
  __assertOk(!someUnlockedHtml.includes('streak_3'), 'un trophee deja debloque ne doit pas apparaitre parmi les prochains a debloquer');
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 }; // restaure l etat par defaut pour la suite des tests
  console.log('OK: le teaser reste affiche meme avec des trophées deja débloqués (regression corrigee)');

  // --- 68. Défis : contrôle d'activation explicite (bouton), pas seulement la ligne cliquable ---
  const pompesInactive = CHALLENGE_LIBRARY.find(x => x.name === 'Pompes');
  activeToday = new Set(); // aucun défi actif -> ce défi est inactif
  const inactiveCardHtml = renderChallengeCard(pompesInactive, 'library');
  __assertOk(inactiveCardHtml.includes('+ Activer'), 'un défi inactif doit afficher un bouton "+ Activer" explicite');
  __assertOk(!inactiveCardHtml.includes('activate-toggle-btn active'), 'le bouton ne doit pas porter la classe active pour un défi inactif');
  activeToday = new Set([pompesInactive.id]);
  const activeCardHtml = renderChallengeCard(pompesInactive, 'library');
  __assertOk(activeCardHtml.includes('activate-toggle-btn active'), 'un défi actif doit afficher le bouton dans son état actif');
  __assertOk(activeCardHtml.includes('✓ Actif'), 'le bouton actif doit afficher "✓ Actif"');
  __assertOk(activeCardHtml.includes('toggleActiveToday(' + pompesInactive.id + ')'), 'le bouton doit rester relié à toggleActiveToday');
  console.log('OK: bouton d activation explicite (+ Activer / ✓ Actif) sur les cartes Défis');

  // --- 69. Harmonisation des noms d'exercices (catalogue + table des pictogrammes en phase) ---
  const renamedPairs = [
    ['Élévations latérales', 'epaule_raise'],
    ['Presse cubaine', 'cuban_press'],
    ['Tirage haltères', 'rowing'],
    ['Extensions triceps nuque', 'extension_nuque'],
  ];
  for (const [name, expectedKey] of renamedPairs) {
    const lib = CHALLENGE_LIBRARY.find(x => x.name === name);
    __assertOk(!!lib, 'le défi renommé "' + name + '" doit exister dans CHALLENGE_LIBRARY');
    __assertEq(getExercisePictogramKey(lib), expectedKey, 'le pictogramme de "' + name + '" doit rester "' + expectedKey + '" apres renommage');
  }
  __assertOk(!CHALLENGE_LIBRARY.some(x => ['Épaule lateral raise', 'Cuban press', 'Rowing haltère', 'Extension triceps nuque'].includes(x.name)), 'les anciens noms d exercices ne doivent plus exister');
  console.log('OK: noms d exercices harmonisés en français correct, pictogrammes toujours résolus');

  // --- 70. Grille +5/+10/+15/+20/+25/+30 : 3 colonnes fixes (plus d auto-fit imprevisible) ---
  const qagIdx = cssText.indexOf('.quick-add-grid {');
  const qagBlock = cssText.slice(qagIdx, cssText.indexOf('}', qagIdx));
  __assertOk(qagBlock.includes('grid-template-columns: repeat(3, 1fr)'), 'la grille rapide doit forcer exactement 3 colonnes');
  __assertOk(!qagBlock.includes('auto-fit'), 'l ancien auto-fit (source du bouton isole) ne doit plus etre utilise');
  console.log('OK: grille de séries rapides forcée en 3x2 (3 colonnes fixes)');

  // --- 71. Bouton "Modifier" : icône crayon discrète, plus de mot "modifier" au milieu du texte ---
  const pompesForTarget = CHALLENGE_LIBRARY.find(x => x.name === 'Pompes');
  await pickChallenge(pompesForTarget.id);
  render(false);
  const detailForTargetHtml = document.getElementById('app').innerHTML;
  __assertOk(detailForTargetHtml.includes('class="target-edit"'), 'le bouton d edition de l objectif doit toujours exister');
  __assertOk(detailForTargetHtml.includes('✏️'), 'le bouton d edition doit afficher une icône crayon');
  __assertOk(!detailForTargetHtml.includes('>modifier<'), 'le mot "modifier" ne doit plus apparaitre comme texte du bouton, coince dans les reps');
  currentChallengeId = null;
  console.log('OK: bouton "modifier" remplacé par une icône crayon à côté de l objectif');

  // --- 72. Bandeau "Chaque bras doit faire X reps" : design dark + bordure néon orange #FF5500 ---
  const amsIdx = cssText.indexOf('.arm-mode-sentence {');
  const amsBlock = cssText.slice(amsIdx, cssText.indexOf('}', amsIdx));
  __assertOk(amsBlock.includes('border: 1px solid #FF5500'), 'la bordure du bandeau doit etre en néon orange #FF5500');
  __assertOk(amsBlock.includes('color: #ffffff'), 'le texte du bandeau doit etre blanc vif');
  __assertOk(cssText.includes('.arm-mode-sentence-icon'), 'l icône du bandeau doit être stylée séparément (orange contrastée)');
  const rowingChallenge = CHALLENGE_LIBRARY.find(x => x.name === 'Tirage haltères'); // armMode: perArm
  await pickChallenge(rowingChallenge.id);
  render(false);
  const armSentenceHtml = document.getElementById('app').innerHTML;
  __assertOk(armSentenceHtml.includes('arm-mode-sentence-icon'), 'la fiche d un défi perArm doit utiliser l icône stylée du bandeau');
  currentChallengeId = null;
  console.log('OK: bandeau de consigne par bras restylé (dark + néon orange + icône contrastée)');

  // --- 73. Alignement vertical des cartes Défis : ANNULE (le rendu ne convenait pas) —
  // retour au centrage d origine du contenu de la carte ---
  const piIdx = cssText.indexOf('.picker-item {');
  const piBlock = cssText.slice(piIdx, cssText.indexOf('}', piIdx));
  __assertOk(piBlock.includes('align-items: center'), 'la carte défi doit revenir a son centrage d origine (modif annulee)');
  __assertOk(!piBlock.includes('align-items: flex-start'), 'l alignement en haut (annule) ne doit plus etre applique');
  console.log('OK: alignement vertical des cartes Défis revenu au centrage d origine (annulation)');

  // --- 74. Ecran vide Aujourd hui : vocabulaire harmonise (onglet Défis), icone cible,
  // et contraste de la date ameliore ---
  const emptyStateHtml2 = renderTodayEmptyState();
  __assertOk(emptyStateHtml2.includes("Rendez-vous dans l'onglet Défis pour choisir tes défis du jour !"), 'le texte doit renvoyer vers l onglet Défis (pas la Bibliothèque)');
  __assertOk(!emptyStateHtml2.includes('Bibliothèque'), 'le mot Bibliotheque ne doit plus apparaitre dans l etat vide');
  __assertOk(emptyStateHtml2.includes('🎯 Choisir un défi'), 'le bouton CTA doit utiliser l icone cible 🎯 (identique a l onglet Défis)');
  __assertOk(!emptyStateHtml2.includes('📚'), 'l icone livre 📚 ne doit plus apparaitre sur le bouton de l etat vide');
  const headerDateIdx = cssText.indexOf('.header .date {');
  const headerDateBlock = cssText.slice(headerDateIdx, cssText.indexOf('}', headerDateIdx));
  __assertOk(headerDateBlock.includes('#D1D5DB') || headerDateBlock.includes('#9CA3AF'), 'la date doit utiliser une couleur claire et lisible sur fond noir');
  console.log('OK: ecran vide harmonise (onglet Défis, icone cible) + contraste de la date ameliore');

  // --- 75. Poids des halteres : bouton "modifier" remplace par une icone crayon ---
  const tricepsForWeight = CHALLENGE_LIBRARY.find(x => x.name === 'Triceps'); // Haltères
  await pickChallenge(tricepsForWeight.id);
  render(false);
  const weightDetailHtml = document.getElementById('app').innerHTML;
  __assertOk(weightDetailHtml.includes('class="weight-pill"'), 'la pastille de poids doit toujours exister');
  __assertOk(weightDetailHtml.includes('✏️'), 'le bouton de modification du poids doit afficher une icone crayon');
  __assertOk(!weightDetailHtml.includes('>modifier<'), 'le mot "modifier" ne doit plus apparaitre comme texte du bouton de poids');
  currentChallengeId = null;
  console.log('OK: bouton "modifier" du poids remplacé par une icône crayon');

  // --- 76. Journal : le calendrier doit afficher TOUS les jours du mois en cours (bug
  // corrigé : l ancienne fenêtre glissante de 28 jours faisait disparaitre les 1ers
  // jours du mois sur un mois de 30/31 jours) ---
  activeTab = 'account';
  profileView = 'journal';
  historyEntries = [];
  historyLoading = false;
  const monthHtml = renderAccountTabScreen();
  const today76 = new Date();
  const daysInMonth76 = new Date(today76.getFullYear(), today76.getMonth() + 1, 0).getDate();
  // Ne pas verifier de chiffre precis dans le texte : si "aujourd'hui" correspond au
  // jour verifie, la cellule affiche "✓" (fait) au lieu du numero — le compte total de
  // cellules (ci-dessous) prouve deja, de maniere fiable, qu aucun jour n est manquant.
  const totalCalCells = (monthHtml.match(/cal-cell/g) || []).length;
  const emptyCalCells = (monthHtml.match(/cal-cell empty/g) || []).length;
  __assertEq(totalCalCells - emptyCalCells, daysInMonth76, 'le calendrier doit contenir exactement une cellule pour chaque jour du mois en cours');
  activeTab = 'today';
  profileView = 'profile';
  console.log('OK: calendrier du mois affiche tous les jours (1er au dernier), plus de fenetre glissante de 28 jours');

  // --- 77. Heatmap : ligne d en-tete avec les noms abreges des mois au-dessus des colonnes ---
  const heatmapHtml = renderHeatmap();
  __assertOk(heatmapHtml.includes('heatmap-months'), 'la heatmap doit avoir une ligne d en-tete des mois');
  const monthLabelCount = (heatmapHtml.match(/heat-month-label/g) || []).length;
  __assertEq(monthLabelCount, 26, 'il doit y avoir un libelle (potentiellement vide) pour chacune des 26 colonnes/semaines');
  const nonEmptyMonthLabels = [...heatmapHtml.matchAll(/heat-month-label">([^<]+)</g)];
  __assertOk(nonEmptyMonthLabels.length >= 5 && nonEmptyMonthLabels.length <= 7, 'environ 6 libelles de mois doivent apparaitre sur une periode de 6 mois');
  const monthNamesFound = nonEmptyMonthLabels.map(m => m[1]);
  const validMonthAbbr = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  __assertOk(monthNamesFound.every(name => validMonthAbbr.includes(name)), 'les libelles doivent etre des noms de mois abreges valides');
  console.log('OK: en-tete des mois ajoutee au-dessus de la heatmap (repères temporels)');

  // --- 78. Pop-up Serie : chiffre nettement agrandi (point focal principal) ---
  const bigIdx = cssText.indexOf('.app-popup-big.big-highlight');
  __assertOk(bigIdx !== -1, 'une classe dediee doit agrandir significativement le chiffre de la serie');
  const bigBlock = cssText.slice(bigIdx, cssText.indexOf('}', bigIdx));
  const fontSizeMatch = bigBlock.match(/font-size: ([0-9]+)px/);
  __assertOk(!!fontSizeMatch && parseInt(fontSizeMatch[1], 10) >= 56, 'le chiffre de la serie doit etre nettement plus grand que le "big" generique (30px)');
  streakCount = 12; hasShield = true;
  popupQueue = []; popupOpen = false;
  showStreakInfoModal();
  __assertOk(currentPopupHtml.includes('big-highlight'), 'la modale de serie doit utiliser la variante chiffre en vedette');
  document.getElementById('appPopupCloseX').onclick();
  console.log('OK: chiffre de la serie agrandi (point focal de la modale)');

  // --- 79. Chrono : icone Play/valider remontee, espacement haut/bas rapproche de la symetrie ---
  const trIdx = cssText.indexOf('.timer-ring-center {');
  const trBlock = cssText.slice(trIdx, cssText.indexOf('}', trIdx));
  __assertOk(trBlock.includes('calc(-50% - 14px)'), 'le groupe temps+icone doit etre remonte pour equilibrer les marges haut/bas');
  const tpIdx = cssText.indexOf('.timer-play-icon {');
  const tpBlock = cssText.slice(tpIdx, cssText.indexOf('}', tpIdx));
  __assertOk(tpBlock.includes('translate(-50%, 4px)'), 'icone par defaut remontee (4px au lieu de 8px)');
  console.log('OK: icone du chrono remontee, espacement haut/bas rapproche de la symetrie');

  // --- 80. Aujourd hui : espacement accru + module trophees cale en bas quand la liste est courte ---
  activeToday = new Set([pompes.id]);
  state = emptyDayState();
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const homeLayoutHtml = document.getElementById('app').innerHTML;
  __assertOk(homeLayoutHtml.includes('today-content-flex'), 'la liste + les trophees doivent partager un conteneur flex dedie');
  __assertOk(homeLayoutHtml.includes('home-trophies-slot'), 'le module trophees doit etre dans un slot dedie (marge auto vers le bas)');
  const tcfIdx = cssText.indexOf('.today-content-flex {');
  const tcfBlock = cssText.slice(tcfIdx, cssText.indexOf('}', tcfIdx));
  __assertOk(tcfBlock.includes('flex-direction: column'), 'le conteneur doit etre une colonne flex');
  __assertOk(tcfBlock.includes('min-height'), 'min-height (pas height) pour ne jamais bloquer le defilement si la liste deborde');
  const htsIdx = cssText.indexOf('.home-trophies-slot {');
  const htsBlock = cssText.slice(htsIdx, cssText.indexOf('}', htsIdx));
  __assertOk(htsBlock.includes('margin-top: auto'), 'le slot trophees doit se caler en bas via margin-top:auto');
  __assertOk(htsBlock.includes('padding-top'), 'un espacement vertical accru doit preceder le module trophees');
  console.log('OK: mise en page Aujourd hui (espacement accru + trophees cales en bas si peu de defis)');

  // --- 81. Journal : chaque case du calendrier est cliquable, ouvre le detail du jour ---
  activeTab = 'account';
  profileView = 'journal';
  historyEntries = [];
  historyLoading = false;
  const calMonthHtml = renderAccountTabScreen();
  __assertOk(calMonthHtml.includes("showDayDetailModal('"), 'chaque case reelle du calendrier doit ouvrir la modal de detail du jour au clic');
  activeTab = 'today';
  profileView = 'profile';
  const pompesForDay = CHALLENGE_LIBRARY.find(x => x.name === 'Pompes');
  state = emptyDayState();
  state.challenges[pompesForDay.id] = { sets: [50, 50], targetOverride: null, done: true, hardcoreDone: false, hardcoreAnnounced: false };
  await saveState();
  popupQueue = []; popupOpen = false;
  await showDayDetailModal(todayKey);
  __assertOk(popupOpen, 'cliquer sur un jour avec des donnees doit ouvrir une popup');
  __assertOk(currentPopupHtml.includes('history-entry'), 'la popup doit lister les defis valides ce jour-la');
  __assertOk(currentPopupHtml.includes('Pompes'), 'le nom du defi valide doit apparaitre dans la liste');
  __assertOk(currentPopupHtml.includes('100/'), 'le total valide (50+50) doit apparaitre');
  document.getElementById('appPopupCloseX').onclick();
  await showDayDetailModal('2000-01-01');
  __assertOk(currentPopupHtml.includes('Aucun défi validé ce jour'), 'un jour sans defi doit afficher un etat vide explicite');
  document.getElementById('appPopupCloseX').onclick();
  console.log('OK: calendrier interactif (cases cliquables, popup detail du jour, etat vide propre)');

  // --- 82. Cartes a chronometre (Aujourd hui/Défis) : format allege "XX min XX s"
  // (plus de cumul brut en secondes du type "375 SEC" devant) ---
  const plancheForCard = CHALLENGE_LIBRARY.find(x => x.unit === 'sec');
  __assertOk(!!plancheForCard, 'un defi en secondes doit exister dans le catalogue pour ce test');
  const secCardToday = renderChallengeCard(plancheForCard, 'today');
  const secCardLibrary = renderChallengeCard(plancheForCard, 'library');
  for (const cardHtml of [secCardToday, secCardLibrary]) {
    __assertOk(!cardHtml.includes('SEC'), 'le cumul brut en secondes (SEC) ne doit plus apparaitre sur les cartes');
    __assertOk(cardHtml.includes('min') || cardHtml.includes(' s'), 'le format allege minutes/secondes doit etre affiche');
  }
  console.log('OK: cartes a chronometre allegees (uniquement XX min XX s, plus de cumul brut en SEC)');

  // --- 82bis. Desynchronisation carte accueil / fiche detail (bug de prod signale) :
  // apres avoir augmente l objectif DU JOUR via le crayon editTarget() (entry.targetOverride),
  // le libelle "goal" de la carte affichait TOUJOURS l objectif standard resolu au lieu de
  // l objectif du jour reellement utilise par getTarget() sur la fiche detail -> carte et
  // fiche montraient 2 chiffres differents pour le meme defi. ---
  const pompesForOverride = CHALLENGE_LIBRARY.find(x => x.name === 'Pompes');
  const resolvedPompesOverride = resolveChallenge(pompesForOverride);
  state = emptyDayState();
  state.challenges[pompesForOverride.id] = { sets: [], targetOverride: resolvedPompesOverride.target + 35, done: false, hardcoreDone: false, hardcoreAnnounced: false };
  activeToday = new Set([pompesForOverride.id]);
  currentChallengeId = pompesForOverride.id;
  __assertEq(getTarget(), resolvedPompesOverride.target + 35, 'la fiche detail (getTarget()) doit utiliser l objectif du jour modifie');
  const cardWithOverrideHtml = renderChallengeCard(pompesForOverride, 'today');
  __assertOk(cardWithOverrideHtml.includes((resolvedPompesOverride.target + 35) + ' reps'), 'la carte doit afficher le MEME objectif du jour que la fiche detail, pas l objectif standard');
  __assertOk(!cardWithOverrideHtml.includes(resolvedPompesOverride.target + ' reps'), 'l ancien objectif standard ne doit plus apparaitre sur la carte une fois l objectif du jour modifie');
  // La ligne "En cours" (une fois une 1ere serie loggee) doit rester cohérente avec ce meme objectif.
  state.challenges[pompesForOverride.id].sets = [10];
  const cardWithOverrideProgressHtml = renderChallengeCard(pompesForOverride, 'today');
  __assertOk(cardWithOverrideProgressHtml.includes('10/' + (resolvedPompesOverride.target + 35)), 'la ligne "En cours" doit aussi refleter l objectif du jour modifie');
  // En mode bibliotheque (aucune notion de "jour" en cours), l objectif standard reste affiche tel quel.
  const libCardIgnoresOverrideHtml = renderChallengeCard(pompesForOverride, 'library');
  __assertOk(libCardIgnoresOverrideHtml.includes(resolvedPompesOverride.target + ' reps'), 'la bibliotheque doit continuer d afficher l objectif standard (pas de contexte "aujourd hui" a y refleter)');
  state = emptyDayState();
  activeToday = new Set();
  currentChallengeId = null;
  console.log('OK: la carte d accueil et la fiche detail affichent desormais le meme objectif (respecte l objectif du jour modifie)');

  // --- 82ter. Desynchronisation accueil / bibliotheque SANS AUCUN objectif du jour
  // modifie (vrai bug de prod signale : Pompes affichait 120 sur l accueil, 110 sur la
  // bibliotheque/fiche detail, alors qu aucun objectif n avait ete touche). Cause reelle :
  // l ecran d accueil pre-resolvait deja activeChallenges via
  // CHALLENGES.filter(...).map(resolveChallenge) AVANT de les passer a
  // renderChallengeCard(), qui appelle resolveChallenge() une 2e fois en interne -> les
  // coefficients de profil (niveau/age/sexe/IMC) etaient appliques DEUX FOIS sur
  // l accueil uniquement (la bibliotheque, elle, passe des defis BRUTS et n est resolue
  // qu une seule fois). ---
  delete manualTargetOverrides[pompesForOverride.id];
  userProfile = { age: 34, sex: 'homme', heightCm: 180, weightKg: 78, level: 'avance' };
  const singleResolvedPompes = resolveChallenge(pompesForOverride);
  __assertOk(singleResolvedPompes.target !== pompesForOverride.target, 'ce profil doit reellement faire varier l objectif pour que le test soit probant');
  state = emptyDayState();
  activeToday = new Set([pompesForOverride.id]);
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const homeScreenHtml = document.getElementById('app').innerHTML;
  __assertOk(homeScreenHtml.includes(singleResolvedPompes.target + ' reps'), 'l accueil doit afficher l objectif resolu UNE SEULE fois (identique a resolveChallenge()), pas un objectif double-applique');
  const libCardSingleResHtml = renderChallengeCard(pompesForOverride, 'library');
  __assertOk(libCardSingleResHtml.includes(singleResolvedPompes.target + ' reps'), 'la bibliotheque doit afficher exactement le meme objectif que l accueil pour le meme defi non modifie');
  state = emptyDayState();
  activeToday = new Set();
  activeTab = 'today';
  userProfile = null;
  console.log('OK: accueil et bibliotheque affichent le meme objectif (plus de double application des coefficients de profil sur l accueil)');

  // --- 83. Heatmap : un mois n est libelle que s il est ENTIEREMENT visible, càd que
  // son 1er jour est present dans la fenetre de 26 semaines (comme le graphique de
  // contributions GitHub : le libelle marque la colonne qui contient le jour 1, pas
  // seulement le mois du Lundi de la colonne, sinon le mois en cours pouvait etre rate
  // quand il demarre au milieu d une semaine, ex: le 1er tombant un samedi). ---
  const MONTH_ABBR_TEST = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  const heatmapHtml2 = renderHeatmap();
  const monthLabels = [...heatmapHtml2.matchAll(/heat-month-label">([^<]*)</g)];
  __assertEq(monthLabels.length, 26, 'il doit y avoir 26 cases dans la ligne des mois');
  const monthNamesFound2 = monthLabels.map(m => m[1]).filter(x => x !== '');
  __assertOk(monthNamesFound2.includes(MONTH_ABBR_TEST[new Date().getMonth()]), 'le mois en cours (non termine, meme s il demarre en milieu de semaine) doit tout de meme etre libelle');
  __assertEq(new Set(monthNamesFound2).size, monthNamesFound2.length, 'chaque mois ne doit apparaitre au plus qu une seule fois dans la ligne des mois');
  // Reproduit independamment la regle de la 1ere colonne (Lundi de la semaine courante
  // moins 25 semaines) : elle n est libelee que si un jour 1 tombe reellement dedans.
  const cwMonday = getCalendarWeekDates(new Date())[0];
  const startH = new Date(cwMonday);
  startH.setDate(startH.getDate() - 25 * 7);
  let expectedFirstColLabel = '';
  for (let i = 0; i < 7; i++) {
    const dd = new Date(startH);
    dd.setDate(startH.getDate() + i);
    if (dd.getDate() === 1) { expectedFirstColLabel = MONTH_ABBR_TEST[dd.getMonth()]; break; }
  }
  __assertEq(monthLabels[0][1], expectedFirstColLabel, 'la 1ere colonne ne doit etre libelee que si elle contient effectivement un 1er jour de mois');
  console.log('OK: heatmap - seuls les mois entierement visibles sont libelles (1ere colonne toujours vide)');

  // --- 84. REGRESSION CRITIQUE DEJA VECUE : le script inline de l appli ne doit
  // JAMAIS porter l attribut defer. Cet attribut est ignore par les navigateurs sur
  // un script SANS src (aucun effet, cf. spec HTML/MDN) : si les 3 SDK Firebase
  // externes sont en defer mais que le script inline ne l est PAS (son seul
  // comportement possible), ce dernier s execute immediatement a sa position, AVANT
  // que les SDK differes aient fini de charger -> throw immediat sur
  // firebase.initializeApp(...) ("firebase is not defined") qui stoppe tout le
  // script -> #loginScreen/#app restent display:none pour toujours -> ecran noir
  // complet en production. Deja vecu et corrige une fois, ne pas reintroduire. ---
  const scriptTagsFound = [...__rawHtml.matchAll(/<script[^>]*>/g)].map(m => m[0]);
  const inlineAppScriptTag = scriptTagsFound.find(t => !t.includes('src='));
  __assertOk(!!inlineAppScriptTag, 'le tag du script inline de l appli doit etre trouvable');
  __assertOk(!inlineAppScriptTag.includes('defer'), 'le script inline de l appli ne doit jamais porter defer (no-op sur un script sans src, casse l ordre avec les SDK Firebase differes)');
  __assertOk(!inlineAppScriptTag.includes('async'), 'le script inline de l appli ne doit jamais porter async, pour la meme raison');
  const firebaseScriptTags = scriptTagsFound.filter(t => t.includes('gstatic.com/firebasejs'));
  __assertEq(firebaseScriptTags.length, 5, 'les 5 SDK Firebase doivent etre presents (app/auth/firestore/functions + messaging depuis les notifications push Phase B)');
  __assertOk(firebaseScriptTags.every(t => !t.includes('defer') && !t.includes('async')), 'les SDK Firebase doivent rester charges de maniere synchrone (coherent avec le script inline non differe)');
  console.log('OK: SDK Firebase + script inline charges de maniere synchrone (pas de defer/async, ordre garanti)');

  // --- 85. Performance : persistance locale Firestore (IndexedDB) activee ---
  __assertOk(__rawHtml.includes('enablePersistence({ synchronizeTabs: true })'), 'la persistance locale Firestore doit etre activee (cache IndexedDB entre sessions)');
  console.log('OK: persistance locale Firestore activee');

  // --- 86. Performance : le service worker alimente desormais son cache sur un miss
  // (avant, le repli cache-first pour icones/manifest/IMAGES ne populait jamais le
  // cache : aucun gain, ni hors-ligne, pour les assets les plus lourds de l appli) ---
  __assertOk(__swSource.length > 0, 'service-worker.js doit etre lisible pour ce test');
  __assertOk(__swSource.includes("'defi-du-jour-v89'"), 'la version du cache doit avoir ete incrementee suite au changement de logique');
  __assertOk(__swSource.includes("'./assets/sounds/success.mp3'"), 'le fichier audio de reussite doit etre precache pour rester disponible hors ligne des le 1er lancement');
  const cachePutCount = __swSource.split('cache.put(event.request, clone)').length - 1;
  __assertEq(cachePutCount, 2, 'cache.put doit alimenter le cache a la fois pour le HTML et pour le repli icones/manifest/images');
  console.log('OK: service worker alimente desormais son cache pour les images (auparavant aucun gain)');

  // --- 86bis. Service worker : ignore les requetes non http(s) (ex: chrome-extension://
  // injectees par une extension du navigateur) AVANT tout traitement -- Cache.put() ne
  // supporte que http(s) et levait une exception non interceptee sur ces schemas ---
  const fetchListenerIdx = __swSource.indexOf("addEventListener('fetch'");
  const guardIdx = __swSource.indexOf("event.request.url.startsWith('http')", fetchListenerIdx);
  __assertOk(fetchListenerIdx !== -1 && guardIdx !== -1, 'le handler fetch doit filtrer les schemas non http(s) avant toute mise en cache');
  __assertOk(guardIdx < __swSource.indexOf('cache.put', fetchListenerIdx), 'le filtre de schema doit intervenir AVANT le premier cache.put (sinon l exception reste possible)');
  console.log('OK: service worker ignore les requetes non http(s) (chrome-extension:// etc.)');

  // --- 87. Demarrage : loadAppData() (chemin rapide, document consolide deja
  // migre) charge a elle seule customChallenges/CHALLENGES en UNE lecture, sans
  // aucun appel separe a loadChallenges() (fusion Firestore, #28) ---
  __appDataStore.exists = true;
  __appDataStore.data = { ...__appDataStore.data, customChallenges: [{ id: 9002, cat: 'Test', name: 'Perf Custom', target: 30, unit: 'reps', hardcoreTarget: 60, isCustom: true }] };
  customChallenges = [];
  CHALLENGES = [];
  activeToday = new Set();
  currentChallengeId = null;
  activeTab = 'today';
  await loadAppData(); // une seule lecture Firestore pour tout le profil/donnees statiques
  __assertOk(customChallenges.some(x => x.name === 'Perf Custom'), 'loadAppData() doit a elle seule charger customChallenges depuis le document consolide');
  __assertOk(CHALLENGES.some(x => x.name === 'Perf Custom'), 'CHALLENGES doit refleter le defi personnalise charge par loadAppData()');
  console.log('OK: demarrage - loadAppData() remplace les lectures separees (une seule lecture Firestore pour le profil/donnees statiques)');

  // --- 88. Cles de pictogramme sans image connue (PICTOGRAM_ASSET_MISSING) : rendu
  // SVG direct, aucune requete reseau vouee a un 404 garanti ---
  const expectedMissingKeys = ['pompes_iso', 'pompes_larges', 'mountain_climbers', 'squats_sumo', 'tirage_elastique', 'generic', 'dumbbell_generic'];
  for (const mk of expectedMissingKeys) {
    __assertOk(PICTOGRAM_ASSET_MISSING.has(mk), 'la cle "' + mk + '" doit etre listee comme sans image sur le disque');
  }
  const runningCustom = { id: 9101, cat: 'Cardio', name: 'Ma course perso', target: 100, unit: 'reps' };
  const missingKeyPictoHtml = renderExercisePicto(runningCustom);
  __assertOk(!missingKeyPictoHtml.includes('<img'), 'aucune balise img ne doit etre rendue pour une cle de pictogramme connue comme manquante');
  __assertOk(missingKeyPictoHtml.includes('exercise-picto loaded'), 'le conteneur doit etre marque loaded immediatement (rien a charger, pas de skeleton fantome)');
  console.log('OK: cles de pictogramme sans image connue -> SVG direct, aucune requete reseau 404');

  // --- 89. Images : WebP essaye en premier (bien plus leger que le PNG/APNG source),
  // repli PNG puis SVG en cascade (onerror), sans modification de code necessaire au
  // fur et a mesure que les .webp arrivent (generate-webp-assets.py) ---
  const pompesForWebp = CHALLENGE_LIBRARY.find(x => x.name === 'Pompes');
  const webpPictoHtml = renderExercisePicto(pompesForWebp);
  __assertOk(webpPictoHtml.includes('exercices/pompes-static.webp'), 'la miniature doit essayer le WebP en premier');
  __assertOk(webpPictoHtml.includes('exercices/pompes-static.png'), 'le repli PNG doit rester cable via onerror');
  __assertOk(webpPictoHtml.includes('loading="lazy"') && webpPictoHtml.includes('decoding="async"'), 'la miniature doit etre lazy et decodee de maniere asynchrone');
  __assertOk(webpPictoHtml.includes('width="64" height="64"'), 'la miniature doit fixer sa largeur/hauteur (coherent avec le conteneur, evite tout redimensionnement au decodage)');

  await pickChallenge(pompesForWebp.id);
  render(false);
  const heroWebpHtml = document.getElementById('app').innerHTML;
  __assertOk(heroWebpHtml.includes('exercices/pompes.webp'), 'l image hero de la fiche detail doit essayer le WebP en premier');
  __assertOk(heroWebpHtml.includes('exercices/pompes.png'), 'le repli PNG de l image hero doit rester cable via onerror');
  currentChallengeId = null;
  console.log('OK: WebP essaye en premier sur les cartes et la fiche detail (repli PNG puis SVG en cascade)');

  // --- 90. Chargement percu : skeleton "shimmer" + fondu a l arrivee (classe .loaded),
  // espace reserve (aspect-ratio) pour ne jamais provoquer de saut de mise en page (CLS) ---
  __assertOk(cssText.includes('picto-shimmer'), 'un skeleton shimmer doit exister pour les miniatures en cours de chargement');
  __assertOk(cssText.includes('.exercise-picto img.loaded { opacity: 1; }'), 'la miniature doit apparaitre en fondu une fois chargee');
  __assertOk(webpPictoHtml.includes("classList.add('loaded')"), 'la miniature doit marquer .loaded au chargement (ou au dernier repli) pour faire disparaitre le shimmer');
  const heroCssIdx = cssText.indexOf('.exercise-hero-apng {');
  const heroCssBlock = cssText.slice(heroCssIdx, cssText.indexOf('}', heroCssIdx));
  __assertOk(heroCssBlock.includes('aspect-ratio: 1 / 1'), 'l image hero doit reserver un espace carre fixe pour ne jamais provoquer de CLS (toutes les sources sont carrees)');
  console.log('OK: skeleton shimmer + fondu a l arrivee, espace reserve (CLS evite)');

  // --- 91. Filet de securite global (window.onerror/unhandledrejection) : ecran de
  // secours affiche une seule fois, avec un bouton Recharger fonctionnel ---
  __assertOk(typeof showFatalErrorScreen === 'function', 'showFatalErrorScreen doit exister');
  __assertOk(!fatalErrorShown, 'fatalErrorShown ne doit pas etre deja actif avant ce test');
  let fatalAppendCount = 0;
  const origBodyAppendChild = document.body.appendChild;
  document.body.appendChild = () => { fatalAppendCount++; };
  showFatalErrorScreen('erreur de test 1');
  showFatalErrorScreen('erreur de test 2'); // ne doit PAS re-afficher un 2e ecran
  document.body.appendChild = origBodyAppendChild;
  __assertEq(fatalAppendCount, 1, 'l ecran de secours ne doit s afficher qu une seule fois meme si plusieurs erreurs surviennent');
  __assertOk(fatalErrorShown, 'fatalErrorShown doit passer a true apres un affichage');
  __assertOk(typeof document.getElementById('fatalReloadBtn').onclick === 'function', 'le bouton Recharger doit avoir un gestionnaire de clic');
  console.log('OK: filet de securite global (ecran de secours affiche une seule fois)');

  // --- 92. Bandeau hors ligne : suit navigator.onLine, disparait/reapparait selon la
  // connectivite ---
  navigator.onLine = true;
  updateOfflineBanner();
  __assertEq(document.getElementById('offlineBanner').style.display, 'none', 'en ligne : le bandeau doit etre masque');
  navigator.onLine = false;
  updateOfflineBanner();
  __assertEq(document.getElementById('offlineBanner').style.display, 'flex', 'hors ligne : le bandeau doit etre visible');
  __assertOk(document.getElementById('offlineBanner').textContent.includes('seront synchronisées'), 'hors ligne sans ecriture en cours : message generique (#1)');
  pendingWriteCount = 2;
  updateOfflineBanner();
  __assertOk(document.getElementById('offlineBanner').textContent.includes('2 modifications en attente de synchronisation'), 'hors ligne avec ecritures en cours : le nombre en attente doit s afficher (#1)');
  pendingWriteCount = 1;
  updateOfflineBanner();
  const singularTxt = document.getElementById('offlineBanner').textContent;
  __assertOk(singularTxt.includes('1 modification en attente') && !singularTxt.includes('modifications'), 'singulier correct pour une seule ecriture en attente (#1)');
  pendingWriteCount = 0;
  navigator.onLine = true;
  updateOfflineBanner();
  console.log('OK: bandeau hors ligne suit navigator.onLine et affiche le nombre d ecritures en attente de synchronisation');

  // --- 111. pendingWriteCount (#1) : dbSet/saveAppField l incrementent bien
  // pendant l ecriture puis le decrementent (y compris en cas d erreur, via finally) ---
  navigator.onLine = false;
  const writePromise = saveAppField('xpTotal', 555);
  __assertOk(pendingWriteCount > 0, 'saveAppField doit incrementer pendingWriteCount pendant l ecriture');
  await writePromise;
  __assertEq(pendingWriteCount, 0, 'pendingWriteCount doit retomber a 0 une fois l ecriture terminee');
  navigator.onLine = true;
  updateOfflineBanner();
  console.log('OK: pendingWriteCount reflete fidelement les ecritures dbSet/saveAppField en cours');

  // --- 93. Mise a jour SW : detection structurelle (updatefound/statechange) +
  // bandeau dedie ; preconnect vers les domaines Firebase/Firestore ---
  __assertOk(__rawHtml.includes("addEventListener('updatefound'"), 'la detection de mise a jour du service worker doit etre cablee');
  __assertOk(__rawHtml.includes("newWorker.state === 'installed'") && __rawHtml.includes('navigator.serviceWorker.controller'), 'une vraie mise a jour (pas la 1ere installation) doit etre distinguee via le controller existant');
  __assertOk(__rawHtml.includes('id="updateBanner"'), 'le bandeau de mise a jour doit exister dans le HTML statique');
  __assertOk(__rawHtml.includes('id="offlineBanner"'), 'le bandeau hors ligne doit exister dans le HTML statique');
  __assertOk(__rawHtml.includes('rel="preconnect" href="https://www.gstatic.com"'), 'preconnect vers gstatic.com');
  __assertOk(__rawHtml.includes('rel="preconnect" href="https://firestore.googleapis.com"'), 'preconnect vers firestore.googleapis.com');
  console.log('OK: detection de mise a jour SW cablee, bandeaux presents, preconnect Firebase/Firestore');

  // Retour utilisateur "effet waouh" : applyContent() utilise desormais la View
  // Transitions API native quand elle est disponible, avec repli total et invisible
  // sur le fade CSS manuel sinon (le mock de test se comporte comme un navigateur
  // SANS support, exactement comme Safari < 18 - deja prouve par l ensemble de la
  // suite qui continue de passer a l identique).
  __assertOk(!('startViewTransition' in document), 'le mock de test doit se comporter comme un navigateur sans support (repli fade CSS), meme chemin que les navigateurs non-supportes en prod');
  let viewTransitionCalls = 0;
  document.startViewTransition = (cb) => { viewTransitionCalls++; cb(); return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() }; };
  activeTab = 'library';
  render(true);
  __assertEq(viewTransitionCalls, 1, 'quand document.startViewTransition existe, applyContent() doit l utiliser au lieu du fade CSS manuel');
  __assertOk(document.getElementById('app').innerHTML.length > 0, 'le contenu doit avoir ete applique de facon SYNCHRONE via le callback de startViewTransition (pas de setTimeout a attendre, contrairement au repli)');
  delete document.startViewTransition;
  console.log('OK: View Transitions API (repli total si non supportee, utilisee en priorite sinon, callback synchrone)');

  // --- 94. Securite : escapeHtml/escapeJsAttr echappent correctement les caracteres
  // dangereux (protection XSS) ---
  __assertEq(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', 'escapeHtml doit neutraliser les chevrons');
  __assertEq(escapeHtml('"quote" & <tag>'), '&quot;quote&quot; &amp; &lt;tag&gt;', 'escapeHtml doit neutraliser guillemets/esperluette/chevrons');
  __assertEq(escapeHtml(null), '', 'escapeHtml doit tolerer null/undefined sans planter');
  const BACKSLASH_CHAR = String.fromCharCode(92);
  const SQUOTE_CHAR = String.fromCharCode(39);
  const DQUOTE_CHAR = String.fromCharCode(34);
  const jsAttrRawInput = 'Cat' + SQUOTE_CHAR + DQUOTE_CHAR + ';alert(1)//';
  const jsAttrEscaped = escapeJsAttr(jsAttrRawInput);
  __assertOk(!jsAttrEscaped.includes(DQUOTE_CHAR), 'escapeJsAttr ne doit laisser aucun guillemet double brut (romprait l attribut HTML)');
  __assertOk(jsAttrEscaped.includes(BACKSLASH_CHAR + SQUOTE_CHAR), 'escapeJsAttr doit echapper le guillemet simple avec un backslash (romprait la chaine JS)');
  console.log('OK: escapeHtml/escapeJsAttr neutralisent correctement les caracteres dangereux');

  // --- 95. Securite : un nom/categorie de defi personnalise malveillant ne s injecte
  // plus tel quel dans les cartes, la fiche detail, ou les en-tetes de categorie ---
  const xssName = '<img src=x onerror=alert(1)>';
  const xssCat = '"><script>alert(2)</script>';
  const xssChallenge = { id: 9201, cat: xssCat, name: xssName, target: 50, unit: 'reps', hardcoreTarget: 100, isCustom: true, armMode: 'total' };
  customChallenges.push(xssChallenge);
  rebuildChallenges();
  const xssCardToday = renderChallengeCard(xssChallenge, 'today');
  const xssCardLibrary = renderChallengeCard(xssChallenge, 'library');
  for (const html of [xssCardToday, xssCardLibrary]) {
    __assertOk(!html.includes('<img src=x onerror'), 'le nom malveillant ne doit pas s injecter tel quel dans la carte');
    __assertOk(html.includes('&lt;img'), 'le nom doit apparaitre echappe dans la carte');
  }
  activeToday = new Set([xssChallenge.id]);
  await pickChallenge(xssChallenge.id);
  render(false);
  const xssDetailHtml = document.getElementById('app').innerHTML;
  __assertOk(!xssDetailHtml.includes('<img src=x onerror'), 'le nom malveillant ne doit pas s injecter dans la fiche detail (active-name)');
  currentChallengeId = null;
  editingChallengeId = null;
  activeTab = 'library';
  libraryOpenCats = new Set([xssCat]);
  const xssLibraryHtml = renderLibraryScreen();
  // Plusieurs categories (dont celles du catalogue par defaut) generent chacune leur
  // propre accordion-title/onclick : on verifie precisement l occurrence liee A NOTRE
  // categorie malveillante (via le contenu echappe attendu), pas juste "la 1ere trouvee".
  //
  // Le titre affiche est du VRAI contenu HTML : doit etre integralement echappe
  // (escapeHtml neutralise aussi < et >, contrairement a escapeJsAttr ci-dessous).
  const expectedEscapedTitle = 'accordion-title">' + escapeHtml(xssCat) + '</span>';
  __assertOk(xssLibraryHtml.includes(expectedEscapedTitle), 'la categorie doit apparaitre integralement echappee dans le titre de l accordeon');
  // L attribut onclick, lui, encapsule la valeur dans une chaine JS a l interieur d un
  // attribut HTML : seuls les guillemets (simple/double) doivent etre neutralises pour
  // rester sans danger — un "<script>" qui y apparaitrait serait du texte inerte a
  // l interieur d une valeur d attribut correctement fermee, jamais interprete comme du
  // balisage (donc pas besoin d etre echappe la, contrairement au titre ci-dessus).
  const expectedOnclickCall = "toggleLibraryCategory('" + escapeJsAttr(xssCat) + "')";
  const onclickIdx = xssLibraryHtml.indexOf(expectedOnclickCall);
  __assertOk(onclickIdx !== -1, 'l attribut onclick doit contenir l appel avec la categorie correctement echappee pour la chaine JS');
  __assertOk(!expectedOnclickCall.includes(DQUOTE_CHAR), 'la categorie malveillante ne doit pas casser l attribut onclick (guillemet double brut)');
  libraryOpenCats = new Set();
  activeTab = 'today';
  customChallenges = customChallenges.filter(x => x.id !== xssChallenge.id);
  rebuildChallenges();
  console.log('OK: noms/categories de defis personnalises malveillants neutralises partout (cartes, fiche detail, accordeon)');

  // --- 96. Securite : le nom de compte Google (currentUser.displayName) est echappe
  // sur l ecran Profil ---
  currentUser = { displayName: '<b>Pwned</b>', email: 'x@test.com', photoURL: '' };
  const xssAccountHtml = renderAccountTabScreen();
  __assertOk(!xssAccountHtml.includes('<b>Pwned</b>'), 'le nom de compte malveillant ne doit pas s injecter tel quel');
  __assertOk(xssAccountHtml.includes('&lt;b&gt;Pwned&lt;/b&gt;'), 'le nom de compte doit apparaitre echappe');
  currentUser = { displayName: 'Test', email: 't@test.com', photoURL: '' };
  console.log('OK: nom de compte Google echappe sur l ecran Profil');

  // --- 97. confirmModal() : remplace les confirm() natifs, resout une Promise<boolean>
  // selon le bouton clique, sans jamais utiliser la file enqueuePopup (independante) ---
  __assertOk(typeof confirmModal === 'function', 'confirmModal doit exister');
  const cancelPromise = confirmModal({ icon: '⚠️', title: 'Titre test', subtitle: 'Sous-titre test', confirmLabel: 'Oui', cancelLabel: 'Non' });
  __assertOk(currentConfirmModalHtml.includes('Titre test') && currentConfirmModalHtml.includes('Sous-titre test'), 'la modale doit afficher le titre et le sous-titre fournis');
  __assertOk(currentConfirmModalHtml.includes('>Oui<') && currentConfirmModalHtml.includes('>Non<'), 'la modale doit afficher les libelles de bouton fournis');
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  __assertEq(await cancelPromise, false, 'cliquer sur Annuler doit resoudre la promesse a false');

  const confirmPromise = confirmModal({ title: 'Suppression', danger: true });
  __assertOk(currentConfirmModalHtml.includes('app-popup-btn danger'), 'la variante danger doit teinter le bouton de confirmation');
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  __assertEq(await confirmPromise, true, 'cliquer sur Confirmer doit resoudre la promesse a true');
  console.log('OK: confirmModal (Annuler/Confirmer stylise, Promise<boolean>, variante danger)');

  // --- 98. Les 4 anciens confirm() natifs (suppression compte x2, suppression defi,
  // suggestion d objectif) passent tous par confirmModal (comptage exact des sites
  // "await confirmModal({" ; les commentaires explicatifs mentionnent le mot "confirm"
  // en prose, donc on ne peut pas fiablement compter une absence de confirm() natif
  // par simple recherche de texte — la preuve la plus fiable est le comptage positif
  // exact des 4 remplacements, deja verifie fonctionnellement pour deleteChallenge au
  // test 11 plus haut). ---
  // 14 depuis l ajout du garde-fou anti-spam (retour utilisateur, Kilito -
  // maybeInterceptSpammyTaps()) : compte x2, defi, suggestion d objectif, import de
  // donnees, forcer la mise a jour, retirer un ami, accepter une demande d ami
  // depuis sa popup, accepter une invitation de groupe depuis sa popup, annuler un
  // defi de groupe, 2x confirmation de joker (Doublon/Immunite et Boulet),
  // supprimer un groupe, + le garde-fou anti-spam.
  const confirmModalCallCount = (__rawHtml.match(/await confirmModal\\(\\{/g) || []).length;
  __assertEq(confirmModalCallCount, 14, 'les 14 sites (compte x2, defi, suggestion objectif, import de donnees, forcer la mise a jour, retirer un ami, accepter une demande d ami depuis sa popup, accepter une invitation de groupe depuis sa popup, annuler un defi de groupe, 2x confirmation de joker, supprimer un groupe, garde-fou anti-spam) doivent utiliser confirmModal');
  console.log('OK: les 4 anciens confirm() natifs (compte x2, defi, suggestion objectif) passent par confirmModal');

  // --- 99. Ecran Parametres dedie : navigation (ouverture/fermeture) + regroupe le
  // coach vocal, l export/import de donnees, et les actions de compte ---
  activeTab = 'account';
  settingsScreenOpen = false;
  currentUser = { displayName: 'Test', email: 't@test.com', photoURL: '' };
  render(false);
  const profileBeforeSettings = document.getElementById('app').innerHTML;
  __assertOk(profileBeforeSettings.includes('openSettingsScreen()'), 'l onglet Profil doit proposer un bouton vers Parametres');
  __assertOk(!profileBeforeSettings.includes('settings-card'), 'l ecran Profil principal ne doit plus montrer directement la carte parametres');
  openSettingsScreen();
  __assertOk(settingsScreenOpen, 'openSettingsScreen() doit ouvrir l ecran Parametres');
  await new Promise(r => setTimeout(r, 200)); // openSettingsScreen() rend avec animate=true (applyContent differe le swap de 140ms)
  const settingsHtmlFull = document.getElementById('app').innerHTML;
  __assertOk(settingsHtmlFull.includes('Coach vocal'), 'l ecran Parametres doit contenir le toggle coach vocal');
  __assertOk(settingsHtmlFull.includes('Exporter mes données'), 'l ecran Parametres doit contenir le bouton export');
  __assertOk(settingsHtmlFull.includes('Importer des données'), 'l ecran Parametres doit contenir le bouton import');
  __assertOk(settingsHtmlFull.includes('signOutUser()') && settingsHtmlFull.includes('deleteMyAccount()'), 'l ecran Parametres doit contenir les actions de compte');
  goBackOneLevel();
  __assertOk(!settingsScreenOpen, 'goBackOneLevel() doit refermer l ecran Parametres');
  activeTab = 'today'; // restaure l onglet par defaut pour la suite des tests
  console.log('OK: ecran Parametres dedie (navigation + contenu regroupe)');

  // --- 100. exportUserData() serialise l etat deja en memoire, sans aucune requete
  // reseau supplementaire ni exception ---
  xpTotal = 1234;
  let exportThrew = false;
  try { exportUserData(); } catch (e) { exportThrew = true; }
  __assertOk(!exportThrew, 'exportUserData() ne doit lever aucune exception');
  console.log('OK: exportUserData() serialise l etat en memoire sans exception');

  // --- 101. importUserData() : passe par confirmModal avant d ecraser quoi que ce
  // soit (chemin annulation = aucun changement), puis reecrit via les save*()
  // existants une fois confirme ---
  xpTotal = 42;
  voiceCoachEnabled = true;
  const fakeFileCancel = { text: async () => JSON.stringify({ xpTotal: 777, voiceCoachEnabled: false }) };
  const importPromiseCancel = importUserData({ target: { files: [fakeFileCancel], value: '' } });
  await new Promise(r => setTimeout(r, 10));
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  await importPromiseCancel;
  __assertEq(xpTotal, 42, 'annuler l import ne doit modifier aucune donnee');
  __assertEq(voiceCoachEnabled, true, 'annuler l import ne doit modifier aucune donnee (coach vocal)');

  const importedXp = 9999;
  const fakeFileConfirm = { text: async () => JSON.stringify({ xpTotal: importedXp, voiceCoachEnabled: false }) };
  const importPromiseConfirm = importUserData({ target: { files: [fakeFileConfirm], value: '' } });
  await new Promise(r => setTimeout(r, 10));
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await importPromiseConfirm;
  __assertEq(xpTotal, importedXp, 'confirmer l import doit ecraser xpTotal avec la valeur importee');
  __assertEq(voiceCoachEnabled, false, 'confirmer l import doit ecraser voiceCoachEnabled avec la valeur importee');
  console.log('OK: importUserData() (annulation = aucun changement ; confirmation = donnees appliquees via confirmModal)');

  // --- 102. Mode Hardcore plus immersif : var(--hardcore) utilisee (au lieu de la
  // couleur codee en dur) pour les usages "a plat" ; toute la carte se teinte
  // (.active-card.hardcore-engaged) une fois l objectif normal atteint ---
  const hardcoreTagIdx = cssText.indexOf('.hardcore-tag {');
  const hardcoreTagBlock = cssText.slice(hardcoreTagIdx, cssText.indexOf('}', hardcoreTagIdx));
  __assertOk(hardcoreTagBlock.includes('var(--hardcore)'), '.hardcore-tag doit utiliser var(--hardcore) plutot qu une couleur codee en dur');
  const hardcoreBannerIdx = cssText.indexOf('.hardcore-banner {');
  const hardcoreBannerBlock = cssText.slice(hardcoreBannerIdx, cssText.indexOf('}', hardcoreBannerIdx));
  __assertOk(hardcoreBannerBlock.includes('var(--hardcore)'), '.hardcore-banner doit utiliser var(--hardcore) plutot qu une couleur codee en dur');
  __assertOk(cssText.includes('.active-card.hardcore-engaged'), 'une classe dediee doit teinter toute la carte en mode Hardcore engage');

  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  const cFor102 = getChallenge();
  const entry102 = getEntry(pompes.id);
  entry102.sets = [cFor102.target]; // objectif normal deja atteint -> phase Hardcore engagee
  entry102.done = true;
  entry102.hardcoreDone = false;
  render(false);
  const engagedHtml = document.getElementById('app').innerHTML;
  __assertOk(engagedHtml.includes('active-card hardcore-engaged'), 'la carte doit porter la classe hardcore-engaged une fois l objectif normal atteint');

  entry102.done = false;
  entry102.sets = [];
  render(false);
  const notEngagedHtml = document.getElementById('app').innerHTML;
  __assertOk(!notEngagedHtml.includes('hardcore-engaged'), 'la carte ne doit pas etre teintee tant que l objectif normal n est pas atteint');
  currentChallengeId = null;
  console.log('OK: mode Hardcore plus immersif (var(--hardcore) + toute la carte teintee une fois engage)');

  // --- 103. Entree en cascade des cartes de liste (Aujourd hui/Défis) : keyframes +
  // delai croissant par carte (plafonne), desactivee sous prefers-reduced-motion ---
  __assertOk(cssText.includes('@keyframes card-pop-in'), 'les keyframes d entree en cascade doivent exister');
  __assertOk(cssText.includes('prefers-reduced-motion: reduce') && cssText.includes('.picker-item { animation: none; }'), 'l animation doit etre desactivee sous prefers-reduced-motion');
  const cardNoIndex = renderChallengeCard(pompes, 'library');
  __assertOk(!cardNoIndex.includes('animation-delay'), 'sans index fourni, aucun delai ne doit etre pose (repli sans animation cassee)');
  const card0 = renderChallengeCard(pompes, 'library', 0);
  const card3 = renderChallengeCard(pompes, 'library', 3);
  const card20 = renderChallengeCard(pompes, 'library', 20);
  __assertOk(card0.includes('animation-delay:0ms'), 'la 1ere carte ne doit avoir aucun delai');
  __assertOk(card3.includes('animation-delay:120ms'), 'le delai doit croitre avec l index (3 * 40ms)');
  __assertOk(card20.includes('animation-delay:320ms'), 'le delai doit etre plafonne (min(index,8) * 40ms), meme pour un index eleve');

  activeToday = new Set([pompes.id]);
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const todayListHtml = document.getElementById('app').innerHTML;
  __assertOk(todayListHtml.includes('animation-delay:0ms'), 'la liste Aujourd hui doit poser un delai (0ms pour la 1ere carte)');
  console.log('OK: entree en cascade des cartes (delai croissant plafonne, desactivee sous reduced-motion)');

  // --- 104. Store minimal (createStore) : get/set/subscribe generiques, notifient
  // tous les abonnes a chaque set(), se desabonner arrete les notifications ---
  const testStore = createStore(0);
  __assertEq(testStore.get(), 0, 'get() doit renvoyer la valeur initiale');
  let notifyCount = 0;
  let lastNotifiedValue = null;
  const unsubscribe = testStore.subscribe((v) => { notifyCount++; lastNotifiedValue = v; });
  testStore.set(1);
  __assertEq(testStore.get(), 1, 'set() doit mettre a jour la valeur lue par get()');
  __assertEq(notifyCount, 1, 'un abonne doit etre notifie a chaque set()');
  __assertEq(lastNotifiedValue, 1, 'l abonne doit recevoir la nouvelle valeur');
  unsubscribe();
  testStore.set(2);
  __assertEq(notifyCount, 1, 'se desabonner doit arreter les notifications');
  console.log('OK: createStore() (get/set/subscribe generique)');

  // --- 105. dayStateStore : filet de securite contre le bug de desync historique
  // (activeToday pas encore recharge au moment du rendu) — rendu automatique
  // declenche seulement une fois state ET activeToday charges, jamais un seul des
  // deux isolement ---
  __assertOk(__rawHtml.includes('stateLoaded: true'), 'loadState() doit notifier dayStateStore une fois charge');
  __assertOk(__rawHtml.includes('activeTodayLoaded: true'), 'loadActiveToday() doit notifier dayStateStore une fois charge');
  activeToday = new Set();
  activeTab = 'today';
  currentChallengeId = null;
  document.getElementById('app').innerHTML = 'SENTINEL_BEFORE_STORE_TEST';
  dayStateStore.set({ stateLoaded: true, activeTodayLoaded: false });
  __assertEq(document.getElementById('app').innerHTML, 'SENTINEL_BEFORE_STORE_TEST', 'un seul flag a true ne doit pas encore declencher de rendu automatique');
  dayStateStore.set({ stateLoaded: true, activeTodayLoaded: true });
  __assertOk(document.getElementById('app').innerHTML !== 'SENTINEL_BEFORE_STORE_TEST', 'les deux flags a true doivent declencher un rendu automatique (filet de securite anti-desync)');
  console.log('OK: dayStateStore declenche un rendu automatique une fois state + activeToday charges (jamais un seul des deux)');

  // --- 106. Extraction en fichiers classiques (exercise-data.js/exercise-pictograms.js) :
  // toujours des <script src=...> SANS defer/async (meme remarque que les SDK Firebase),
  // charges AVANT le script principal, contenu retire de index.html et jamais duplique ---
  __assertOk(__externalClassicScripts.length > 0, 'exercise-data.js/exercise-pictograms.js doivent etre lisibles a cote de index.html');
  const pictogramsTagIdx = __rawHtml.indexOf('<script src="exercise-pictograms.js">');
  const dataTagIdx = __rawHtml.indexOf('<script src="exercise-data.js">');
  // lastIndexOf (pas indexOf) : un commentaire explicatif plus haut dans le fichier
  // mentionne litteralement le texte "<script>" en prose, avant les vraies balises.
  const mainScriptTagIdx = __rawHtml.lastIndexOf('<script>');
  __assertOk(pictogramsTagIdx !== -1 && dataTagIdx !== -1, 'les 2 balises <script src=...> doivent exister dans index.html');
  __assertOk(mainScriptTagIdx !== -1, 'le script principal doit etre trouvable pour verifier l ordre de chargement');
  __assertOk(pictogramsTagIdx < mainScriptTagIdx && dataTagIdx < mainScriptTagIdx, 'les 2 scripts classiques doivent etre charges AVANT le script principal (CHALLENGE_LIBRARY etc. doivent deja etre des globaux disponibles)');
  const extractedTagsSnippet = __rawHtml.slice(pictogramsTagIdx, dataTagIdx + 60);
  __assertOk(!extractedTagsSnippet.includes('defer') && !extractedTagsSnippet.includes('async'), 'ces 2 scripts ne doivent jamais porter defer/async (meme risque que les SDK Firebase)');
  __assertOk(!__rawHtml.includes("const CHALLENGE_LIBRARY = ["), 'CHALLENGE_LIBRARY ne doit plus vivre dans index.html (deplace, pas duplique)');
  __assertOk(!__rawHtml.includes('const EXERCISE_PICTOGRAMS = {'), 'EXERCISE_PICTOGRAMS ne doit plus vivre dans index.html (deplace, pas duplique)');
  __assertOk(__externalClassicScripts.includes('const CHALLENGE_LIBRARY = ['), 'CHALLENGE_LIBRARY doit vivre dans les fichiers externes');
  __assertOk(__externalClassicScripts.includes('const EXERCISE_PICTOGRAMS = {'), 'EXERCISE_PICTOGRAMS doit vivre dans les fichiers externes');
  // Preuve fonctionnelle : le code applicatif (qui vient APRES dans la concatenation du
  // harnais, exactement comme un navigateur charge ces scripts dans l ordre) resout bien
  // ces globaux sans exception, comme avant l extraction.
  __assertOk(CHALLENGE_LIBRARY.length > 20, 'CHALLENGE_LIBRARY doit rester utilisable comme global par le reste du code');
  __assertOk(Object.keys(EXERCISE_PICTOGRAMS).length > 20, 'EXERCISE_PICTOGRAMS doit rester utilisable comme global par le reste du code');
  __assertEq(getExercisePictogramKey(CHALLENGE_LIBRARY.find(x => x.name === 'Pompes')), 'pompes', 'getExercisePictogramKey() (deplace) doit continuer a fonctionner normalement');
  console.log('OK: catalogue + pictogrammes extraits en scripts classiques (pas de defer/async, charges avant le script principal)');

  // --- 112. CSS extrait dans styles.css (#4) : plus de <style> inline dans
  // index.html, un <link rel="stylesheet"> le remplace, et le vrai contenu CSS
  // vit desormais dans le fichier a part (jamais duplique) ---
  __assertOk(!__rawHtml.includes('<style>'), 'index.html ne doit plus contenir de bloc <style> inline');
  __assertOk(__rawHtml.includes('<link rel="stylesheet" href="styles.css">'), 'index.html doit charger styles.css via un <link> classique');
  __assertOk(__cssSource.length > 10000, 'styles.css doit contenir le contenu CSS reel (pas juste lisible, non vide)');
  __assertOk(__cssSource.includes('--track-bg') && __cssSource.includes('@keyframes card-pop-in'), 'des regles CSS connues doivent vivre dans styles.css');
  console.log('OK: CSS extrait dans styles.css (plus de <style> inline, contenu non duplique)');

  // --- 107. Fusion Firestore (#28) : demarrage avec document consolide DEJA
  // migre (chemin rapide) -> une seule lecture suffit, aucune des 12 anciennes
  // cles separees n est lue (si loadAppData() retombait par erreur sur le
  // chemin de migration, les dbGet() sur les vieilles cles absentes du __store
  // couvriraient les valeurs avec des defauts differents de ceux ci-dessous) ---
  __store.clear();
  __appDataStore.exists = true;
  __appDataStore.data = {
    profile: { age: 40, sex: 'femme', heightCm: 170, weightKg: 65, level: 'avance' },
    customChallenges: [{ id: 9101, cat: 'Test', name: 'Doc Consolide', target: 10, unit: 'reps', hardcoreTarget: 20 }],
    manualTargetOverrides: { 1: 111 },
    streakData: { streakCount: 7, lastCompletedDate: '2026-07-30', hasShield: false, lastShieldResetWeek: '2026-07-27' },
    xpTotal: 4242,
    voiceCoachEnabled: false,
    hasSeenTour: true,
    lastCompleted: { 1: 12345 },
    stats: { 1: { lifetimeTotal: 99, bestDay: { total: 50, date: '2026-07-01' }, recordStreak: 2 } },
    badges: { totalCompletions: 5, unlocked: ['x'], totalHardcore: 1 },
    dailyActivity: { '2026-07-30': 2 },
    weights: { 5: 15 },
  };
  userProfile = null; customChallenges = []; CHALLENGES = []; manualTargetOverrides = {};
  streakCount = 0; lastCompletedDate = null; hasShield = true; lastShieldResetWeek = null;
  xpTotal = 0; voiceCoachEnabled = true; hasSeenTour = false; lastCompleted = {};
  stats = {}; badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 };
  dailyActivity = {}; weights = {};
  await loadAppData();
  __assertEq(userProfile, { age: 40, sex: 'femme', heightCm: 170, weightKg: 65, level: 'avance' }, 'profile charge depuis le document consolide (chemin rapide)');
  __assertOk(customChallenges.some(c => c.name === 'Doc Consolide' && c.isCustom === true), 'customChallenges charge depuis le document consolide');
  __assertEq(manualTargetOverrides, { 1: 111 }, 'manualTargetOverrides charge depuis le document consolide');
  __assertEq(streakCount, 7, 'streakCount charge depuis le champ streakData du document consolide');
  __assertEq(hasShield, false, 'hasShield charge depuis le champ streakData du document consolide');
  __assertEq(xpTotal, 4242, 'xpTotal charge depuis le document consolide');
  __assertEq(voiceCoachEnabled, false, 'voiceCoachEnabled charge depuis le document consolide');
  __assertEq(hasSeenTour, true, 'hasSeenTour charge depuis le document consolide');
  __assertEq(badges.totalCompletions, 5, 'badges charge depuis le document consolide');
  __assertEq(weights[5], 15, 'weights charge depuis le document consolide (backfillDefaultWeights ajoute aussi des defauts pour les autres halteres, sans ecraser celui-ci)');
  console.log('OK: fusion Firestore - chemin rapide (document appData deja migre, une seule lecture)');

  // --- 108. Fusion Firestore (#28) : migration non destructive depuis les
  // anciennes cles separees (compte pre-migration, jamais vu le document
  // consolide) -> ecrit le document consolide une bonne fois pour toutes ---
  __store.clear();
  __appDataStore.exists = false;
  __appDataStore.data = {};
  __store.set('profile', JSON.stringify({ age: 25, sex: 'homme', heightCm: 180, weightKg: 75, level: 'debutant' }));
  __store.set('xpTotal', '321');
  __store.set('badges', JSON.stringify({ totalCompletions: 2, unlocked: [], totalHardcore: 0 }));
  __store.set('hasSeenTour', 'true');
  userProfile = null; customChallenges = []; CHALLENGES = []; xpTotal = 0;
  badges = { totalCompletions: 0, unlocked: [], totalHardcore: 0 }; hasSeenTour = false;
  await loadAppData();
  __assertEq(userProfile, { age: 25, sex: 'homme', heightCm: 180, weightKg: 75, level: 'debutant' }, 'profile migre depuis l ancienne cle separee');
  __assertEq(xpTotal, 321, 'xpTotal migre depuis l ancienne cle separee');
  __assertEq(hasSeenTour, true, 'hasSeenTour migre depuis l ancienne cle separee (ne doit pas rester a son defaut false)');
  __assertOk(__appDataStore.exists && __appDataStore.data.xpTotal === 321 && __appDataStore.data.hasSeenTour === true, 'le document consolide doit etre ecrit une bonne fois pour toutes suite a la migration');
  __assertOk(__store.has('profile'), 'l ancienne cle separee ne doit JAMAIS etre supprimee (migration additive, filet de securite)');
  console.log('OK: fusion Firestore - migration non destructive depuis les anciennes cles separees');

  // --- 109. Fusion Firestore (#28) : tout nouvel utilisateur (aucune donnee nulle
  // part, ni document consolide ni anciennes cles) -> aucune ecriture prematuree
  // du document consolide (le premier saveProfile() de l onboarding le creera) ---
  __store.clear();
  __appDataStore.exists = false;
  __appDataStore.data = {};
  userProfile = null;
  await loadAppData();
  __assertEq(userProfile, null, 'nouvel utilisateur : aucun profil nulle part');
  __assertOk(!__appDataStore.exists, 'nouvel utilisateur : le document consolide ne doit PAS etre cree avant la fin de l onboarding');
  console.log('OK: fusion Firestore - nouvel utilisateur, aucune ecriture prematuree du document consolide');

  // --- 110. Fusion Firestore (#28) : saveAppField() fait un merge Firestore
  // reel, jamais un ecrasement complet du document (protege des ecritures
  // concurrentes entre deux ecrans differents, ex: terminer un defi pendant
  // que les Parametres modifient les poids d haltere ailleurs) ---
  __appDataStore.exists = true;
  __appDataStore.data = { xpTotal: 999, badges: { totalCompletions: 1, unlocked: [], totalHardcore: 0 } };
  weights = { 7: 20 };
  await saveAppField('weights', weights);
  __assertEq(__appDataStore.data.xpTotal, 999, 'saveAppField() ne doit jamais toucher aux AUTRES champs deja presents (xpTotal intact)');
  __assertEq(__appDataStore.data.badges, { totalCompletions: 1, unlocked: [], totalHardcore: 0 }, 'saveAppField() ne doit jamais toucher aux AUTRES champs deja presents (badges intact)');
  __assertEq(__appDataStore.data.weights, { 7: 20 }, 'saveAppField() doit bien ecrire le champ cible');
  console.log('OK: fusion Firestore - saveAppField() fait un merge partiel, jamais un ecrasement du document entier');

  // --- 113. Recherche dans l onglet Defis (#5) : filtre les cartes par nom,
  // force l ouverture des categories avec resultat, masque celles sans resultat ---
  customChallenges = [];
  rebuildChallenges();
  activeToday = new Set();
  libraryOpenCats = new Set();
  librarySearchQuery = '';
  const libNoSearchHtml = renderLibraryScreen();
  __assertOk(libNoSearchHtml.includes('id="librarySearchInput"'), 'le champ de recherche doit etre present sur l onglet Defis');
  __assertOk(!libNoSearchHtml.includes('accordion-body'), 'sans recherche : comportement accordeon inchange, tout ferme par defaut');

  librarySearchQuery = 'pompes';
  const libSearchHtml = renderLibraryScreen();
  __assertOk(libSearchHtml.includes('Pompes'), 'la recherche doit trouver Pompes (Haut du corps)');
  __assertOk(!libSearchHtml.includes('>Squats<'), 'la recherche ne doit pas montrer un defi qui ne correspond pas (Squats)');
  __assertOk(libSearchHtml.includes('accordion-body'), 'une categorie avec au moins un resultat doit etre forcee ouverte pendant la recherche');
  __assertOk(!libSearchHtml.includes('library-search-empty'), 'des resultats existent : pas de message "aucun resultat"');

  librarySearchQuery = 'zzz_defi_inexistant';
  const libSearchEmptyHtml = renderLibraryScreen();
  __assertOk(libSearchEmptyHtml.includes('library-search-empty'), 'aucun resultat : le message dedie doit s afficher');
  __assertOk(!libSearchEmptyHtml.includes('accordion-header'), 'aucun resultat : aucune categorie ne doit rester affichee');

  librarySearchQuery = '<script>alert(1)</script>';
  const libSearchXssHtml = renderLibraryScreen();
  __assertOk(!libSearchXssHtml.includes('<script>alert(1)</script>'), 'la requete de recherche affichee dans le champ/le message doit etre echappee (XSS)');

  librarySearchQuery = '';
  libraryOpenCats = new Set();
  console.log('OK: recherche dans l onglet Defis (filtre par nom, categories forcees ouvertes, message si aucun resultat, requete echappee)');

  // --- 114. switchTab() reinitialise la recherche en quittant l onglet Defis
  // (comme libraryOpenCats), pour repartir d une recherche vide au retour ---
  activeTab = 'library';
  librarySearchQuery = 'pompes';
  switchTab('today');
  __assertEq(librarySearchQuery, '', 'quitter l onglet Defis doit vider librarySearchQuery');
  activeTab = 'today';
  console.log('OK: quitter l onglet Defis reinitialise la recherche');

  // --- 115. render() restaure le focus du champ de recherche apres chaque
  // frappe (sinon applyContent() remplace tout le innerHTML de #app et le
  // nouvel <input> ne recevrait jamais le focus - saisie cassee, un seul
  // caractere tapable a la fois). Le mock ne recree pas de vrais noeuds DOM a
  // chaque innerHTML : on verifie donc directement que le callback afterRender
  // de render() appelle bien .focus() sur le champ, pas juste que l objet
  // document.activeElement reste inchange (ce qui serait vrai meme sans le
  // correctif, et ne prouverait rien) ---
  activeTab = 'library';
  librarySearchQuery = '';
  render();
  const searchInputEl = document.getElementById('librarySearchInput');
  searchInputEl.focus(); // simule l utilisateur qui clique/tape dans le champ
  let focusCalls = 0;
  searchInputEl.focus = () => { focusCalls++; };
  updateLibrarySearch('pom');
  __assertEq(focusCalls, 1, 'render() doit rappeler focus() sur le champ de recherche apres chaque frappe (callback afterRender), sinon la saisie serait cassee');
  activeTab = 'today';
  console.log('OK: le focus du champ de recherche est restaure apres chaque frappe (render() complet)');

  // Regression d un bug reel signale en prod : les champs texte de l onglet Groupes
  // (creer un groupe, formulaire de defi collectif...) perdaient le focus/clavier a
  // CHAQUE frappe - contrairement a la recherche Defis ci-dessus, la branche
  // activeTab==='groups' de render() n avait PAS le meme filet de restauration.
  // Corrige en generalisant le filet (applyContentPreservingFocus(), par ID plutot
  // que par ecran) et en ajoutant les id="..." manquants sur ces champs.
  activeTab = 'groups';
  openGroupId = null;
  render();
  const groupNameInputEl = document.getElementById('groupCreateNameInput');
  groupNameInputEl.focus();
  let groupNameFocusCalls = 0;
  groupNameInputEl.focus = () => { groupNameFocusCalls++; };
  updateGroupCreateNameInput('Les Costauds');
  __assertEq(groupNameFocusCalls, 1, 'taper dans le champ "creer un groupe" ne doit plus faire perdre le focus a chaque frappe (bug reel signale en prod)');
  activeTab = 'today';
  console.log('OK: le focus des champs texte de l onglet Groupes est restaure apres chaque frappe (regression corrigee)');

  // --- 116. Raccourcis PWA (#7) : ?tab=... positionne activeTab au demarrage
  // et nettoie ensuite l URL (evite de re-declencher au prochain rechargement) ---
  location.search = '?tab=library';
  activeTab = 'today';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'library', '?tab=library doit positionner activeTab sur Defis');
  __assertEq(location.search, '', 'l URL doit etre nettoyee apres lecture (history.replaceState)');

  location.search = '?tab=history';
  activeTab = 'today';
  profileView = 'profile';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'account', '?tab=history (raccourci PWA retro-compatible) doit positionner activeTab sur Profil');
  __assertEq(profileView, 'journal', '?tab=history doit aussi selectionner le sous-onglet Journal');

  location.search = '?tab=valeur_invalide';
  activeTab = 'today';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'today', 'une valeur de tab invalide/inconnue ne doit pas modifier activeTab');

  location.search = '';
  activeTab = 'account';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'account', 'sans parametre tab dans l URL, activeTab ne doit pas etre touche');
  activeTab = 'today';
  console.log('OK: raccourcis PWA (?tab=...) positionnent activeTab au demarrage et nettoient l URL');

  // --- 117. Accessibilite de base (#14) : barre d onglets (role tablist/tab +
  // aria-selected), champ de recherche et bouton + de la bibliotheque (aria-label),
  // toast (aria-live) ---
  activeTab = 'library';
  const ariaTabBarHtml = renderTabBar();
  __assertOk(ariaTabBarHtml.includes('role="tablist"'), 'la barre d onglets doit avoir role="tablist"');
  __assertOk(ariaTabBarHtml.includes('role="tab"'), 'chaque bouton d onglet doit avoir role="tab"');
  __assertOk(ariaTabBarHtml.includes('tab-btn active"'), 'un bouton d onglet actif doit exister (classe tab-btn active)');
  __assertEq((ariaTabBarHtml.match(/aria-selected="true"/g) || []).length, 1, 'un seul onglet a la fois doit avoir aria-selected="true"');
  __assertOk(ariaTabBarHtml.includes('aria-selected="false"'), 'les onglets inactifs doivent avoir aria-selected="false"');
  activeTab = 'today';

  const ariaLibHtml = renderLibraryScreen();
  __assertOk(ariaLibHtml.includes('aria-label="Rechercher un défi"'), 'le champ de recherche doit avoir un aria-label');
  __assertOk(ariaLibHtml.includes('aria-label="Ajouter un défi personnalisé"'), 'le bouton + (icone seule) doit avoir un aria-label');

  // Note : pas de verification via document.getElementById('toast') apres coup - le mock
  // fait de getElementById() une auto-creation permanente (jamais null), donc le "if (!el)"
  // de showToast() (creation paresseuse a la premiere fois) ne se declenche jamais dans le
  // harnais. Verification directe du code source a la place (meme principe que d autres
  // verifications deja presentes dans ce fichier, ex: enablePersistence).
  __assertOk(__rawHtml.includes("el.setAttribute('aria-live', 'polite')"), 'le toast doit annoncer aria-live="polite" aux lecteurs d ecran');
  console.log('OK: accessibilite de base (tablist/tab/aria-selected, aria-label champs icone-seule, toast aria-live)');

  // --- 118. Fermeture #3 (lazy-loading) : l image hero de la fiche detail reste
  // explicitement eager (LCP-critique, ne doit jamais devenir lazy) ; les images de
  // liste (renderExercisePicto) restent lazy comme deja verifie plus haut ---
  __assertOk(__rawHtml.includes('class="exercise-hero-apng parallax-img"') && __rawHtml.includes('loading="eager"'), 'l image hero de la fiche detail doit etre explicitement loading="eager"');
  console.log('OK: image hero de la fiche detail explicitement loading="eager" (LCP-critique)');

  // --- 119. Nettoyage des libelles d exercices : plus aucun nom ne contient
  // "cumulé"/"cumulée" (catalogue + table de pictogrammes associee) ---
  const stillHasCumule = CHALLENGE_LIBRARY.some(c => /cumulé/i.test(c.name));
  __assertOk(!stillHasCumule, 'aucun nom d exercice ne doit plus contenir "cumulé"/"cumulée"');
  __assertOk(CHALLENGE_LIBRARY.some(c => c.name === 'Planche'), '"Planche cumulée" doit devenir "Planche"');
  __assertOk(CHALLENGE_LIBRARY.some(c => c.name === 'Hollow hold'), '"Hollow hold cumulé" doit devenir "Hollow hold"');
  __assertOk(CHALLENGE_LIBRARY.some(c => c.name === 'Chaise (wall sit)'), '"Chaise (wall sit) cumulée" doit devenir "Chaise (wall sit)"');
  __assertEq(getExercisePictogramKey({ name: 'Planche', cat: 'Gainage / Core' }), 'planche', 'EXERCISE_ICON_BY_NAME doit reconnaitre le nouveau nom "Planche"');
  __assertEq(getExercisePictogramKey({ name: 'Hollow hold', cat: 'Gainage / Core' }), 'hollow_hold', 'EXERCISE_ICON_BY_NAME doit reconnaitre le nouveau nom "Hollow hold"');
  __assertEq(getExercisePictogramKey({ name: 'Chaise (wall sit)', cat: 'Bas du corps' }), 'chaise', 'EXERCISE_ICON_BY_NAME doit reconnaitre le nouveau nom "Chaise (wall sit)"');
  console.log('OK: noms d exercices nettoyes (retrait de "cumulé"/"cumulée")');

  // --- 120. L entree en cascade des cartes Defis n anime QUE la categorie qui vient
  // d etre depliee ; un toggle d activation dans un accordeon deja ouvert ne doit pas
  // re-declencher l animation sur ses cartes (evite l effet de clignotement/refresh) ---
  activeTab = 'today'; // evite que le render() interne de toggleLibraryCategory()/toggleActiveToday() consomme le flag via renderLibraryScreen()
  customChallenges = [];
  rebuildChallenges();
  activeToday = new Set();
  libraryOpenCats = new Set();
  librarySearchQuery = '';
  libraryAnimatingCat = null;
  toggleLibraryCategory('Haut du corps'); // simule un vrai tap : ouvre la categorie + arme libraryAnimatingCat
  const freshOpenHtml = renderLibraryScreen();
  __assertOk(freshOpenHtml.includes('accordion-body'), 'la categorie doit etre ouverte apres toggleLibraryCategory()');
  __assertOk(!freshOpenHtml.includes('no-anim'), 'une categorie qui vient d etre depliee doit animer ses cartes (pas de classe no-anim)');

  const pompesForAnim = CHALLENGE_LIBRARY.find(c => c.name === 'Pompes'); // categorie 'Haut du corps', deja ouverte
  await toggleActiveToday(pompesForAnim.id);
  const afterToggleHtml = renderLibraryScreen();
  __assertOk(afterToggleHtml.includes('accordion-body'), 'la categorie doit rester ouverte apres un simple toggle d activation');
  __assertOk(afterToggleHtml.includes('no-anim'), 'un toggle d activation dans un accordeon deja ouvert ne doit PAS re-animer ses cartes (pas de clignotement)');
  activeToday = new Set();
  libraryOpenCats = new Set();
  libraryAnimatingCat = null;
  console.log('OK: entree en cascade limitee a l ouverture d un menu deroulant (pas de re-animation au toggle d activation)');

  // --- 121. Espacement recherche/premiere carte (#3 CSS) : meme marge que celle
  // entre deux accordeons (.accordion { margin-bottom: ... }), pour un espacement
  // vertical uniforme et propre ---
  const accordionRuleIdx = cssText.indexOf('.accordion { margin-bottom:');
  __assertOk(accordionRuleIdx !== -1, 'la regle .accordion (espacement entre deux accordeons) doit exister dans styles.css');
  const accordionRuleBlock = cssText.slice(accordionRuleIdx, cssText.indexOf('}', accordionRuleIdx) + 1);
  const mbStart = accordionRuleBlock.indexOf('margin-bottom:') + 'margin-bottom:'.length;
  const mbEnd = accordionRuleBlock.indexOf(';', mbStart);
  const accordionMarginBottom = accordionRuleBlock.slice(mbStart, mbEnd).trim();
  const searchInputCssIdx = cssText.indexOf('.library-search-input {');
  __assertOk(searchInputCssIdx !== -1, 'la regle .library-search-input doit exister dans styles.css');
  const searchInputCssBlock = cssText.slice(searchInputCssIdx, cssText.indexOf('}', searchInputCssIdx));
  __assertOk(searchInputCssBlock.includes('margin-bottom: ' + accordionMarginBottom), 'le champ de recherche doit avoir le meme margin-bottom que .accordion (' + accordionMarginBottom + '), pour un espacement uniforme avec le premier accordeon');
  console.log('OK: espacement uniforme entre la recherche et le premier accordeon (meme margin-bottom que .accordion)');

  // --- 122. reportSaveError (persistance Firestore, #2) : signale une erreur
  // d ecriture via un toast visible, mais SEULEMENT si on est en ligne - hors ligne,
  // Firestore rejoue deja automatiquement (persistance locale), pas la peine
  // d alarmer l utilisateur pour ca ---
  navigator.onLine = true;
  document.getElementById('toast').innerHTML = '';
  reportSaveError('save test failed', new Error('boom'));
  __assertOk(document.getElementById('toast').innerHTML.includes('Échec de sauvegarde'), 'en ligne, un echec d ecriture doit afficher un toast d erreur visible (jusqu ici invisible, simple console.error)');

  navigator.onLine = false;
  document.getElementById('toast').innerHTML = '';
  reportSaveError('save test failed', new Error('boom'));
  __assertEq(document.getElementById('toast').innerHTML, '', 'hors ligne, reportSaveError ne doit PAS afficher de toast (deja gere par le bandeau hors ligne + la file Firestore)');
  navigator.onLine = true;
  console.log('OK: reportSaveError affiche un toast uniquement en ligne (echec reellement anormal, plus jamais silencieux)');

  // --- 123. Diagnostic de persistance Firestore (#2) dans Parametres > Depannage :
  // reflete fidelement firestorePersistenceEnabled (true/false/pas encore determine) ---
  firestorePersistenceEnabled = true;
  const settingsPersistOkHtml = renderSettingsScreen();
  __assertOk(settingsPersistOkHtml.includes('Active') && !settingsPersistOkHtml.includes('Indisponible'), 'persistance active : diagnostic positif affiche dans Parametres');

  firestorePersistenceEnabled = false;
  const settingsPersistKoHtml = renderSettingsScreen();
  __assertOk(settingsPersistKoHtml.includes('Indisponible sur cet appareil'), 'persistance indisponible : avertissement explicite affiche dans Parametres > Depannage');

  firestorePersistenceEnabled = null;
  const settingsPersistPendingHtml = renderSettingsScreen();
  __assertOk(settingsPersistPendingHtml.includes('vérification en cours'), 'etat pas encore determine (juste apres demarrage) : message neutre, pas d avertissement premature');
  firestorePersistenceEnabled = true;
  console.log('OK: diagnostic de persistance Firestore affiche fidelement dans Parametres > Depannage');

  // --- 124. forceAppUpdate() (#1, filet de secours PWA) : desenregistre TOUS les
  // service workers + vide TOUS les caches + recharge, gate par confirmModal ---
  __mockCacheKeys.length = 0;
  __mockCacheKeys.push('defi-du-jour-v3', 'defi-du-jour-v4'); // simule un vieux cache jamais purge + le courant
  __mockSwRegistrations.forEach(r => { r.unregisterCalled = false; });
  location.reloadCalled = false;
  const forceUpdatePromise = forceAppUpdate();
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick(); // simule le clic sur "Forcer la mise a jour"
  await forceUpdatePromise;
  __assertOk(__mockSwRegistrations.every(r => r.unregisterCalled), 'forceAppUpdate() doit desenregistrer TOUS les service workers actifs');
  __assertEq(__mockCacheKeys.length, 0, 'forceAppUpdate() doit vider TOUS les caches (y compris un ancien jamais purge)');
  __assertOk(location.reloadCalled, 'forceAppUpdate() doit recharger la page une fois le nettoyage termine');

  // Annulation : ne doit RIEN nettoyer ni recharger
  __mockCacheKeys.push('defi-du-jour-v4');
  __mockSwRegistrations.forEach(r => { r.unregisterCalled = false; });
  location.reloadCalled = false;
  const forceUpdateCancelPromise = forceAppUpdate();
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  await forceUpdateCancelPromise;
  __assertOk(__mockSwRegistrations.every(r => !r.unregisterCalled), 'annuler forceAppUpdate() ne doit RIEN desenregistrer');
  __assertEq(__mockCacheKeys.length, 1, 'annuler forceAppUpdate() ne doit vider AUCUN cache');
  __assertOk(!location.reloadCalled, 'annuler forceAppUpdate() ne doit PAS recharger la page');
  console.log('OK: forceAppUpdate() (filet de secours PWA) desenregistre les SW + vide les caches + recharge, annulable');

  // --- 125. Verification a la source (#1) : detection de mise a jour SW rendue plus
  // proactive (visibilitychange -> registration.update()), independamment de
  // l heuristique interne du navigateur pour une PWA restee ouverte longtemps ---
  __assertOk(__rawHtml.includes("document.addEventListener('visibilitychange'") && __rawHtml.includes('registration.update()'), 'une PWA restee ouverte longtemps doit revérifier une mise a jour au retour au premier plan, pas seulement au chargement');
  console.log('OK: verification de mise a jour SW plus proactive (visibilitychange)');

  // --- 126. Modal "Nouveau record 3 fois de suite" (bug #1) : le flux complet
  // (3e record consecutif -> confirmModal differe de 1400ms -> clic sur Augmenter
  // l objectif) doit mettre a jour manualTargetOverrides et fermer la modale ---
  activeTab = 'today';
  customChallenges = [];
  rebuildChallenges();
  activeToday = new Set([pompesForAnim.id]);
  manualTargetOverrides = {};
  state = emptyDayState();
  await pickChallenge(pompesForAnim.id);
  const cRecord = getChallenge();
  stats[pompesForAnim.id] = { lifetimeTotal: 0, bestDay: { total: cRecord.target - 10, date: '2020-01-01' }, recordStreak: 2 };
  popupQueue = []; popupOpen = false;
  await addSet(cRecord.target); // 3e record consecutif -> programme le confirmModal (setTimeout 1400ms)
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  __assertEq(stats[pompesForAnim.id].recordStreak, 3, '3e record consecutif atteint');
  await new Promise(r => setTimeout(r, 1500)); // laisse le setTimeout(1400) declencher confirmModal()
  __assertOk(currentConfirmModalHtml.includes('Nouveau record 3 fois de suite'), 'la modale de suggestion d objectif doit s afficher apres 3 records consecutifs');
  __assertOk(currentConfirmModalEl.querySelector('#confirmModalConfirmBtn') && typeof currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick === 'function', 'le bouton Augmenter l objectif doit avoir un gestionnaire de clic actif');
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  __assertEq(manualTargetOverrides[pompesForAnim.id], Math.ceil((cRecord.target * 1.15) / 5) * 5, 'cliquer Augmenter l objectif doit mettre a jour manualTargetOverrides avec la cible suggeree');
  __assertEq(stats[pompesForAnim.id].recordStreak, 0, 'recordStreak doit se reinitialiser apres la decision (acceptee ou non)');
  console.log('OK: modal "Nouveau record 3 fois de suite" - le bouton Augmenter l objectif fonctionne et ferme la modale');

  // --- 127. Bug #1 (root cause) : confirmModal() n a AUCUN garde-fou d instance
  // unique (contrairement a drainPopupQueue()/popupOpen) - deux popups simultanes
  // avec les MEMES id ne doivent JAMAIS se marcher dessus. Reproduit exactement le
  // scenario reel (terminer 2 defis differents chacun avec 3 records d affilee, a
  // quelques secondes d ecart : 2 setTimeout(1400) qui se chevauchent) ---
  const confirmPromise1 = confirmModal({ title: 'Modal 1', confirmLabel: 'OK1', cancelLabel: 'Annuler1' });
  const el1 = currentConfirmModalEl; // capture AVANT que le 2e appel n ecrase currentConfirmModalEl
  const confirmPromise2 = confirmModal({ title: 'Modal 2', confirmLabel: 'OK2', cancelLabel: 'Annuler2' });
  const el2 = currentConfirmModalEl;
  __assertOk(el1 !== el2, 'les 2 appels concurrents doivent creer 2 elements distincts');

  let result2 = null;
  el2.querySelector('#confirmModalConfirmBtn').onclick(); // clique sur celui que l utilisateur VOIT (affiche en dernier, donc au-dessus visuellement)
  confirmPromise2.then(v => { result2 = v; });
  await new Promise(r => setTimeout(r, 10));
  __assertEq(result2, true, 'cliquer sur le bouton du 2e popup doit resoudre LE 2e popup (pas rester inerte)');

  let result1 = null;
  el1.querySelector('#confirmModalConfirmBtn').onclick(); // le 1er popup doit rester independamment fonctionnel
  confirmPromise1.then(v => { result1 = v; });
  await new Promise(r => setTimeout(r, 10));
  __assertEq(result1, true, 'le 1er popup doit rester fonctionnel independamment du 2e (aucun des deux ne doit etre inerte)');
  console.log('OK: confirmModal() reste fonctionnel meme avec 2 instances simultanees (portee querySelector, pas de collision d id)');

  // --- 128. Bug #3 : le defilement d une roulette d onboarding (age/taille/poids) doit
  // persister EN DIRECT dans profileDraft (pas seulement au clic sur "Suivant"), pour
  // survivre a un re-render intempestif (ex: pull-to-refresh mal interprete) sans
  // reinitialiser la roulette a sa valeur par defaut (175cm/75kg) ---
  showProfileOnboarding = true;
  profileStep = 3; // ecran taille/poids
  profileDraft = { age: 30, sex: 'homme', heightCm: null, weightKg: null, level: null };
  render();
  document.getElementById('pfHeight').dataset = { min: '100', max: '250', step: '1', itemHeight: '44' };
  document.getElementById('pfWeight').dataset = { min: '30', max: '300', step: '1', itemHeight: '44' };

  document.getElementById('pfHeight').scrollTop = (160 - 100) * 44; // l utilisateur defile jusqu a 160cm
  onWheelPickerScroll('pfHeight');
  __assertEq(profileDraft.heightCm, 160, 'profileDraft.heightCm doit se mettre a jour EN DIRECT pendant le defilement, pas seulement au clic sur Suivant');

  // Un re-render intempestif survient PENDANT que l utilisateur est encore sur cet ecran
  // (initWheelPickers() est exactement le callback afterRender rejoue a chaque render()) :
  // ne doit PAS reinitialiser la roulette a son defaut (175cm) puisque profileDraft.heightCm
  // reflete deja la derniere valeur choisie.
  initWheelPickers();
  __assertEq(getWheelPickerValue('pfHeight'), 160, 'un re-render intempestif ne doit PAS reinitialiser la roulette a sa valeur par defaut (175cm)');
  __assertEq(profileDraft.heightCm, 160, 'profileDraft.heightCm ne doit pas non plus etre ecrase par le re-render');
  showProfileOnboarding = false;
  profileStep = 0;
  console.log('OK: le defilement des roulettes d onboarding persiste en direct dans profileDraft (survit a un re-render intempestif)');

  // --- 129. Bug #3 (garde-fou complementaire) : le pull-to-refresh ne doit jamais se
  // declencher pendant l onboarding (verification a la source : le mock ne simule pas de
  // vrais evenements touch document-level, addEventListener y est un no-op) ---
  __assertOk(__rawHtml.includes('ptrRefreshing || showProfileOnboarding'), 'le pull-to-refresh doit etre desactive pendant l onboarding (evite un refreshApp() accidentel qui reinitialiserait les roulettes)');
  console.log('OK: pull-to-refresh desactive pendant l onboarding (garde-fou complementaire)');

  // Bug reel signale : glisser une bottom sheet vers le bas pour la fermer
  // declenchait EN MEME TEMPS le pull-to-refresh de la page en arriere-plan
  // (verification a la source, meme raison que le garde-fou onboarding ci-dessus).
  __assertOk(__rawHtml.includes("document.querySelector('.level-roadmap-overlay')"), 'le pull-to-refresh doit aussi etre desactive tant qu une bottom sheet (info groupe/profil ami/palier de niveau) est ouverte par-dessus');
  console.log('OK: pull-to-refresh desactive pendant qu une bottom sheet est ouverte (conflit de gestes corrige)');

  // --- 130. Refonte copywriting onboarding (#2) : l ecran de bienvenue est condense
  // en 3 points cles (plus les 2 longs paragraphes), et l explication du coach virtuel
  // est deplacee sur l ecran age (avec l icone cerveau) ---
  profileStep = 0;
  const welcomeHtml = renderProfileOnboardingScreen();
  __assertOk(welcomeHtml.includes('feature-item') && welcomeHtml.includes('🎯') && welcomeHtml.includes('⚡') && welcomeHtml.includes('📈'), 'l ecran de bienvenue doit afficher les 3 points cles avec emojis');
  __assertOk(!welcomeHtml.includes('coach-badge'), 'le badge coach virtuel ne doit pas apparaitre sur l ecran de bienvenue (deplace sur l ecran age)');
  __assertOk(!welcomeHtml.includes('dépasse-toi jour après jour'), 'l ancien long paragraphe de bienvenue ne doit plus apparaitre');

  profileStep = 1;
  const ageHtml = renderProfileOnboardingScreen();
  __assertOk(ageHtml.includes('coach-badge') && ageHtml.includes('Coach Virtuel IA') && ageHtml.includes('kilo-idle'), 'le badge coach virtuel (mascotte Kilo) doit desormais apparaitre sur l ecran age');
  __assertOk(ageHtml.includes('id="pfAge"'), 'le rouleau d age doit toujours etre present sur cet ecran');
  profileStep = 0;
  console.log('OK: onboarding - ecran de bienvenue condense (3 points cles), coach virtuel (Kilo) explique sur l ecran age');

  // Retour utilisateur (mascotte doit accompagner TOUTE la phase d initiation, pas
  // seulement l ecran age) : Kilo apparait aussi en grand sur l ecran de bienvenue
  // et de confirmation, et dans le badge coach virtuel de CHAQUE etape du
  // questionnaire (sexe/mensurations/niveau, pas seulement age).
  profileStep = 0;
  const kiloWelcomeHtml = renderProfileOnboardingScreen();
  __assertOk(kiloWelcomeHtml.includes('onboarding-kilo-hero') && kiloWelcomeHtml.includes('kilo-idle'), 'Kilo (idle, en grand) doit accueillir l ecran de bienvenue');
  profileStep = 2;
  const kiloSexHtml = renderProfileOnboardingScreen();
  __assertOk(kiloSexHtml.includes('coach-badge') && kiloSexHtml.includes('kilo-idle'), 'Kilo doit aussi accompagner l ecran sexe');
  profileStep = 3;
  const kiloMetricsHtml = renderProfileOnboardingScreen();
  __assertOk(kiloMetricsHtml.includes('coach-badge') && kiloMetricsHtml.includes('kilo-idle'), 'Kilo doit aussi accompagner l ecran taille/poids');
  profileStep = 4;
  const kiloLevelHtml = renderProfileOnboardingScreen();
  __assertOk(kiloLevelHtml.includes('coach-badge') && kiloLevelHtml.includes('kilo-idle'), 'Kilo doit aussi accompagner l ecran niveau');
  profileStep = 0;
  console.log('OK: Kilo accompagne desormais TOUTES les etapes du questionnaire de profil (bienvenue + age/sexe/mensurations/niveau)');

  // Nouvel ecran demande : presentation de Kilito, juste apres la bienvenue et
  // avant la 1ere question (age) - etape 0.5 volontairement non entiere (voir
  // profileNext()/profilePrev()) pour ne renumeroter aucune des etapes existantes.
  profileStep = 0;
  profileNext(); // bienvenue -> Kilito (pas directement l age)
  __assertEq(profileStep, 0.5, 'apres la bienvenue, l etape suivante doit etre la presentation de Kilito, pas directement l age');
  let kiloIntroHtml = renderProfileOnboardingScreen();
  __assertOk(kiloIntroHtml.includes('Kilito') && kiloIntroHtml.includes('kilo-intro-hero') && kiloIntroHtml.includes('kilo-idle'), 'l ecran doit presenter Kilito en grand (anime, etat idle)');
  __assertOk(kiloIntroHtml.includes(t('onboarding.kiloIntro.message')), 'le message de presentation doit etre affiche');
  __assertOk(kiloIntroHtml.includes('onboarding-cta'), 'l ecran de presentation doit avoir son propre bouton pour continuer');
  __assertOk(!kiloIntroHtml.includes('pf-progress'), 'les points de progression du questionnaire ne doivent pas apparaitre sur cet ecran (comme sur la bienvenue, ce n est pas une question)');
  profileNext(); // Kilito -> age
  __assertEq(profileStep, 1, 'apres l ecran Kilito, l etape suivante doit etre la question age (numerotation existante inchangee)');
  profilePrev(); // age -> Kilito (retour, pas directement la bienvenue)
  __assertEq(profileStep, 0.5, 'le bouton retour depuis l age doit ramener sur l ecran Kilito, pas directement sur la bienvenue');
  profilePrev(); // Kilito -> bienvenue
  __assertEq(profileStep, 0, 'le bouton retour depuis l ecran Kilito doit ramener sur la bienvenue');
  profileStep = 0;
  console.log('OK: nouvel ecran de presentation de Kilito entre la bienvenue et la question age (navigation avant/arriere correcte dans les 2 sens)');

  // --- 131. Finitions UI onboarding : bouton CTA present uniquement sur les etapes qui
  // en ont besoin (0, 1, 3, ecran de confirmation), badge coach virtuel repositionne
  // AVANT la question age, mini-carte de preview d objectif sur l ecran de confirmation ---
  profileStep = 0;
  const anchoredWelcomeHtml = renderProfileOnboardingScreen();
  __assertOk(anchoredWelcomeHtml.includes('onboarding-content') && anchoredWelcomeHtml.includes('onboarding-cta'), 'l ecran de bienvenue doit utiliser le conteneur de contenu + un bouton CTA');
  const idxContentDiv = anchoredWelcomeHtml.indexOf('onboarding-content');
  const idxCommencerBtn = anchoredWelcomeHtml.indexOf('onboarding-cta');
  __assertOk(idxContentDiv !== -1 && idxCommencerBtn > idxContentDiv, 'le bouton Commencer doit venir apres le conteneur de contenu centre (ancre en bas, pas emporte dans le centrage)');

  profileStep = 1;
  const anchoredAgeHtml = renderProfileOnboardingScreen();
  __assertOk(anchoredAgeHtml.includes('onboarding-cta'), 'l ecran age (bouton Suivant) doit avoir un bouton CTA');
  const idxCoachTitle = anchoredAgeHtml.indexOf('coach-badge');
  const idxAgeQuestion = anchoredAgeHtml.indexOf('Quel âge as-tu');
  __assertOk(idxCoachTitle !== -1 && idxAgeQuestion !== -1 && idxCoachTitle < idxAgeQuestion, 'le badge coach virtuel doit apparaitre AVANT la question/emoticone gateau (fonctionne comme un titre de page)');

  profileStep = 2;
  const sexHtml = renderProfileOnboardingScreen();
  __assertOk(!sexHtml.includes('onboarding-cta'), 'l ecran sexe (pas de bouton, avance automatique au clic) ne doit pas avoir de bouton CTA');

  profileStep = 3;
  const metricsHtml = renderProfileOnboardingScreen();
  __assertOk(metricsHtml.includes('onboarding-cta'), 'l ecran taille/poids (bouton Suivant) doit avoir un bouton CTA');

  profileStep = 4;
  const levelHtml = renderProfileOnboardingScreen();
  __assertOk(!levelHtml.includes('onboarding-cta'), 'l ecran niveau (pas de bouton, avance automatique au clic) ne doit pas avoir de bouton CTA');
  profileStep = 0;
  console.log('OK: bouton CTA present uniquement sur les etapes avec un vrai bouton (0, 1, 3, confirmation)');

  // --- 132. Mini-carte de preview (ecran de confirmation) : objectif REELLEMENT
  // calcule pour Pompes a partir du profil qui vient d etre rempli, pas une valeur
  // fictive codee en dur ---
  userProfile = { age: 40, sex: 'homme', heightCm: 185, weightKg: 90, level: 'avance' };
  onboardingTransitionPhase = 'confirm';
  const previewHtml = renderOnboardingTransitionScreen();
  const pompesForPreview = CHALLENGE_LIBRARY.find(c => c.name === 'Pompes');
  const expectedPreviewTarget = computeStandardTarget(pompesForPreview, userProfile);
  __assertOk(previewHtml.includes(expectedPreviewTarget + ' REPS'), 'la mini-carte de preview doit afficher l objectif REELLEMENT calcule pour Pompes selon le profil (pas une valeur fictive)');
  __assertOk(previewHtml.includes('onboarding-kilo-hero') && previewHtml.includes('kilo-success'), 'Kilo (etat success) doit celebrer l ecran de confirmation, a la place de l ancien badge coche');
  onboardingTransitionPhase = 'loading';
  const kiloLoadingHtml = renderOnboardingTransitionScreen();
  __assertOk(kiloLoadingHtml.includes('onboarding-kilo-hero') && kiloLoadingHtml.includes('kilo-idle'), 'Kilo doit aussi accompagner l ecran de chargement (calcul des objectifs)');
  onboardingTransitionPhase = null;
  console.log('OK: la mini-carte de preview affiche un objectif reellement calcule (pas une valeur fictive codee en dur), Kilo accompagne chargement + confirmation');

  // --- 133. Refonte visuelle premium de l onboarding (design system precis, remplace
  // integralement le HTML/CSS des 3 ecrans) : icone teinte accent sur les cartes de
  // bienvenue, badge coach virtuel discret, fondu du wheel picker adouci (25%/75%),
  // texte de confirmation propre (plus de ponctuation orpheline « »), carte de
  // preview nom+badge ---
  __assertOk(cssText.includes('background: rgba(57, 233, 122, 0.1)') && cssText.includes('.feature-icon'), 'les icones des cartes de bienvenue doivent etre teintees accent');
  __assertOk(cssText.includes('.coach-badge'), 'le badge coach virtuel doit exister (remplace le gros bloc vert)');
  __assertOk(cssText.includes('black 25%, black 75%'), 'le fondu du wheel picker doit etre adouci a 25%/75% (moins agressif que 30%/70%)');
  __assertOk(!cssText.includes('.pf-algo-callout') && !cssText.includes('.pf-coach-chip') && !cssText.includes('.pf-welcome-bullet') && !cssText.includes('.pf-step-anchored') && !cssText.includes('.pf-preview-card'), 'les anciennes classes remplacees ne doivent plus exister dans le CSS (onboarding-screen/onboarding-content/onboarding-cta/features-list/feature-item/coach-badge/preview-card)');

  profileStep = 0;
  onboardingTransitionPhase = 'confirm';
  const cleanConfirmHtml = renderOnboardingTransitionScreen();
  __assertOk(!cleanConfirmHtml.includes("l'onglet « Défis"), 'l ancien texte avec ponctuation orpheline (emoji colle a la fermeture de guillemet) ne doit plus apparaitre');
  __assertOk(cleanConfirmHtml.includes('Ton programme personnalisé est prêt'), 'le sous-titre de confirmation doit etre court et propre');
  __assertOk(cleanConfirmHtml.includes('preview-title') && cleanConfirmHtml.includes('preview-badge'), 'la carte de preview doit avoir un nom d exercice et un badge neon separes (pas un bloc de texte brut)');
  __assertOk(cleanConfirmHtml.includes('preview-container') && cleanConfirmHtml.includes('preview-header-tag') && cleanConfirmHtml.includes('exercise-name') && cleanConfirmHtml.includes('exercise-sub'), 'la carte de preview doit etre etiquetee comme un EXEMPLE (pas presentee comme le seul defi genere)');
  __assertOk(cleanConfirmHtml.includes('Découvrir mes défis'), 'le bouton de fin d onboarding doit inviter a decouvrir les autres defis, pas juste demarrer');
  __assertOk(cleanConfirmHtml.includes('onboarding-screen') && cleanConfirmHtml.includes('onboarding-content') && cleanConfirmHtml.includes('onboarding-cta'), 'l ecran de confirmation doit utiliser le nouveau design system (onboarding-screen/onboarding-content/onboarding-cta)');
  onboardingTransitionPhase = null;
  console.log('OK: refonte visuelle premium de l onboarding (design system exact applique integralement)');

  // --- 134. Bouton retour minimaliste (filet de secours iOS, le swipe natif n est pas
  // toujours fiable) : cercle discret sur la vue detaillee d un defi (flottant, absent
  // avant ce correctif), sur Parametres et sur le formulaire de defi personnalise ---
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  render(false);
  const challengeDetailBackHtml = document.getElementById('app').innerHTML;
  __assertOk(challengeDetailBackHtml.includes('nav-back-btn') && challengeDetailBackHtml.includes('floating') && challengeDetailBackHtml.includes("history.back()"), 'la vue detaillee d un defi doit avoir un bouton retour flottant relie a history.back()');
  currentChallengeId = null;
  activeTab = 'account';
  settingsScreenOpen = true;
  render(false);
  const settingsBackHtml = document.getElementById('app').innerHTML;
  __assertOk(settingsBackHtml.includes('nav-back-btn') && settingsBackHtml.includes("history.back()"), 'l ecran Parametres doit garder un bouton retour relie a history.back()');
  settingsScreenOpen = false;
  activeTab = 'library';
  editingChallengeId = 'new';
  render(false);
  const formBackHtml = document.getElementById('app').innerHTML;
  __assertOk(formBackHtml.includes('nav-back-btn') && formBackHtml.includes("history.back()"), 'le formulaire de defi personnalise doit garder un bouton retour relie a history.back()');
  editingChallengeId = null;
  activeTab = 'today';
  __assertOk(!cssText.includes('.history-back'), 'l ancienne classe texte remplacee ne doit plus exister dans le CSS');
  console.log('OK: bouton retour minimaliste present sur les ecrans secondaires (defi/parametres/formulaire)');

  // --- 135. Journal : l emoji calendrier "tear-off" (📅, "17 JUL" grave en dur dans le
  // dessin Apple) ne doit plus apparaitre dans la popup de detail du jour, remplace par
  // 🗓️ (sans date fixe dessinee) ---
  activeTab = 'account';
  profileView = 'journal';
  popupQueue = []; popupOpen = false;
  await showDayDetailModal(todayKey);
  __assertOk(!currentPopupHtml.includes('📅'), 'l emoji calendrier avec une date figee (17 JUL) ne doit plus apparaitre');
  __assertOk(currentPopupHtml.includes('🗓️'), 'un icone calendrier sans date figee doit le remplacer');
  document.getElementById('appPopupCloseX').onclick();
  activeTab = 'today';
  profileView = 'profile';
  console.log('OK: emoji calendrier fige (17 JUL) remplace dans la popup de detail du jour');

  // --- 136. Heatmap : seulement 3 niveaux de couleur distincts (0 / 1 / 2+ defis),
  // fini les 4 nuances proches peu lisibles ; legende explicite ---
  dailyActivity = { [todayKey]: 5 };
  const heatmap3 = renderHeatmap();
  __assertOk(!heatmap3.includes('lvl3'), 'il ne doit plus y avoir de 4e niveau (lvl3)');
  __assertOk(heatmap3.includes('lvl2'), 'le niveau maximal (2+ defis) doit exister');
  __assertOk(heatmap3.includes('heat-legend-item') && heatmap3.includes('Aucun') && heatmap3.includes('1 défi') && heatmap3.includes('2+ défis'), 'la legende doit refleter clairement les 3 niveaux (Aucun / 1 defi / 2+ defis)');
  const lvl1CellIdx = cssText.indexOf('.heat-cell.lvl1');
  const lvl1Block = cssText.slice(lvl1CellIdx, cssText.indexOf('}', lvl1CellIdx));
  __assertOk(lvl1Block.includes('rgba(57, 233, 122, 0.4)'), 'le niveau 1 defi doit etre un vert accent adouci, distinct du niveau 2+ (accent plein)');
  dailyActivity = {};
  console.log('OK: heatmap simplifiee a 3 etats de couleur tres contrastes');

  // --- 137. Partage des stats (onglet Journal) : icone SVG epuree style iOS
  // (square.and.arrow.up), fini l emoji 📤 avec son fond lourd ---
  activeTab = 'account';
  profileView = 'journal';
  render(false);
  const journalShareHtml = document.getElementById('app').innerHTML;
  __assertOk(journalShareHtml.includes('share-icon') && journalShareHtml.includes('<svg'), 'le bouton de partage des stats doit utiliser une icone SVG');
  __assertOk(!journalShareHtml.includes('📤 Partager'), 'l ancien emoji de partage ne doit plus apparaitre devant le texte du bouton');
  activeTab = 'today';
  profileView = 'profile';
  console.log('OK: icone de partage des stats remplacee par un SVG epure style iOS');

  // --- 138. Communaute (fondations) : defi du jour communautaire genere de facon
  // deterministe (meme seed = date -> meme resultat sur tous les clients, sans backend) ---
  const dailyA = getDailyCommunityChallenges('2026-08-10');
  const dailyB = getDailyCommunityChallenges('2026-08-10');
  __assertOk(!!dailyA.challenge1 && !!dailyA.challenge2, 'les 2 defis communautaires doivent etre resolus');
  __assertEq(dailyA.challenge1.id, dailyB.challenge1.id, 'meme date -> meme defi 1 (deterministe, aucun hasard reel)');
  __assertEq(dailyA.challenge2.id, dailyB.challenge2.id, 'meme date -> meme defi 2 (deterministe)');
  __assertEq(dailyA.challenge1.cat, 'Gainage / Core', 'le defi 1 doit toujours venir de la categorie Gainage / Core');
  __assertOk(dailyA.challenge2.cat !== 'Gainage / Core', 'le defi 2 doit venir d une autre categorie');
  const dailyOtherDate = getDailyCommunityChallenges('2026-12-25');
  __assertOk(!!dailyOtherDate.challenge1 && !!dailyOtherDate.challenge2, 'une autre date doit aussi resoudre 2 defis valides');
  console.log('OK: defi du jour communautaire deterministe (identique pour tous, sans backend)');

  // --- 139. Communaute (fondations) : exercice hebdomadaire du Boss Battle,
  // deterministe par semaine calendaire (meme lundi -> meme exercice, reste pur/
  // synchrone -- seule la CIBLE CHIFFREE a besoin d une lecture Firestore) ---
  const bossChallengeA = getWeeklyBossBattleChallenge('2026-08-10');
  const bossChallengeB = getWeeklyBossBattleChallenge('2026-08-10');
  __assertEq(bossChallengeA.id, bossChallengeB.id, 'meme lundi de semaine -> meme exercice cible (deterministe)');
  __assertOk(CHALLENGE_LIBRARY.some(c => c.id === bossChallengeA.id), 'l exercice cible du Boss Battle doit exister dans CHALLENGE_LIBRARY');
  console.log('OK: exercice hebdomadaire du Boss Battle deterministe (identique pour toute la communaute)');

  // --- 139bis. Cible adaptative : plancher (x2 l objectif journalier standard) sans
  // historique, puis ratio "multiples de l objectif standard" (sans unite) de la
  // semaine precedente x1.15, RECONVERTI dans l unite du defi de CETTE semaine --
  // deux exercices differents n ont pas le meme volume naturel (ex: pompes vs
  // squats), et reps/secondes ne sont jamais comparables directement : recopier le
  // nombre brut d une semaine a l autre serait incoherent des que l exercice change.
  __resetCommunityMocks();
  const noHistoryTarget = await computeWeeklyBossBattleTarget('2026-08-10');
  __assertEq(noHistoryTarget.targetAmount, Math.round(BOSS_BATTLE_FLOOR_RATIO * bossChallengeA.target), 'sans historique (1ere semaine ou mock reinitialise), la cible doit retomber sur le plancher (x2 l objectif standard)');

  // Assertion independante (sans reutiliser previousWeekStartKey() des 2 cotes) : le
  // 3 aout 2026 est un lundi, donc le lundi de la semaine precedant le 10 aout 2026
  // (un autre lundi) doit etre exactement le 3 aout 2026 -- 7 jours avant, pas 6/8.
  __assertEq(previousWeekStartKey('2026-08-10'), '2026-08-03', 'le lundi de la semaine precedente doit etre exactement 7 jours avant (03/08, pas 02/08 ni 04/08)');

  const prevWeekStartForTest = previousWeekStartKey('2026-08-10');
  const prevChallengeForTest = getWeeklyBossBattleChallenge(prevWeekStartForTest);
  await bossBattleDocRef(prevWeekStartForTest).set({ currentProgress: prevChallengeForTest.target * 100 }, { merge: true }); // "100x l objectif standard" reellement accompli la semaine precedente
  const adaptiveTarget = await computeWeeklyBossBattleTarget('2026-08-10');
  const expectedRatio = Math.max(BOSS_BATTLE_FLOOR_RATIO, 100 * BOSS_BATTLE_GROWTH_FACTOR);
  __assertEq(adaptiveTarget.targetAmount, Math.round(expectedRatio * bossChallengeA.target), 'la cible doit etre le ratio de la semaine precedente (x1.15) reconverti dans l unite du defi de CETTE semaine, jamais le nombre brut recopie tel quel');
  __resetCommunityMocks();
  console.log('OK: cible adaptative du Boss Battle (plancher sans historique, ratio normalise entre exercices differents sinon)');

  // --- 139ter. Le cache de la cible adaptative ne doit JAMAIS servir une valeur
  // perimee d une AUTRE semaine (getWeeklyBossBattleTarget() doit renvoyer null tant
  // qu il n a pas ete rafraichi pour la semaine demandee, plutot que la derniere
  // valeur en cache d une semaine differente) ---
  communityBossBattleTargetCache = { weekStart: '2000-01-03', targetChallengeId: 1, targetAmount: 999 };
  __assertEq(getWeeklyBossBattleTarget('2026-08-10'), null, 'une cible en cache pour une AUTRE semaine ne doit jamais etre servie a tort pour la semaine demandee');
  await refreshWeeklyBossBattleTargetCache('2026-08-10');
  __assertOk(getWeeklyBossBattleTarget('2026-08-10') !== null, 'apres rafraichissement pour la bonne semaine, la cible doit etre disponible');
  communityBossBattleTargetCache = null;
  console.log('OK: le cache de la cible adaptative ne sert jamais une valeur perimee d une autre semaine');

  // --- 140. Mock Firestore generique (collections communautaires top-level) : get/set
  // avec merge, FieldValue.increment, requetes where/orderBy/limit/count, onSnapshot,
  // sous-collections -- fondation du harnais de test pour les batches suivants ---
  __resetCommunityMocks();
  await db.collection('leaderboard').doc('uid1').set({ displayName: 'Alice', xpTotal: 100 }, { merge: true });
  const uid1Snap = await db.collection('leaderboard').doc('uid1').get();
  __assertOk(uid1Snap.exists && uid1Snap.data().displayName === 'Alice' && uid1Snap.data().xpTotal === 100, 'set/get basique sur une collection communautaire simulee');
  await db.collection('leaderboard').doc('uid1').set({ streakCount: 5 }, { merge: true });
  const uid1Snap2 = await db.collection('leaderboard').doc('uid1').get();
  __assertOk(uid1Snap2.data().xpTotal === 100 && uid1Snap2.data().streakCount === 5, 'un set en merge:true ne doit jamais ecraser les autres champs deja presents');
  await db.collection('leaderboard').doc('uid1').set({ xpTotal: firebase.firestore.FieldValue.increment(50) }, { merge: true });
  const uid1Snap3 = await db.collection('leaderboard').doc('uid1').get();
  __assertEq(uid1Snap3.data().xpTotal, 150, 'FieldValue.increment() doit incrementer atomiquement la valeur existante');

  await db.collection('leaderboard').doc('uid2').set({ displayName: 'Bob', xpTotal: 300 }, { merge: true });
  await db.collection('leaderboard').doc('uid3').set({ displayName: 'Chloe', xpTotal: 50 }, { merge: true });
  const topByXp = await db.collection('leaderboard').orderBy('xpTotal', 'desc').limit(2).get();
  __assertEq(topByXp.docs.map(d => d.data().displayName), ['Bob', 'Alice'], 'orderBy(desc)+limit doit renvoyer les 2 plus hauts XP dans l ordre');
  const countAboveMine = await db.collection('leaderboard').where('xpTotal', '>', 150).count().get();
  __assertEq(countAboveMine.data().count, 1, 'count() doit compter uniquement les documents au-dessus du seuil (rang exact sans lire tout le classement)');

  let lastSnapshotXp = null;
  const unsub = db.collection('leaderboard').doc('uid1').onSnapshot((snap) => { lastSnapshotXp = snap.data() ? snap.data().xpTotal : null; });
  await Promise.resolve().then(() => {}).then(() => {}); // laisse la microtask du get() initial de onSnapshot se resoudre
  __assertEq(lastSnapshotXp, 150, 'onSnapshot doit etre declenche avec l etat courant a l abonnement');
  await db.collection('leaderboard').doc('uid1').set({ xpTotal: 999 }, { merge: true });
  __assertEq(lastSnapshotXp, 999, 'onSnapshot doit etre re-declenche a chaque ecriture sur le document ecoute (temps reel)');
  unsub();

  await db.collection('community').doc('bossBattle_2026-08-10').collection('contributions').add({ uid: 'uid1', amount: 20 });
  await db.collection('community').doc('bossBattle_2026-08-10').collection('contributions').add({ uid: 'uid2', amount: 40 });
  const contribs = await db.collection('community').doc('bossBattle_2026-08-10').collection('contributions').orderBy('amount', 'desc').get();
  __assertEq(contribs.size, 2, 'une sous-collection doit accumuler ses propres documents independamment du document parent');
  __assertEq(contribs.docs[0].data().amount, 40, 'orderBy doit fonctionner aussi sur une sous-collection');
  __resetCommunityMocks();
  const afterReset = await db.collection('leaderboard').doc('uid1').get();
  __assertOk(!afterReset.exists, '__resetCommunityMocks() doit repartir d un etat vide entre les tests');
  console.log('OK: mock Firestore generique (merge, increment, requetes, onSnapshot, sous-collections)');

  // --- 140bis. Extensions du mock Firestore : where(...,'in',...), db.batch(),
  // db.runTransaction() -- prerequis pour le fil d amis/kudos (aucun des 3 n existait
  // avant : deleteMyAccount() utilise deja db.batch() en prod sans AUCUNE couverture
  // de test pour cette raison exacte). ---
  __resetCommunityMocks();
  await db.collection('activityFeed').doc('a1').set({ uid: 'alice' }, { merge: true });
  await db.collection('activityFeed').doc('a2').set({ uid: 'bob' }, { merge: true });
  await db.collection('activityFeed').doc('a3').set({ uid: 'chloe' }, { merge: true });
  const inQueryResults = await db.collection('activityFeed').where('uid', 'in', ['alice', 'chloe']).get();
  __assertEq(inQueryResults.docs.map(d => d.data().uid).sort(), ['alice', 'chloe'], 'where(field,"in",[...]) doit ne matcher que les valeurs presentes dans le tableau');
  const inQueryEmptyArray = await db.collection('activityFeed').where('uid', 'in', []).get();
  __assertEq(inQueryEmptyArray.size, 0, 'where(field,"in",[]) (tableau vide) ne doit jamais matcher personne');

  await db.collection('friendRequests').doc('alice_bob').set({ fromUid: 'alice', toUid: 'bob' }, { merge: true });
  const batch = db.batch();
  batch.set(db.collection('friendships').doc('alice_bob'), { uidA: 'alice', uidB: 'bob' });
  batch.delete(db.collection('friendRequests').doc('alice_bob'));
  await batch.commit();
  const friendshipAfterBatch = await db.collection('friendships').doc('alice_bob').get();
  const requestAfterBatch = await db.collection('friendRequests').doc('alice_bob').get();
  __assertOk(friendshipAfterBatch.exists && !requestAfterBatch.exists, 'db.batch() doit appliquer plusieurs ecritures liees (creer + supprimer) en un seul commit()');

  await db.collection('leaderboard').doc('uid1').set({ kudosTotal: 4 }, { merge: true });
  const kudosResult = await db.runTransaction(async (tx) => {
    const doc = await tx.get(db.collection('leaderboard').doc('uid1'));
    const current = doc.exists ? (doc.data().kudosTotal || 0) : 0;
    tx.set(db.collection('leaderboard').doc('uid1'), { kudosTotal: current + 1 }, { merge: true });
    return current + 1;
  });
  const uid1AfterTx = await db.collection('leaderboard').doc('uid1').get();
  __assertEq(kudosResult, 5, 'runTransaction() doit renvoyer la valeur de retour du callback');
  __assertEq(uid1AfterTx.data().kudosTotal, 5, 'runTransaction() doit lire l etat courant (tx.get) et ecrire (tx.set) dans le meme cycle');
  __resetCommunityMocks();
  console.log('OK: extensions du mock Firestore (where in, db.batch, db.runTransaction) pretes pour le fil d amis/kudos');

  // --- Bug reel signale (RGPD) : deleteMyAccount() ne nettoyait jamais le roster des
  // groupes (groups/{id}/members/{uid}) ni les relations d amitie
  // (friendships/{pairId}) - le profil supprime continuait d apparaitre comme
  // membre/ami chez les autres utilisateurs. Couverture desormais possible grace aux
  // extensions du mock Firestore ci-dessus (db.batch(), where(...,'in',...)).
  currentUser = { uid: 'm-deleteme-uid', displayName: 'A Supprimer', email: 'del@test.com', photoURL: '' };
  // Bug reel signale (2e ronde) : le pseudo (reservation create-only
  // usernames/{pseudo}) n etait jamais libere - en recreant un profil juste
  // apres une suppression, l app refusait le pseudo comme "deja pris" par
  // l ancien compte, pourtant supprime.
  const usernameBeforeDelete = username;
  username = 'monpseudo';
  await db.collection('usernames').doc('monpseudo').set({ uid: 'm-deleteme-uid' });
  await db.collection('users').doc('m-deleteme-uid').collection('myGroups').doc('groupA').set({ groupId: 'groupA', name: 'Groupe A' });
  await db.collection('users').doc('m-deleteme-uid').collection('myGroups').doc('groupB').set({ groupId: 'groupB', name: 'Groupe B' });
  await db.collection('groups').doc('groupA').collection('members').doc('m-deleteme-uid').set({ uid: 'm-deleteme-uid', displayName: 'A Supprimer' });
  await db.collection('groups').doc('groupB').collection('members').doc('m-deleteme-uid').set({ uid: 'm-deleteme-uid', displayName: 'A Supprimer' });
  // 2 amities, une ou m-deleteme-uid est uidA (trie apres), une ou il est uidB (trie
  // avant) - couvre les 2 sens de la requete bornee (where uidA==uid / where uidB==uid).
  await db.collection('friendships').doc('a-friend1-uid_m-deleteme-uid').set({ uidA: 'a-friend1-uid', uidB: 'm-deleteme-uid' });
  await db.collection('friendships').doc('m-deleteme-uid_z-friend2-uid').set({ uidA: 'm-deleteme-uid', uidB: 'z-friend2-uid' });
  const originalConfirmModalDeleteAccount = confirmModal;
  confirmModal = async () => true;
  await deleteMyAccount();
  confirmModal = originalConfirmModalDeleteAccount;
  const memberADoc = await db.collection('groups').doc('groupA').collection('members').doc('m-deleteme-uid').get();
  const memberBDoc = await db.collection('groups').doc('groupB').collection('members').doc('m-deleteme-uid').get();
  __assertOk(!memberADoc.exists && !memberBDoc.exists, 'deleteMyAccount() doit retirer l utilisateur du roster de CHAQUE groupe dont il etait membre (sinon il continue d apparaitre comme membre chez les autres)');
  const myGroupsAfterDelete = await db.collection('users').doc('m-deleteme-uid').collection('myGroups').get();
  __assertEq(myGroupsAfterDelete.size, 0, 'le propre index myGroups de l utilisateur doit aussi etre nettoye');
  const friendship1After = await db.collection('friendships').doc('a-friend1-uid_m-deleteme-uid').get();
  const friendship2After = await db.collection('friendships').doc('m-deleteme-uid_z-friend2-uid').get();
  __assertOk(!friendship1After.exists && !friendship2After.exists, 'les 2 relations d amitie (peu importe le sens, uidA ou uidB) doivent etre supprimees - un seul document partage par paire, donc retire aussi de la liste de l autre personne');
  const usernameDocAfterDelete = await db.collection('usernames').doc('monpseudo').get();
  __assertOk(!usernameDocAfterDelete.exists, 'le pseudo doit etre libere a la suppression du compte, sinon personne (meme le meme utilisateur) ne peut plus jamais le reprendre');
  username = usernameBeforeDelete;
  console.log('OK: deleteMyAccount() nettoie desormais le roster des groupes, les relations d amitie ET le pseudo reserve (bugs RGPD reels corriges)');

  // Bug reel signale (cause racine du pseudo saute silencieusement pendant
  // l onboarding) : la variable username n etait jamais reinitialisee a la
  // deconnexion - dans la meme session (deconnexion puis reconnexion immediate
  // sur un AUTRE compte, ex: juste apres deleteMyAccount()), la valeur de
  // l ancien compte restait en memoire, et pour un compte tout neuf
  // loadAppData() ne la touche meme pas (son bloc conditionnel "doc existe" est
  // saute quand le document consolide n existe pas encore) -
  // finishProfileOnboarding() voyait alors username toujours "vrai" et sautait
  // silencieusement l etape de choix du pseudo. Le handler onAuthStateChanged()
  // n est jamais reellement declenchable depuis ce harnais de test (mock
  // auth() : pilote manuellement depuis le test, jamais un vrai callback) -
  // verification a la source, meme principe que les autres garde-fous
  // document/window.addEventListener deja verifies ainsi ailleurs dans ce fichier.
  const usernameResetIdx = __rawHtml.indexOf('    username = null;');
  const usernameSetupModeResetIdx = __rawHtml.indexOf('usernameSetupMode = null;');
  __assertOk(usernameResetIdx !== -1, 'le handler de deconnexion doit reinitialiser username a null (indentation de reaffectation, pas la declaration let en tete de fichier)');
  __assertOk(usernameResetIdx !== -1 && usernameSetupModeResetIdx !== -1 && usernameResetIdx < usernameSetupModeResetIdx, 'la reinitialisation de username doit se trouver dans le meme bloc que celle de usernameSetupMode (deconnexion), pas ailleurs par coincidence');

  // --- 141. Pilier 1 : Hero Banner communautaire remplace l ecran vide par defaut
  // (accompagnement sans effort de choix + preuve sociale/FOMO) ---
  __resetCommunityMocks();
  todayKey = '2026-08-10';
  const { challenge1: heroC1, challenge2: heroC2 } = getDailyCommunityChallenges(todayKey);
  activeToday = new Set();
  state = emptyDayState();
  communityDailyCounts = { completions1: 3, completions2: 7, participants: 5 };
  activeTab = 'today';
  currentChallengeId = null;
  render(false);
  const heroHtml = document.getElementById('app').innerHTML;
  __assertOk(heroHtml.includes('community-hero-banner'), 'le Hero Banner doit remplacer l ancien ecran vide quand aucun defi n est actif');
  __assertOk(heroHtml.includes(escapeHtml(heroC1.name)) && heroHtml.includes(escapeHtml(heroC2.name)), 'les 2 defis communautaires du jour doivent etre presents sur le banner');
  // Meme format de carte que l onglet Defis (.picker-item : nom a gauche, reps/poids a
  // droite via .name/.goal/.goal-weight), plutot qu une mise en page dediee -- coherence
  // visuelle demandee entre les 2 ecrans.
  __assertOk(heroHtml.includes('picker-item') && heroHtml.includes('class="name"') && heroHtml.includes('class="goal"'), 'les cartes du Hero Banner doivent reutiliser le meme format que l onglet Defis (nom a gauche, reps/poids a droite)');
  __assertOk(!heroHtml.includes('community-hero-name') && !heroHtml.includes('community-hero-info'), 'l ancienne mise en page dediee (nom/objectif empiles) ne doit plus exister');
  const heroHasWeightExercise = heroC1.cat === 'Haltères' || heroC2.cat === 'Haltères';
  __assertEq(heroHtml.includes('goal-weight'), heroHasWeightExercise, 'le poids (comme sur l onglet Defis) ne doit apparaitre que si l un des 2 defis du jour est de categorie Halteres');
  // La preuve sociale (participants) doit etre affichee UNE SEULE FOIS en haut de la
  // carte globale, pas repetee sous chaque exercice avec des chiffres differents
  // (completions1/completions2, qui restent des compteurs distincts, utilises
  // seulement par le ruban dans la bibliotheque).
  __assertOk(heroHtml.includes('community-hero-proof') && heroHtml.includes('5 membres') && heroHtml.includes('ont relevé ce défi aujourd'), 'un unique compteur de participants doit etre affiche en haut de la carte');
  __assertOk(!heroHtml.includes('3 membre') && !heroHtml.includes('7 membre'), 'les completions par exercice ne doivent plus etre affichees repetees sous chaque carte du Hero Banner');
  __assertOk(heroHtml.includes('acceptAllCommunityChallenges()'), 'un unique bouton doit permettre d accepter les 2 defis communautaires EN UNE FOIS (pas un bouton par carte, source de confusion : n activait qu un seul des 2 defis)');
  __assertOk(!heroHtml.includes('community-hero-accept-btn'), 'les anciens boutons par carte (un seul defi active a la fois) ne doivent plus exister');
  __assertOk(heroHtml.includes("switchTab('library')"), 'un CTA doit permettre de choisir un defi personnalise a la place');
  console.log('OK: Hero Banner communautaire affiche par defaut quand aucun defi n est actif');

  // --- 142. Le bouton unique active les 2 defis communautaires EN UNE FOIS, et fait
  // disparaitre le Hero Banner (remplace par la liste normale) ---
  await acceptAllCommunityChallenges();
  __assertOk(activeToday.has(heroC1.id) && activeToday.has(heroC2.id), 'acceptAllCommunityChallenges doit activer les 2 defis communautaires du jour, pas seulement un');
  render(false);
  const afterAcceptHtml = document.getElementById('app').innerHTML;
  __assertOk(!afterAcceptHtml.includes('community-hero-banner'), 'le Hero Banner doit disparaitre des qu un defi (communautaire ou personnel) est actif');
  __assertOk(afterAcceptHtml.includes('community-card-ribbon'), 'les defis acceptes doivent garder un ruban communautaire sur leur carte dans la liste normale');
  __assertOk(afterAcceptHtml.includes('🌍 3') && afterAcceptHtml.includes('🌍 7'), 'le ruban doit afficher le compteur de validations en cours pour CHAQUE defi (preuve sociale conservee apres acceptation)');
  // Le clic sur le bouton unique compte aussi comme UNE participation au defi du jour
  // (distinct des completions), une seule fois par jour meme si le bouton est cliquable
  // plusieurs fois (garde-fou state.communityJoined, persiste via saveState()).
  const participantDocAfterAccept = await communityDailyChallengeDocRef(todayKey).get();
  __assertEq(participantDocAfterAccept.data().participants, 1, 'accepter le defi communautaire doit incrementer le compteur partage de participants');
  __assertOk(state.communityJoined, 'le flag de participation du jour doit etre memorise (pour ne jamais recompter le meme utilisateur)');
  await acceptAllCommunityChallenges();
  const participantDocAfterSecondClick = await communityDailyChallengeDocRef(todayKey).get();
  __assertEq(participantDocAfterSecondClick.data().participants, 1, 'un 2e appel le meme jour ne doit jamais recompter la meme participation');
  activeToday = new Set();
  console.log('OK: le bouton unique active les 2 defis communautaires en une fois et masque le banner (FOMO conserve via le ruban)');

  // --- 143. Completer un defi communautaire incremente le compteur partage
  // (community/dailyChallenge_{date}), une seule fois par jour et par defi ---
  activeToday = new Set([heroC1.id]);
  state = emptyDayState();
  currentChallengeId = heroC1.id;
  stats[heroC1.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  const targetC1 = resolveChallenge(heroC1).target;
  await addSet(targetC1);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  const dailyDocAfter = await communityDailyChallengeDocRef(todayKey).get();
  __assertOk(dailyDocAfter.exists, 'terminer un defi communautaire doit creer/mettre a jour le doc partage du jour');
  __assertEq(dailyDocAfter.data().completions1, 1, 'completer le defi 1 doit incrementer completions1');
  // Annuler puis re-valider le meme defi le meme jour (undoLast -> addSet) ne doit
  // JAMAIS re-incrementer : sans garde-fou, ce cycle gonflerait artificiellement la
  // preuve sociale partagee par toute la communaute.
  await undoLast();
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  await addSet(targetC1);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  const dailyDocAfter2 = await communityDailyChallengeDocRef(todayKey).get();
  __assertEq(dailyDocAfter2.data().completions1, 1, 'un defi deja compte aujourd hui ne doit jamais etre recompte, meme apres un cycle annuler/revalider (pas de gonflement artificiel de la preuve sociale)');
  currentChallengeId = null;
  activeToday = new Set();
  console.log('OK: compteur de validations communautaire incremente une seule fois par defi/par jour');

  // --- 144. Pilier 2 : nouvel onglet Communaute + syncLeaderboardEntry (XP hebdo
  // avec reset lundi, streak) ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Alice', email: 'a@test.com', photoURL: '' };
  leaderboardOptOut = false;
  const communityTabBarHtml = renderTabBar();
  __assertOk(communityTabBarHtml.includes("switchTab('community')"), 'un 5e onglet Communaute doit exister dans la tab-bar');

  xpTotal = 0; xpWeekly = 0; xpWeekStart = null;
  await awardXp(80);
  let myLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertOk(myLbDoc.exists, 'awardXp() doit synchroniser une entree de classement');
  __assertEq(myLbDoc.data().xpTotal, 80, 'xpTotal synchronise doit correspondre');
  __assertEq(myLbDoc.data().xpWeekly, 80, 'xpWeekly doit demarrer a la valeur gagnee cette semaine');
  const wkNow = mondayOfWeek(new Date());
  __assertEq(myLbDoc.data().xpWeekStart, wkNow, 'xpWeekStart doit etre le lundi de la semaine courante');
  await awardXp(20);
  myLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertEq(myLbDoc.data().xpWeekly, 100, 'un 2e gain la meme semaine doit s additionner');
  // Simule un ancien xpWeekStart (semaine precedente) : le prochain gain doit repartir a zero.
  xpWeekStart = '2000-01-03';
  await awardXp(15);
  myLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertEq(myLbDoc.data().xpWeekly, 15, 'un nouveau lundi doit remettre xpWeekly a zero avant d ajouter le nouveau gain');
  __assertEq(myLbDoc.data().xpTotal, 115, 'xpTotal, lui, ne doit jamais etre remis a zero (historique a vie)');

  streakCount = 4;
  await saveStreakData();
  myLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertEq(myLbDoc.data().streakCount, 4, 'saveStreakData() doit aussi synchroniser le classement (serie)');
  console.log('OK: onglet Communaute + synchronisation classement (XP hebdo avec reset lundi, XP total, serie)');

  // --- 145. Toggle vie privee : desactiver retire le doc public, reactiver le recree ---
  await toggleLeaderboardOptOut();
  __assertOk(leaderboardOptOut, 'toggleLeaderboardOptOut doit activer le retrait');
  const deletedDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertOk(!deletedDoc.exists, 'se retirer du classement doit supprimer le document public existant (pas juste l ignorer en lecture)');
  await awardXp(5);
  const stillGoneDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertOk(!stillGoneDoc.exists, 'tant que le retrait est actif, aucune synchronisation ne doit recreer le document');
  await toggleLeaderboardOptOut();
  __assertOk(!leaderboardOptOut, 'toggleLeaderboardOptOut doit pouvoir revenir en arriere');
  const recreatedDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertOk(recreatedDoc.exists, 'reactiver la participation doit resynchroniser immediatement le document');
  console.log('OK: toggle vie privee du classement (suppression reelle du document, resynchronisation a la reactivation)');

  // --- 145bis. Amis (demande mutuelle) : recherche exacte par pseudo, envoi/acceptation/
  // refus/retrait, badge de notification, jamais besoin d ecrire dans le document
  // personnel d autrui (friendships/{paire triee} + friendRequests/{from}_{to}). ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  myFriends = []; incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  friendSearchQuery = ''; friendSearchResult = null;

  // ID deterministes.
  __assertEq(friendRequestId('a', 'b'), 'a_b', 'friendRequestId doit etre from_to, dans cet ordre');
  __assertEq(friendshipPairId('zoe', 'alice'), 'alice_zoe', 'friendshipPairId doit trier les 2 uids');
  __assertEq(friendshipPairId('alice', 'zoe'), 'alice_zoe', 'friendshipPairId doit etre le meme quel que soit l ordre d appel');

  // Recherche : pseudo introuvable.
  friendSearchQuery = 'inconnu123';
  await submitFriendSearch();
  __assertEq(friendSearchResult, 'not-found', 'un pseudo non reserve doit etre signale introuvable');

  // Recherche : son propre pseudo.
  await usernamesCollRef().doc('moipseudo').set({ uid: 'me-uid' });
  friendSearchQuery = 'moipseudo';
  await submitFriendSearch();
  __assertEq(friendSearchResult, 'self', 'rechercher son propre pseudo doit etre signale explicitement');

  // Recherche : pseudo reserve mais personne introuvable (opt-out classement = opt-out
  // decouverte, effet de bord voulu -- voir fetchPublicProfile()).
  await usernamesCollRef().doc('fantome').set({ uid: 'ghost-uid' });
  friendSearchQuery = 'fantome';
  await submitFriendSearch();
  __assertEq(friendSearchResult, 'not-found', 'un pseudo reserve par quelqu un qui a desactive le classement doit rester introuvable');

  // Recherche : trouve, aucune relation encore -> bouton "+ Ajouter".
  await usernamesCollRef().doc('alicepseudo').set({ uid: 'alice-uid' });
  await db.collection('leaderboard').doc('alice-uid').set({ displayName: 'Alice Dupont', photoURL: '' }, { merge: true });
  friendSearchQuery = 'alicepseudo';
  await submitFriendSearch();
  __assertOk(typeof friendSearchResult === 'object' && friendSearchResult.uid === 'alice-uid' && friendSearchResult.relation === 'none', 'un pseudo trouve sans relation existante doit permettre d envoyer une demande');
  __assertEq(friendSearchResult.displayName, 'Alice D.', 'le nom affiche doit etre anonymise (formatDisplayName), jamais le nom complet');
  const searchResultHtml = renderFriendsScreen();
  __assertOk(searchResultHtml.includes("sendFriendRequest('alice-uid')"), 'le bouton doit permettre d envoyer une demande a ce uid precis');

  // Envoi de la demande.
  await sendFriendRequest('alice-uid');
  const sentReqDoc = await db.collection('friendRequests').doc('me-uid_alice-uid').get();
  __assertOk(sentReqDoc.exists && sentReqDoc.data().fromUid === 'me-uid' && sentReqDoc.data().toUid === 'alice-uid', 'la demande doit etre creee avec un ID deterministe from_to');
  __assertEq(friendSearchResult.relation, 'request-sent', 'l etat local doit refleter immediatement la demande envoyee (sans re-recherche)');

  // Cote destinataire (Alice) : la demande doit apparaitre en "recue".
  currentUser = { uid: 'alice-uid', displayName: 'Alice Dupont', email: 'a@test.com', photoURL: '' };
  await refreshFriendsData();
  __assertEq(incomingFriendRequests.length, 1, 'Alice doit voir 1 demande recue');
  __assertEq(incomingFriendRequests[0].fromUid, 'me-uid', 'la demande recue doit venir de moi-uid');
  const communityHeaderHtml = renderCommunityScreen();
  __assertOk(communityHeaderHtml.includes('friends-badge') && communityHeaderHtml.includes('>1<'), 'le bouton Amis doit afficher un badge avec le nombre de demandes en attente');

  // Acceptation : cree friendships/{paire triee}, supprime la demande, ET
  // previent desormais le demandeur original (Phase A notifications push -
  // trou reel comble : avant ce correctif, Alice n etait jamais prevenue que
  // sa demande avait ete acceptee).
  await acceptFriendRequest('me-uid');
  const friendshipDoc = await db.collection('friendships').doc(friendshipPairId('me-uid', 'alice-uid')).get();
  __assertOk(friendshipDoc.exists, 'accepter doit creer le document friendships partage');
  __assertEq([friendshipDoc.data().uidA, friendshipDoc.data().uidB].sort(), ['alice-uid', 'me-uid'], 'le document friendships doit contenir les 2 uids');
  const reqAfterAccept = await db.collection('friendRequests').doc('me-uid_alice-uid').get();
  __assertOk(!reqAfterAccept.exists, 'la demande doit etre supprimee une fois acceptee (pas juste marquee)');
  __assertEq(incomingFriendRequests.length, 0, 'la demande acceptee ne doit plus apparaitre en attente');
  __assertOk(myFriends.some(f => f.uid === 'me-uid'), 'Alice doit maintenant voir "moi" dans sa liste d amis');
  const meAcceptedNotifs = await notificationsCollRef('me-uid').where('type', '==', 'friend_request_accepted').get();
  __assertEq(meAcceptedNotifs.size, 1, 'moi-uid (demandeur original) doit recevoir une notification friend_request_accepted');
  __assertEq(meAcceptedNotifs.docs[0].data().fromUid, 'alice-uid', 'fromUid doit etre la personne qui a accepte (Alice)');
  console.log('OK: acceptFriendRequest() previent le demandeur original (friend_request_accepted, trou reel comble)');

  // Cote "moi" : doit aussi voir Alice comme amie (meme document partage, requete
  // symetrique uidA/uidB).
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await refreshFriendsData();
  __assertOk(myFriends.some(f => f.uid === 'alice-uid'), 'moi doit aussi voir Alice comme amie, sans qu aucun document dans mon espace personnel n ait ete modifie par Alice');

  // Refus (avec un 2e utilisateur, Bob) : supprime juste la demande, ne cree JAMAIS de friendships.
  await usernamesCollRef().doc('bobpseudo').set({ uid: 'bob-uid' });
  await db.collection('leaderboard').doc('bob-uid').set({ displayName: 'Bob Martin', photoURL: '' }, { merge: true });
  await sendFriendRequest('bob-uid');
  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  await refreshFriendsData();
  __assertEq(incomingFriendRequests.length, 1, 'Bob doit voir la demande de "moi"');
  await declineFriendRequest('me-uid');
  const reqAfterDecline = await db.collection('friendRequests').doc('me-uid_bob-uid').get();
  __assertOk(!reqAfterDecline.exists, 'refuser doit supprimer la demande');
  const friendshipAfterDecline = await db.collection('friendships').doc(friendshipPairId('me-uid', 'bob-uid')).get();
  __assertOk(!friendshipAfterDecline.exists, 'refuser ne doit JAMAIS creer de document friendships');

  // Retrait d un ami : passe par confirmModal (comme les autres actions destructives du
  // projet), supprime le document friendships partage.
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await refreshFriendsData();
  __assertOk(myFriends.some(f => f.uid === 'alice-uid'), 'pre-requis : Alice doit encore etre amie avant le test de retrait');
  const removeFriendPromise = removeFriend('alice-uid');
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await removeFriendPromise;
  const friendshipAfterRemove = await db.collection('friendships').doc(friendshipPairId('me-uid', 'alice-uid')).get();
  __assertOk(!friendshipAfterRemove.exists, 'retirer un ami doit supprimer le document friendships partage');
  __assertOk(!myFriends.some(f => f.uid === 'alice-uid'), 'Alice ne doit plus apparaitre dans ma liste d amis apres retrait');

  // Ecran Amis : ecran pousse, dismissible via goBackOneLevel() (pas de verrou ici,
  // contrairement au pseudo obligatoire).
  friendsScreenOpen = true;
  goBackOneLevel();
  __assertEq(friendsScreenOpen, false, 'l ecran Amis doit etre dismissible via le bouton retour');

  __resetCommunityMocks();
  myFriends = []; incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  friendSearchQuery = ''; friendSearchResult = null;
  currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };
  console.log('OK: systeme d amis (recherche exacte par pseudo, demande/acceptation/refus/retrait, badge de notification, jamais d ecriture dans le document personnel d autrui)');

  // --- Retour utilisateur : fiabiliser le systeme de demandes d amis. La section
  // "Demandes en attente" doit (1) afficher le PSEUDO de l expediteur, pas son nom
  // Google formate, et (2) rester fiable meme si la notification (push OS ou popup
  // in-app) a ete manquee/refusee - ouvrir l ecran Amis doit toujours re-interroger
  // Firestore, jamais dependre d une notification recue pour retrouver une demande. ---
  __resetCommunityMocks();
  await usernamesCollRef().doc('senderpseudo').set({ uid: 'sender-uid' });
  await db.collection('leaderboard').doc('sender-uid').set({ displayName: 'Sender Real', photoURL: '' }, { merge: true });
  currentUser = { uid: 'sender-uid', displayName: 'Sender Real', email: 's@test.com', photoURL: '' };
  const usernameBeforeFriendPseudoTest = username;
  username = 'senderpseudo';
  await sendFriendRequest('recipient-uid');
  const pseudoReqDoc = await db.collection('friendRequests').doc('sender-uid_recipient-uid').get();
  __assertEq(pseudoReqDoc.data().fromUsername, 'senderpseudo', 'le pseudo de l expediteur doit etre denormalise sur le document friendRequests des l envoi (aucun index public uid->pseudo n existe ailleurs)');
  username = usernameBeforeFriendPseudoTest;

  // Cote destinataire : la ligne "Demandes en attente" doit afficher le pseudo (@...),
  // pas le nom Google formate.
  currentUser = { uid: 'recipient-uid', displayName: 'Recipient Name', email: 'r@test.com', photoURL: '' };
  myFriends = []; incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  await refreshFriendsData();
  __assertEq(incomingFriendRequests.length, 1, 'le destinataire doit voir 1 demande en attente');
  __assertEq(incomingFriendRequests[0].fromUsername, 'senderpseudo', 'le pseudo doit etre propage dans incomingFriendRequests');
  const pendingHtml = renderFriendsScreen();
  __assertOk(pendingHtml.includes(t('friends.incomingLabel')), 'le titre de section "Demandes en attente" doit etre affiche');
  __assertOk(pendingHtml.includes('@senderpseudo'), 'la ligne doit afficher le PSEUDO de l expediteur, prefixe par "@" (convention deja utilisee ailleurs dans l app)');
  __assertOk(!pendingHtml.includes('Sender Real') && !pendingHtml.includes('Sender R.'), 'le nom Google formate ne doit plus etre affiche des qu un pseudo est disponible sur la demande');

  // Repli legitime : une demande ecrite AVANT ce correctif (aucun champ fromUsername)
  // doit retomber sur le nom formate, pas planter/afficher "undefined".
  await db.collection('friendRequests').doc('legacy-uid_recipient-uid').set({ fromUid: 'legacy-uid', toUid: 'recipient-uid', at: Date.now() });
  await db.collection('leaderboard').doc('legacy-uid').set({ displayName: 'Legacy Sender', photoURL: '' }, { merge: true });
  await refreshFriendsData();
  const legacyHtml = renderFriendsScreen();
  __assertOk(legacyHtml.includes('Legacy S.'), 'une ancienne demande sans pseudo denormalise doit retomber sur le nom formate (repli gracieux)');
  console.log('OK: la section "Demandes en attente" affiche le pseudo de l expediteur (repli sur le nom formate pour les anciennes demandes sans ce champ)');

  // Fiabilite : ouvrir l ecran Amis doit TOUJOURS re-interroger Firestore, meme pour
  // une demande recue pendant que l app etait deja ouverte et pour laquelle aucune
  // notification (push ou in-app) n a jamais ete traitee - bug reel signale
  // (incomingFriendRequests n etait rafraichi qu au demarrage de l app et apres une
  // action ami, jamais a la reouverture de l ecran Amis lui-meme).
  await db.collection('friendRequests').doc('lateuid_recipient-uid').set({ fromUid: 'lateuid', toUid: 'recipient-uid', at: Date.now(), fromUsername: 'latecomer' });
  incomingFriendRequests = []; // simule un etat rafraichi pour la derniere fois AVANT que cette demande n existe
  openFriendsScreen();
  __assertEq(incomingFriendRequests.length, 0, 'le rendu synchrone initial de l ouverture ne doit pas bloquer sur la relecture Firestore (asynchrone)');
  await new Promise((r) => setTimeout(r, 20));
  __assertOk(incomingFriendRequests.some((r) => r.fromUid === 'lateuid'), 'ouvrir l ecran Amis doit re-interroger Firestore et retrouver une demande recue pendant que l app etait deja ouverte, meme sans notification');
  __assertOk(renderFriendsScreen().includes('@latecomer'), 'la demande retrouvee doit bien s afficher, pseudo inclus, sans avoir jamais dependu d une notification recue');
  friendsScreenOpen = false;
  console.log('OK: ouvrir l ecran Amis re-interroge toujours Firestore (fiable meme si la notification push/in-app a ete manquee ou refusee)');

  __resetCommunityMocks();
  myFriends = []; incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  friendSearchQuery = ''; friendSearchResult = null;
  currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };

  // --- 145ter. Fil d activite global (amis) : un document PAR defi complete (pas par
  // serie, contrairement au Boss Battle), filtre en lecture par la liste d amis
  // (where('uid','in', ...)), jamais un fil public. ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  myFriends = []; incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  communityActivityFeed = [];

  // Etat vide (aucun ami) : pas de requete Firestore lancee (where('in',[]) est
  // invalide cote vrai SDK), CTA vers l ecran Amis affiche.
  startActivityFeedListener();
  __assertEq(communityActivityFeed.length, 0, 'sans ami, le fil doit rester vide (aucune requete where(in,[]) invalide)');
  const noFriendsHtml = renderActivityFeedSection();
  __assertOk(noFriendsHtml.includes('Suis des amis') && noFriendsHtml.includes('openFriendsScreen()'), 'sans ami, un CTA doit inviter a en trouver');

  // Ecriture : completer un defi doit creer EXACTEMENT un document activityFeed, avec
  // le nom deja anonymise (jamais le nom complet dans une collection partagee).
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  const targetForFeed = getTarget();
  await addSet(targetForFeed);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  let feedSnap = await db.collection('activityFeed').orderBy('at').get();
  __assertEq(feedSnap.size, 1, 'completer un defi doit creer exactement 1 document activityFeed');
  __assertEq(feedSnap.docs[0].data().displayName, 'Moi A.', 'le nom doit etre anonymise des l ecriture (jamais le nom complet)');
  __assertEq(feedSnap.docs[0].data().amount, targetForFeed, 'le montant enregistre doit correspondre au total au moment de la completion');
  __assertEq(feedSnap.docs[0].data().kudosCount, 0, 'kudosCount doit demarrer a 0');
  currentChallengeId = null;

  // Une serie qui NE complete PAS le defi ne doit rien ecrire dans le fil (contrairement
  // au Boss Battle, qui compte chaque serie).
  state = emptyDayState();
  await pickChallenge(pompes.id);
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(1); // tres en dessous de l objectif
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  feedSnap = await db.collection('activityFeed').orderBy('at').get();
  __assertEq(feedSnap.size, 1, 'une serie qui ne complete pas le defi ne doit RIEN ajouter au fil (contrairement au Boss Battle)');
  currentChallengeId = null;

  // Lecture filtree par amis : l activite d une "amie" n apparait dans mon fil qu une
  // fois qu on est effectivement amis.
  // Optimisation quota Firestore : ce listener est suspendu hors de l onglet Communaute
  // (voir switchTab()/startActivityFeedListener()) - il ne se rattache que si activeTab
  // vaut bien 'community', exactement comme dans l appli reelle.
  activeTab = 'community';
  await db.collection('activityFeed').add({ uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Squats', cat: 'Bas du corps', amount: 50, unit: 'reps', at: Date.now(), kudosCount: 0 });
  startActivityFeedListener();
  __assertEq(communityActivityFeed.length, 0, 'sans etre ami avec amie-uid, son activite ne doit pas apparaitre dans mon fil');
  myFriends = [{ uid: 'amie-uid', displayName: 'Amie B.', photoURL: '' }];
  startActivityFeedListener();
  await new Promise(r => setTimeout(r, 0)); // laisse l onSnapshot initial (microtask) se resoudre
  __assertEq(communityActivityFeed.length, 1, 'une fois amis, son activite doit apparaitre dans mon fil');
  __assertEq(communityActivityFeed[0].challengeName, 'Squats', 'le fil doit refleter le bon defi complete par mon amie');

  // Etat "amis mais rien de recent" distinct de "aucun ami" (message different, pas le
  // meme CTA).
  communityActivityFeed = [];
  const emptyButFriendsHtml = renderActivityFeedSection();
  __assertOk(emptyButFriendsHtml.includes('Aucune activité récente') && !emptyButFriendsHtml.includes('openFriendsScreen()'), 'avec des amis mais aucune activite recente, le message doit etre neutre (pas le CTA "trouver des amis")');

  // Rendu d une ligne du fil.
  communityActivityFeed = [{ uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Squats', amount: 50, unit: 'reps', at: Date.now() }];
  const feedHtml = renderActivityFeedSection();
  __assertOk(feedHtml.includes('Amie B.') && feedHtml.includes('Squats') && feedHtml.includes('50 reps'), 'une ligne du fil doit afficher le nom, le defi et le montant');

  if (communityActivityFeedUnsub) { communityActivityFeedUnsub(); communityActivityFeedUnsub = null; }
  communityActivityFeed = [];
  myFriends = [];
  activeTab = 'today';
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };
  console.log('OK: fil d activite global filtre par amis (1 document par defi complete, jamais par serie, filtre where(uid,in,...))');

  // --- 145quater. Kudos : evenementiel (fil d activite + contributions Boss Battle,
  // reutilise giveKudosToEvent/removeKudosFromEvent, permanent + retrait possible) et
  // personne (classement, giveKudosToPerson, quotidien, pas de retrait). Atomicite via
  // db.runTransaction() : jamais de double-comptage meme en cas de double-tap. ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  myKudosGivenEventIds = new Set();
  myKudosGivenToday = new Set();

  // Evenementiel : donner un kudos incremente kudosCount ET pose la preuve kudosBy.
  const feedEntryRef = await db.collection('activityFeed').add({ uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Squats', amount: 50, unit: 'reps', at: Date.now(), kudosCount: 0 });
  await giveKudosToEvent(feedEntryRef);
  let feedEntryDoc = await feedEntryRef.get();
  __assertEq(feedEntryDoc.data().kudosCount, 1, 'donner un kudos doit incrementer kudosCount de 1');
  const kudosByDoc = await feedEntryRef.collection('kudosBy').doc('me-uid').get();
  __assertOk(kudosByDoc.exists, 'la preuve kudosBy/{votant} doit etre posee');
  __assertOk(myKudosGivenEventIds.has(feedEntryRef.id), 'l etat local doit refleter le kudos donne');

  // Double-tap (2e appel sans avoir retire entre-temps) : ne doit JAMAIS re-incrementer
  // (garde par transaction : preuve deja presente -> avorte sans ecrire).
  await giveKudosToEvent(feedEntryRef);
  feedEntryDoc = await feedEntryRef.get();
  __assertEq(feedEntryDoc.data().kudosCount, 1, 'un 2e appel sans retrait entre les deux ne doit jamais re-incrementer (protection anti double-comptage)');

  // Retrait : decremente et retire la preuve.
  await removeKudosFromEvent(feedEntryRef);
  feedEntryDoc = await feedEntryRef.get();
  __assertEq(feedEntryDoc.data().kudosCount, 0, 'retirer un kudos doit decrementer kudosCount');
  const kudosByDocAfterRemove = await feedEntryRef.collection('kudosBy').doc('me-uid').get();
  __assertOk(!kudosByDocAfterRemove.exists, 'la preuve kudosBy doit etre supprimee au retrait');
  __assertOk(!myKudosGivenEventIds.has(feedEntryRef.id), 'l etat local doit refleter le retrait');

  // Retirer un kudos jamais donne ne doit rien faire (pas de kudosCount negatif).
  await removeKudosFromEvent(feedEntryRef);
  feedEntryDoc = await feedEntryRef.get();
  __assertEq(feedEntryDoc.data().kudosCount, 0, 'retirer un kudos jamais donne ne doit jamais faire descendre le compteur sous 0');

  // Meme mecanisme reutilise sur les contributions Boss Battle (structure identique).
  const contribRef = await bossBattleDocRef().collection('contributions').add({ uid: 'amie-uid', displayName: 'Amie B.', amount: 20, at: Date.now(), kudosCount: 0 });
  await giveKudosToEvent(contribRef);
  const contribDoc = await contribRef.get();
  __assertEq(contribDoc.data().kudosCount, 1, 'giveKudosToEvent() doit fonctionner identiquement sur une contribution Boss Battle');

  // Rendu : jamais affiche sur son propre evenement.
  const ownRowHtml = renderActivityFeedRow({ id: 'x', uid: 'me-uid', displayName: 'Moi Athlete', challengeName: 'Pompes', amount: 10, unit: 'reps', at: Date.now(), kudosCount: 3 });
  __assertOk(!ownRowHtml.includes('kudos-btn'), 'le bouton kudos ne doit jamais apparaitre sur son propre evenement');
  const otherRowHtml = renderActivityFeedRow({ id: feedEntryRef.id, uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Squats', amount: 50, unit: 'reps', at: Date.now(), kudosCount: 0 });
  __assertOk(otherRowHtml.includes('kudos-btn') && otherRowHtml.includes('👏 0'), 'le bouton kudos doit apparaitre sur l evenement de quelqu un d autre, avec le bon compteur');

  // Personne (classement) : incremente kudosTotal a vie, quotidien (ID = jour_votant),
  // pas de retrait, jamais sur soi-meme.
  __resetCommunityMocks();
  await db.collection('leaderboard').doc('cible-uid').set({ displayName: 'Cible C.', kudosTotal: 4 }, { merge: true });
  await giveKudosToPerson('cible-uid');
  let targetDoc = await db.collection('leaderboard').doc('cible-uid').get();
  __assertEq(targetDoc.data().kudosTotal, 5, 'donner un kudos a une personne doit incrementer kudosTotal (cumul a vie)');
  __assertOk(myKudosGivenToday.has('cible-uid'), 'l etat local doit refleter le kudos donne aujourd hui');
  const givenDoc = await db.collection('leaderboard').doc('cible-uid').collection('kudosGiven').doc(todayKey + '_me-uid').get();
  __assertOk(givenDoc.exists, 'la preuve doit etre datee du jour (ID = jour_votant), pour permettre un nouveau kudos demain sans code de reset');

  // Meme jour, 2e tentative : ne doit pas re-incrementer.
  await giveKudosToPerson('cible-uid');
  targetDoc = await db.collection('leaderboard').doc('cible-uid').get();
  __assertEq(targetDoc.data().kudosTotal, 5, 'un 2e kudos le meme jour a la meme personne ne doit pas re-incrementer');

  // Jamais sur soi-meme.
  await db.collection('leaderboard').doc('me-uid').set({ displayName: 'Moi', kudosTotal: 0 }, { merge: true });
  await giveKudosToPerson('me-uid');
  const selfDoc = await db.collection('leaderboard').doc('me-uid').get();
  __assertEq(selfDoc.data().kudosTotal, 0, 'impossible de se donner un kudos a soi-meme');

  // Rendu classement : jamais sur sa propre ligne (highlight=true), affiche ailleurs.
  const ownLeaderboardRowHtml = renderLeaderboardRow({ uid: 'me-uid', displayName: 'Moi', value: 5, kudosTotal: 0 }, 1, 'streaks', true);
  __assertOk(!ownLeaderboardRowHtml.includes('kudos-btn'), 'le bouton kudos ne doit jamais apparaitre sur sa propre ligne du classement');
  const otherLeaderboardRowHtml = renderLeaderboardRow({ uid: 'cible-uid', displayName: 'Cible C.', value: 3, kudosTotal: 5 }, 2, 'streaks', false);
  __assertOk(otherLeaderboardRowHtml.includes('kudos-btn') && otherLeaderboardRowHtml.includes('👏 5'), 'le bouton kudos doit apparaitre sur la ligne de quelqu un d autre, avec son cumul a vie');

  __resetCommunityMocks();
  myKudosGivenEventIds = new Set();
  myKudosGivenToday = new Set();
  currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };
  console.log('OK: kudos (evenementiel reutilisable fil/Boss Battle avec retrait, personne quotidien sans retrait, atomicite via transaction, jamais sur soi-meme)');

  // --- 145quinquies. Notifications (sous-collection dediee users/{uid}/notifications,
  // UN SEUL listener au demarrage) : ecriture cote emetteur (nom deja anonymise stocke
  // DIRECTEMENT dans la notification, jamais relu via fetchPublicProfile() a
  // l affichage) + rattrapage natif (une notification deja presente AVANT meme
  // l abonnement, ex. recue hors ligne, declenche quand meme sa popup des le tout 1er
  // instantane -- contrairement a l ancien systeme, changement de comportement voulu). ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  popupQueue = []; popupOpen = false;

  // Ecriture : kudos (personne, classement) -> notification chez la CIBLE, nom deja
  // anonymise.
  await db.collection('leaderboard').doc('me-uid').set({ displayName: 'Moi', kudosTotal: 0 }, { merge: true });
  currentUser = { uid: 'amie-uid', displayName: 'Amie Berger', email: 'a@test.com', photoURL: '' };
  await giveKudosToPerson('me-uid');
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  let unread = await notificationsCollRef('me-uid').where('read', '==', false).get();
  __assertEq(unread.size, 1, 'donner un kudos a une personne doit ecrire exactement 1 notification chez la cible');
  __assertEq(unread.docs[0].data().type, 'kudo', 'le type doit etre "kudo"');
  __assertEq(unread.docs[0].data().fromName, 'Amie B.', 'le nom de l emetteur doit etre deja anonymise DANS la notification elle-meme');
  const amieUnreadIsolation = await notificationsCollRef('amie-uid').where('read', '==', false).get();
  __assertEq(amieUnreadIsolation.size, 0, "les notifications sont isolees PAR UTILISATEUR : donner un kudos a 'me-uid' ne doit rien ecrire chez 'amie-uid' (l emetteur)");

  // Ecriture : kudos (evenementiel, fil d activite) -> notification chez le
  // PROPRIETAIRE de l evenement (pas chez le votant).
  const myFeedEntryRef = await db.collection('activityFeed').add({ uid: 'me-uid', displayName: 'Moi A.', challengeName: 'Pompes', amount: 20, unit: 'reps', at: Date.now(), kudosCount: 0 });
  currentUser = { uid: 'amie-uid', displayName: 'Amie Berger', email: 'a@test.com', photoURL: '' };
  await giveKudosToEvent(myFeedEntryRef);
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  unread = await notificationsCollRef('me-uid').where('read', '==', false).get();
  __assertEq(unread.size, 2, 'un kudos sur mon entree du fil d activite doit aussi m envoyer une notification (le proprietaire de l evenement, pas le votant)');

  // Ecriture : demande d ami -> notification chez la CIBLE.
  currentUser = { uid: 'demandeur-uid', displayName: 'Demandeur Dupont', email: 'd@test.com', photoURL: '' };
  await sendFriendRequest('me-uid');
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  unread = await notificationsCollRef('me-uid').where('read', '==', false).get();
  __assertEq(unread.size, 3, 'envoyer une demande d ami doit aussi ecrire une notification chez la cible');
  __assertOk(unread.docs.some(d => d.data().type === 'friend_request' && d.data().fromName === 'Demandeur D.'), 'la notification de demande d ami doit porter le bon type et le bon nom anonymise');

  // Nettoyage : on isole le rattrapage kudos (A) et demande d ami (B) dans 2 scenarios
  // separes, pour eviter toute ambiguite entre la file de popups (enqueuePopup, kudos)
  // et confirmModal (demande d ami), qui sont 2 mecanismes INDEPENDANTS (pas de garde-fou
  // d instance unique sur confirmModal, deja documente ailleurs dans ce fichier).
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;

  // A. Rattrapage kudos : 2 notifications de kudos deja presentes AVANT l abonnement
  // (simule 2 kudos recus hors ligne) doivent toutes les deux declencher une popup des
  // le tout 1er instantane, dans l ordre de creation (file enqueuePopup).
  await notificationsCollRef('me-uid').doc().set({ type: 'kudo', fromUid: 'amie-uid', fromName: 'Amie B.', read: false, createdAt: 1000 });
  await notificationsCollRef('me-uid').doc().set({ type: 'kudo', fromUid: 'bob-uid', fromName: 'Bob M.', read: false, createdAt: 2000 });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen, 'une notification de kudos deja presente AVANT l abonnement doit quand meme declencher une popup des le 1er instantane (rattrapage natif)');
  __assertOk(currentPopupHtml.includes('Amie B.'), 'la 1ere popup (la plus ancienne, createdAt le plus petit) doit etre celle d Amie B.');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  __assertOk(popupOpen && currentPopupHtml.includes('Bob M.'), 'la 2e popup (en file) doit ensuite s afficher, celle de Bob M.');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  unread = await notificationsCollRef('me-uid').where('read', '==', false).get();
  __assertEq(unread.size, 0, 'les 2 notifications de kudos traitees doivent etre marquees lues (plus aucune non-lue)');
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  // B. Rattrapage demande d ami : "Accepter" cree l amitie directement depuis la popup.
  __resetCommunityMocks();
  await notificationsCollRef('me-uid').doc().set({ type: 'friend_request', fromUid: 'demandeur-uid', fromName: 'Demandeur D.', read: false, createdAt: Date.now() });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(currentConfirmModalHtml.includes("Nouvelle demande d'ami") && currentConfirmModalHtml.includes('Demandeur D.'), 'la demande d ami deja presente AVANT l abonnement doit aussi declencher sa popup des le 1er instantane, nommant le demandeur');
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await new Promise(r => setTimeout(r, 20));
  const friendshipAfterNotif = await db.collection('friendships').doc(friendshipPairId('me-uid', 'demandeur-uid')).get();
  __assertOk(friendshipAfterNotif.exists, 'accepter directement depuis la popup de notification doit creer l amitie (reutilise acceptFriendRequest())');
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  // C. "Plus tard" ne doit RIEN faire sur la demande sous-jacente (pas de refus
  // silencieux) : la notification passe quand meme a lue (on ne la re-proposera pas),
  // mais la demande reste visible normalement dans l ecran Amis.
  __resetCommunityMocks();
  await db.collection('friendRequests').doc('quelquun-uid_me-uid').set({ fromUid: 'quelquun-uid', toUid: 'me-uid', at: Date.now() });
  await notificationsCollRef('me-uid').doc().set({ type: 'friend_request', fromUid: 'quelquun-uid', fromName: 'Quelquun Q.', read: false, createdAt: Date.now() });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  await new Promise(r => setTimeout(r, 20));
  const requestStillThere = await db.collection('friendRequests').doc('quelquun-uid_me-uid').get();
  __assertOk(requestStillThere.exists, '"Plus tard" ne doit pas supprimer la demande (juste remise a plus tard, pas un refus)');
  unread = await notificationsCollRef('me-uid').where('read', '==', false).get();
  __assertEq(unread.size, 0, 'meme refusee pour l instant ("Plus tard"), la notification doit etre marquee lue (pas re-proposee en boucle)');
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  // E. group_challenge_settled : la popup de felicitations doit nommer le gagnant
  // (winnerName, embarque par settleChallengeIfNeeded() cote Cloud Function) quand
  // il est present - repli sur le message generique sinon (anciennes notifications).
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_challenge_settled', fromUid: 'system', groupId: 'g1', challengeId: 'c1',
    challengeName: '100 pompes', winnerName: 'Bob M.', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes('Bob M.') && currentPopupHtml.includes('100 pompes'), 'la popup de reglement doit nommer le gagnant quand winnerName est fourni');
  __assertOk(currentPopupHtml.includes('kilo-beer'), 'la mascotte Kilo (etat beer) doit accompagner le bilan/reglement des gages de groupe (retour utilisateur "effet waouh")');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }
  console.log('OK: popup de reglement de defi de groupe enrichie du nom du gagnant (winnerName)');

  // E-bis (passe UX premium, idee #6 - celebration plein ecran) : quand
  // targetReached est vrai (embarque par settleChallengeIfNeeded() cote Cloud
  // Function), la popup doit basculer en variante epique (confettis, meme
  // traitement qu'un trophee/changement de titre) plutot que le bilan neutre
  // habituel - une victoire collective merite plus qu'un simple "Bilan disponible".
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  // Bug reel signale (retour utilisateur) : cette popup de victoire collective
  // s'affichait jusqu'ici en silence - meme son de celebration que la completion
  // personnelle/Hardcore desormais (playSuccessSound(), voir processUnreadNotifications()).
  let groupWinAudioPlayCalls = [];
  const originalAudioForGroupWin = window.Audio;
  window.Audio = function (src) { groupWinAudioPlayCalls.push(src); this.play = () => Promise.resolve(); };
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_challenge_settled', fromUid: 'system', groupId: 'g1', challengeId: 'c2',
    challengeName: '500 squats', winnerName: 'Bob M.', targetReached: true, read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes('app-popup-card epic') && currentPopupHtml.includes(t('popups.notifications.groupChallengeWonTitle')) && currentPopupHtml.includes('500 squats'), 'un objectif de groupe atteint doit declencher la celebration epique (confettis), pas le bilan neutre');
  __assertOk(!currentPopupHtml.includes('kilo-beer'), 'la celebration epique (trophee) garde son propre traitement, deja distinctif - pas de Kilo ici, reserve au bilan neutre');
  __assertEq(groupWinAudioPlayCalls, ['./assets/sounds/success.mp3'], 'la celebration d un defi de groupe reussi doit desormais etre accompagnee du son de reussite, pas silencieuse');
  window.Audio = originalAudioForGroupWin;
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }
  console.log('OK: victoire collective de groupe (targetReached) declenche la celebration plein ecran epique + le son de reussite, distincte du bilan neutre par expiration (silencieux)');

  // F. Notifications push (Phase A) : les 4 nouveaux types de notification
  // declenchent chacun leur propre popup in-app (meme mecanisme que les types
  // existants - c est aussi ce qui s affiche au rattrapage, que l on ait tape
  // sur un push OS ou simplement rouvert l app).
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'friend_request_accepted', fromUid: 'alice-uid', fromName: 'Alice D.', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.friendAcceptedTitle')) && currentPopupHtml.includes('Alice D.'), 'friend_request_accepted doit afficher une popup nommant qui a accepte');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_challenge_created', fromUid: 'bob-uid', fromName: 'Bob M.', groupId: 'g1', groupName: 'Les Costauds',
    challengeId: 'c3', challengeName: 'Squats du jour', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.groupChallengeCreatedTitle')) && currentPopupHtml.includes('Squats du jour') && currentPopupHtml.includes('Les Costauds'), 'group_challenge_created doit nommer le defi et le groupe');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_member_joined', fromUid: 'chloe-uid', fromName: 'Chloe D.', groupId: 'g1', groupName: 'Les Costauds', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.groupMemberJoinedTitle')) && currentPopupHtml.includes('Chloe D.'), 'group_member_joined doit nommer le nouveau membre');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  // thresholdLabel distingue 2 titres differents (urgence croissante), meme
  // sous-titre - voir maybeRemindChallengeDeadline() cote Cloud Function.
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_challenge_reminder', fromUid: 'system', groupId: 'g1', challengeId: 'c1',
    challengeName: '500 squats', thresholdLabel: '24h', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.reminderTitle24h')) && currentPopupHtml.includes('500 squats'), 'group_challenge_reminder (24h) doit afficher le bon titre et nommer le defi');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }

  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'group_challenge_reminder', fromUid: 'system', groupId: 'g1', challengeId: 'c1',
    challengeName: '500 squats', thresholdLabel: '3h', read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.reminderTitle3h')), 'group_challenge_reminder (3h) doit afficher un titre plus urgent que le rappel 24h');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }
  console.log('OK: 4 nouveaux types de notification (friend_request_accepted, group_challenge_created, group_member_joined, group_challenge_reminder) affichent chacun leur popup dediee');

  // Retour utilisateur : quand un membre du groupe active Le Boulet contre moi, je
  // dois etre prevenu (in-app si l appli est ouverte, push OS sinon - meme canal,
  // ecrit par applyGroupJoker() cote Cloud Function).
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  await notificationsCollRef('me-uid').doc().set({
    type: 'boulet_attack', fromUid: 'bob-uid', fromName: 'Bob M.', groupId: 'g1', groupName: 'Les Costauds',
    challengeId: 'c1', challengeName: '500 squats', amount: 20, read: false, createdAt: Date.now(),
  });
  startNotificationsListener();
  await new Promise(r => setTimeout(r, 50));
  __assertOk(popupOpen && currentPopupHtml.includes(t('popups.notifications.bouletAttackTitle')) && currentPopupHtml.includes('Bob M.') && currentPopupHtml.includes('-20') && currentPopupHtml.includes('500 squats'), 'boulet_attack doit nommer l attaquant, le handicap inflige et le defi concerne');
  document.getElementById('appPopupCloseBtn').onclick();
  await new Promise(r => setTimeout(r, 10));
  if (notificationsUnsub) { notificationsUnsub(); notificationsUnsub = null; }
  console.log('OK: notification boulet_attack (la victime du Boulet est prevenue, in-app ou push OS)');

  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  myKudosGivenEventIds = new Set(); myKudosGivenToday = new Set();
  currentUser = { uid: 'test-uid', displayName: 'Test', email: 't@test.com', photoURL: '' };
  console.log('OK: notifications (sous-collection users/uid/notifications, listener unique, rattrapage natif, nom stocke a l ecriture)');

  // --- 146. Classement precalcule cote serveur (Phase 1, Cloud Functions) : le
  // client lit desormais UNIQUEMENT le document deja agrege leaderboardCache/{view}
  // (voir functions/index.js:aggregateLeaderboard), simulé ici par une ecriture
  // directe du document (comme si la fonction planifiee venait de s executer) - 1
  // seule lecture, quelle que soit la taille reelle de la communaute. Rang exact
  // gratuit pour tout le monde dans le Top N (simple index du tableau precalcule). ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Moi', email: 'a@test.com', photoURL: '' };
  xpTotal = 150; xpWeekly = 20; streakCount = 5;
  const seedCache = (view, entries, totalCount) => db.collection('leaderboardCache').doc(view).set({ entries, totalCount, updatedAt: Date.now() });
  await seedCache('streaks', [
    { uid: 'uidA', displayName: 'Alice', photoURL: '', value: 10, kudosTotal: 0 },
    { uid: 'uidB', displayName: 'Bob', photoURL: '', value: 8, kudosTotal: 0 },
    { uid: 'test-uid', displayName: 'Moi', photoURL: '', value: 5, kudosTotal: 0 },
    { uid: 'uidD', displayName: 'Dan', photoURL: '', value: 3, kudosTotal: 0 },
  ], 4);
  await seedCache('alltime', [
    { uid: 'uidA', displayName: 'Alice', photoURL: '', value: 500, kudosTotal: 0 },
    { uid: 'uidB', displayName: 'Bob', photoURL: '', value: 300, kudosTotal: 0 },
    { uid: 'test-uid', displayName: 'Moi', photoURL: '', value: 150, kudosTotal: 0 },
    { uid: 'uidD', displayName: 'Dan', photoURL: '', value: 50, kudosTotal: 0 },
  ], 4);

  const topStreaks = await fetchLeaderboardTop('streaks');
  __assertEq(topStreaks.entries.map(e => e.displayName), ['Alice', 'Bob', 'Moi', 'Dan'], 'fetchLeaderboardTop() doit renvoyer les entrees telles que precalculees par aggregateLeaderboard, sans re-trier ni re-filtrer cote client');
  __assertEq(topStreaks.totalCount, 4);

  activeTab = 'today';
  activeTab = 'community';
  communityLeaderboardView = 'alltime';
  await loadCommunityLeaderboard('alltime');
  // Retour utilisateur "effet waouh" : ecran squelette (shimmer) pendant le
  // chargement du classement, a la place d un simple texte "Chargement...".
  communityLeaderboardLoading = true;
  const communitySkeletonHtml = renderCommunityScreen();
  __assertOk((communitySkeletonHtml.match(/skeleton-row/g) || []).length === 6, 'le classement en chargement doit afficher 6 lignes squelettes');
  __assertOk(!communitySkeletonHtml.includes('leaderboard-row'), 'aucune vraie ligne de classement ne doit apparaitre tant que le chargement n est pas termine');
  communityLeaderboardLoading = false;
  console.log('OK: ecran squelette du classement pendant le chargement (effet waouh, remplace le texte "Chargement...")');

  const communityHtml = renderCommunityScreen();
  __assertOk(communityHtml.includes('leaderboard-tabs') && communityHtml.includes('leaderboard-row'), 'l ecran Communaute doit afficher les onglets et les lignes de classement');
  __assertOk(communityHtml.includes('#1') && communityHtml.includes('#3'), 'chaque ligne doit afficher un rang numerique EXACT (gratuit, simple index du tableau precalcule) - plus de badge approximatif');

  // Retour utilisateur : sous le fil d activite (amis), les boutons de filtre du
  // classement (serie/hebdo/legende) s enchainaient sans transition, illisible comme
  // une section distincte. Un titre section-label (meme composant que "Temple de la
  // renommee"/"Fil d activite" juste au-dessus) annonce desormais explicitement le
  // debut du classement, juste avant les onglets de filtre.
  __assertOk(communityHtml.includes(t('community.leaderboardSectionLabel')), 'un titre de section doit annoncer explicitement le debut du classement');
  __assertOk(communityHtml.indexOf(t('community.leaderboardSectionLabel')) < communityHtml.indexOf('leaderboard-tabs'), 'ce titre doit se trouver juste au-dessus des boutons de filtre serie/hebdo/legende');
  console.log('OK: titre de section "Classement communautaire" separe visuellement le fil d activite des filtres de classement');
  // Ici, "Moi" est deja dans le Top N affiche -> aucun appel a getMyRank ne doit
  // avoir ete declenche (pas seulement son resultat ignore : l appel lui-meme doit
  // etre evite, voir loadCommunityLeaderboard()).
  __assertEq(communityLeaderboardMyRank, null, 'aucun appel a getMyRank ne doit etre declenche quand je suis deja visible dans le Top N mis en cache');
  __assertEq(__mockGetMyRankCallCount, 0, 'getMyRank() ne doit meme pas etre appelee dans ce cas');
  __assertOk(!communityHtml.includes('rank-bar'), 'la barre de mon propre rang ne doit PAS s afficher quand je suis deja visible dans la liste principale (evite le doublon de ma ligne)');

  // Ma propre ligne doit TOUJOURS refleter ma valeur EN MEMOIRE a jour, meme si le
  // document leaderboardCache (rafraichi toutes les 15 min cote serveur seulement)
  // n a pas encore vu un changement que je viens de faire moi-meme - patch cote
  // client, sans lecture Firestore supplementaire (voir loadCommunityLeaderboard()).
  xpTotal = 777;
  await loadCommunityLeaderboard('alltime');
  __assertOk(renderCommunityScreen().includes('777'), 'ma propre ligne doit toujours afficher ma valeur en memoire a jour, meme si le document leaderboardCache (15 min) n a pas ete rafraichi entre-temps');
  xpTotal = 150;
  console.log('OK: classement precalcule cote serveur (1 lecture du document leaderboardCache, rang exact gratuit dans le Top N, ma propre valeur toujours a jour)');

  // --- 146bis. Hors du Top N precalcule : mon rang EXACT vient desormais de
  // getMyRank() (Cloud Function Callable, .count() cote Admin SDK - fonctionnel
  // contrairement au SDK compat client), plus le badge "Hors Top 50"/voisins
  // approximatifs de l ancien mecanisme 100% client. ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Moi', email: 'a@test.com', photoURL: '' };
  xpTotal = 150;
  // Simule un classement bien plus grand que moi (54 participants au total, mais je
  // ne fais pas partie des 2 entrees mises en cache dans ce test).
  await seedCache('alltime', [
    { uid: 'uidA', displayName: 'Alice', photoURL: '', value: 500, kudosTotal: 0 },
    { uid: 'uidB', displayName: 'Bob', photoURL: '', value: 300, kudosTotal: 0 },
  ], 54);
  __setMockGetMyRank({ rank: 42, value: 150 });
  activeTab = 'community';
  await loadCommunityLeaderboard('alltime');
  __assertEq(__mockGetMyRankCallCount, 1, 'getMyRank() doit etre appelee exactement une fois des que je ne suis pas dans le Top N mis en cache');
  __assertEq(__mockGetMyRankLastArgs.view, 'alltime', 'le bon parametre de vue doit etre transmis a getMyRank()');
  __assertOk(communityLeaderboardMyRank && communityLeaderboardMyRank.rank === 42, 'mon rang exact (renvoye par getMyRank) doit etre stocke');
  const communityHtmlBig = renderCommunityScreen();
  __assertOk(communityHtmlBig.includes('rank-bar'), 'la barre de mon propre rang doit apparaitre des que je sors du Top N mis en cache');
  __assertOk(communityHtmlBig.includes('#42'), 'mon rang EXACT (calcule par la Cloud Function, pas un badge approximatif) doit etre affiche');
  __assertOk(communityHtmlBig.includes('54'), 'le nombre total de participants (deja disponible sans cout supplementaire dans le meme document leaderboardCache) doit etre affiche');
  activeTab = 'today';
  console.log('OK: rang exact hors du Top N via getMyRank() (Cloud Function, .count() cote Admin SDK) - plus de badge approximatif ni de requetes "voisins"');

  // --- 146ter. Empty state du classement : incite a inviter des proches tant que la
  // communaute visible est trop petite (<3) pour etre motivante ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Moi', email: 'a@test.com', photoURL: '' };
  leaderboardOptOut = false;
  await seedCache('streaks', [{ uid: 'test-uid', displayName: 'Moi', photoURL: '', value: 2, kudosTotal: 0 }], 1);
  activeTab = 'community';
  communityLeaderboardView = 'streaks';
  await loadCommunityLeaderboard('streaks');
  __assertOk(communityLeaderboardTop.length < 3, 'ce scenario doit avoir moins de 3 personnes dans le classement pour tester l empty state');
  const smallCommunityHtml = renderCommunityScreen();
  __assertOk(smallCommunityHtml.includes('community-invite-card') && smallCommunityHtml.includes('shareCommunityInvite()'), 'avec moins de 3 personnes, une carte d invitation avec un bouton de partage doit s afficher sous la liste');
  __assertOk(smallCommunityHtml.includes('Inviter des proches pour pimenter le classement'), 'le texte incitatif exact doit etre affiche');

  // Avec 3 personnes ou plus, l empty state ne doit plus s afficher (la communaute
  // est deja assez fournie pour etre motivante).
  await seedCache('streaks', [
    { uid: 'test-uid', displayName: 'Moi', photoURL: '', value: 2, kudosTotal: 0 },
    { uid: 'uidX', displayName: 'X', photoURL: '', value: 1, kudosTotal: 0 },
    { uid: 'uidY', displayName: 'Y', photoURL: '', value: 1, kudosTotal: 0 },
  ], 3);
  invalidateLeaderboardCache(); // simule une vraie ré-entree sur l onglet
  await loadCommunityLeaderboard('streaks');
  __assertOk(communityLeaderboardTop.length >= 3, 'ce 2e scenario doit avoir 3 personnes ou plus');
  const filledCommunityHtml = renderCommunityScreen();
  __assertOk(!filledCommunityHtml.includes('community-invite-card'), 'la carte d invitation ne doit plus s afficher des que le classement compte 3 personnes ou plus');
  activeTab = 'today';
  console.log('OK: empty state du classement (carte d invitation a partager si moins de 3 membres)');

  // --- 146quater. Cache TTL 15 min sur le classement : une nouvelle visite/
  // changement de vue REUTILISE le document leaderboardCache deja lu (1 seule
  // lecture reelle, meme apres plusieurs visites dans la fenetre de fraicheur), MAIS
  // (a) ma propre ligne dans le Top N reste TOUJOURS a jour (patch cote client, voir
  // 146 ci-dessus, independant du TTL) et (b) mon rang (getMyRank) est recalcule
  // immediatement des que MES propres donnees changent (invalidateLeaderboardCache()
  // dans syncLeaderboardEntry()), pour ne jamais servir un rang perime. ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Moi', email: 'a@test.com', photoURL: '' };
  xpTotal = 150;
  await seedCache('alltime', [{ uid: 'uidA', displayName: 'Alice', photoURL: '', value: 500, kudosTotal: 0 }], 54);
  __setMockGetMyRank({ rank: 10, value: 150 });
  __resetLeaderboardCacheGetCallCount();
  await loadCommunityLeaderboard('alltime');
  __assertEq(__leaderboardCacheGetCallCount, 1, 'le 1er appel doit bien lire le document leaderboardCache');
  __assertEq(__mockGetMyRankCallCount, 1, 'le 1er appel doit bien appeler getMyRank (je ne suis pas dans le Top N mis en cache)');
  await loadCommunityLeaderboard('alltime');
  __assertEq(__leaderboardCacheGetCallCount, 1, 'tant que le cache TTL (15 min) cote client est frais, une 2e visite ne doit PAS relire le document leaderboardCache');
  __assertEq(__mockGetMyRankCallCount, 1, 'tant que le cache TTL est frais, une 2e visite ne doit PAS rappeler getMyRank non plus');
  // DES QUE MON PROPRE score change, le rang doit etre recalcule immediatement, sans
  // attendre le TTL de 15 min (invalidateLeaderboardCache() vide aussi le cache du
  // rang, pas seulement celui du Top N).
  xpTotal = 999;
  __setMockGetMyRank({ rank: 3, value: 999 });
  await syncLeaderboardEntry();
  await loadCommunityLeaderboard('alltime');
  __assertEq(__mockGetMyRankCallCount, 2, 'apres syncLeaderboardEntry() (mon propre score qui change), getMyRank doit etre rappelee immediatement, sans attendre le TTL de 15 min');
  __assertOk(communityLeaderboardMyRank.rank === 3, 'mon nouveau rang (3) doit etre reflete immediatement');
  xpTotal = 150;
  console.log('OK: cache TTL 15 min sur le classement (document + rang), invalide immediatement des que mon propre score change');

  // --- 146quater-bis. Optimisation quota Firestore : le Journal met en cache les jours
  // PASSES (immuables une fois le jour termine) - une 2e ouverture dans la meme session
  // ne doit relire QUE "aujourd hui" (encore modifiable), jamais les 27 autres jours.
  // loadHistoryEntries() calcule TOUJOURS sa fenetre de 28 jours depuis le "new Date()"
  // reel (jamais depuis todayKey, souvent fige a une date fictive par d autres tests
  // plus haut) : todayKey doit correspondre a la vraie date du jour ici, sinon aucune
  // des 28 entrees ne correspond a "aujourd hui" et le test ne mesure rien de valide.
  todayKey = dateKey(new Date());
  historyDayCache = {};
  __resetDbGetDayCallCount();
  const pastDate1 = new Date();
  pastDate1.setDate(pastDate1.getDate() - 3);
  const pastKey1 = dateKey(pastDate1);
  __store.set('day:' + pastKey1, JSON.stringify({ challenges: { [pompes.id]: { sets: [10, 10], targetOverride: null, done: true, hardcoreDone: false, hardcoreAnnounced: false } } }));
  await loadHistoryEntries();
  __assertEq(__dbGetDayCallCount, 28, 'la 1ere ouverture du Journal doit lire les 28 jours (aucun n est encore en cache)');
  __assertOk(historyEntries.some(e => e.key === pastKey1 && e.total === 20), 'l entree du jour passe seede doit apparaitre avec le bon total');

  __resetDbGetDayCallCount();
  await loadHistoryEntries();
  __assertEq(__dbGetDayCallCount, 1, '2e ouverture dans la meme session : seul "aujourd hui" (encore modifiable) doit etre relu, les 27 jours passes reutilisent le cache');
  __assertOk(historyEntries.some(e => e.key === pastKey1 && e.total === 20), 'les entrees des jours passes (servies depuis le cache) doivent rester correctes');
  console.log('OK: le Journal met en cache les jours passes (immuables), seul "aujourd hui" est relu a chaque ouverture');

  // --- 146quater-ter. Optimisation quota Firestore : fetchPublicProfile(uid) met en
  // cache le resultat pour la duree de la session - un meme uid redemande plusieurs
  // fois (ami + demande recue, refreshFriendsData() rappelee apres chaque action) ne
  // doit relire son profil public qu UNE SEULE fois.
  publicProfileCache = {};
  __resetLeaderboardGetCallCount();
  await db.collection('leaderboard').doc('profil-uid').set({ displayName: 'Alice Dupont', photoURL: 'http://x/a.png' }, { merge: true });
  const profil1 = await fetchPublicProfile('profil-uid');
  __assertEq(profil1.displayName, 'Alice D.', 'le profil public doit etre anonymise (formatDisplayName)');
  __assertEq(__leaderboardGetCallCount, 1, 'le 1er appel doit bien lire Firestore');
  const profil2 = await fetchPublicProfile('profil-uid');
  __assertEq(profil2.displayName, 'Alice D.', 'le 2e appel doit renvoyer le meme profil');
  __assertEq(__leaderboardGetCallCount, 1, 'le 2e appel pour le MEME uid ne doit PAS relire Firestore (cache de session)');
  console.log('OK: fetchPublicProfile() met en cache le resultat pour la duree de la session');

  // --- 146quater-quinquies. Optimisation quota Firestore : le cache fetchPublicProfile()
  // survit a une reouverture de la PWA (localStorage, TTL 6h) - simule une reouverture
  // en vidant le cache MEMOIRE (publicProfileCache = {}) sans toucher au localStorage,
  // puis recharge depuis le stockage comme le ferait un vrai rechargement de page.
  __resetLeaderboardGetCallCount();
  publicProfileCache = {};
  loadPublicProfileCacheFromStorage();
  const profil3 = await fetchPublicProfile('profil-uid');
  __assertEq(profil3.displayName, 'Alice D.', 'le profil doit rester disponible apres une simulation de reouverture');
  __assertEq(__leaderboardGetCallCount, 0, 'une reouverture dans la fenetre de 6h ne doit RIEN relire depuis Firestore (cache localStorage)');
  console.log('OK: le cache fetchPublicProfile() survit a une reouverture de la PWA (localStorage, TTL 6h)');

  // --- 146quater-quater. Optimisation quota Firestore : les listeners fil d activite/
  // contributions Boss Battle ne s attachent QUE si activeTab vaut 'community' (voir
  // switchTab()) - hors de cet onglet, chaque ecriture d un AUTRE utilisateur sur ces
  // collections facturerait sinon une lecture a une session qui ne regarde meme pas
  // cet ecran.
  activeTab = 'today';
  myFriends = [{ uid: 'amie-uid', displayName: 'Amie', photoURL: '' }];
  communityActivityFeedUnsub = null;
  communityContributionsUnsub = null;
  startActivityFeedListener();
  startRecentContributionsListener();
  __assertOk(communityActivityFeedUnsub === null, 'le listener fil d activite ne doit PAS s attacher hors de l onglet Communaute');
  __assertOk(communityContributionsUnsub === null, 'le listener contributions Boss Battle ne doit PAS s attacher hors de l onglet Communaute');
  activeTab = 'community';
  startActivityFeedListener();
  startRecentContributionsListener();
  __assertOk(typeof communityActivityFeedUnsub === 'function', 'le listener fil d activite doit s attacher une fois sur l onglet Communaute');
  __assertOk(typeof communityContributionsUnsub === 'function', 'le listener contributions Boss Battle doit s attacher une fois sur l onglet Communaute');
  communityActivityFeedUnsub(); communityActivityFeedUnsub = null;
  communityContributionsUnsub(); communityContributionsUnsub = null;
  myFriends = [];
  activeTab = 'today';
  console.log('OK: les listeners fil d activite/contributions Boss Battle sont suspendus hors de l onglet Communaute');

  // --- 146quater-sexies. Optimisation quota Firestore : addSet() regroupe (debounce)
  // les ecritures Firestore (appData + day:{date}) de plusieurs taps rapproches en une
  // SEULE paire d ecritures, sans jamais retarder la mise a jour LOCALE (deja verifiee
  // par les tests existants, qui lisent xpTotal/streakCount/etc juste apres addSet()).
  // flushWorkoutWrites() (force-flush, declenche en vrai par visibilitychange/pagehide)
  // doit toujours pouvoir provoquer l ecriture reelle sans attendre le debounce, sans
  // jamais perdre la derniere action.
  activeToday = new Set([pompes.id]);
  state = emptyDayState();
  await pickChallenge(pompes.id);
  stats[pompes.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  __resetAppDataSetCallCount();
  __resetDbSetDayCallCount();
  addSet(1); // sans await : simule un tap - le debounce programme le flush, n ecrit pas encore
  addSet(1);
  addSet(1);
  await new Promise(r => setTimeout(r, 0)); // laisse les 3 appels se derouler (mais PAS le delai du debounce, voir WORKOUT_WRITE_DEBOUNCE_MS)
  __assertEq(__appDataSetCallCount, 0, 'juste apres 3 taps rapproches, aucune ecriture Firestore ne doit encore avoir eu lieu (debounce en cours)');
  __assertEq(__dbSetDayCallCount, 0, 'idem pour le document day:{date}');
  __assertEq(stats[pompes.id].lifetimeTotal, 3, 'la donnee LOCALE doit deja refleter les 3 taps, jamais retardee par le debounce');
  await flushWorkoutWrites();
  __assertEq(__appDataSetCallCount, 1, '3 taps rapproches ne doivent produire QU UNE SEULE ecriture Firestore sur le document consolide (debounce)');
  __assertEq(__dbSetDayCallCount, 1, 'idem pour le document day:{date} (une seule ecriture pour les 3 taps)');

  // Un flush sans rien en attente doit etre un no-op (pas de nouvelle ecriture).
  await flushWorkoutWrites();
  __assertEq(__appDataSetCallCount, 1, 'un flush sans ecriture en attente ne doit rien ecrire de plus');

  // Un nouveau tap APRES un flush doit reprogrammer un nouveau debounce independant.
  addSet(1);
  await new Promise(r => setTimeout(r, 0));
  __assertEq(__appDataSetCallCount, 1, 'juste apres ce nouveau tap, pas encore de nouvelle ecriture (nouveau debounce en cours)');
  await flushWorkoutWrites();
  __assertEq(__appDataSetCallCount, 2, 'le flush force doit bien ecrire ce nouveau tap (jamais perdu)');

  currentChallengeId = null;
  activeToday = new Set();
  console.log('OK: addSet() regroupe plusieurs taps rapproches en une seule paire d ecritures Firestore (debounce), flush force jamais perdu');

  // --- 146quinquies. Contraste du bouton secondaire "Choisir mon propre defi" (#2 CSS) :
  // ne doit plus utiliser var(--line)/var(--chalk-dim), quasi invisibles sur ce fond
  // et donnant l impression trompeuse d un bouton desactive ---
  const chooseBtnCssIdx = cssText.indexOf('.community-hero-choose-btn {');
  __assertOk(chooseBtnCssIdx !== -1, 'la regle .community-hero-choose-btn doit exister dans styles.css');
  const chooseBtnCssBlock = cssText.slice(chooseBtnCssIdx, cssText.indexOf('}', chooseBtnCssIdx));
  __assertOk(chooseBtnCssBlock.includes('rgba(255, 255, 255, 0.15)'), 'la bordure doit etre rehaussee en rgba(255,255,255,0.15) pour un contraste suffisant');
  __assertOk(!chooseBtnCssBlock.includes('var(--line)') && !chooseBtnCssBlock.includes('var(--chalk-dim)'), 'les anciens tokens quasi invisibles (--line/--chalk-dim) ne doivent plus etre utilises pour ce bouton');
  console.log('OK: lisibilite rehaussee du bouton secondaire "Choisir mon propre defi"');

  // --- 147. Pilier 3 : chaque serie loggee sur le defi cible de la semaine contribue
  // a la jauge collective (Boss Battle), pas seulement la completion du defi ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Alice', email: 'a@test.com', photoURL: '' };
  communityBossBattleTargetCache = null; // force un recalcul frais (mock tout juste reinitialise)
  await refreshWeeklyBossBattleTargetCache();
  const bossTarget = getWeeklyBossBattleTarget();
  const bossChallenge147 = CHALLENGE_LIBRARY.find(c => c.id === bossTarget.targetChallengeId);
  activeToday = new Set([bossChallenge147.id]);
  state = emptyDayState();
  currentChallengeId = bossChallenge147.id;
  stats[bossChallenge147.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(10); // serie partielle, ne complete pas le defi (sauf objectif tres bas)
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  let bossDoc = await bossBattleDocRef().get();
  __assertOk(bossDoc.exists && bossDoc.data().currentProgress === 10, 'une simple serie (pas forcement la completion) doit deja contribuer a la jauge collective');
  await addSet(5);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  bossDoc = await bossBattleDocRef().get();
  __assertEq(bossDoc.data().currentProgress, 15, 'les contributions doivent s additionner au fil des series');
  const contributorDoc = await bossBattleDocRef().collection('dailyContributors').doc(todayKey + '_test-uid').get();
  __assertOk(contributorDoc.exists && contributorDoc.data().amount === 15, 'l agregat par jour/utilisateur (badge Contributeur du jour) doit suivre les memes contributions');

  // Un defi qui n est PAS la cible de la semaine ne doit jamais contribuer.
  const otherChallenge147 = CHALLENGE_LIBRARY.find(c => c.id !== bossChallenge147.id);
  currentChallengeId = otherChallenge147.id;
  activeToday = new Set([otherChallenge147.id]);
  stats[otherChallenge147.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(999);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  bossDoc = await bossBattleDocRef().get();
  __assertEq(bossDoc.data().currentProgress, 15, 'un defi different de la cible hebdomadaire ne doit jamais contribuer a la jauge collective');
  currentChallengeId = null;
  activeToday = new Set();
  console.log('OK: contributions a la jauge collective (chaque serie compte, uniquement sur le defi cible de la semaine)');

  // --- 148. Victoire du Boss Battle : detection du franchissement + archive create-only ---
  __resetCommunityMocks();
  popupQueue = []; popupOpen = false;
  startBossBattleListener();
  await Promise.resolve().then(() => {}).then(() => {}); // laisse le get() initial de l abonnement se resoudre
  __assertEq(communityBossBattleProgress, 0, 'la jauge doit demarrer a 0 si aucune contribution n existe encore cette semaine');
  await bossBattleDocRef().set({ currentProgress: bossTarget.targetAmount }, { merge: true });
  await Promise.resolve().then(() => {}).then(() => {}).then(() => {});
  __assertEq(communityBossBattleProgress, bossTarget.targetAmount, 'la progression en memoire doit suivre le document partage en temps reel');
  __assertOk(popupOpen, 'franchir la cible doit declencher la popup de victoire');
  __assertOk(currentPopupHtml.includes('Objectif communautaire atteint'), 'la popup doit annoncer la victoire collective');
  document.getElementById('appPopupCloseX').onclick();
  const archiveDoc = await db.collection('bossBattleArchive').doc(mondayOfWeek(new Date())).get();
  __assertOk(archiveDoc.exists, 'la victoire doit etre archivee (Temple de la renommee) des le 1er franchissement');
  __assertEq(archiveDoc.data().finalProgress, bossTarget.targetAmount, 'l archive doit garder la progression finale reelle');
  // Une contribution supplementaire APRES la victoire ne doit jamais re-declencher la popup ni dupliquer l archive.
  popupQueue = []; popupOpen = false;
  await bossBattleDocRef().set({ currentProgress: firebase.firestore.FieldValue.increment(50) }, { merge: true });
  await Promise.resolve().then(() => {}).then(() => {}).then(() => {});
  __assertOk(!popupOpen, 'une contribution apres la victoire deja detectee ne doit pas redeclencher la popup');
  // 2 clients qui detectent le franchissement quasi simultanement (2 utilisateurs actifs
  // au meme instant) ne doivent jamais ecraser l archive definitive du 1er : simule un
  // 2e appel direct a handleBossBattleVictory() avec une progression finale differente.
  await handleBossBattleVictory(mondayOfWeek(new Date()), bossTarget, bossTarget.targetAmount + 999);
  const archiveDocAfterSecondCall = await db.collection('bossBattleArchive').doc(mondayOfWeek(new Date())).get();
  __assertEq(archiveDocAfterSecondCall.data().finalProgress, bossTarget.targetAmount, 'l archive create-only ne doit jamais etre ecrasee par un 2e franchissement detecte en parallele');
  console.log('OK: victoire du Boss Battle detectee une seule fois, archivee (create-only, jamais dupliquee)');

  // --- 149. Ecran Communaute : jauge collective affichee avec pourcentage + badge
  // Contributeur du jour ---
  communityTopContributorToday = { displayName: 'Bob', amount: 42 };
  activeTab = 'community';
  const bossBattleSectionHtml = renderBossBattleSection();
  __assertOk(bossBattleSectionHtml.includes('boss-battle-card') && bossBattleSectionHtml.includes(escapeHtml(bossChallenge147.name)), 'la jauge collective doit afficher le defi cible de la semaine');
  __assertOk(bossBattleSectionHtml.includes('100%'), 'le pourcentage affiche doit refleter la progression (ici deja au maximum apres la victoire simulee)');
  __assertOk(bossBattleSectionHtml.includes('Contributeur du jour') && bossBattleSectionHtml.includes('Bob'), 'le badge Contributeur du jour doit afficher le plus gros contributeur du jour');
  communityTopContributorToday = null;
  activeTab = 'today';
  __resetCommunityMocks();
  console.log('OK: ecran Communaute affiche la jauge collective + le badge Contributeur du jour');

  // --- 150. Temple de la renommee : rien tant qu aucune victoire, puis liste des
  // semaines gagnees (plus recente en premier) une fois des archives disponibles ---
  __resetCommunityMocks();
  communityBossBattleArchive = [];
  __assertEq(renderHallOfFameSection(), '', 'aucun module ne doit apparaitre tant qu aucune semaine n a ete remportee (pas un etat vide traite comme une erreur)');
  const hofChallenge = CHALLENGE_LIBRARY.find(c => c.id === bossTarget.targetChallengeId);
  await db.collection('bossBattleArchive').doc('2026-08-03').set({ targetChallengeId: hofChallenge.id, targetAmount: 50000, finalProgress: 50120, completedAt: 1000 });
  await db.collection('bossBattleArchive').doc('2026-08-10').set({ targetChallengeId: hofChallenge.id, targetAmount: 50000, finalProgress: 51000, completedAt: 2000 });
  communityBossBattleArchive = await fetchBossBattleArchive();
  __assertEq(communityBossBattleArchive.map(e => e.weekStart), ['2026-08-10', '2026-08-03'], 'les victoires doivent etre triees de la plus recente a la plus ancienne');
  const hofHtml = renderHallOfFameSection();
  __assertOk(hofHtml.includes('Temple de la renommée') && hofHtml.includes('hall-of-fame-row'), 'le Temple de la renommee doit lister les victoires collectives passees');
  __assertOk(hofHtml.includes(escapeHtml(hofChallenge.name)) && hofHtml.includes('51'), 'chaque entree doit afficher le defi et la progression finale reelle');
  communityBossBattleArchive = [];
  __resetCommunityMocks();
  console.log('OK: Temple de la renommee (victoires collectives passees, triees de la plus recente a la plus ancienne)');

  // --- 151. Le ruban "defi communautaire du jour" doit rester visible dans la
  // bibliotheque (mode 'library'), pas seulement sur l accueil -- sans ca, un
  // utilisateur parti "choisir son propre defi" ne peut plus reperer le(s) defi(s)
  // du jour communautaires en parcourant le catalogue ---
  __resetCommunityMocks();
  todayKey = '2026-08-10';
  const { challenge1: libC1 } = getDailyCommunityChallenges(todayKey);
  const libRibbonHtml = renderChallengeCard(libC1, 'library');
  __assertOk(libRibbonHtml.includes('community-card-ribbon'), 'le ruban communautaire doit aussi apparaitre sur les cartes de la bibliotheque (mode library), pas seulement sur l accueil');
  console.log('OK: ruban communautaire visible aussi dans la bibliotheque (mode library)');

  // --- 152. Fil des contributions individuelles au Boss Battle (temps reel, ~20
  // dernieres) : distinct de dailyContributors (agregat), un document PAR evenement ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Julie', email: 'j@test.com', photoURL: '' };
  const feedTarget = getWeeklyBossBattleTarget();
  const feedChallenge = CHALLENGE_LIBRARY.find(c => c.id === feedTarget.targetChallengeId);
  activeToday = new Set([feedChallenge.id]);
  state = emptyDayState();
  currentChallengeId = feedChallenge.id;
  stats[feedChallenge.id] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(40);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  const contribSnap = await bossBattleDocRef().collection('contributions').orderBy('at', 'desc').limit(20).get();
  __assertEq(contribSnap.size, 1, 'chaque contribution doit creer un nouveau document (pas fusionne, contrairement a dailyContributors)');
  __assertEq(contribSnap.docs[0].data().displayName, 'Julie', 'le document de contribution doit garder le nom affiche de l auteur');
  __assertEq(contribSnap.docs[0].data().amount, 40, 'le montant de la contribution doit etre celui reellement ajoute');

  // Optimisation quota Firestore : ce listener est suspendu hors de l onglet Communaute
  // (voir switchTab()/startRecentContributionsListener()), exactement comme le fil
  // d activite ci-dessus.
  activeTab = 'community';
  startRecentContributionsListener();
  await Promise.resolve().then(() => {}).then(() => {}).then(() => {});
  __assertEq(communityRecentContributions.length, 1, 'le listener doit alimenter le fil en temps reel');
  currentChallengeId = null;
  activeToday = new Set();
  const feedSectionHtml = renderBossBattleSection();
  __assertOk(feedSectionHtml.includes('boss-battle-feed') && feedSectionHtml.includes('Julie') && feedSectionHtml.includes("vient d'ajouter 40"), 'l ecran Communaute doit afficher le fil des dernieres contributions (FOMO en direct)');
  communityRecentContributions = [];
  if (communityContributionsUnsub) { communityContributionsUnsub(); communityContributionsUnsub = null; }
  activeTab = 'today';
  __resetCommunityMocks();
  console.log('OK: fil des dernieres contributions au Boss Battle (temps reel, FOMO en direct)');

  // --- 153. continueStartApp() doit synchroniser l entree de classement AU DEMARRAGE,
  // pas seulement sur un nouveau gain XP/serie -- garanti par evaluateStreakOnLoad(),
  // qui appelle INCONDITIONNELLEMENT saveStreakData() (donc syncLeaderboardEntry())
  // a chaque demarrage, meme si rien n a change. Sans cette garantie, un utilisateur
  // qui a deja de l XP/une serie mais n a rien valide depuis l ajout du classement
  // n apparaitrait jamais dedans tant qu il n aurait pas complete un NOUVEAU defi ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Alice', email: 'a@test.com', photoURL: '' };
  leaderboardOptOut = false;
  xpTotal = 250; xpWeekly = 0; xpWeekStart = null; streakCount = 7;
  await continueStartApp();
  const startupLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertOk(startupLbDoc.exists, 'l entree de classement doit exister des le demarrage, meme sans nouvelle validation de defi');
  __assertEq(startupLbDoc.data().xpTotal, 250, 'la synchronisation au demarrage doit reprendre l XP deja existant');
  __assertEq(startupLbDoc.data().streakCount, 7, 'la synchronisation au demarrage doit reprendre la serie deja existante');
  __resetCommunityMocks();
  console.log('OK: la synchronisation du classement se fait aussi au demarrage (pas seulement sur un nouveau gain XP/serie)');

  // --- 154. loadCommunityLeaderboard() : l echec de getMyRank() ne doit JAMAIS
  // vider le top N alors qu il a reussi (deja vecu en production avec l ancien
  // mecanisme "voisins" : un Promise.all englobant les 2 requetes effacait le top 20
  // a tort a cause d un souci isole) -- chaque partie garde son propre etat d echec ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Alice', email: 'a@test.com', photoURL: '' };
  await db.collection('leaderboardCache').doc('streaks').set({
    entries: [{ uid: 'autre-uid', displayName: 'Quelqu un d autre', photoURL: '', value: 3, kudosTotal: 0 }],
    totalCount: 5,
    updatedAt: Date.now(),
  });
  __setMockGetMyRankShouldFail(true);
  await loadCommunityLeaderboard('streaks');
  __assertEq(communityLeaderboardTop.length, 1, 'le top N doit rester peuple meme si l appel getMyRank echoue independamment');
  __assertEq(communityLeaderboardMyRank, null, 'mon rang doit rester null (pas de valeur fantome) quand son propre appel a echoue');

  // Regression : un souci sur currentUser (ex: deconnexion en cours) ne doit PAS non
  // plus casser le top N, meme depuis l ajout du patch "ma propre ligne a jour" (voir
  // 146) qui referme lui aussi currentUser.uid - doit etre protege (currentUser &&).
  const realCurrentUser154 = currentUser;
  currentUser = null;
  await loadCommunityLeaderboard('streaks');
  currentUser = realCurrentUser154;
  __assertEq(communityLeaderboardTop.length, 1, 'un currentUser absent ne doit pas casser le top N (patch "ma propre ligne" protege contre currentUser null)');
  __resetCommunityMocks();
  console.log('OK: le top N du classement et mon propre rang ont des etats d echec independants');

  // --- 155. Cliquer sur l onglet deja actif doit reinitialiser sa pile de navigation
  // (fiche defi ouverte, formulaire, Parametres) et revenir a la racine -- avant ce
  // correctif, cliquer "Aujourd hui" depuis la fiche detail d un defi ne faisait RIEN
  // (l onglet etait deja "today", le early-return bloquait tout) ---
  activeTab = 'today';
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  __assertEq(currentChallengeId, pompes.id, 'pre-requis : la fiche detail doit etre ouverte');
  switchTab('today');
  __assertEq(currentChallengeId, null, 'cliquer sur l onglet Aujourd hui deja actif doit fermer la fiche detail et revenir a la racine');
  render(false);
  __assertOk(document.getElementById('app').innerHTML.includes('today-content-flex') || document.getElementById('app').innerHTML.includes('community-hero-banner'), 'apres reinitialisation, l accueil doit afficher la liste racine (pas la fiche detail)');

  activeTab = 'library';
  editingChallengeId = 'new';
  switchTab('library');
  __assertEq(editingChallengeId, null, 'cliquer sur l onglet Defis deja actif doit fermer le formulaire de defi personnalise');

  activeTab = 'account';
  settingsScreenOpen = true;
  switchTab('account');
  __assertOk(!settingsScreenOpen, 'cliquer sur l onglet Profil deja actif doit fermer l ecran Parametres');
  activeTab = 'today';
  console.log('OK: cliquer sur l onglet deja actif reinitialise la pile de navigation vers la racine');

  // --- 156. formatDisplayName() : anonymise "Prenom Nom" -> "Prenom N.", inchange si
  // un seul mot, idempotent (re-appliquer ne change rien), repli si vide ---
  __assertEq(formatDisplayName('Jean Dupont'), 'Jean D.', 'nom+prenom doit devenir Prenom N.');
  __assertEq(formatDisplayName('Sarah'), 'Sarah', 'un nom seul (1 mot) doit rester inchange');
  __assertEq(formatDisplayName('Alexandre Martin'), 'Alexandre M.', 'exemple donne par l utilisateur');
  __assertEq(formatDisplayName('Jean Paul Dupont'), 'Jean D.', 'seule l initiale du DERNIER mot est gardee (pas les mots intermediaires)');
  __assertEq(formatDisplayName('  Hector   HAAB  '), 'Hector H.', 'espaces superflus normalises, initiale toujours en majuscule meme si le nom est saisi en majuscules');
  __assertEq(formatDisplayName('Jean D.'), 'Jean D.', 'idempotent : ré-appliquer sur un nom deja anonymise ne doit rien changer (filet de securite a l affichage sans danger)');
  __assertEq(formatDisplayName(''), 'Athlete', 'nom vide -> repli Athlete en anglais (langue fixe, ecrit dans des collections partagees lues par tous, voir CLAUDE.md)');
  __assertEq(formatDisplayName(null), 'Athlete', 'nom absent (null) -> repli Athlete');
  console.log('OK: formatDisplayName() anonymise correctement (Prenom N., idempotent, repli si vide)');

  // --- 157. formatDisplayName() est applique A L ECRITURE (pas seulement a
  // l affichage) : le nom complet ne doit JAMAIS atteindre les collections
  // communautaires partagees, lisibles par n importe quel autre utilisateur ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Jean Dupont', email: 'j@test.com', photoURL: '' };
  leaderboardOptOut = false;
  await syncLeaderboardEntry();
  const privacyLbDoc = await db.collection('leaderboard').doc('test-uid').get();
  __assertEq(privacyLbDoc.data().displayName, 'Jean D.', 'syncLeaderboardEntry() ne doit jamais ecrire le nom complet, meme si currentUser.displayName est complet');

  const privacyTarget = getWeeklyBossBattleTarget();
  activeToday = new Set([privacyTarget.targetChallengeId]);
  state = emptyDayState();
  currentChallengeId = privacyTarget.targetChallengeId;
  stats[privacyTarget.targetChallengeId] = { lifetimeTotal: 0, bestDay: { total: 0, date: null }, recordStreak: 0 };
  await addSet(10);
  // Optimisation quota Firestore : force le flush du debounce (voir scheduleWorkoutWriteFlush()/flushWorkoutWrites() dans index.html), pour que la suite du test voie l ecriture Firestore comme si le debounce avait expire.
  await flushWorkoutWrites();
  const privacyContribDoc = await bossBattleDocRef().collection('dailyContributors').doc(todayKey + '_test-uid').get();
  __assertEq(privacyContribDoc.data().displayName, 'Jean D.', 'l agregat dailyContributors (badge Contributeur du jour) ne doit jamais garder le nom complet');
  const privacyFeedSnap = await bossBattleDocRef().collection('contributions').orderBy('at', 'desc').limit(1).get();
  __assertEq(privacyFeedSnap.docs[0].data().displayName, 'Jean D.', 'le fil des contributions individuelles ne doit jamais garder le nom complet');
  currentChallengeId = null;
  activeToday = new Set();
  __resetCommunityMocks();
  console.log('OK: le nom complet n atteint jamais les collections communautaires partagees (anonymise des l ecriture)');

  // --- 158. Verrou d installation PWA plein ecran ("PWA First" strict) : detection
  // standalone/iOS, blocage AVANT meme la connexion (pas de gating sur hasSeenTour
  // -- s applique aussi aux comptes deja existants), contenu par plateforme, et
  // echappatoire pour les navigateurs qui ne proposeront jamais d installation reelle ---
  __mockLocalStorageStore.clear();
  deferredInstallPrompt = null;
  navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10)';
  navigator.platform = 'Linux armv8l';
  navigator.maxTouchPoints = 0;
  navigator.standalone = undefined;
  __assertOk(!isIosDevice(), 'un user-agent Android ne doit pas etre detecte comme iOS');

  navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  __assertOk(isIosDevice(), 'un user-agent iPhone doit etre detecte comme iOS');
  navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  navigator.platform = 'MacIntel';
  navigator.maxTouchPoints = 5;
  __assertOk(isIosDevice(), 'un iPad (declare Macintosh, tactile multipoint) doit etre detecte comme iOS malgre le user-agent');
  navigator.maxTouchPoints = 0;
  __assertOk(!isIosDevice(), 'un vrai Mac (non tactile) ne doit jamais etre detecte comme iOS');

  // Deja installee (mode standalone) : le verrou ne doit jamais s afficher, MEME
  // dans un etat par ailleurs eligible (iOS) -- sinon ce test ne prouverait rien.
  navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  window.matchMedia = () => ({ matches: true });
  updatePwaInstallGate();
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'none', 'en mode standalone (deja installee), le verrou ne doit jamais s afficher meme sur un appareil par ailleurs eligible (iOS)');
  window.matchMedia = () => ({ matches: false });

  // AUCUN gating sur hasSeenTour (contrairement a l ancienne banniere) : le verrou
  // bloque AVANT MEME l ecran de connexion, donc aussi un compte deja existant qui
  // rouvrirait le site depuis un onglet/favori classique.
  hasSeenTour = true;
  updatePwaInstallGate();
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'flex', 'le verrou doit s afficher meme si le tour a deja ete vu (compte existant, decision produit assumee)');

  // iOS : guide visuel 3 etapes, pas de bouton d installation directe (l API
  // navigateur n existe pas sur iOS).
  const iosGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(iosGateHtml.includes('Partager') && iosGateHtml.includes("Sur l'écran d'accueil") && iosGateHtml.includes("Ouvre l'application"), 'le guide iOS doit expliquer les 3 etapes (Partager, Sur l ecran d accueil, Ouvrir l app)');
  __assertOk(!iosGateHtml.includes("Installer l'application en 1 clic"), 'iOS n a pas de bouton d installation directe (API navigateur absente)');

  // Android/Chrome sans beforeinstallprompt encore intercepte : repli generique
  // (jamais de fausse instruction), avec l echappatoire volontaire.
  navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10)';
  navigator.platform = 'Linux armv8l';
  updatePwaInstallGate();
  const fallbackGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'flex', 'sans beforeinstallprompt intercepte, le repli generique doit quand meme s afficher (jamais un ecran vide)');
  __assertOk(fallbackGateHtml.includes('Continuer quand même'), 'le repli generique doit proposer une echappatoire (navigateurs sans installation PWA reelle possible)');

  // Une fois beforeinstallprompt intercepte : CTA direct.
  let deferredPromptCalled = false;
  deferredInstallPrompt = { prompt() { deferredPromptCalled = true; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  updatePwaInstallGate();
  const androidGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(androidGateHtml.includes("Installer l'application en 1 clic"), 'le guide Android doit proposer un CTA direct une fois beforeinstallprompt intercepte');
  await triggerPwaInstallFromGate();
  __assertOk(deferredPromptCalled, 'triggerPwaInstallFromGate() doit relancer le prompt natif differe');
  const installedGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(installedGateHtml.includes('Application installée') && installedGateHtml.includes("écran d'accueil"), 'apres acceptation, le verrou doit inviter a ouvrir l icone installee (pas juste se refermer -- l utilisateur est encore dans l onglet navigateur)');
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'flex', 'le verrou reste affiche apres installation reussie : l utilisateur doit encore ouvrir l icone, il n est pas encore dans la version standalone');

  // Prompt REFUSE (dismissed) : ne doit jamais afficher le message de succes --
  // repli sur le bouton Android normal pour retenter, pas de faux "installe".
  deferredInstallPrompt = { prompt() {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) };
  await triggerPwaInstallFromGate();
  const declinedGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(!declinedGateHtml.includes('Application installée'), 'un prompt refuse ne doit jamais afficher le message de succes');

  // Desktop (ni iOS ni Android) : repli specifique avec une echappatoire de DEBOGAGE
  // tres discrete -- prioritaire meme si beforeinstallprompt est disponible (Chrome
  // desktop le supporte aussi), car le message "installe sur mobile" n a de sens que
  // sur ordinateur.
  __mockLocalStorageStore.clear();
  navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0';
  navigator.platform = 'Linux x86_64';
  __assertOk(isDesktopDevice(), 'un navigateur desktop (ni iOS ni Android) doit etre detecte comme tel');
  deferredInstallPrompt = { prompt() {}, userChoice: Promise.resolve({}) }; // meme disponible, ne doit pas primer sur le repli desktop
  updatePwaInstallGate();
  const desktopGateHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(desktopGateHtml.includes('gate-debug-bypass-btn'), 'sur desktop, l echappatoire doit etre la variante TRES discrete (debug), pas le bouton normal du repli mobile');
  __assertOk(!desktopGateHtml.includes("Installer l'application en 1 clic"), 'le bouton d installation Android ne doit jamais apparaitre sur desktop, meme si beforeinstallprompt est disponible');

  navigator.userAgent = 'Mozilla/5.0 (Linux; Android 10)'; // vrai mobile Android : ne doit jamais etre traite comme desktop
  navigator.platform = 'Linux armv8l';
  __assertOk(!isDesktopDevice(), 'un vrai appareil Android ne doit jamais etre detecte comme desktop');
  deferredInstallPrompt = null;

  // Echappatoire (repli mobile generique) : masque le verrou et persiste le choix
  // (localStorage, propre a cet appareil/navigateur -- jamais synchronise via Firestore).
  navigator.userAgent = 'Mozilla/5.0 (Android 10; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0'; // Firefox mobile : jamais de beforeinstallprompt, mais pas "desktop" non plus
  updatePwaInstallGate();
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'flex', 'pre-requis : le verrou (repli generique mobile) doit etre visible avant de tester l echappatoire');
  const mobileFallbackHtml = document.getElementById('pwaInstallGate').innerHTML;
  __assertOk(mobileFallbackHtml.includes('gate-bypass-btn') && !mobileFallbackHtml.includes('gate-debug-bypass-btn'), 'sur mobile (Firefox Android), le repli doit utiliser le bouton normal, pas la variante debug reservee au desktop');
  bypassPwaInstallGate();
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'none', 'l echappatoire doit masquer le verrou immediatement');
  updatePwaInstallGate();
  __assertEq(document.getElementById('pwaInstallGate').style.display, 'none', 'apres l echappatoire, le verrou ne doit jamais revenir sur CET appareil/navigateur, meme apres un nouveau chargement');
  __mockLocalStorageStore.clear();
  deferredInstallPrompt = null;
  hasSeenTour = false;
  document.getElementById('pwaInstallGate').style.display = 'none';
  console.log('OK: verrou d installation PWA plein ecran (standalone/iOS/Android/repli+echappatoire, aucun gating sur le tour)');

  // --- 159. Hierarchie visuelle de l ecran d execution : +5/+10 (CTA principal, vert
  // neon #00E676) doivent dominer visuellement la saisie personnalisee "Ajouter"
  // (action secondaire, style ghost) -- avant ce correctif c etait l inverse
  // (.qa-btn discret en var(--bg-raised), .custom-add-btn en plein var(--accent)). ---
  const qaBtnCssIdx = cssText.indexOf('.qa-btn {');
  __assertOk(qaBtnCssIdx !== -1, 'la regle .qa-btn doit exister dans styles.css');
  const qaBtnCssBlock = cssText.slice(qaBtnCssIdx, cssText.indexOf('}', qaBtnCssIdx));
  __assertOk(qaBtnCssBlock.includes('#00E676'), '+5/+10 doivent utiliser le vert neon #00E676 (CTA principal)');
  __assertOk(!qaBtnCssBlock.includes('var(--bg-raised)') && !qaBtnCssBlock.includes('var(--line)'), '+5/+10 ne doivent plus utiliser les tokens discrets d origine (bouton trop secondaire)');

  const customAddBtnCssIdx = cssText.indexOf('.custom-add-btn {');
  __assertOk(customAddBtnCssIdx !== -1, 'la regle .custom-add-btn doit exister dans styles.css');
  const customAddBtnCssBlock = cssText.slice(customAddBtnCssIdx, cssText.indexOf('}', customAddBtnCssIdx));
  __assertOk(customAddBtnCssBlock.includes('rgba(255, 255, 255, 0.08)'), 'le bouton "Ajouter" doit devenir une action secondaire discrete (ghost)');
  __assertOk(!customAddBtnCssBlock.includes('var(--accent)'), 'le bouton "Ajouter" ne doit plus utiliser le vert plein var(--accent) (reserve au CTA principal +5/+10)');
  console.log('OK: hierarchie visuelle ecran execution (+5/+10 CTA principal vert neon, "Ajouter" relegue en action secondaire ghost)');

  // --- Kilo, coach temps reel sur la fiche d'exercice (retour utilisateur,
  // chantier gamification Phase 1) : paliers de progression (fonction PURE). ---
  __assertEq(computeKiloExerciseProgressBucket(0, 100, false), 'notStarted', 'aucune repetition encore faite -> notStarted');
  __assertEq(computeKiloExerciseProgressBucket(30, 100, false), 'started', 'moins de la moitie -> started');
  __assertEq(computeKiloExerciseProgressBucket(50, 100, false), 'almostThere', 'exactement la moitie -> deja almostThere (borne incluse)');
  __assertEq(computeKiloExerciseProgressBucket(95, 110, false), 'almostThere', 'scenario type du cahier des charges (95/110)');
  __assertEq(computeKiloExerciseProgressBucket(100, 100, false), 'done', 'objectif atteint pile -> done');
  __assertEq(computeKiloExerciseProgressBucket(50, 100, true), 'done', 'entry.done doit l emporter meme si total < target (objectif reduit apres coup)');
  __assertEq(computeKiloExerciseMood(0, 100, false), 'idle', 'humeur idle tant que l objectif n est pas atteint');
  __assertEq(computeKiloExerciseMood(100, 100, false), 'success', 'humeur success des que l objectif est atteint');
  __assertEq(computeKiloExerciseMood(50, 100, true), 'success', 'humeur success si done, meme total < target');
  console.log('OK: computeKiloExerciseProgressBucket()/computeKiloExerciseMood() (paliers purs, testes independamment de la replique aleatoire)');

  // --- Bulle d'ouverture : replique basee sur la progression, choisie parmi les
  // variantes de la cle du bon palier (voir pickKiloExerciseLine()). ---
  activeToday = new Set([pompes.id]);
  state.challenges[pompes.id] = { sets: [], targetOverride: 110, done: false, hardcoreDone: false, hardcoreAnnounced: false };
  await pickChallenge(pompes.id);
  let expectedVariants = t('kilo.exercise.opening.notStarted').map((v) => interpolate(v, { current: 0, target: 110 }));
  __assertOk(expectedVariants.includes(exerciseKiloBubbleText), 'a l ouverture sans aucune repetition, la bulle doit afficher une variante "notStarted" avec le bon objectif');

  state.challenges[pompes.id] = { sets: [95], targetOverride: 110, done: false, hardcoreDone: false, hardcoreAnnounced: false };
  await pickChallenge(pompes.id);
  expectedVariants = t('kilo.exercise.opening.almostThere').map((v) => interpolate(v, { current: 95, target: 110 }));
  __assertOk(expectedVariants.includes(exerciseKiloBubbleText), 'a 95/110 (exemple du cahier des charges), la bulle doit afficher une variante "almostThere" avec les nombres exacts');
  render(false);
  const exerciseScreenHtmlForKilo = document.getElementById('app').innerHTML;
  __assertOk(exerciseScreenHtmlForKilo.includes('active-header-row') && exerciseScreenHtmlForKilo.includes('kilo-exercise-slot') && exerciseScreenHtmlForKilo.includes('kilo-exercise-bubble'), 'Kilo et sa bulle doivent bien apparaitre dans le bloc titre de la fiche d exercice');
  __assertOk(exerciseScreenHtmlForKilo.includes(escapeHtml(exerciseKiloBubbleText)), 'le texte affiche doit correspondre exactement a la replique resolue');
  console.log('OK: bulle d ouverture de Kilo basee sur la progression (variantes dynamisees avec les nombres exacts)');

  // --- A chaque tap (+5/+10/...), Kilo flashe en 'success' et la bulle se met a
  // jour avec une punchline dynamisee par le montant ajoute - independamment de
  // l objectif du jour (une serie qui n acheve pas encore l objectif merite quand
  // meme une reaction). ---
  state.challenges[pompes.id] = { sets: [], targetOverride: 110, done: false, hardcoreDone: false, hardcoreAnnounced: false };
  await pickChallenge(pompes.id);
  await addSet(10);
  expectedVariants = t('kilo.exercise.tapPunchline').map((v) => interpolate(v, { amount: 10 }));
  __assertOk(expectedVariants.includes(exerciseKiloBubbleText), 'apres un tap +10, la bulle doit afficher une punchline dynamisee avec le montant exact ajoute');
  render(false);
  const flashHtml = document.getElementById('app').innerHTML;
  const flashKiloIdx = flashHtml.indexOf('kilo-exercise-slot');
  __assertOk(flashHtml.slice(flashKiloIdx, flashKiloIdx + 400).includes('kilo-success'), 'juste apres un tap, Kilo doit flasher en etat "success" (motive), meme si l objectif du jour est encore loin');

  // Simule l expiration de la fenetre de flash (sans attendre reellement 1.6s) :
  // l humeur doit alors retomber sur celle calculee par computeKiloExerciseMood().
  exerciseKiloFlashUntil = 0;
  render(false);
  const afterFlashHtml = document.getElementById('app').innerHTML;
  const afterFlashKiloIdx = afterFlashHtml.indexOf('kilo-exercise-slot');
  __assertOk(afterFlashHtml.slice(afterFlashKiloIdx, afterFlashKiloIdx + 400).includes('kilo-idle'), 'une fois le flash expire, Kilo doit revenir a l humeur stable (idle, objectif encore loin - 10/110)');
  console.log('OK: chaque tap declenche un flash motive de Kilo + une punchline dynamisee, qui retombe sur l humeur stable une fois le flash expire');

  currentChallengeId = null;

  // --- 160. i18n batch 2/7 : navigation (tab-bar) + ecran Parametres + selecteur de
  // langue -- 1er ecran migre bout-en-bout pour valider le mecanisme en conditions
  // reelles (voir CLAUDE.md, "Internationalisation (i18n) FR/EN/ES"). renderTabBar()/
  // renderSettingsScreen() sont des fonctions pures (pas de dependance a state/
  // activeToday), testables directement sans passer par render(). ---
  const localeBeforeBatch2 = currentLocale;
  currentLocale = 'fr';
  const tabBarFr = renderTabBar();
  __assertOk(tabBarFr.includes(">Aujourd'hui<") && tabBarFr.includes('>Défis<') && tabBarFr.includes('>Commu<') && tabBarFr.includes('>Profil<'), 'la barre d onglets doit afficher les libelles francais par defaut');

  currentLocale = 'en';
  const tabBarEn = renderTabBar();
  __assertOk(tabBarEn.includes('>Today<') && tabBarEn.includes('>Challenges<') && tabBarEn.includes('>Community<') && tabBarEn.includes('>Profile<'), 'la barre d onglets doit basculer entierement en anglais via t()');

  currentLocale = 'es';
  const tabBarEs = renderTabBar();
  __assertOk(tabBarEs.includes('>Hoy<') && tabBarEs.includes('>Retos<') && tabBarEs.includes('>Comunidad<') && tabBarEs.includes('>Perfil<'), 'la barre d onglets doit basculer entierement en espagnol via t()');

  // Ecran Parametres : contenu traduit + selecteur de langue (3 boutons natifs, celui
  // de la langue active seul marque '.active').
  currentLocale = 'en';
  const savedUsernameBatch2 = username;
  username = 'testuser';
  const settingsHtmlEn = renderSettingsScreen();
  __assertOk(settingsHtmlEn.includes('Settings'), 'le titre de l ecran Parametres doit etre traduit');
  __assertOk(settingsHtmlEn.includes('Voice coach'), 'la ligne coach vocal doit etre traduite');
  __assertOk(settingsHtmlEn.includes('Community leaderboard'), 'la ligne classement doit etre traduite');
  __assertOk(settingsHtmlEn.includes('@testuser'), 'le pseudo reste interpole tel quel dans la traduction ({{username}})');
  __assertOk(settingsHtmlEn.includes('Sign out'), 'les actions de compte doivent etre traduites');
  __assertOk(settingsHtmlEn.includes('lang-switch-tabs'), 'le selecteur de langue doit etre present dans Parametres');
  __assertOk(settingsHtmlEn.includes('>Français<') && settingsHtmlEn.includes('>English<') && settingsHtmlEn.includes('>Español<'), 'les noms de langue dans le selecteur restent toujours dans leur PROPRE langue, jamais traduits (convention standard des selecteurs de langue)');
  __assertOk(settingsHtmlEn.includes('class="leaderboard-tab-btn active" onclick="setPreferredLanguage(\\'en\\')"'), 'seul le bouton de la langue ACTIVE doit porter la classe active');
  __assertOk(!settingsHtmlEn.includes('class="leaderboard-tab-btn active" onclick="setPreferredLanguage(\\'fr\\')"') && !settingsHtmlEn.includes('class="leaderboard-tab-btn active" onclick="setPreferredLanguage(\\'es\\')"'), 'les boutons des langues INACTIVES ne doivent jamais porter la classe active');
  username = savedUsernameBatch2;
  currentLocale = localeBeforeBatch2;
  console.log('OK: i18n batch 2 - navigation + ecran Parametres + selecteur de langue (1er ecran migre bout-en-bout)');

  // --- 161. i18n batch 3/7 : Aujourd hui (accueil, carte de defi partagee) + fiche
  // d execution d exercice (unite reps ET unite chrono/sec) -- verifie le rendu
  // traduit via render()/renderChallengeCard() en conditions quasi reelles,
  // contrairement au batch 2 qui ne testait que des fonctions pures. ---
  const localeBeforeBatch3 = currentLocale;
  // planche (unite "sec") deja declare plus haut dans ce fichier, reutilise tel quel
  // pour exercer la branche chrono (Chronometrer une serie / Time a set).
  activeToday = new Set([pompes.id]);
  currentChallengeId = null;
  await pickChallenge(pompes.id);
  currentLocale = 'en';
  render(false); // 2e render() immediat : neutralise le swap DIFFERE (140ms) de pickChallenge()'s render(true), meme filet que le test "bouton retour minimaliste" plus haut
  const exerciseRepsHtmlEn = document.getElementById('app').innerHTML;
  __assertOk(exerciseRepsHtmlEn.includes('Add a set'), 'la fiche d exercice (unite reps) doit afficher le libelle traduit "Add a set"');
  __assertOk(exerciseRepsHtmlEn.includes('Custom number') && exerciseRepsHtmlEn.includes('>Add<'), 'le champ de saisie personnalisee doit etre traduit (placeholder + bouton)');
  __assertOk(exerciseRepsHtmlEn.includes('Record:'), 'le record doit utiliser le prefixe traduit "Record"');
  __assertOk(exerciseRepsHtmlEn.includes('lifetime'), 'le total a vie doit etre traduit');

  activeToday = new Set([planche.id]);
  await pickChallenge(planche.id);
  currentLocale = 'es';
  render(false);
  const exerciseSecHtmlEs = document.getElementById('app').innerHTML;
  __assertOk(exerciseSecHtmlEs.includes('Cronometrar una serie'), 'la fiche d exercice (unite sec) doit afficher le libelle traduit du chrono en espagnol');
  __assertOk(exerciseSecHtmlEs.includes('progress-unit"> SEG</span>'), 'l unite secondes doit etre traduite (SEG) sur la fiche detail en espagnol');

  // Carte de defi (renderChallengeCard, partagee Aujourd hui/Defis) : etat "en cours".
  currentChallengeId = null;
  const cardEntry = getEntry(pompes.id);
  cardEntry.sets = [10];
  cardEntry.done = false;
  currentLocale = 'en';
  const cardHtmlEn = renderChallengeCard(pompes, 'today', 0);
  __assertOk(cardHtmlEn.includes('In progress'), 'la carte de defi doit afficher le statut "En cours" traduit');
  cardEntry.sets = [];

  currentLocale = localeBeforeBatch3;
  currentChallengeId = null;
  render(false);
  console.log('OK: i18n batch 3 - Aujourd hui + fiche d execution d exercice (reps + chrono sec)');

  // --- 162. i18n batch 4/7 : Defis (bibliotheque + formulaire personnalise) + Journal
  // -- meme methode que les batches precedents, fonctions de rendu pures appelees
  // directement (pas de dependance a un render() complet). ---
  const localeBeforeBatch4 = currentLocale;
  const editingBefore = editingChallengeId;
  const searchBefore = librarySearchQuery;
  const historyEntriesBefore = historyEntries;
  const historyLoadingBefore = historyLoading;

  editingChallengeId = null;
  librarySearchQuery = '';
  currentLocale = 'en';
  const libraryHtmlEn = renderLibraryScreen();
  __assertOk(libraryHtmlEn.includes('>Challenges<'), 'le titre de l ecran Defis doit etre traduit');
  __assertOk(libraryHtmlEn.includes('active') , 'le compteur d actifs par categorie doit passer par tn()');

  editingChallengeId = 'new';
  currentLocale = 'es';
  const formHtmlEs = renderChallengeForm();
  __assertOk(formHtmlEs.includes('Nuevo reto'), 'le titre du formulaire (creation) doit etre traduit en espagnol');
  __assertOk(formHtmlEs.includes('Guardar'), 'le bouton Enregistrer doit etre traduit en espagnol');
  __assertOk(formHtmlEs.includes('Repeticiones') && formHtmlEs.includes('Cronómetro'), 'les options d unite du formulaire doivent etre traduites');
  editingChallengeId = null;

  const historyEntriesBeforeSnapshot = [...historyEntries];
  historyEntries = [];
  historyLoading = false;
  currentLocale = 'en';
  const profileViewBeforeBatch4 = profileView;
  const activeTabBeforeBatch4 = activeTab;
  activeTab = 'account';
  profileView = 'journal';
  const historyHtmlEn = renderAccountTabScreen();
  __assertOk(historyHtmlEn.includes('>Log<'), 'le titre du Journal doit etre traduit');
  __assertOk(historyHtmlEn.includes('No history yet'), 'l etat vide du Journal doit etre traduit');
  profileView = profileViewBeforeBatch4;
  activeTab = activeTabBeforeBatch4;
  historyEntries = historyEntriesBeforeSnapshot;

  editingChallengeId = editingBefore;
  librarySearchQuery = searchBefore;
  historyEntries = historyEntriesBefore;
  historyLoading = historyLoadingBefore;
  currentLocale = localeBeforeBatch4;
  console.log('OK: i18n batch 4 - Defis (bibliotheque + formulaire) + Journal');

  // --- 163. i18n batch 5/7 : Communaute (classement, Boss Battle, Temple de la
  // renommee, fil d activite, Amis) + correctif exerciseSlug sur activityFeed. ---
  __resetCommunityMocks();
  const localeBeforeBatch5 = currentLocale;
  currentUser = { uid: 'test-uid', displayName: 'Julie D.', email: 'j@test.com', photoURL: '' };

  // registerActivityFeedEntryIfNeeded() doit ecrire le slug reel du defi (desormais
  // present sur CHALLENGE_LIBRARY depuis le batch 7b) ; un defi personnalise (jamais de
  // slug par nature) doit lui toujours retomber sur null (c.slug ?? null).
  await registerActivityFeedEntryIfNeeded(pompes, 30);
  const feedWriteSnap = await db.collection('activityFeed').orderBy('at', 'desc').limit(1).get();
  __assertEq(feedWriteSnap.docs[0].data().exerciseSlug, pompes.slug, 'exerciseSlug doit correspondre au slug reel du defi de bibliotheque (desormais peuple depuis le batch 7b)');
  __assertOk(!!pompes.slug, 'pre-requis : pompes doit avoir un slug reel pour que l assertion ci-dessus soit significative');
  __resetCommunityMocks(); // evite toute ambiguite de tri si les 2 ecritures partagent le meme Date.now() a la milliseconde pres
  const customChallengeFixture = { id: 9002, cat: 'Test', name: 'Defi perso sans slug', target: 10, unit: 'reps', isCustom: true };
  await registerActivityFeedEntryIfNeeded(customChallengeFixture, 10);
  const customFeedWriteSnap = await db.collection('activityFeed').orderBy('at', 'desc').limit(1).get();
  __assertEq(customFeedWriteSnap.docs[0].data().exerciseSlug, null, 'un defi personnalise (jamais de slug) doit toujours ecrire exerciseSlug: null');
  __resetCommunityMocks();

  currentLocale = 'en';
  const leaderboardRowStreaksEn = renderLeaderboardRow({ uid: 'x', displayName: 'Bob', value: 5 }, 1, 'streaks', false);
  __assertOk(leaderboardRowStreaksEn.includes('5d'), 'la valeur de la vue Series (jours de suite) doit etre traduite en anglais');
  const leaderboardRowXpEn = renderLeaderboardRow({ uid: 'x', displayName: 'Bob', value: 300 }, 1, 'alltime', false);
  __assertOk(leaderboardRowXpEn.includes('300 XP'), 'la valeur de la vue Legendes (XP) doit rester lisible en anglais');

  communityBossBattleTargetCache = { weekStart: mondayOfWeek(new Date()), targetChallengeId: pompes.id, targetAmount: 1000 };
  communityBossBattleProgress = 250;
  communityTopContributorToday = { displayName: 'Bob', amount: 42 };
  communityRecentContributions = [{ id: 'c1', uid: 'other-uid', displayName: 'Bob', amount: 10, kudosCount: 0 }];
  const bossBattleHtmlEn = renderBossBattleSection();
  __assertOk(bossBattleHtmlEn.includes("This week's community goal"), 'le badge de la jauge collective doit etre traduit en anglais');
  __assertOk(bossBattleHtmlEn.includes("Today's top contributor"), 'le badge Contributeur du jour doit etre traduit en anglais');
  __assertOk(bossBattleHtmlEn.includes('just added 10'), 'le fil des contributions individuelles doit etre traduit en anglais');
  communityTopContributorToday = null;
  communityRecentContributions = [];
  communityBossBattleTargetCache = null;

  communityBossBattleArchive = [{ weekStart: '2026-08-03', targetChallengeId: pompes.id, finalProgress: 5000 }];
  const hallOfFameHtmlEn = renderHallOfFameSection();
  __assertOk(hallOfFameHtmlEn.includes('Hall of Fame') && hallOfFameHtmlEn.includes('Week of'), 'le Temple de la renommee doit etre traduit en anglais');
  communityBossBattleArchive = [];

  // renderActivityFeedRow() : repli gracieux sur challengeName (document sans
  // exerciseSlug, cas actuel/documents pre-batch 7) ET resolution via t() quand un slug
  // ET une traduction existent (simule ici le batch 7 en ajoutant temporairement une
  // cle exercises.pompes.name a LOCALE_EN, pour prouver que le CHEMIN existe deja).
  myFriends = [{ uid: 'amie-uid', displayName: 'Amie B.', photoURL: '' }];
  communityActivityFeed = [{ uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Nom francais historique perime', exerciseSlug: null, amount: 50, unit: 'reps', at: Date.now() }];
  const activityFeedFallbackHtmlEn = renderActivityFeedSection();
  __assertOk(activityFeedFallbackHtmlEn.includes('completed Nom francais historique perime'), 'sans exerciseSlug, le fil d activite doit retomber sur le challengeName deja stocke (repli gracieux, ex: document ecrit avant le batch 5)');
  // exerciseSlug reel + vraie traduction (peuplees depuis le batch 7b) : le nom traduit
  // doit primer sur challengeName, qui n est ici volontairement PAS "Pompes" (pour
  // prouver que c est bien exerciseSlug qui pilote l affichage, pas challengeName).
  communityActivityFeed = [{ uid: 'amie-uid', displayName: 'Amie B.', challengeName: 'Nom francais historique perime', exerciseSlug: pompes.slug, amount: 50, unit: 'reps', at: Date.now() }];
  const activityFeedSlugHtmlEn = renderActivityFeedSection();
  __assertOk(activityFeedSlugHtmlEn.includes('completed Push-ups'), 'avec exerciseSlug ET une traduction disponible, le nom traduit doit primer sur le challengeName francais stocke');
  communityActivityFeed = [];
  myFriends = [];

  const communityScreenHtmlEn = renderCommunityScreen();
  __assertOk(communityScreenHtmlEn.includes('>Community<') && communityScreenHtmlEn.includes('>Streaks<') && communityScreenHtmlEn.includes('>Weekly<') && communityScreenHtmlEn.includes('>All-time<'), 'l ecran Communaute (titre + onglets de vue) doit etre traduit en anglais');

  currentLocale = 'es';
  friendSearchResult = null;
  const friendsScreenHtmlEs = renderFriendsScreen();
  __assertOk(friendsScreenHtmlEs.includes('Amigos') && friendsScreenHtmlEs.includes('Buscar'), 'l ecran Amis doit etre traduit en espagnol');
  friendSearchResult = 'not-found';
  friendSearchQuery = 'zzz';
  const friendsNotFoundHtmlEs = renderFriendsScreen();
  __assertOk(friendsNotFoundHtmlEs.includes('No se encontró el usuario "@zzz"'), 'le message "pseudo introuvable" doit etre traduit et interpoler la requete en espagnol');
  friendSearchResult = null;
  friendSearchQuery = '';

  currentUser = null;
  currentLocale = localeBeforeBatch5;
  __resetCommunityMocks();
  console.log('OK: i18n batch 5 - Communaute (classement/Boss Battle/Temple/fil d activite/Amis) + exerciseSlug');

  // --- 164. i18n batch 6/7 : Profil, onboarding (profil + transition + tour guide),
  // pseudo (setup/renommage). Fonctions de rendu pures appelees directement. ---
  const localeBeforeBatch6 = currentLocale;
  const profileStepBefore = profileStep;
  const profileDraftBefore = { ...profileDraft };
  const guidedTourStepBefore = guidedTourStep;
  const usernameSetupModeBefore = usernameSetupMode;
  const usernameDraftBefore = usernameDraft;
  const usernameAvailabilityBefore = usernameAvailability;
  const onboardingTransitionPhaseBefore = onboardingTransitionPhase;

  currentLocale = 'en';
  guidedTourStep = 0;
  const tourWelcomeHtmlEn = renderGuidedTourOverlay();
  __assertOk(tourWelcomeHtmlEn.includes('Welcome to Défi du Jour!') && tourWelcomeHtmlEn.includes('Next ›'), 'la 1ere carte du tour guide doit etre traduite en anglais');
  guidedTourStep = GUIDED_TOUR_STEPS.length - 1;
  const tourLastHtmlEn = renderGuidedTourOverlay();
  __assertOk(tourLastHtmlEn.includes('Finish'), 'la derniere carte du tour guide doit afficher le bouton de fin traduit');
  guidedTourStep = null;

  onboardingTransitionPhase = 'loading';
  const transitionLoadingHtmlEn = renderOnboardingTransitionScreen();
  __assertOk(transitionLoadingHtmlEn.includes('Calculating your targets...'), 'l ecran de transition (chargement) doit etre traduit en anglais');
  onboardingTransitionPhase = 'done';
  const transitionDoneHtmlEn = renderOnboardingTransitionScreen();
  __assertOk(transitionDoneHtmlEn.includes('Targets calculated!') && transitionDoneHtmlEn.includes('Discover my challenges'), 'l ecran de transition (termine) doit etre traduit en anglais');
  onboardingTransitionPhase = null;

  profileStep = 0;
  const profileWelcomeHtmlEn = renderProfileOnboardingScreen();
  __assertOk(profileWelcomeHtmlEn.includes('Welcome to') && profileWelcomeHtmlEn.includes('Get started'), 'l etape de bienvenue de l onboarding profil doit etre traduite en anglais');
  profileStep = 1;
  const profileAgeHtmlEn = renderProfileOnboardingScreen();
  __assertOk(profileAgeHtmlEn.includes('How old are you?') && profileAgeHtmlEn.includes('yo'), 'l etape age doit etre traduite en anglais (question + suffixe unite)');
  profileStep = 4;
  profileDraft.level = null;
  const profileLevelHtmlEn = renderProfileOnboardingScreen();
  __assertOk(profileLevelHtmlEn.includes('Your current level?') && profileLevelHtmlEn.includes('Beginner') && profileLevelHtmlEn.includes('Advanced'), 'l etape niveau doit etre traduite en anglais');
  profileStep = profileStepBefore;
  Object.assign(profileDraft, profileDraftBefore);

  currentLocale = 'es';
  usernameSetupMode = 'onboarding';
  usernameDraft = 'te';
  usernameAvailability = null;
  const usernameShortHtmlEs = renderUsernameSetupScreen();
  __assertOk(usernameShortHtmlEs.includes('Elige tu usuario') && usernameShortHtmlEs.includes('Falta 1 carácter'), 'l ecran de choix de pseudo (trop court) doit etre traduit en espagnol, y compris le decompte singulier');
  usernameDraft = 'testuser';
  usernameAvailability = 'taken';
  const usernameTakenHtmlEs = renderUsernameSetupScreen();
  __assertOk(usernameTakenHtmlEs.includes('Ya está en uso'), 'le statut "deja pris" doit etre traduit en espagnol');
  usernameSetupMode = 'rename';
  usernameAvailability = 'available';
  const usernameRenameHtmlEs = renderUsernameSetupScreen();
  __assertOk(usernameRenameHtmlEs.includes('Editar mi usuario') && usernameRenameHtmlEs.includes('>Guardar<'), 'le mode renommage doit afficher son propre titre + bouton Enregistrer traduits');
  usernameSetupMode = usernameSetupModeBefore;
  usernameDraft = usernameDraftBefore;
  usernameAvailability = usernameAvailabilityBefore;

  const savedXpTotal = xpTotal;
  xpTotal = 50;
  const athleteCardHtmlEs = renderAthleteCard();
  __assertOk(athleteCardHtmlEs.includes('Nivel') && athleteCardHtmlEs.includes('XP'), 'la carte athlete (niveau/XP) doit etre traduite en espagnol');
  const trophiesGridHtmlEs = renderTrophiesGrid();
  __assertOk(trophiesGridHtmlEs.includes('Trofeos ('), 'le libelle des trophees doit etre traduit en espagnol');
  // renderLevelRoadmapSheet() : le parametre de .map() a ete renomme tier (pas t, qui
  // masquerait la fonction globale de traduction) -- verifie que l appel a t() a
  // l interieur de ce callback fonctionne reellement, pas seulement que ca ne plante pas.
  const roadmapHtmlEs = renderLevelRoadmapSheet();
  __assertOk(roadmapHtmlEs.includes('Nivel') && roadmapHtmlEs.includes('Recorrido de títulos de atleta'), 'la fiche parcours de niveau doit etre traduite en espagnol (titre + libelle de section)');
  __assertOk(/Nivel \\d+\\+/.test(roadmapHtmlEs) && /Niveles \\d+–\\d+/.test(roadmapHtmlEs), 'les intitules de palier (Nivel X+ / Niveles X-Y) doivent etre traduits, pas juste le contenu autour');
  xpTotal = savedXpTotal;

  const savedCurrentUserBatch6 = currentUser;
  currentUser = null;
  const accountSectionHtmlEs = renderAccountSection();
  __assertOk(accountSectionHtmlEs.includes('Cuenta'), 'le repli de nom de compte (aucun utilisateur) doit etre traduit en espagnol');
  currentUser = savedCurrentUserBatch6;

  activeTab = 'account';
  settingsScreenOpen = false;
  const accountTabHtmlEs = renderAccountTabScreen();
  __assertOk(accountTabHtmlEs.includes('>Perfil<') && accountTabHtmlEs.includes('Ajustes'), 'l onglet Profil (titre + bouton Parametres) doit etre traduit en espagnol');
  activeTab = 'today';

  currentLocale = localeBeforeBatch6;
  guidedTourStep = guidedTourStepBefore;
  console.log('OK: i18n batch 6 - Profil + onboarding (profil/transition/tour guide) + pseudo');

  // --- 165. i18n batch 7a/7 : vocabulaire de dates (formatDateLabel/formatRelative/
  // DOW_LABELS/MONTH_ABBR/lettres du calendrier mensuel), delibrement laisse en
  // francais dur dans tous les batches precedents jusqu ici. ---
  const localeBeforeBatch7a = currentLocale;
  currentLocale = 'en';
  const dateLabelEn = formatDateLabel(new Date(2026, 6, 31)); // vendredi 31 juillet 2026
  __assertOk(dateLabelEn.includes('Friday') && dateLabelEn.includes('Jul'), 'formatDateLabel() doit traduire le jour ET le mois en anglais');
  __assertEq(formatRelative(Date.now() - 30000), 'just now', 'formatRelative() (<1min) doit etre traduit en anglais');
  __assertEq(formatRelative(Date.now() - 5 * 60000), '5min ago', 'formatRelative() (minutes) doit etre traduit en anglais');
  __assertEq(formatRelative(Date.now() - 3 * 3600000), '3h ago', 'formatRelative() (heures) doit etre traduit en anglais');
  __assertEq(formatRelative(Date.now() - 2 * 86400000), '2d ago', 'formatRelative() (jours) doit etre traduit en anglais');

  activeToday = new Set([pompes.id]);
  currentChallengeId = null;
  state = emptyDayState();
  render(false);
  const weekStripHtmlEn = document.getElementById('app').innerHTML;
  __assertOk(/class="dow">[SMTWF]</.test(weekStripHtmlEn), 'la bande de semaine (accueil) doit utiliser les lettres de jour traduites (DOW_LABELS -> dates.dowShort)');

  activeTab = 'account';
  profileView = 'journal';
  historyEntries = [];
  historyLoading = false;
  const historyHtmlEnFull = renderAccountTabScreen();
  __assertOk(historyHtmlEnFull.includes('class="cal-dow">M<') && historyHtmlEnFull.includes('class="cal-dow">S<'), 'l en-tete du calendrier mensuel (Journal) doit utiliser les lettres de jour traduites');
  activeTab = 'today';
  profileView = 'profile';

  currentLocale = 'es';
  const heatmapHtmlEs = renderHeatmap();
  __assertOk(/heat-month-label">(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic|)</.test(heatmapHtmlEs), 'les abreviations de mois de la heatmap doivent etre traduites en espagnol (ou vides si aucun 1er du mois dans la colonne)');

  currentLocale = localeBeforeBatch7a;
  console.log('OK: i18n batch 7a - vocabulaire de dates (formatDateLabel/formatRelative/DOW_LABELS/MONTH_ABBR)');

  // --- 166. i18n batch 7b/7 : slug reel + traduction des noms/categories d exercices
  // (exercise-data.js) -- challengeDisplayName()/translateCategoryName() et leur
  // branchement sur les ecrans deja migres (carte de defi, bibliotheque, Boss Battle,
  // Temple de la renommee, onboarding). ---
  const localeBeforeBatch7b = currentLocale;
  __assertOk(CHALLENGE_LIBRARY.every(c => typeof c.slug === 'string' && c.slug.length > 0), 'chaque entree de CHALLENGE_LIBRARY doit desormais avoir un slug reel non vide');
  const uniqueSlugs = new Set(CHALLENGE_LIBRARY.map(c => c.slug));
  __assertEq(uniqueSlugs.size, CHALLENGE_LIBRARY.length, 'les slugs doivent tous etre uniques (aucun doublon)');

  currentLocale = 'en';
  __assertEq(challengeDisplayName(pompes), 'Push-ups', 'challengeDisplayName() doit traduire un defi de bibliotheque via son slug');
  __assertEq(pompes.name, 'Pompes', 'c.name lui-meme ne doit JAMAIS etre modifie par challengeDisplayName() (reste l identifiant canonique francais utilise par les CHALLENGE_LIBRARY.find(...) partout ailleurs)');
  const customNoSlug = { id: 9003, name: 'Mon defi maison', isCustom: true };
  __assertEq(challengeDisplayName(customNoSlug), 'Mon defi maison', 'un defi personnalise (sans slug) doit retomber sur son nom brut, jamais casse');
  __assertEq(translateCategoryName('Haltères'), 'Dumbbells', 'translateCategoryName() doit traduire une categorie fixe connue');
  __assertEq(translateCategoryName('Ma categorie perso'), 'Ma categorie perso', 'une categorie inconnue (defi personnalise) doit retomber sur le texte brut tel quel');

  activeToday = new Set([pompes.id]);
  state = emptyDayState();
  currentChallengeId = null;
  render(false);
  const homeHtmlEn = document.getElementById('app').innerHTML;
  __assertOk(homeHtmlEn.includes('Push-ups') && homeHtmlEn.includes('Upper body'), 'la carte de defi ET le libelle de categorie doivent etre traduits sur l accueil');

  librarySearchQuery = 'push';
  const libarySearchHtmlEn = renderLibraryScreen();
  __assertOk(libarySearchHtmlEn.includes('Push-ups'), 'la recherche de l onglet Defis doit matcher sur le nom TRADUIT, pas seulement le nom francais original');
  librarySearchQuery = '';

  profileStep = 0; // le previewChallenge de l ecran de transition est toujours "Pompes"
  onboardingTransitionPhase = 'done';
  const transitionPreviewHtmlEn = renderOnboardingTransitionScreen();
  __assertOk(transitionPreviewHtmlEn.includes('Push-ups') && transitionPreviewHtmlEn.includes('REPS'), 'la mini-carte de preview de l onboarding doit afficher le nom d exercice traduit + l unite traduite en majuscules');
  onboardingTransitionPhase = null;

  communityBossBattleTargetCache = { weekStart: mondayOfWeek(new Date()), targetChallengeId: pompes.id, targetAmount: 1000 };
  communityBossBattleProgress = 100;
  const bossBattleHtmlEnBatch7b = renderBossBattleSection();
  __assertOk(bossBattleHtmlEnBatch7b.includes('Push-ups —'), 'la jauge collective doit afficher le nom d exercice traduit dans son libelle d objectif');
  communityBossBattleTargetCache = null;

  communityBossBattleArchive = [{ weekStart: '2026-08-03', targetChallengeId: pompes.id, finalProgress: 5000 }];
  const hofHtmlEnBatch7b = renderHallOfFameSection();
  __assertOk(hofHtmlEnBatch7b.includes('Push-ups'), 'le Temple de la renommee doit afficher le nom d exercice traduit');
  communityBossBattleArchive = [];

  activeToday = new Set();
  state = emptyDayState();
  currentChallengeId = null;
  librarySearchQuery = '';
  currentLocale = localeBeforeBatch7b;
  render(false);
  console.log('OK: i18n batch 7b - exercise-data.js (slug reel + traduction noms/categories)');

  // --- 167. i18n batch 7c/7 : BADGE_DEFS (badgeLabel()) + ATHLETE_TITLE_TIERS
  // (athleteTitle(), id+icon a la place de l ancien title fige en francais). ---
  const localeBeforeBatch7c = currentLocale;
  __assertOk(BADGE_DEFS.every(b => typeof b.id === 'string' && b.id.length > 0), 'chaque trophee doit avoir un id stable');
  __assertOk(ATHLETE_TITLE_TIERS.every(tr => typeof tr.id === 'string' && tr.id.length > 0 && typeof tr.icon === 'string'), 'chaque palier de titre d athlete doit avoir un id stable + une icone separee');

  currentLocale = 'en';
  const streak3Badge = BADGE_DEFS.find(b => b.id === 'streak_3');
  __assertEq(badgeLabel(streak3Badge), '3-day streak', 'badgeLabel() doit traduire via l id stable du trophee');
  __assertEq(streak3Badge.label, '3 jours de suite', 'le champ label original doit rester le texte canonique francais, jamais modifie');

  __assertEq(athleteTitle(1), 'Recruit 🥉', 'athleteTitle() doit traduire le titre ET garder l icone separee, pour le 1er palier');
  __assertEq(athleteTitle(999), 'Immortal Legend 👑', 'athleteTitle() doit traduire le dernier palier (maxLevel Infinity)');

  const savedXpTotalBatch7c = xpTotal;
  xpTotal = 50;
  const roadmapHtmlEnBatch7c = renderLevelRoadmapSheet();
  __assertOk(roadmapHtmlEnBatch7c.includes('Recruit') && roadmapHtmlEnBatch7c.includes('Immortal Legend'), 'la fiche parcours de niveau doit afficher tous les titres traduits, pas seulement le titre courant');
  xpTotal = savedXpTotalBatch7c;

  badges.unlocked = [];
  const trophiesGridHtmlEnBatch7c = renderTrophiesGrid();
  __assertOk(trophiesGridHtmlEnBatch7c.includes('3-day streak'), 'la grille de trophees (Profil) doit afficher les libelles traduits');
  const badgesStripHtmlEnBatch7c = renderBadgesStrip();
  __assertOk(badgesStripHtmlEnBatch7c.includes('day streak') || badgesStripHtmlEnBatch7c.includes('challenges completed'), 'la bande "prochains trophees" (accueil) doit afficher des libelles traduits');

  currentLocale = localeBeforeBatch7c;
  console.log('OK: i18n batch 7c - BADGE_DEFS (badgeLabel) + ATHLETE_TITLE_TIERS (athleteTitle)');

  // --- 168. i18n batch 7d/7 : les 39 sites alert()/confirmModal()/enqueuePopup()/
  // showToast() du fichier, + formatTargetLabel() (exercise-data.js) qui appelle
  // desormais t() lui aussi (SEC/reps traduits partout ou il est utilise). ---
  const localeBeforeBatch7d = currentLocale;

  __assertEq(formatTargetLabel(100, 'reps'), '100 reps', 'formatTargetLabel() (reps) doit rester identique en francais (repli/langue par defaut)');
  currentLocale = 'es';
  __assertOk(formatTargetLabel(90, 'sec').includes('SEG'), 'formatTargetLabel() (sec) doit traduire l unite meme depuis exercise-data.js (SEG en espagnol)');

  currentLocale = 'en';
  let capturedAlert = null;
  const realAlert = alert;
  alert = (msg) => { capturedAlert = msg; };
  const profileStepBeforeBatch7d = profileStep;
  const profileDraftBeforeBatch7d = { ...profileDraft };
  profileStep = 2; // etape sexe : declenche l alerte de validation si rien de selectionne
  profileDraft.sex = null;
  profileNext();
  __assertEq(capturedAlert, 'Please select an option.', 'les alertes de validation de l onboarding profil doivent etre traduites (alert() capture directement)');
  alert = realAlert;
  profileStep = profileStepBeforeBatch7d;
  Object.assign(profileDraft, profileDraftBeforeBatch7d);

  const confirmModalPromise = confirmModal({ title: 'Test' }); // sans confirmLabel/cancelLabel explicites : verifie les VALEURS PAR DEFAUT traduites
  __assertOk(currentConfirmModalHtml.includes('>Confirm<') && currentConfirmModalHtml.includes('>Cancel<'), 'confirmModal() doit utiliser Confirm/Cancel comme libelles par defaut traduits (pas Confirmer/Annuler fige)');
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  await confirmModalPromise;

  const savedStreakCountBatch7d = streakCount;
  const savedHasShieldBatch7d = hasShield;
  streakCount = 1;
  hasShield = true;
  showStreakInfoModal();
  __assertOk(popupQueue.length > 0, 'showStreakInfoModal() doit enfiler une popup');
  const streakPopup = popupQueue[popupQueue.length - 1];
  __assertEq(streakPopup.bigLabel, 'Day', 'le libelle de jour (singulier, streakCount=1) doit etre traduit via tn()');
  __assertOk(streakPopup.subtitle.includes("keeping your streak"), 'le sous-titre "serie active" doit etre traduit');
  __assertOk(streakPopup.badgeLine.includes('Available'), 'le statut du bouclier doit etre traduit');
  popupQueue.length = 0;
  streakCount = savedStreakCountBatch7d;
  hasShield = savedHasShieldBatch7d;

  const savedOnlineBatch7d = navigator.onLine;
  navigator.onLine = true;
  document.getElementById('toast').innerHTML = '';
  reportSaveError('test', new Error('x'));
  __assertOk(document.getElementById('toast').innerHTML.includes('Save failed'), 'le toast d erreur de sauvegarde doit etre traduit en anglais');
  document.getElementById('toast').innerHTML = '';
  navigator.onLine = savedOnlineBatch7d;

  currentLocale = localeBeforeBatch7d;
  console.log('OK: i18n batch 7d - popups/toasts/alertes (39 sites) + formatTargetLabel()');

  // --- 169. i18n batch 7e/7 : audit final -- bandeau hors ligne, verrou d installation
  // PWA, coach vocal (texte ET langue de la synthese vocale), repli client "Athlete"
  // (fetchPublicProfile absent) : 4 sites reperes par une relecture systematique du
  // fichier APRES les batches 7a-7d, tous manques une premiere fois. ---
  const localeBeforeBatch7e = currentLocale;

  currentLocale = 'en';
  const savedPendingWriteCountBatch7e = pendingWriteCount;
  const savedOnlineBatch7e = navigator.onLine;
  navigator.onLine = false;
  pendingWriteCount = 3;
  updateOfflineBanner();
  __assertOk(document.getElementById('offlineBanner').textContent.includes('3 changes pending sync'), 'le bandeau hors ligne (avec ecritures en attente) doit etre traduit en anglais, tn() inclus');
  pendingWriteCount = 0;
  updateOfflineBanner();
  __assertOk(document.getElementById('offlineBanner').textContent.includes('will sync when you reconnect'), 'le bandeau hors ligne (etat neutre) doit etre traduit en anglais');
  pendingWriteCount = savedPendingWriteCountBatch7e;
  navigator.onLine = savedOnlineBatch7e;
  updateOfflineBanner();

  const pwaGateHtmlEn = buildPwaInstallGateHtml('ios');
  __assertOk(pwaGateHtmlEn.includes('Welcome to Défi du Jour') && pwaGateHtmlEn.includes('Share') && pwaGateHtmlEn.includes('Add to Home Screen'), 'le verrou d installation PWA (iOS) doit etre traduit en anglais');
  const pwaGateAndroidHtmlEn = buildPwaInstallGateHtml('android');
  __assertOk(pwaGateAndroidHtmlEn.includes('Install the app in 1 tap'), 'le verrou d installation PWA (Android) doit etre traduit en anglais');

  const savedVoiceCoachBatch7e = voiceCoachEnabled;
  voiceCoachEnabled = true;
  const savedSpeakFn = window.speechSynthesis.speak;
  let lastSpokenLang = null, lastSpokenText = null;
  window.speechSynthesis.speak = (utt) => { lastSpokenLang = utt.lang; lastSpokenText = utt.text; };
  speak('test');
  __assertEq(lastSpokenLang, 'en-US', "l attribut lang de l utterance doit suivre la langue active (plus jamais fr-FR fige), essentiel pour une prononciation correcte");
  window.speechSynthesis.speak = savedSpeakFn;
  voiceCoachEnabled = savedVoiceCoachBatch7e;
  void lastSpokenText;

  currentLocale = localeBeforeBatch7e;
  console.log('OK: i18n batch 7e - audit final (bandeau hors ligne, verrou PWA, langue coach vocal)');

  // --- 170. Fiche profil d'un ami (clic sur une ligne dans l'onglet Amis) : XP/niveau/
  // titre/serie + activite recente, via une requete CIBLEE (pas le fil fusionne de tous
  // les amis), avec repli explicite si l ami a desactive le classement. ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };

  // fetchPublicProfile() expose desormais aussi xpTotal/streakCount (deja presents sur le
  // doc leaderboard/{uid}, juste pas encore extraits avant ce chantier).
  publicProfileCache = {};
  await db.collection('leaderboard').doc('amie-uid').set({ displayName: 'Bea Martin', photoURL: '', xpTotal: 450, streakCount: 4 }, { merge: true });
  const profilAvecXp = await fetchPublicProfile('amie-uid');
  __assertEq(profilAvecXp.xpTotal, 450, 'fetchPublicProfile doit desormais exposer xpTotal, necessaire a la fiche profil d un ami');
  __assertEq(profilAvecXp.streakCount, 4, 'fetchPublicProfile doit desormais exposer streakCount');

  // renderFriendActionRow() : seul clickable=true (liste "Mes amis") ouvre la fiche
  // profil au clic sur la ligne - recherche et demandes recues restent non cliquables.
  const rowNonCliquable = renderFriendActionRow('u1', 'Nom', '', '<span></span>');
  __assertOk(!rowNonCliquable.includes('openFriendProfile('), 'sans clickable=true (recherche/demandes), la ligne ne doit PAS ouvrir de fiche profil');
  const rowCliquable = renderFriendActionRow('u1', 'Nom', '', '<span></span>', true);
  __assertOk(rowCliquable.includes("openFriendProfile('u1'"), 'clickable=true (liste Mes amis) doit ouvrir la fiche profil au clic sur la ligne');
  __assertOk(rowCliquable.includes('leaderboard-row clickable'), 'la ligne cliquable doit porter la classe CSS clickable (curseur pointeur)');

  // Retour utilisateur "effet waouh" : sur la liste "Mes amis" (clickable=true),
  // l action doit etre cachee par defaut (revelee par glissement, voir
  // initSwipeableRows()) - jamais pour les autres usages (recherche/invitation),
  // ou l action reste toujours visible telle quelle.
  __assertOk(rowCliquable.includes('class="swipeable-row"') && rowCliquable.includes('swipeable-row-actions') && rowCliquable.includes('swipeable-row-content'), 'la ligne cliquable doit etre enveloppee dans la structure "glisser pour reveler"');
  __assertEq((rowCliquable.match(/<span><\\/span>/g) || []).length, 1, 'l action ne doit apparaitre qu UNE SEULE fois (dans le panneau cache), jamais dupliquee dans la ligne visible');
  __assertOk(!rowNonCliquable.includes('swipeable-row'), 'les usages non cliquables (recherche, invitation a un groupe) ne doivent jamais etre enveloppes dans la structure de glissement - l action y reste toujours visible');

  // renderFriendsScreen() : le bouton "retirer" (🗑️) doit stopper la propagation, sinon
  // il declencherait AUSSI l ouverture de la fiche profil de l ami qu on retire.
  myFriends = [{ uid: 'amie-uid', displayName: 'Bea M.', photoURL: '' }];
  incomingFriendRequests = []; outgoingFriendRequestUids = new Set();
  friendSearchQuery = ''; friendSearchResult = null;
  const friendsScreenHtml = renderFriendsScreen();
  __assertOk(friendsScreenHtml.includes("event.stopPropagation(); removeFriend('amie-uid')"), 'le bouton retirer doit stopper la propagation avant de retirer l ami');

  // renderFriendProfileSheet() : etats chargement / contenu complet / repli opt-out.
  // Retour utilisateur "effet waouh" : ecran squelette (shimmer) plutot qu un
  // simple texte "Chargement..." pendant le fetch async du profil.
  const sheetChargement = renderFriendProfileSheet({ displayName: 'Bea M.', photoURL: '', loading: true });
  __assertOk((sheetChargement.match(/skeleton-block/g) || []).length >= 3, 'l etat de chargement doit afficher un ecran squelette (plusieurs blocs), pas juste un texte');
  __assertOk(!sheetChargement.includes(t('friends.profileLoading')), 'l ancien texte "Chargement..." ne doit plus apparaitre, remplace par le squelette');

  const activitesAmie = [
    { id: 'a1', uid: 'amie-uid', displayName: 'Bea M.', challengeName: 'Pompes', amount: 20, unit: 'reps', at: Date.now(), kudosCount: 0 },
  ];
  const sheetComplete = renderFriendProfileSheet({ displayName: 'Bea M.', photoURL: '', loading: false, profile: { xpTotal: 320, streakCount: 4 }, activities: activitesAmie, activitiesFailed: false });
  __assertOk(sheetComplete.includes('Niveau'), 'la fiche doit afficher le niveau de l ami (xpProgress/athleteTitle, purs sur un xpTotal quelconque)');
  // Bug reel signale : la fiche d un ami n est PAS cliquable pour ouvrir un Parcours
  // de niveau (ce serait le TIEN, pas le sien) - ne doit donc jamais afficher l indice
  // "appuie pour voir ta progression" copie depuis sa propre carte cliquable.
  __assertOk(!sheetComplete.includes(t('profileTab.xpProgress').split(' · ')[1]), 'la fiche d un ami ne doit jamais afficher l indice "appuie pour voir ta progression" (elle n est pas cliquable)');
  __assertOk(sheetComplete.includes('XP'), 'la fiche d un ami doit quand meme afficher le total XP (juste sans l indice de clic)');
  __assertOk(sheetComplete.includes('4 j'), 'la fiche doit afficher la serie de l ami');
  __assertOk(sheetComplete.includes('Pompes'), 'la fiche doit lister l activite recente de l ami (renderActivityFeedRow reutilise tel quel)');

  const sheetActivitesVides = renderFriendProfileSheet({ displayName: 'Bea M.', photoURL: '', loading: false, profile: { xpTotal: 320, streakCount: 0 }, activities: [], activitiesFailed: false });
  __assertOk(sheetActivitesVides.includes(t('friends.noRecentActivity')), 'sans activite recente, un etat vide explicite doit s afficher (pas une liste blanche)');

  const sheetIndisponible = renderFriendProfileSheet({ displayName: 'Ami Prive', photoURL: '', loading: false, profile: null });
  __assertOk(sheetIndisponible.includes(t('friends.profileUnavailable')), 'si le profil public est absent (ami ayant desactive le classement), afficher un repli explicite');
  console.log('OK: renderFriendProfileSheet() gere chargement / contenu complet (XP, titre, serie, activite) / repli opt-out');

  // openFriendProfile() : orchestration reelle - fetch profil PUIS fetch activite CIBLEE
  // (pas le fil fusionne de tous les amis, filtre bien par uid), avec court-circuit total
  // si le profil est indisponible (jamais d appel a fetchFriendRecentActivities dans ce cas).
  __resetCommunityMocks();
  publicProfileCache = {};
  await db.collection('leaderboard').doc('amie-uid').set({ displayName: 'Bea Martin', photoURL: '', xpTotal: 450, streakCount: 4 }, { merge: true });
  await db.collection('activityFeed').add({ uid: 'amie-uid', displayName: 'Bea M.', challengeName: 'Squats', amount: 30, unit: 'reps', at: 1000, kudosCount: 0 });
  await db.collection('activityFeed').add({ uid: 'autre-uid', displayName: 'Autre', challengeName: 'Pompes', amount: 10, unit: 'reps', at: 2000, kudosCount: 0 });

  let friendActivitiesFetchCallCount = 0;
  const originalFetchFriendRecentActivities = fetchFriendRecentActivities;
  fetchFriendRecentActivities = async (...args) => { friendActivitiesFetchCallCount++; return originalFetchFriendRecentActivities(...args); };

  await openFriendProfile('amie-uid', 'Bea Martin', '');
  __assertEq(friendProfileOpenUid, 'amie-uid', 'openFriendProfile doit marquer la fiche comme ouverte pour ce uid');
  __assertEq(friendActivitiesFetchCallCount, 1, 'openFriendProfile doit declencher exactement 1 requete activite ciblee');
  const activitesAmieSeule = await originalFetchFriendRecentActivities('amie-uid');
  __assertEq(activitesAmieSeule.length, 1, 'la requete ciblee (where uid==, pas where uid in) ne doit renvoyer QUE l activite de CET ami, pas celle des autres utilisateurs');
  __assertEq(activitesAmieSeule[0].challengeName, 'Squats', 'seule l activite de l ami demande doit remonter');

  closeFriendProfile();
  __assertEq(friendProfileOpenUid, null, 'closeFriendProfile doit refermer la fiche (plus aucun uid ouvert)');

  publicProfileCache = {};
  friendActivitiesFetchCallCount = 0;
  await openFriendProfile('inconnu-uid', 'Fantome', '');
  __assertEq(friendActivitiesFetchCallCount, 0, 'si le profil public est indisponible (opt-out classement), ne JAMAIS interroger le fil d activite (court-circuit)');
  closeFriendProfile();

  fetchFriendRecentActivities = originalFetchFriendRecentActivities;
  console.log('OK: openFriendProfile() ne lit que les donnees de CET ami via une requete ciblee, et court-circuite proprement si le profil est indisponible');

  // --- 171. Groupes & Defis Collectifs (Phase 2 - fondations) : creation/adhesion par
  // code, defi collectif simple (contribution via addSet(), comme le Boss Battle),
  // reglement (simule ici cote client - le calcul reel vit dans
  // functions/test/groups.test.js, closeExpiredGroupChallenges etant une Cloud
  // Function server-only), bilan + "Gage honore", invitation via notification. ---
  __resetCommunityMocks();
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  myGroups = []; myActiveGroupChallenges = [];
  groupJoinError = null;

  await createGroup('Les Costauds', '💪');
  __assertOk(openGroupId, 'creer un groupe doit ouvrir directement son detail');
  const createdGroupId = openGroupId;
  const createdGroupDoc = await db.collection('groups').doc(createdGroupId).get();
  __assertOk(createdGroupDoc.exists && createdGroupDoc.data().name === 'Les Costauds' && createdGroupDoc.data().memberCount === 1, 'le doc groupe doit etre cree avec memberCount=1');
  __assertOk(/^[A-Z0-9]{6}$/.test(createdGroupDoc.data().code), 'le code doit faire 6 caracteres alphanumeriques majuscules');
  const groupCode = createdGroupDoc.data().code;
  const codeDoc = await db.collection('groups_by_code').doc(groupCode).get();
  __assertEq(codeDoc.data().groupId, createdGroupId, 'le code doit pointer vers le bon groupe');
  const myMemberDoc = await db.collection('groups').doc(createdGroupId).collection('members').doc('me-uid').get();
  __assertOk(myMemberDoc.exists && myMemberDoc.data().role === 'creator', 'le createur doit avoir son propre doc membre avec role creator');
  const myGroupsIndexDoc = await db.collection('users').doc('me-uid').collection('myGroups').doc(createdGroupId).get();
  __assertOk(myGroupsIndexDoc.exists, 'un index personnel doit etre cree dans users/{uid}/myGroups (jamais lu par personne d autre)');
  console.log('OK: createGroup() (code a 6 caracteres, doc groupe + membre + index personnel en un seul batch)');

  // Bob rejoint avec le code.
  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  await joinGroupByCode(groupCode);
  __assertEq(openGroupId, createdGroupId, 'rejoindre par code doit ouvrir le detail du groupe');
  const bobMemberDoc = await db.collection('groups').doc(createdGroupId).collection('members').doc('bob-uid').get();
  __assertOk(bobMemberDoc.exists && bobMemberDoc.data().role === 'member', 'Bob doit avoir son propre doc membre, role member');
  const groupAfterJoin = await db.collection('groups').doc(createdGroupId).get();
  __assertEq(groupAfterJoin.data().memberCount, 2, 'memberCount doit s incrementer a l adhesion');

  // Notifications push (Phase A) - trou reel comble : rejoindre un groupe doit
  // previent les membres DEJA presents (ici moi-uid, le createur), jamais le
  // nouveau membre lui-meme.
  const meNotifsAfterJoin = await notificationsCollRef('me-uid').where('type', '==', 'group_member_joined').get();
  __assertEq(meNotifsAfterJoin.size, 1, 'le createur (deja membre) doit etre previenu de l arrivee de Bob');
  __assertEq(meNotifsAfterJoin.docs[0].data().fromUid, 'bob-uid', 'fromUid doit etre le nouveau membre');
  const bobNotifsAfterJoin = await notificationsCollRef('bob-uid').where('type', '==', 'group_member_joined').get();
  __assertEq(bobNotifsAfterJoin.size, 0, 'le nouveau membre ne doit jamais se notifier lui-meme');
  console.log('OK: performJoinGroup() previent les membres deja presents (group_member_joined, trou reel comble)');

  // Code invalide.
  groupJoinError = null;
  await joinGroupByCode('ZZZZZZ');
  __assertEq(groupJoinError, 'not-found', 'un code inconnu doit signaler not-found, sans planter');

  // Groupe plein (plafond 20 membres).
  await db.collection('groups').doc(createdGroupId).set({ memberCount: 20 }, { merge: true });
  groupJoinError = null;
  currentUser = { uid: 'chloe-uid', displayName: 'Chloe D.', email: 'c@test.com', photoURL: '' };
  await joinGroupByCode(groupCode);
  __assertEq(groupJoinError, 'full', 'un groupe deja a 20 membres doit refuser une nouvelle adhesion');
  await db.collection('groups').doc(createdGroupId).set({ memberCount: 2 }, { merge: true }); // restaure pour la suite
  console.log('OK: joinGroupByCode() (adhesion, code introuvable, groupe complet)');

  // refreshMyGroupsAndActiveChallenges() : alimente myActiveGroupChallenges (utilise par
  // registerGroupChallengeContributionsIfNeeded()), aucun defi actif pour l instant.
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  myGroups = []; myActiveGroupChallenges = [];
  await refreshMyGroupsAndActiveChallenges();
  __assertEq(myGroups.length, 1, 'je dois retrouver le groupe que je viens de creer');
  __assertEq(myActiveGroupChallenges.length, 0, 'aucun defi actif pour l instant dans ce groupe');

  // Passe UX premium (retour utilisateur : l onglet Groupes reutilisait trop de
  // composants generiques .leaderboard-row/.history-empty, effet "page web plate") :
  // liste "mes groupes" en cartes distinctes, pas de badge "Defi en cours" tant
  // qu aucun defi n est actif.
  const openGroupIdBeforeCardCheck = openGroupId;
  openGroupId = null;
  const groupsListHtml = renderGroupsScreen();
  __assertOk(groupsListHtml.includes('group-card') && groupsListHtml.includes('Les Costauds'), 'la liste "mes groupes" doit utiliser des cartes (.group-card), pas de simples lignes de leaderboard');
  __assertOk(!groupsListHtml.includes(t('groups.activeChallengeBadge')), 'le badge "Defi en cours" ne doit pas apparaitre tant qu aucun defi n est actif dans ce groupe');
  console.log('OK: liste "mes groupes" en cartes premium (.group-card), badge "Defi en cours" conditionnel');

  // Rejoindre/creer en icones haut-droite (loupe/plus), pas 2 gros blocs toujours
  // visibles (retour utilisateur : actions rares une fois les premiers groupes
  // crees) - un seul des 2 formulaires ouvert a la fois.
  __assertOk(!groupsListHtml.includes('id="groupJoinCodeInput"') && !groupsListHtml.includes('id="groupCreateNameInput"'), 'les formulaires rejoindre/creer ne doivent pas etre affiches par defaut, seules les icones le sont');
  toggleJoiningGroupOpen();
  const groupsListWithJoinOpen = renderGroupsScreen();
  __assertOk(groupsListWithJoinOpen.includes('id="groupJoinCodeInput"'), 'l icone loupe doit reveler le formulaire "rejoindre avec un code"');
  toggleCreatingGroupOpen();
  const groupsListWithCreateOpen = renderGroupsScreen();
  __assertOk(groupsListWithCreateOpen.includes('id="groupCreateNameInput"') && !groupsListWithCreateOpen.includes('id="groupJoinCodeInput"'), 'ouvrir "creer" doit refermer "rejoindre" (un seul formulaire a la fois)');
  toggleCreatingGroupOpen();
  __assertOk(!renderGroupsScreen().includes('id="groupCreateNameInput"'), 'recliquer sur l icone plus doit refermer son propre formulaire');
  console.log('OK: rejoindre/creer en icones haut-droite (loupe/plus), un seul formulaire ouvert a la fois (passe UX premium)');

  // Retour utilisateur "effet waouh" : le bouton "+" (ferme) et le panneau du
  // formulaire (ouvert) doivent partager le meme view-transition-name, mais
  // JAMAIS etre presents tous les deux a la fois (sinon 2 elements avec le meme
  // nom = la View Transitions API echoue silencieusement sur ce nom).
  __assertOk(!renderGroupsScreen().includes('id="groupCreateNameInput"'), 'etat initial : formulaire ferme (verifie par le test precedent, resynchronise ici)');
  __assertOk(renderGroupsScreen().includes('view-transition-name:group-create-fab') && renderGroupsScreen().includes('view-transition-name:group-join-fab'), 'ferme : les 2 BOUTONS (+ et loupe) doivent porter leur propre view-transition-name');
  toggleCreatingGroupOpen();
  const createOpenHtml = renderGroupsScreen();
  __assertEq((createOpenHtml.match(/view-transition-name:group-create-fab/g) || []).length, 1, 'ouvert : le nom ne doit apparaitre qu une seule fois (sur le PANNEAU, plus sur le bouton)');
  __assertOk(createOpenHtml.includes('class="group-fab-form" style="view-transition-name:group-create-fab"'), 'ouvert : c est desormais le panneau qui porte le nom, pas le bouton');
  __assertOk(createOpenHtml.includes('view-transition-name:group-join-fab'), 'le formulaire "rejoindre" (toujours ferme) doit garder son nom sur son propre bouton, inchange');
  toggleCreatingGroupOpen();
  console.log('OK: view-transition-name partage entre bouton ferme et panneau ouvert (morph FAB via View Transitions), jamais duplique');

  openGroupId = openGroupIdBeforeCardCheck;

  // Creation d'un defi collectif : le createur recoit son propre doc participant
  // (initialise a 0) - chaque membre n'ecrit QUE son propre doc (voir les regles
  // Firestore), un membre qui n'ouvre jamais le groupe ni ne contribue restera hors
  // du reglement final (simplification assumee, voir le commentaire de
  // ensureMyParticipantDoc()).
  const challengeEndDate = Date.now() + 7 * 24 * 3600 * 1000;
  await createGroupChallenge(createdGroupId, {
    name: 'Pompes de la semaine', exerciseSlug: pompes.slug,
    startDate: dateKey(new Date()), endDate: challengeEndDate,
    targetTotal: 500, stakeMode: '5050', stakeType: 'custom', stakeDescription: 'Offre une biere',
  });
  const challengesSnap = await db.collection('groups').doc(createdGroupId).collection('challenges').get();
  __assertEq(challengesSnap.size, 1, 'un seul defi doit avoir ete cree');
  const groupChallengeId = challengesSnap.docs[0].id;
  __assertEq(challengesSnap.docs[0].data().status, 'active');
  __assertEq(challengesSnap.docs[0].data().stakeMode, '5050');
  __assertEq(challengesSnap.docs[0].data().stakeType, 'custom');
  __assertEq(challengesSnap.docs[0].data().stakeDescription, 'Offre une biere');
  const myParticipantDoc0 = await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid').get();
  __assertOk(myParticipantDoc0.exists && myParticipantDoc0.data().totalAmount === 0, 'le createur du defi doit avoir son propre doc participant initialise a 0');
  await refreshMyGroupsAndActiveChallenges();
  __assertEq(myActiveGroupChallenges.length, 1, 'le nouveau defi actif doit apparaitre dans myActiveGroupChallenges');
  __assertEq(myActiveGroupChallenges[0].exerciseSlug, pompes.slug, 'le bon exerciseSlug doit etre associe');
  // Chantier gamification Phase 2 (moteur d humeur, computeKiloMood()) : endDate/
  // currentTotal doivent desormais etre enrichis sur chaque defi actif. endDate
  // repris du MEME doc deja lu (aucun cout supplementaire) ; currentTotal via une
  // lecture des participants (meme formule que loadActiveExerciseGroupChallenges(),
  // 0 ici puisqu aucune contribution n a encore ete loguee).
  __assertEq(myActiveGroupChallenges[0].endDate, challengeEndDate, 'endDate doit etre repris du doc defi actif');
  __assertEq(myActiveGroupChallenges[0].currentTotal, 0, 'currentTotal doit etre calcule via une lecture des participants (0 au tout debut)');
  console.log('OK: createGroupChallenge() (doc defi + mon propre doc participant, repris par refreshMyGroupsAndActiveChallenges())');

  // Notifications push (Phase A) - trou reel comble : creer un defi de groupe
  // doit desormais prevenir les AUTRES membres (jamais moi-meme), pas le
  // createur - meme canal que le reste (declenche aussi sendPushOnNotificationCreate
  // cote Cloud Function, non testable ici sans emulateur FCM).
  const bobNotifsAfterChallenge = await notificationsCollRef('bob-uid').where('type', '==', 'group_challenge_created').get();
  __assertEq(bobNotifsAfterChallenge.size, 1, 'Bob (autre membre) doit recevoir une notification group_challenge_created');
  __assertEq(bobNotifsAfterChallenge.docs[0].data().fromUid, 'me-uid', 'fromUid doit etre le createur du defi');
  __assertEq(bobNotifsAfterChallenge.docs[0].data().challengeName, 'Pompes de la semaine');
  __assertEq(bobNotifsAfterChallenge.docs[0].data().groupName, 'Les Costauds');
  const meNotifsAfterChallenge = await notificationsCollRef('me-uid').where('type', '==', 'group_challenge_created').get();
  __assertEq(meNotifsAfterChallenge.size, 0, 'le createur du defi ne doit jamais se notifier lui-meme');
  console.log('OK: createGroupChallenge() previent les AUTRES membres du groupe (group_challenge_created, jamais le createur lui-meme)');

  // stakeType structure ('beer' par defaut, evite la fragmentation de texte libre) :
  // createGroupChallenge() force stakeDescription a vide pour 'beer' (rien a saisir),
  // et le formulaire ne revele le champ texte que pour 'custom' (voir
  // renderCreateGroupChallengeForm()). submitGroupChallengeForm() bloque la
  // soumission si 'custom' est choisi sans texte (evite un gage vide).
  await createGroupChallenge(createdGroupId, {
    name: 'Squats du mois', exerciseSlug: pompes.slug,
    startDate: dateKey(new Date()), endDate: challengeEndDate,
    targetTotal: 100, stakeMode: 'winnerTakesAll', stakeType: 'beer', stakeDescription: 'ignore-moi',
  });
  const beerChallengesSnap = await db.collection('groups').doc(createdGroupId).collection('challenges').where('name', '==', 'Squats du mois').get();
  __assertEq(beerChallengesSnap.docs[0].data().stakeType, 'beer');
  __assertEq(beerChallengesSnap.docs[0].data().stakeDescription, '', 'le texte libre doit etre ignore/vide pour le gage structure "beer"');
  // Annule immediatement : ce 2e defi n etait la que pour verifier stakeType, il ne
  // doit pas devenir le defi "actif" a la place de "Pompes de la semaine" pour le
  // reste du scenario (loadGroupDetail() prend le plus RECENT defi actif).
  await cancelGroupChallenge(createdGroupId, beerChallengesSnap.docs[0].id);

  __assertEq(groupChallengeFormDraft.stakeType, 'beer', 'le formulaire doit proposer "Une biere" par defaut');
  creatingGroupChallenge = true;
  let challengeFormHtml = renderCreateGroupChallengeForm();
  __assertOk(!challengeFormHtml.includes('id="groupChallengeStakeDescInput"'), 'le champ texte libre ne doit PAS etre affiche tant que "beer" (defaut) est selectionne');

  // Retour utilisateur (capture d ecran) : le formulaire, auparavant une liste
  // plate de champs identiques, doit regrouper clairement 3 idees distinctes -
  // Defi (nom/exercice/objectif), Date & duree (debut/fin), Recompense (mode/gage).
  const challengeFormSectionCount = (challengeFormHtml.match(/group-challenge-form-section-label/g) || []).length;
  __assertEq(challengeFormSectionCount, 3, 'le formulaire de defi collectif doit etre regroupe en exactement 3 sections visuelles');
  __assertOk(challengeFormHtml.includes(t('groups.formSections.challenge')) && challengeFormHtml.includes(t('groups.formSections.dates')) && challengeFormHtml.includes(t('groups.formSections.reward')), 'les 3 sections doivent etre intitulees Defi / Date & duree / Recompense');
  __assertOk(challengeFormHtml.includes(t('groups.startDateLabel')) && challengeFormHtml.includes(t('groups.endDateLabel')), 'les 2 champs date doivent etre distingues par un libelle (Debut/Fin), pas 2 champs identiques sans repere');
  console.log('OK: formulaire de defi collectif regroupe en 3 sections visuelles distinctes (Defi / Date & duree / Recompense)');

  // Retour utilisateur : le champ "Debut" doit afficher "Aujourd'hui" (texte) par
  // defaut plutot qu'une date numerique, tout en restant un vrai champ date
  // cliquable (bouton visible -> input natif cache, voir openGroupChallengeStartDatePicker()).
  __assertEq(formatGroupChallengeStartDateLabel(''), t('nav.today'), 'aucune date choisie -> le libelle affiche doit etre "Aujourd hui"');
  __assertEq(formatGroupChallengeStartDateLabel(dateKey(new Date())), t('nav.today'), 'la date du jour explicitement choisie doit aussi afficher "Aujourd hui", pas les chiffres');
  const futureDateKey = dateKey(new Date(Date.now() + 5 * 86400000));
  __assertEq(formatGroupChallengeStartDateLabel(futureDateKey), formatDateLabel(new Date(futureDateKey + 'T00:00:00')), 'une date differente d aujourd hui doit afficher la date formatee normalement (pas "Aujourd hui")');
  __assertOk(challengeFormHtml.includes('id="groupChallengeStartDateInput"') && challengeFormHtml.includes(escapeHtml(t('nav.today'))), 'le formulaire doit afficher "Aujourd hui" sur le bouton Debut par defaut, avec le vrai champ date natif cache juste en dessous');
  __assertOk(!challengeFormHtml.includes('group-challenge-hidden-date-input" value=""'), 'le champ date natif cache doit deja porter la date du jour comme valeur par defaut, jamais une valeur vide');
  console.log('OK: champ "Debut" du defi collectif affiche "Aujourd hui" par defaut (texte), reste cliquable via le calendrier natif');
  updateGroupChallengeDraft('stakeType', 'custom');
  challengeFormHtml = renderCreateGroupChallengeForm();
  __assertOk(challengeFormHtml.includes('id="groupChallengeStakeDescInput"'), 'le champ texte libre doit apparaitre des que "Autre" est selectionne');
  groupChallengeFormDraft.name = 'Test validation'; groupChallengeFormDraft.exerciseSlug = pompes.slug;
  groupChallengeFormDraft.endDate = dateKey(new Date()); groupChallengeFormDraft.targetTotal = '50';
  groupChallengeFormDraft.stakeDescription = '';
  const challengeCountBefore = (await db.collection('groups').doc(createdGroupId).collection('challenges').get()).size;
  await submitGroupChallengeForm();
  const challengeCountAfterEmpty = (await db.collection('groups').doc(createdGroupId).collection('challenges').get()).size;
  __assertEq(challengeCountAfterEmpty, challengeCountBefore, '"Autre" sans texte saisi ne doit PAS creer de defi (gage vide refuse)');
  creatingGroupChallenge = false;
  groupChallengeFormDraft = { name: '', exerciseSlug: '', startDate: '', endDate: '', targetTotal: '', unlimited: false, stakeMode: '5050', stakeType: 'beer', stakeDescription: '' };
  console.log('OK: gage structure "beer" par defaut + "Autre" revele le champ texte + validation (gage custom vide refuse)');

  // Contribution via addSet() (comme registerBossBattleContributionIfNeeded()) : chaque
  // serie loguee sur le MEME exercice contribue, pas seulement la complétion du défi.
  // Delegue desormais a la Cloud Function logGroupChallengeContribution (plafond
  // exact + reglement instantane, voir CLAUDE.md) au lieu d'un increment Firestore
  // direct - le mock ne fait qu'enregistrer l'appel (la logique de plafonnage
  // elle-meme est testee en isolation : computeCreditedAmount() dans
  // functions/test/groups.test.js). On simule ensuite l'effet serveur (increment
  // reel) par une ecriture directe, pour que les tests d affichage qui suivent
  // (classement, bilan...) continuent de disposer de vrais totaux.
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  await addSet(10);
  __assertEq(__mockLogGroupChallengeContributionCalls.length, 1, 'ma serie loguee sur l exercice cible du defi doit appeler logGroupChallengeContribution');
  __assertEq(__mockLogGroupChallengeContributionCalls[0].amount, 10, 'le montant transmis a la Cloud Function doit etre celui de la serie loguee');
  __assertEq(__mockLogGroupChallengeContributionCalls[0].challengeId, groupChallengeId);
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid').set({ totalAmount: 10 }, { merge: true });

  // Bob contribue aussi (davantage) : verifie qu un defi peut recevoir des
  // contributions de PLUSIEURS membres, chacun son propre doc.
  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  myActiveGroupChallenges = [];
  await refreshMyGroupsAndActiveChallenges();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);
  await addSet(30);
  __assertEq(__mockLogGroupChallengeContributionCalls.length, 2, 'la contribution de Bob doit elle aussi appeler logGroupChallengeContribution');
  __assertEq(__mockLogGroupChallengeContributionCalls[1].amount, 30, 'la serie de Bob doit transmettre SON PROPRE montant');
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('bob-uid').set({ totalAmount: 30 }, { merge: true });
  console.log('OK: registerGroupChallengeContributionsIfNeeded() (hook addSet(), delegue integralement a logGroupChallengeContribution - plafond + reglement server-side)');

  // Detail du groupe : classement du defi actif, rang gratuit (index du tableau).
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await loadGroupDetail(createdGroupId);
  __assertOk(groupDetailChallenge && groupDetailChallenge.status === 'active', 'le defi actif doit etre charge');
  __assertEq(groupDetailChallenge.participants.length, 2, 'les 2 participants ayant contribue doivent apparaitre');
  __assertEq(groupDetailChallenge.participants[0].uid, 'bob-uid', 'Bob (30) doit etre classe avant Moi (10)');
  const groupDetailHtml = renderGroupDetailScreen();
  __assertOk(groupDetailHtml.includes('Pompes de la semaine'), 'le nom du defi doit etre affiche');
  __assertOk(groupDetailHtml.includes('#1') && groupDetailHtml.includes('#2'), 'le classement doit afficher un rang numerique exact pour chaque participant');
  console.log('OK: loadGroupDetail() (roster + defi actif classe par totalAmount decroissant, rang exact gratuit)');

  // Passe UX premium (retour utilisateur) : le defi ACTIF doit desormais dominer
  // l ecran (carte "hero", a l image de la Boss Battle en Communaute) - progression
  // en gros, temps restant affiche. La liste des membres/invitations, elle,
  // devient accessoire : releguee derriere le bouton "⋯" (comme l ecran d info
  // d un groupe WhatsApp) plutot que toujours visible en tete d ecran.
  __assertOk(groupDetailHtml.includes('group-challenge-hero'), 'le defi actif doit etre affiche dans une carte "hero" proeminente, pas une simple barre de progression');
  __assertOk(groupDetailHtml.includes('class="group-challenge-hero tilt-card"'), 'la carte hero du defi de groupe doit aussi etre une carte "tilt" (effet waouh)');
  __assertOk(groupDetailHtml.includes('8%'), 'le pourcentage de progression (40/500) doit etre affiche en gros dans la carte hero');
  __assertOk(groupDetailHtml.includes(tn('groups.timeRemaining.daysLeft', 7)), 'le temps restant avant l echeance (7 jours) doit etre affiche dans la carte hero');
  __assertOk(!groupDetailHtml.includes(t('groups.inviteFriendsLabel')) && !groupDetailHtml.includes(tn('groups.membersLabel', groupDetailMembers.length)), 'la liste des membres/invitations ne doit plus etre affichee directement dans l ecran principal (releguee au bouton info)');
  __assertOk(groupDetailHtml.includes('onclick="openGroupInfoOverlay()"'), 'un bouton "⋯" doit permettre d ouvrir les infos du groupe (membres, invitations)');
  const groupInfoSheetHtml = renderGroupInfoSheet();
  __assertOk(groupInfoSheetHtml.includes('Bob M.') && groupInfoSheetHtml.includes('Moi A.'), 'le panneau info doit lister tous les membres du groupe');
  __assertOk(groupInfoSheetHtml.includes('Bea M.') && groupInfoSheetHtml.includes(t('groups.inviteBtn')), 'le panneau info doit proposer d inviter les amis pas encore membres du groupe');
  openGroupInfoOverlay();
  __assertOk(groupInfoOverlayOpen, 'openGroupInfoOverlay() doit marquer le panneau comme ouvert');
  closeGroupInfoOverlay();
  __assertOk(!groupInfoOverlayOpen, 'fermer le panneau info doit le marquer comme referme');
  console.log('OK: carte "hero" du defi actif (progression + temps restant en avant) + panneau info groupe accessoire derriere le bouton "⋯" (passe UX premium)');

  // Retour utilisateur : un bouton "Faire {{exercice}}" sur la carte hero doit
  // permettre de rejoindre directement la fiche d execution de l exercice cible du
  // defi de groupe, sans avoir a l activer soi-meme au prealable dans l onglet Défis
  // (friction reelle signalee : activer + changer d onglet + retrouver la carte).
  __assertOk(groupDetailHtml.includes('onclick="startGroupChallengeExercise(\\'' + pompes.slug + '\\')"'), 'la carte hero doit proposer un bouton qui cible directement l exercice du defi');
  __assertOk(groupDetailHtml.includes(escapeHtml(t('groups.doExerciseBtn', { exercise: t('exercises.' + pompes.slug + '.name') }))), 'le bouton doit nommer l exercice concerne, pas juste "Activer"');
  activeToday = new Set();
  currentChallengeId = null;
  activeTab = 'groups'; // reproduit le contexte reel du bug : le bouton est sur l ecran Groupes
  await startGroupChallengeExercise(pompes.slug);
  __assertOk(activeToday.has(pompes.id), 'startGroupChallengeExercise() doit activer l exercice s il ne l etait pas deja (jamais le desactiver si deja actif - toggleActiveToday() n est appelee QUE si absent)');
  __assertEq(currentChallengeId, pompes.id, 'startGroupChallengeExercise() doit naviguer directement vers la fiche de l exercice cible');
  // Bug reel signale : le bouton semblait juste "rafraichir" l ecran Groupes - car
  // render() teste activeTab AVANT currentChallengeId, donc rester sur 'groups' fait
  // ignorer completement currentChallengeId. activeTab doit basculer sur 'today'.
  __assertEq(activeTab, 'today', 'startGroupChallengeExercise() doit basculer sur l onglet Aujourd hui, sinon la fiche exercice ne s affiche jamais (render() reste sur l ecran Groupes)');
  console.log('OK: bouton "Faire {{exercice}}" sur la carte hero (active + navigue VRAIMENT vers la fiche, bug de render() sur le mauvais onglet corrige)');

  // Progression du defi de groupe affichee SOUS l objectif personnel du jour, sur la
  // fiche de l exercice lui-meme - evite l impression de 2 mondes separes ("je fais
  // des pompes ici, mais je ne suis meme pas sur que ca compte pour le defi").
  await new Promise(r => setTimeout(r, 20)); // laisse loadActiveExerciseGroupChallenges() (fire-and-forget) se resoudre
  __assertEq(activeExerciseGroupChallenges.length, 1, 'le defi de groupe actif sur ce meme exercice doit etre detecte automatiquement');
  __assertEq(activeExerciseGroupChallenges[0].groupName, 'Les Costauds');
  render(false);
  let exerciseScreenHtml = document.getElementById('app').innerHTML;
  __assertOk(exerciseScreenHtml.includes(t('exercise.linkedGroupChallenge', { group: 'Les Costauds' })), 'le nom du groupe doit etre affiche sous l objectif personnel');
  __assertOk(exerciseScreenHtml.includes('40 / 500'), 'la progression CUMULEE du defi de groupe (tous membres confondus) doit etre affichee, pas seulement ma propre contribution');
  console.log('OK: progression du defi de groupe affichee sous l objectif personnel sur la fiche de l exercice (activeExerciseGroupChallenges)');

  // Bug reel signale (retour utilisateur, "malus Boulet") : l ancienne mise a jour
  // "optimiste" (currentTotal + amount, sans jamais consulter le serveur) etait
  // mathematiquement FAUSSE des qu un handicap Boulet est en jeu - computeGroupTotalProgress()
  // plafonne le NET de chaque participant (totalAmount - handicap) a 0 avant de sommer,
  // donc une victime encore SOUS son handicap qui loggue des repetitions ne doit PAS
  // faire avancer le total affiche au meme rythme que le nombre brut tape. addSetInner()
  // resynchronise desormais TOUJOURS via une relecture Firestore fraiche et autoritative
  // (loadActiveExerciseGroupChallenges()) au lieu d une estimation locale.
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ handicap: 20 }, { merge: true }); // me-uid: totalAmount=10, handicap=20 -> net=-10 (plafonne a 0) ; bob-uid=30 -> total groupe = 30
  // Simule l effet serveur d une 1ere serie de +10 (mock logGroupChallengeContribution
  // n ecrit rien lui-meme, voir son commentaire dedie plus haut) : totalAmount 10->20,
  // net = 20-20 = 0, TOUJOURS plafonne - le total du groupe ne doit PAS bouger, meme si
  // 10 repetitions brutes viennent d etre tapees. C est exactement le symptome signale
  // ("un premier clic de +10 pompes n a pas ete comptabilise a l ecran") - desormais un
  // comportement CORRECT et STABLE (le malus n est pas encore compense), pas un bug
  // d affichage instable.
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ totalAmount: 20 }, { merge: true });
  await addSet(10);
  __assertEq(activeExerciseGroupChallenges[0].currentTotal, 30, 'tant que le malus Boulet n est pas compense, une serie loguee ne doit PAS faire avancer le total affiche du defi de groupe (30 = bob seul, me-uid reste plafonne a 0)');
  console.log('OK: la progression du defi de groupe affichee reste stable/correcte tant que le malus Boulet n est pas compense par une repetition reelle');

  // Le clic SUIVANT (+11) fait franchir le handicap : totalAmount 20->31, net = 31-20 = 11
  // (positif, plus jamais plafonne) - le total affiche doit desormais refleter cet exces
  // EXACTEMENT, sans aucune perte de donnees (bob=30 + me-uid=11 = 41).
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ totalAmount: 31 }, { merge: true });
  await addSet(11);
  __assertEq(activeExerciseGroupChallenges[0].currentTotal, 41, 'des que le malus Boulet est compense, la progression affichee doit immediatement refleter le nouvel exces net, sans aucune perte de donnees');
  console.log('OK: chaque repetition ajoutee est desormais recalculee de facon authoritative (relecture Firestore) et se met a jour immediatement, meme malus Boulet en jeu (bug reel corrige)');

  // Remet me-uid dans l etat neutre attendu par les tests suivants (Jokers tactiques,
  // Le Boulet) - ne PAS laisser ce handicap/totalAmount de test "fuiter" plus loin.
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ totalAmount: 10, handicap: 0 }, { merge: true });

  // Regression du bug reel signale en prod : un defi a 125/100 (objectif depasse)
  // restait affiche "actif" indefiniment sans aucune Ardoise/Palmares, car seule
  // l echeance declenchait le reglement cote Cloud Function. Cote client, un message
  // d attente doit desormais s afficher des que total >= target, meme avant l echeance
  // et meme si status est encore 'active' (le reglement reel arrive au prochain
  // passage de closeExpiredGroupChallenges, jusqu a 15 min plus tard).
  const originalTarget = groupDetailChallenge.targetTotal;
  groupDetailChallenge.targetTotal = 40; // total actuel (10 + 30) atteint tout juste la cible
  const targetReachedHtml = renderGroupDetailScreen();
  __assertOk(targetReachedHtml.includes(t('groups.targetReachedAwaitingSettlement')), 'un message d attente doit s afficher des que l objectif est atteint, meme si le defi est encore actif');
  __assertOk(targetReachedHtml.includes('confetti-piece'), 'une celebration (confettis) doit accompagner le message d objectif atteint (passe UX premium)');
  groupDetailChallenge.targetTotal = originalTarget;
  console.log('OK: message "objectif atteint, en attente du reglement" affiche des que total >= target, sans attendre l echeance');

  // cancelGroupChallenge() : le CREATEUR d'un defi encore actif peut l'annuler (ex :
  // mauvais parametrage, envie de retester un scenario sans attendre une echeance) -
  // seul lui voit le bouton, et un defi annule ne bloque plus jamais le groupe (le
  // defi actif le plus recent redevient le defi "relevant" affiche).
  const throwawayChallengeRef = db.collection('groups').doc(createdGroupId).collection('challenges').doc();
  await throwawayChallengeRef.set({
    name: 'Defi jetable', exerciseSlug: pompes.slug, startDate: dateKey(new Date()),
    endDate: Date.now() + 999999, targetTotal: 10, stakeMode: '5050', stakeDescription: '',
    createdBy: 'me-uid', createdAt: Date.now() + 1, status: 'active',
  });
  await loadGroupDetail(createdGroupId);
  __assertEq(groupDetailChallenge.challengeId, throwawayChallengeRef.id, 'le defi actif le plus recent doit devenir le defi affiche');
  __assertOk(renderGroupDetailScreen().includes(t('groups.cancelChallengeBtn')), 'le createur doit voir le bouton d annulation');

  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  await loadGroupDetail(createdGroupId);
  __assertOk(!renderGroupDetailScreen().includes(t('groups.cancelChallengeBtn')), 'un membre qui n est pas le createur ne doit jamais voir le bouton d annulation');

  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await cancelGroupChallenge(createdGroupId, throwawayChallengeRef.id);
  const cancelledDoc = await throwawayChallengeRef.get();
  __assertEq(cancelledDoc.data().status, 'cancelled', 'cancelGroupChallenge() doit marquer le defi cancelled');
  __assertEq(groupDetailChallenge.challengeId, groupChallengeId, 'apres annulation, le defi actif restant (le tout premier) doit redevenir celui affiche');
  console.log('OK: cancelGroupChallenge() (annulation par le createur uniquement, libere le groupe d un defi bloquant)');

  // Suppression d'un groupe (retour utilisateur) : reservee au createur (verifie
  // cote rendu ET cote appel), confirmation requise, delegue integralement a
  // deleteGroup() (Cloud Function - seule capable de nettoyer recursivement le
  // groupe ET l index myGroups des AUTRES membres, voir functions/index.js).
  const infoSheetAsCreator = renderGroupInfoSheet();
  __assertOk(infoSheetAsCreator.includes(t('groups.deleteGroupBtn')), 'le createur doit voir le bouton de suppression du groupe');

  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  await loadGroupDetail(createdGroupId);
  const infoSheetAsMember = renderGroupInfoSheet();
  __assertOk(!infoSheetAsMember.includes(t('groups.deleteGroupBtn')), 'un membre qui n est pas le createur ne doit jamais voir le bouton de suppression');

  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await loadGroupDetail(createdGroupId);
  const originalConfirmModalDelete = confirmModal;
  confirmModal = async () => true;
  await deleteGroupConfirm(createdGroupId, 'Les Costauds');
  confirmModal = originalConfirmModalDelete;
  __assertEq(__mockDeleteGroupCalls.length, 1, 'confirmer la suppression doit appeler la Cloud Function deleteGroup()');
  __assertEq(__mockDeleteGroupCalls[0].groupId, createdGroupId);
  __assertOk(!myGroups.some(g => g.groupId === createdGroupId), 'le groupe supprime ne doit plus apparaitre dans myGroups localement');
  __assertOk(!myActiveGroupChallenges.some(c => c.groupId === createdGroupId), 'le groupe supprime ne doit plus apparaitre dans myActiveGroupChallenges localement');
  console.log('OK: deleteGroup() (reserve au createur, confirmation requise, nettoyage local de myGroups/myActiveGroupChallenges)');

  // Jokers tactiques (Phase 4) : UN SEUL joker par participant et par defi
  // (Doublon/Boulet/Immunite Swiss), applique server-side via applyGroupJoker
  // (Cloud Function) - la logique de plafonnage/reglement elle-meme est deja
  // testee en isolation (rankForSettlement()/applyDoublonMultiplier(), voir
  // functions/test/groups.test.js). Cote client, on verifie que les 3 boutons sont
  // proposes tant qu aucun joker n a ete utilise, que l appel delegue bien a la
  // Cloud Function, et que chaque statut/badge s affiche correctement une fois
  // l effet simule par une ecriture directe (mock, pas d Admin SDK ici).
  let jokerHtml = renderGroupDetailScreen();
  __assertOk(jokerHtml.includes(t('groups.jokers.doublonBtn')) && jokerHtml.includes(t('groups.jokers.bouletBtn')) && jokerHtml.includes(t('groups.jokers.immuniteBtn')), 'les 3 jokers doivent etre proposes tant qu aucun n a ete utilise pour ce defi');
  __assertOk(jokerHtml.includes('joker-card doublon') && jokerHtml.includes('joker-card boulet') && jokerHtml.includes('joker-card immunite'), 'chaque joker doit avoir sa propre identite visuelle (passe UX premium)');

  const originalConfirmModalJoker = confirmModal;
  confirmModal = async () => true;
  await applyGroupJokerConfirm(createdGroupId, groupChallengeId, 'doublon');
  confirmModal = originalConfirmModalJoker;
  __assertEq(__mockApplyGroupJokerCalls.length, 1, 'utiliser Le Doublon doit appeler applyGroupJoker');
  __assertEq(__mockApplyGroupJokerCalls[0].jokerType, 'doublon');
  // Simule l effet serveur (le mock ne fait qu enregistrer l appel, voir plus haut).
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ jokerUsed: 'doublon', doublonActiveUntil: Date.now() + 2 * 3600 * 1000 }, { merge: true });
  await loadGroupDetail(createdGroupId);
  jokerHtml = renderGroupDetailScreen();
  __assertOk(!jokerHtml.includes(t('groups.jokers.doublonBtn')), 'une fois Le Doublon utilise, les boutons de jokers doivent disparaitre (un seul par defi)');
  __assertOk(jokerHtml.includes('⏫'), 'le statut du Doublon actif doit s afficher');
  __assertOk(jokerHtml.includes('joker-card doublon'), 'le statut du Doublon doit garder son identite visuelle (carte bleue electrique)');
  console.log('OK: Jokers tactiques - Le Doublon (un seul par defi, delegue a applyGroupJoker, statut affiche une fois actif)');

  // Le Boulet : necessite de cibler un adversaire (picker), jamais soi-meme.
  currentUser = { uid: 'bob-uid', displayName: 'Bob Martin', email: 'b@test.com', photoURL: '' };
  await loadGroupDetail(createdGroupId);
  startBouletTargeting();
  let bouletHtml = renderGroupDetailScreen();
  __assertOk(bouletHtml.includes(t('groups.jokers.pickTargetLabel')) && bouletHtml.includes('Moi A.'), 'le picker du Boulet doit lister les AUTRES participants (jamais moi-meme)');
  confirmModal = async () => true;
  await applyBouletOnTarget(createdGroupId, groupChallengeId, 'me-uid', 'Moi A.');
  confirmModal = originalConfirmModalJoker;
  __assertEq(__mockApplyGroupJokerCalls.length, 2, 'lancer Le Boulet doit appeler applyGroupJoker');
  __assertEq(__mockApplyGroupJokerCalls[1].jokerType, 'boulet');
  __assertEq(__mockApplyGroupJokerCalls[1].targetUid, 'me-uid');
  __assertOk(!pickingBouletTarget, 'applyGroupJoker() doit refermer le picker apres l appel');
  // Simule l effet serveur : Bob a utilise son joker (boulet), Moi recoit le handicap.
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('bob-uid')
    .set({ jokerUsed: 'boulet', jokerTargetUid: 'me-uid' }, { merge: true });
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ handicap: 20 }, { merge: true });
  await loadGroupDetail(createdGroupId);
  bouletHtml = renderGroupDetailScreen();
  __assertOk(bouletHtml.includes(t('groups.jokers.bouletLaunchedStatus', { name: 'Moi A.' })), 'le statut du Boulet doit nommer la cible');
  __assertOk(bouletHtml.includes(t('groups.jokers.handicapBadge', { amount: 20 })), 'le handicap doit etre affiche en badge sur la ligne de la cible');
  console.log('OK: Jokers tactiques - Le Boulet (picker de cible, handicap applique et affiche)');

  // Bug reel signale (2e ronde) : le compteur/pourcentage global de la carte hero
  // (tout en haut de l ecran) sommait encore le totalAmount BRUT de chaque
  // participant, au lieu de la valeur NETTE (deja utilisee par le classement juste
  // en dessous depuis le correctif precedent) - desynchronisant visuellement le haut
  // de la carte du classement qui la suit immediatement.
  const netUnflooredHeroTotal = groupDetailChallenge.participants.reduce((s, p) => s + computeGroupParticipantDisplayAmount(p), 0);
  const rawHeroTotal = groupDetailChallenge.participants.reduce((s, p) => s + (p.totalAmount || 0), 0);
  __assertOk(netUnflooredHeroTotal !== rawHeroTotal, 'ce scenario (handicap actif) doit avoir un total net different du total brut, sinon le test ne prouve rien');

  // Bug reel signale (3e ronde) : la ou le classement individuel PEUT (a raison)
  // afficher une valeur nette negative pour la victime du Boulet, le total
  // COLLECTIF du groupe, lui, devenait aussi negatif des que personne d autre ne
  // compensait suffisamment - absurde pour un objectif partage. Chaque
  // contribution individuelle nette doit desormais etre plafonnee a 0 AVANT
  // d etre sommee (computeGroupTotalProgress()). Fixtures ISOLEES (pas l etat
  // accumule du scenario Boulet ci-dessus, ou Bob a deja 30 grace a un test
  // precedent - le total NET y reste positif malgre le malus de Moi, ce qui ne
  // prouverait rien ici) :
  const soloMalusFixture = [{ totalAmount: 10, handicap: 20 }]; // net = -10
  __assertEq(soloMalusFixture.reduce((s, p) => s + computeGroupParticipantDisplayAmount(p), 0), -10, 'sanity check de la fixture isolee : le net non plafonne doit bien etre negatif');
  __assertEq(computeGroupTotalProgress(soloMalusFixture), 0, 'le total du groupe ne doit jamais devenir negatif a cause du malus d une seule personne - il reste bloque a 0 tant que ce malus n est pas compense');
  const mixedMalusFixture = [{ totalAmount: 10, handicap: 20 }, { totalAmount: 15, handicap: 0 }]; // -10 (plafonne a 0) + 15
  __assertEq(computeGroupTotalProgress(mixedMalusFixture), 15, 'le malus d une personne ne doit jamais faire baisser la contribution des AUTRES membres (contribution individuelle plafonnee a 0, jamais un total global "compense" en negatif)');
  // Verifie aussi que la carte hero REELLEMENT affichee suit bien cette formule
  // (pas seulement la fonction pure isolee) - valeur attendue calculee
  // dynamiquement depuis l etat courant, jamais supposee a l avance.
  const expectedHeroTotal = computeGroupTotalProgress(groupDetailChallenge.participants);
  __assertOk(bouletHtml.includes(t('groups.challengeProgress', { current: expectedHeroTotal, target: groupDetailChallenge.targetTotal })), 'le compteur global de la carte hero affiche doit correspondre exactement a computeGroupTotalProgress()');
  console.log('OK: le total du groupe ne devient jamais negatif a cause d un malus Boulet non compense (reste bloque a 0, sans jamais penaliser les autres membres)');

  // Bug reel signale en prod : le nombre affiche pour la victime du Boulet restait
  // le totalAmount BRUT (10 repetitions reellement faites), sans jamais refleter
  // visuellement le handicap deja inflige (-20) - laissant croire a tort que la
  // victime "gagne" alors qu elle est tres loin derriere une fois le reglement
  // applique. Corrige : le nombre affiche ET le classement EN DIRECT (pas
  // seulement le bilan apres coup) doivent refleter la valeur NETTE.
  __assertEq(computeGroupParticipantDisplayAmount({ totalAmount: 10, handicap: 20 }), -10, 'la valeur nette (repetitions - handicap) doit pouvoir etre negative, comme rankForSettlement() cote Cloud Function');
  __assertOk(bouletHtml.includes('leaderboard-value">-10<'), 'le nombre affiche sur la ligne de la victime doit deja etre net du handicap (-10), jamais le total brut de repetitions (10)');
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('bob-uid')
    .set({ uid: 'bob-uid', displayName: 'Bob Martin', totalAmount: 0 }, { merge: true });
  await loadGroupDetail(createdGroupId);
  __assertEq(groupDetailChallenge.participants[0].uid, 'bob-uid', 'Bob (0 repetition, aucun handicap = 0 net) doit desormais devancer la victime du Boulet (10 repetitions mais -20 = -10 net) dans le classement EN DIRECT, pas seulement au reglement final');
  console.log('OK: le classement en direct et le nombre affiche refletent desormais le handicap du Boulet (bug reel corrige)');

  // Une fois le malus COMPENSE par ses propres repetitions (net redevenu positif),
  // le total du groupe doit recommencer a grimper normalement - exactement le
  // comportement decrit par l utilisateur ("des que Bob fait sa 21eme pompe").
  // Etat actuel : bob-uid=0 (aucun handicap), me-uid=10 avec handicap=20 (net=-10).
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('me-uid')
    .set({ totalAmount: 21 }, { merge: true }); // net = 21 - 20 = 1 (positif)
  await loadGroupDetail(createdGroupId);
  const recoveredHtml = renderGroupDetailScreen();
  const recoveredTotal = computeGroupTotalProgress(groupDetailChallenge.participants);
  __assertEq(recoveredTotal, 1, 'une fois le malus compense (net positif), le total du groupe doit refleter exactement ce depassement (21 - 20 = 1, bob-uid contribuant 0), pas plafonne a 0');
  __assertOk(recoveredHtml.includes(t('groups.challengeProgress', { current: recoveredTotal, target: groupDetailChallenge.targetTotal })), 'le total du groupe doit recommencer a grimper des que le malus est compense');
  console.log('OK: le total du groupe recommence a grimper des que la personne penalisee compense son propre malus par ses propres repetitions');

  // Regression d un bug reel signale en prod : "je clique sur Le Boulet, rien ne se
  // passe" - en realite le picker s ouvrait bien mais restait VIDE des que
  // l adversaire vise n avait pas encore de doc participant pour CE defi (n avait
  // jamais ouvert le groupe ni contribue - voir ensureMyParticipantDoc()). Corrige
  // en listant N IMPORTE QUEL MEMBRE DU GROUPE (groupDetailMembers), pas seulement
  // les participants du defi.
  await db.collection('groups').doc(createdGroupId).collection('members').doc('dave-uid').set({
    uid: 'dave-uid', displayName: 'Dave D.', photoURL: '', joinedAt: Date.now(), role: 'member',
  });
  await loadGroupDetail(createdGroupId);
  const daveParticipantDoc = await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).collection('participants').doc('dave-uid').get();
  __assertOk(!daveParticipantDoc.exists, 'Dave ne doit PAS avoir de doc participant (n a jamais ouvert ce defi ni contribue)');
  pickingBouletTarget = true;
  const pickerWithDaveHtml = renderGroupDetailScreen();
  __assertOk(pickerWithDaveHtml.includes('Dave D.'), 'un membre du groupe SANS doc participant doit quand meme apparaitre comme cible possible du Boulet');
  pickingBouletTarget = false;
  console.log('OK: le picker du Boulet liste TOUS les membres du groupe, meme ceux sans doc participant pour ce defi');

  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };

  // Bilan (simule ici : le reglement REEL est calcule par closeExpiredGroupChallenges,
  // une Cloud Function server-only - voir functions/test/groups.test.js pour
  // computeSettlementPairs()). On simule juste l etat "regle" pour tester le rendu et
  // le bouton "Gage honore !".
  await db.collection('groups').doc(createdGroupId).collection('challenges').doc(groupChallengeId).set({ status: 'settled', settledAt: Date.now() }, { merge: true });
  const ledgerEntryId = groupChallengeId + '_me-uid_bob-uid';
  await db.collection('groups').doc(createdGroupId).collection('ledger').doc(ledgerEntryId).set({
    challengeId: groupChallengeId, fromUid: 'me-uid', toUid: 'bob-uid',
    stakeDescription: 'Offre une biere', createdAt: Date.now(), honoredAt: null, honoredBy: null,
  });
  await loadGroupDetail(createdGroupId);
  __assertEq(groupDetailChallenge.status, 'settled');
  __assertEq(groupDetailLedger.length, 1, 'l entree ledger du defi regle doit etre chargee');
  const bilanHtml = renderGroupDetailScreen();
  __assertOk(bilanHtml.includes('Offre une biere'), 'le gage doit etre affiche dans le bilan');
  __assertOk(bilanHtml.includes(t('groups.honorBtn')), 'le bouton "Gage honore !" doit etre propose tant que non honore');

  await honorLedgerEntries(createdGroupId, [ledgerEntryId]);
  const honoredDoc = await db.collection('groups').doc(createdGroupId).collection('ledger').doc(ledgerEntryId).get();
  __assertOk(honoredDoc.data().honoredAt, 'honorLedgerEntries() doit marquer honoredAt');
  __assertEq(honoredDoc.data().honoredBy, 'me-uid', 'honoredBy doit etre celui qui declare le gage honore');
  console.log('OK: bilan (classement + % implicite, "qui doit quoi a qui", bouton Gage honore!)');

  // Invitation d'un ami via le canal de notifications existant (comme les demandes
  // d ami) - acceptee via processUnreadNotifications()/confirmModal().
  myFriends = [{ uid: 'chloe-uid', displayName: 'Chloe D.', photoURL: '' }];
  await inviteFriendToGroup(createdGroupId, 'Les Costauds', 'chloe-uid');
  const inviteNotifSnap = await notificationsCollRef('chloe-uid').where('read', '==', false).get();
  __assertEq(inviteNotifSnap.size, 1, 'une notification group_invite doit etre creee pour Chloe');
  __assertEq(inviteNotifSnap.docs[0].data().type, 'group_invite');

  currentUser = { uid: 'chloe-uid', displayName: 'Chloe D.', email: 'c@test.com', photoURL: '' };
  const originalConfirmModalGroups = confirmModal;
  confirmModal = async () => true; // simule l acceptation de l invitation
  await processUnreadNotifications(inviteNotifSnap);
  confirmModal = originalConfirmModalGroups;
  const chloeMemberDoc = await db.collection('groups').doc(createdGroupId).collection('members').doc('chloe-uid').get();
  __assertOk(chloeMemberDoc.exists, 'accepter l invitation depuis la notification doit ajouter Chloe comme membre');
  // Retour utilisateur (Priorite 2, centralisation) : une fois acceptee depuis CETTE
  // popup in-app, la notification group_invite ne doit plus jamais reapparaitre comme
  // "en attente" dans l ecran Amis (voir processUnreadNotifications()).
  const inviteNotifAfterAccept = await notificationsCollRef('chloe-uid').where('type', '==', 'group_invite').get();
  __assertEq(inviteNotifAfterAccept.size, 0, 'la notification group_invite doit etre supprimee une fois acceptee depuis la popup, sinon elle resterait indument "en attente"');
  console.log('OK: invitation a un groupe via le canal de notifications existant (accept -> joinGroupById())');

  // --- Priorite 2 (retour utilisateur) : centraliser les invitations de groupe en
  // attente dans l ecran Amis, meme fiabilite que les demandes d ami - reliees a la
  // notification group_invite elle-meme (son EXISTENCE fait foi), pas a un mecanisme
  // separe. ---
  myFriends = [{ uid: 'dan-uid', displayName: 'Dan L.', photoURL: '' }];
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await inviteFriendToGroup(createdGroupId, 'Les Costauds', 'dan-uid');

  // Cote Dan : sur "Plus tard" (refus de la popup in-app), la notification ne doit
  // PAS etre supprimee - c est exactement ce qui doit la laisser visible dans la
  // liste centralisee pour un traitement ulterieur (bug reel signale : avant meme
  // cette liste, une invitation "Plus tard" tombait dans un trou noir).
  currentUser = { uid: 'dan-uid', displayName: 'Dan L.', email: 'd@test.com', photoURL: '' };
  const danInviteSnap = await notificationsCollRef('dan-uid').where('read', '==', false).get();
  __assertEq(danInviteSnap.size, 1, 'une notification group_invite doit etre creee pour Dan');
  confirmModal = async () => false; // "Plus tard"
  await processUnreadNotifications(danInviteSnap);
  confirmModal = originalConfirmModalGroups;
  const danMemberDocAfterLater = await db.collection('groups').doc(createdGroupId).collection('members').doc('dan-uid').get();
  __assertOk(!danMemberDocAfterLater.exists, '"Plus tard" ne doit jamais rejoindre le groupe');
  const danInviteAfterLater = await notificationsCollRef('dan-uid').where('type', '==', 'group_invite').get();
  __assertEq(danInviteAfterLater.size, 1, '"Plus tard" ne doit PAS supprimer la notification - elle doit rester "en attente" pour la liste centralisee');

  // La liste centralisee doit desormais la retrouver, meme sans avoir traite/vu la
  // popup une seconde fois - meme fiabilite que refreshFriendsData()/incomingFriendRequests.
  incomingGroupInvites = [];
  await refreshPendingGroupInvites();
  __assertEq(incomingGroupInvites.length, 1, 'refreshPendingGroupInvites() doit retrouver l invitation laissee "en attente"');
  __assertEq(incomingGroupInvites[0].groupName, 'Les Costauds');
  __assertEq(incomingGroupInvites[0].fromName, 'Moi A.', 'fromName doit deja etre le nom anonymise (formatDisplayName, applique a l ecriture par inviteFriendToGroup()), jamais le nom complet');
  const friendsScreenWithInviteHtml = renderFriendsScreen();
  __assertOk(friendsScreenWithInviteHtml.includes(t('friends.groupInvitesLabel')), 'le titre de section "Invitations de groupe" doit etre affiche');
  __assertOk(friendsScreenWithInviteHtml.includes('Les Costauds'), 'chaque ligne doit afficher EXPLICITEMENT le nom du groupe concerne');
  __assertOk(friendsScreenWithInviteHtml.includes(t('groups.joinBtn')), 'un bouton d action clair ("Rejoindre") doit etre propose');

  // Accepter depuis CETTE liste centralisee : rejoint reellement le groupe ET
  // supprime la notification (ne doit plus jamais reapparaitre).
  await acceptGroupInviteFromList(danInviteAfterLater.docs[0].id, createdGroupId);
  const danMemberDocAfterAccept = await db.collection('groups').doc(createdGroupId).collection('members').doc('dan-uid').get();
  __assertOk(danMemberDocAfterAccept.exists, 'acceptGroupInviteFromList() doit reellement rejoindre le groupe (joinGroupById())');
  __assertEq(incomingGroupInvites.length, 0, 'l invitation acceptee doit disparaitre immediatement de la liste locale');
  const danInviteAfterListAccept = await notificationsCollRef('dan-uid').where('type', '==', 'group_invite').get();
  __assertEq(danInviteAfterListAccept.size, 0, 'la notification doit etre supprimee une fois acceptee depuis la liste centralisee');

  // Refus explicite (Refuser) : ne rejoint jamais, supprime seulement la notification -
  // section masquee de nouveau des qu il n y a plus aucune invitation en attente.
  await inviteFriendToGroup(createdGroupId, 'Les Costauds', 'dan-uid');
  incomingGroupInvites = [];
  await refreshPendingGroupInvites();
  __assertEq(incomingGroupInvites.length, 1, 'une 2e invitation doit de nouveau etre retrouvee');
  await declineGroupInviteFromList(incomingGroupInvites[0].id);
  const danMemberDocAfterDecline = await db.collection('groups').doc(createdGroupId).collection('members').doc('dan-uid').get();
  __assertOk(danMemberDocAfterDecline.exists, 'refuser ne doit jamais retirer une adhesion DEJA existante (celle du scenario precedent) - juste ne pas en creer une nouvelle');
  __assertEq(incomingGroupInvites.length, 0, 'refuser doit retirer l invitation de la liste locale');
  __assertOk(!renderFriendsScreen().includes(t('friends.groupInvitesLabel')), 'la section doit redevenir masquee des qu il n y a plus aucune invitation en attente');
  console.log('OK: invitations de groupe centralisees dans l ecran Amis (Rejoindre/Refuser, fiable meme si la popup in-app a ete manquee/refusee)');

  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  incomingGroupInvites = [];

  // Navigation : goBackOneLevel() ferme le plus imbrique en premier (formulaire de
  // defi avant le detail du groupe), meme discipline que le reste de l app.
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  activeTab = 'groups';
  openGroupId = createdGroupId;
  creatingGroupChallenge = true;
  goBackOneLevel();
  __assertOk(!creatingGroupChallenge, 'goBackOneLevel() doit fermer le formulaire de defi en premier (le plus imbrique)');
  __assertEq(openGroupId, createdGroupId, 'le detail du groupe doit rester ouvert apres avoir juste ferme le formulaire');
  goBackOneLevel();
  __assertEq(openGroupId, null, 'un 2e goBackOneLevel() doit fermer le detail du groupe');

  openGroupId = createdGroupId;
  switchTab('groups'); // onglet deja actif -> doit reinitialiser sa pile de navigation
  __assertEq(openGroupId, null, 'cliquer sur l onglet Groupes deja actif doit fermer le detail ouvert et revenir a la racine');
  activeTab = 'today';
  console.log('OK: navigation Groupes (goBackOneLevel() ferme le plus imbrique en premier, clic sur l onglet deja actif reinitialise)');

  // --- 172. Phase 3 : Ardoise Globale + Hall of Fame. Les ROLLUPS eux-memes
  // (debtsOwed/totalVolume/challengesParticipated/clutchWins) sont maintenus par
  // closeExpiredGroupChallenges(), une Cloud Function server-only (voir
  // functions/test/groups.test.js pour detectClutchWin()) - ici on teste uniquement
  // le calcul PUR des titres et le rendu client a partir de rollups simules. ---
  const hofMembers = [
    { uid: 'a', displayName: 'Alice', debtsOwed: 3, totalVolume: 500, challengesParticipated: 2, clutchWins: 1 },
    { uid: 'b', displayName: 'Bob', debtsOwed: 1, totalVolume: 900, challengesParticipated: 4, clutchWins: 0 },
    { uid: 'c', displayName: 'Chloe', debtsOwed: 0, totalVolume: 50, challengesParticipated: 1, clutchWins: 0 },
  ];
  const hofTitles = computeGroupHallOfFameTitles(hofMembers);
  const titleFor = (id) => hofTitles.find(t => t.id === id);
  __assertEq(titleFor('mecene').member.uid, 'a', 'Le Mecene doit etre celui avec le plus de debtsOwed (Alice, 3)');
  __assertEq(titleFor('roiDesRepets').member.uid, 'b', 'Le Roi des Repets doit etre celui avec le plus de totalVolume (Bob, 900)');
  __assertEq(titleFor('clutchPlayer').member.uid, 'a', 'Le Clutch Player doit etre celui avec le plus de clutchWins (Alice, 1)');
  __assertEq(titleFor('fantome').member.uid, 'c', 'Le Fantome doit etre celui avec le moins de totalVolume PARMI CEUX AYANT PARTICIPE (Chloe, 50)');
  __assertEq(titleFor('metronome').member.uid, 'b', 'Le Metronome doit etre celui avec le plus de challengesParticipated (Bob, 4)');
  __assertEq(computeGroupHallOfFameTitles([]).length, 0, 'aucun membre -> aucun titre');
  __assertEq(computeGroupHallOfFameTitles([{ uid: 'z', displayName: 'Z' }]).length, 0, 'un membre sans aucune statistique positive -> aucun titre attribue');
  console.log('OK: computeGroupHallOfFameTitles() (5 titres, chacun sur sa propre statistique, aucun titre si personne n a de stat positive)');

  // Rendu Hall of Fame : simule des rollups deja ecrits par closeExpiredGroupChallenges()
  // directement sur les docs membres, verifie juste le RENDU cote client (zero
  // lecture supplementaire - deja dans groupDetailMembers).
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await db.collection('groups').doc(createdGroupId).collection('members').doc('me-uid').set({ debtsOwed: 2, totalVolume: 10, challengesParticipated: 1, clutchWins: 1 }, { merge: true });
  await db.collection('groups').doc(createdGroupId).collection('members').doc('bob-uid').set({ debtsOwed: 0, totalVolume: 300, challengesParticipated: 1, clutchWins: 0 }, { merge: true });
  await loadGroupDetail(createdGroupId);
  switchGroupDetailView('hallOfFame');
  __assertEq(groupDetailView, 'hallOfFame');
  const hallOfFameHtml = renderGroupDetailScreen();
  __assertOk(hallOfFameHtml.includes(t('groups.hallOfFameTitles.mecene')) && hallOfFameHtml.includes('Moi'), 'Le Mecene (Moi, 2 dettes) doit apparaitre dans le palmares');
  __assertOk(hallOfFameHtml.includes(t('groups.hallOfFameTitles.roiDesRepets')) && hallOfFameHtml.includes('Bob'), 'Le Roi des Repets (Bob, 300 de volume) doit apparaitre');
  __assertOk(hallOfFameHtml.includes('groups-subtab-content'), 'le contenu du sous-onglet doit etre encapsule pour l animation de transition (passe UX premium)');
  __assertOk(hallOfFameHtml.includes("showGroupHallOfFameTitleModal('mecene'"), 'chaque ligne du palmares doit etre cliquable et ouvrir sa propre modal d explication');
  console.log('OK: rendu Hall of Fame (sous-onglet Palmares, zero lecture supplementaire - deja dans le roster charge)');

  // Retour utilisateur : chaque titre du Palmares doit expliquer concretement ce qu il
  // represente (ex: "Metronome", pas evident au premier coup d oeil) - reutilise le meme
  // moteur de popup que showTrophyDetailModal() (trophees individuels).
  popupQueue = []; popupOpen = false;
  showGroupHallOfFameTitleModal('metronome', '⏱️', 'Bob Martin');
  __assertOk(popupOpen, 'cliquer un titre du palmares doit ouvrir la modal d explication');
  __assertOk(currentPopupHtml.includes(t('groups.hallOfFameTitles.metronome')), 'la modal doit afficher le nom du titre');
  __assertOk(currentPopupHtml.includes('Bob Martin'), 'la modal doit afficher le nom du membre titulaire');
  __assertOk(currentPopupHtml.includes(t('groups.hallOfFameExplain.metronome')), 'la modal doit expliquer concretement ce que represente le titre');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: showGroupHallOfFameTitleModal() (popup d explication par titre du palmares)');

  // Etat vide "premium" (passe UX premium) : verifie via le Palmares (aucun membre
  // n a de statistique positive) que le composant partage renderGroupsEmptyState()
  // est bien utilise (icone + texte), pas le simple texte .history-empty d avant.
  const membersBeforeEmptyCheck = groupDetailMembers;
  groupDetailMembers = [];
  const emptyHallOfFameHtml = renderGroupDetailScreen();
  __assertOk(emptyHallOfFameHtml.includes('groups-empty-state') && emptyHallOfFameHtml.includes('groups-empty-icon') && emptyHallOfFameHtml.includes(t('groups.hallOfFameEmpty')), 'l etat vide du Palmares doit utiliser le composant premium (icone + texte)');
  groupDetailMembers = membersBeforeEmptyCheck;
  console.log('OK: etats vides de Groupes utilisent le composant premium renderGroupsEmptyState() (icone + texte + CTA optionnel)');

  // Ardoise Globale : historique COMPLET du groupe, tous defis confondus
  // (contrairement au bilan, scope a un seul defi) - seed une 2e entree ledger d un
  // defi DIFFERENT de celui deja regle plus haut.
  const anotherLedgerEntryId = 'autre-defi_bob-uid_me-uid';
  await db.collection('groups').doc(createdGroupId).collection('ledger').doc(anotherLedgerEntryId).set({
    challengeId: 'autre-defi', fromUid: 'bob-uid', toUid: 'me-uid',
    stakeDescription: 'Fait la vaisselle', createdAt: Date.now() - 100000, honoredAt: null, honoredBy: null,
  });
  await loadGroupDetail(createdGroupId);
  __assertOk(groupDetailLedgerHistory.length >= 2, 'l Ardoise Globale doit contenir les entrees de PLUSIEURS defis, pas seulement le dernier');
  switchGroupDetailView('ledger');
  const ledgerHistoryHtml = renderGroupDetailScreen();
  __assertOk(ledgerHistoryHtml.includes('Fait la vaisselle') && ledgerHistoryHtml.includes('Offre une biere'), 'l Ardoise doit afficher les gages de TOUS les defis passes, pas juste le dernier');
  console.log('OK: Ardoise Globale (historique complet des gages, tous defis confondus, 1 seul champ trie - aucun index composite)');

  // Resume des soldes (passe UX premium, idee #3 - inspire de Splitwise) : liste en
  // tete de l Ardoise Globale, exclut les gages DEJA HONORES (ici "Offre une biere",
  // honore plus haut dans ce scenario), ne montre que ce qui reste EN ATTENTE (ici
  // "Fait la vaisselle").
  __assertOk(ledgerHistoryHtml.includes(t('groups.balancesTitle')), 'l Ardoise Globale doit afficher un resume des soldes en tete');
  const balancesSummaryHtml = renderGroupBalancesSummary(groupDetailLedgerHistory);
  __assertOk(balancesSummaryHtml.includes('Fait la vaisselle'), 'le resume des soldes doit lister le gage encore en attente');
  __assertOk(!balancesSummaryHtml.includes('Offre une biere'), 'le resume des soldes ne doit PAS lister un gage deja honore (deja regle, plus une dette reelle)');
  console.log('OK: resume des soldes en tete de l Ardoise Globale (gages honores exclus, seul ce qui reste en attente est affiche)');

  // Regroupement/somme des gages structures identiques ("beer", Phase suivante) :
  // 2 gages "biere" distincts (2 defis differents) entre les 2 MEMES personnes
  // doivent s afficher comme une seule ligne "2 bieres" (pluralise via tn()), pas 2
  // lignes separees - c est exactement le probleme de fragmentation de texte libre
  // que stakeType structure resout.
  await db.collection('groups').doc(createdGroupId).collection('ledger').doc('defi-biere-1_me-uid_bob-uid').set({
    challengeId: 'defi-biere-1', fromUid: 'me-uid', toUid: 'bob-uid',
    stakeType: 'beer', stakeDescription: '', createdAt: Date.now() - 50000, honoredAt: null, honoredBy: null,
  });
  await db.collection('groups').doc(createdGroupId).collection('ledger').doc('defi-biere-2_me-uid_bob-uid').set({
    challengeId: 'defi-biere-2', fromUid: 'me-uid', toUid: 'bob-uid',
    stakeType: 'beer', stakeDescription: '', createdAt: Date.now() - 10000, honoredAt: null, honoredBy: null,
  });
  await loadGroupDetail(createdGroupId);
  const groupedLedger = groupLedgerEntriesForDisplay(groupDetailLedgerHistory);
  const beerGroup = groupedLedger.find(g => g.stakeType === 'beer' && g.fromUid === 'me-uid' && g.toUid === 'bob-uid');
  __assertOk(beerGroup && beerGroup.count === 2, 'les 2 gages "biere" identiques (meme paire, meme statut) doivent etre regroupes en une seule entree avec un compteur de 2');
  switchGroupDetailView('ledger');
  const aggregatedHtml = renderGroupDetailScreen();
  __assertOk(aggregatedHtml.includes(tn('groups.stakeTypes.beerLabel', 2)), 'l Ardoise doit afficher "2 bieres" (pluralise), pas 2 lignes separees');
  __assertOk(!aggregatedHtml.includes(tn('groups.stakeTypes.beerLabel', 1)), 'ne doit jamais afficher "1 biere" en plus du total agrege');
  // Retour utilisateur : le nom du gage doit etre integre DANS la phrase ("doit
  // 2 bieres a"), pas affiche sur une ligne separee en dessous comme avant -
  // rank-bar-hint (l ancienne ligne isolee) ne doit plus jamais apparaitre sur
  // cet ecran (Ardoise), la seule autre chose qui l utilise (par-personne, mode
  // infini) vit sur l onglet "Defi", pas "Ardoise".
  __assertOk(aggregatedHtml.includes('doit ' + tn('groups.stakeTypes.beerLabel', 2) + ' à'), 'le libelle du gage doit etre integre directement dans la phrase ("doit 2 bieres a"), pas isole en dessous');
  __assertOk(!aggregatedHtml.includes('rank-bar-hint'), 'l ancienne ligne isolee sous chaque gage (rank-bar-hint) ne doit plus jamais apparaitre dans l Ardoise');

  // honorLedgerEntries() honore les 2 gages agreges EN UN SEUL geste (1 clic honore
  // tout le "paquet" de bieres identiques).
  await honorLedgerEntries(createdGroupId, beerGroup.entryIds);
  const honoredBeer1 = await db.collection('groups').doc(createdGroupId).collection('ledger').doc('defi-biere-1_me-uid_bob-uid').get();
  const honoredBeer2 = await db.collection('groups').doc(createdGroupId).collection('ledger').doc('defi-biere-2_me-uid_bob-uid').get();
  __assertOk(honoredBeer1.data().honoredAt && honoredBeer2.data().honoredAt, 'honorer une ligne agregee doit honorer TOUTES les entrees du groupe en un seul batch');
  console.log('OK: les gages structures "beer" identiques (meme paire, meme statut) sont regroupes/sommes dans l Ardoise ("2 bieres" au lieu de 2 lignes), honores en un seul geste');

  // computeGroupNetBalances() (pur) : nette les gages EN ATTENTE d'UNE MEME paire
  // ET d'UN MEME type de gage exact dans les 2 sens - jamais 2 types differents
  // entre eux (pas fongible, contrairement a de l argent chez Splitwise), et
  // ignore totalement les gages deja honores.
  const netFixture = [
    { fromUid: 'a', toUid: 'b', stakeType: 'beer', stakeDescription: '', honoredAt: null },
    { fromUid: 'a', toUid: 'b', stakeType: 'beer', stakeDescription: '', honoredAt: null },
    { fromUid: 'a', toUid: 'b', stakeType: 'beer', stakeDescription: '', honoredAt: null },
    { fromUid: 'b', toUid: 'a', stakeType: 'beer', stakeDescription: '', honoredAt: null },
    { fromUid: 'a', toUid: 'b', stakeType: 'custom', stakeDescription: 'Vaisselle', honoredAt: null },
    { fromUid: 'a', toUid: 'b', stakeType: 'custom', stakeDescription: 'Autre chose', honoredAt: Date.now() },
  ];
  const netBalances = computeGroupNetBalances(netFixture);
  __assertEq(netBalances.length, 2, 'les gages de types/descriptions differents ne doivent jamais se compenser entre eux, et les gages deja honores doivent etre ignores');
  const beerNet = netBalances.find((b) => b.stakeType === 'beer');
  __assertOk(beerNet && beerNet.fromUid === 'a' && beerNet.toUid === 'b' && beerNet.count === 2, '3 bieres dues par a a b, moins 1 due par b a a, doit netter a "a doit 2 bieres a b"');
  const customNet = netBalances.find((b) => b.stakeType === 'custom');
  __assertOk(customNet && customNet.fromUid === 'a' && customNet.toUid === 'b' && customNet.count === 1 && customNet.stakeDescription === 'Vaisselle', 'le gage personnalise non honore doit apparaitre tel quel (le gage honore "Autre chose" doit etre exclu)');
  __assertEq(computeGroupNetBalances([{ fromUid: 'a', toUid: 'b', stakeType: 'beer', stakeDescription: '', honoredAt: null }, { fromUid: 'b', toUid: 'a', stakeType: 'beer', stakeDescription: '', honoredAt: null }]).length, 0, 'un gage identique dans les 2 sens doit netter a zero (personne ne doit plus rien) et disparaitre du resume');
  __assertEq(computeGroupNetBalances([]).length, 0, 'aucune entree -> aucun solde');
  console.log('OK: computeGroupNetBalances() (nettage par paire+type de gage EXACT, gages honores exclus, jamais de compensation entre types differents)');

  // Etat "tout le monde est quitte" (passe UX premium) : composant premium
  // (icone + texte), pas un simple texte generique.
  const settledBalancesHtml = renderGroupBalancesSummary([]);
  __assertOk(settledBalancesHtml.includes('groups-empty-state') && settledBalancesHtml.includes(t('groups.allSettled')), 'aucun solde en attente doit afficher un etat "tout le monde est quitte" premium, pas une liste vide');
  console.log('OK: etat "tout le monde est quitte" du resume des soldes (composant premium reutilise)');

  // Historique horodate des contributions (alimente detectClutchWin() cote Cloud
  // Function) : desormais ecrit UNIQUEMENT server-side, dans la meme transaction que
  // le plafonnage (logGroupChallengeContribution, non executable ici sans emulateur
  // Firestore - voir functions/test/groups.test.js). Cote client, on verifie
  // seulement que chaque contribution delegue bien un appel de plus a la fonction.
  myActiveGroupChallenges = [{ groupId: createdGroupId, challengeId: groupChallengeId, exerciseSlug: pompes.slug, targetTotal: 500 }];
  const callsBefore = __mockLogGroupChallengeContributionCalls.length;
  await registerGroupChallengeContributionsIfNeeded(pompes.slug, 5);
  __assertEq(__mockLogGroupChallengeContributionCalls.length, callsBefore + 1, 'chaque contribution doit appeler la Cloud Function une fois de plus');
  __assertEq(__mockLogGroupChallengeContributionCalls[__mockLogGroupChallengeContributionCalls.length - 1].amount, 5);
  console.log('OK: chaque contribution delegue integralement a logGroupChallengeContribution (plafond + historique horodate + reglement, server-side)');

  // "Mode infini" (targetTotal:0, retour utilisateur : classer par le volume total
  // cumule plutot que par une cible chiffree) - nouveau groupe dedie pour ne pas
  // perturber l invariant "un seul defi actif a la fois" du groupe utilise par le
  // reste du scenario ci-dessus (createdGroupId a deja un defi actif/regle).
  currentUser = { uid: 'me-uid', displayName: 'Moi Athlete', email: 'me@test.com', photoURL: '' };
  await createGroup('Solo Infini', '♾️');
  const infiniGroupId = openGroupId;
  creatingGroupChallenge = true;
  groupChallengeFormDraft = { name: '', exerciseSlug: '', startDate: '', endDate: '', targetTotal: '', unlimited: false, stakeMode: '5050', stakeType: 'beer', stakeDescription: '' };
  let infiniFormHtml = renderCreateGroupChallengeForm();
  __assertOk(infiniFormHtml.includes('id="groupChallengeTargetInput"'), 'le champ objectif doit rester visible tant que le Mode infini n est pas coche');
  updateGroupChallengeDraft('unlimited', true);
  infiniFormHtml = renderCreateGroupChallengeForm();
  __assertOk(!infiniFormHtml.includes('id="groupChallengeTargetInput"'), 'le champ objectif doit disparaitre des que le Mode infini est coche (aucune cible a saisir)');
  __assertOk(infiniFormHtml.includes(t('groups.unlimitedModeHint')), 'un texte explicatif doit accompagner le Mode infini');

  groupChallengeFormDraft.name = 'Defi infini'; groupChallengeFormDraft.exerciseSlug = pompes.slug;
  groupChallengeFormDraft.endDate = dateKey(new Date());
  await submitGroupChallengeForm();
  const infiniChallengesSnap = await db.collection('groups').doc(infiniGroupId).collection('challenges').where('name', '==', 'Defi infini').get();
  __assertEq(infiniChallengesSnap.size, 1, 'le Mode infini doit permettre de creer un defi sans objectif chiffre renseigne (targetTotal vide n est plus bloquant)');
  __assertEq(infiniChallengesSnap.docs[0].data().targetTotal, 0, 'targetTotal doit etre explicitement 0 - deja interprete comme "aucun plafond, reglement uniquement a l echeance" cote Cloud Function (shouldSettleChallenge/computeCreditedAmount)');
  const infiniChallengeId = infiniChallengesSnap.docs[0].id;
  creatingGroupChallenge = false;

  await loadGroupDetail(infiniGroupId);
  await db.collection('groups').doc(infiniGroupId).collection('challenges').doc(infiniChallengeId).collection('participants').doc('me-uid').set({ totalAmount: 42 }, { merge: true });
  await loadGroupDetail(infiniGroupId);
  groupDetailView = 'challenge'; // reste sur 'ledger' d un test precedent (meme groupe non concerne), sinon renderGroupDetailScreen() n affiche pas le hero du defi actif
  const infiniDetailHtml = renderGroupDetailScreen();
  __assertOk(infiniDetailHtml.includes(t('groups.unlimitedProgress', { total: 42 })), 'le Mode infini doit afficher le volume total cumule au lieu d un "X / Y"');
  __assertOk(!infiniDetailHtml.includes('group-challenge-hero-track'), 'aucune barre de progression n a de sens sans cible chiffree en Mode infini');
  __assertOk(!infiniDetailHtml.includes(t('groups.targetReachedAwaitingSettlement')), 'le Mode infini ne peut jamais afficher "objectif atteint" (seule l echeance declenche le reglement, voir shouldSettleChallenge cote Cloud Function)');
  console.log('OK: defi de groupe "Mode infini" (targetTotal:0, classement par volume total cumule, aucune barre/pourcentage, reglement uniquement a l echeance)');

  // Retour utilisateur : Kilito agrandi sur l accueil (size:72) gonflait la hauteur
  // de toute la ligne .header (align-items:baseline, un flex item garde son
  // "hypothetical cross size" meme avec align-self:center), rendant le bandeau
  // Date/Streak anormalement grand. Kilito garde sa taille visuelle mais son
  // calage (.kilo-home-slot) est reduit a un gabarit compact, avec une marge
  // negative sur le SVG lui-meme pour deborder sans agrandir la ligne.
  const kiloSlotIdx = cssText.indexOf('.kilo-home-slot {');
  const kiloSlotBlock = cssText.slice(kiloSlotIdx, cssText.indexOf('}', kiloSlotIdx));
  __assertOk(kiloSlotIdx !== -1 && kiloSlotBlock.includes('height: 36px') && kiloSlotBlock.includes('overflow: visible'), 'le calage de Kilito doit retrouver une hauteur compacte independante de la taille visuelle du SVG');
  __assertOk(cssText.includes('.kilo-home-slot .kilo-svg { margin: -18px 0; }'), 'une marge negative doit compenser le debordement visuel de Kilito sans jamais agrandir la ligne .header qui le contient');
  console.log('OK: Kilito garde sa grande taille sur l accueil sans gonfler le bandeau Date/Streak (marge negative de compensation)');

  // Retour utilisateur : l aplat "pilule" (fond uni + bords arrondis nets) derriere
  // l onglet actif lisait comme un rectangle aux frontieres trop nettes - remplace
  // par un halo diffus (radial-gradient qui s estompe jusqu a transparent + flou).
  const tabActiveIdx = cssText.indexOf('.tab-btn.active {');
  const tabActiveBlock = cssText.slice(tabActiveIdx, cssText.indexOf('}', tabActiveIdx));
  __assertOk(tabActiveIdx !== -1 && !tabActiveBlock.includes('background:'), 'l ancien aplat uni aux bords nets ne doit plus exister directement sur .tab-btn.active (deplace vers un halo en pseudo-element)');
  __assertOk(cssText.includes('.tab-btn.active::before'), 'un halo diffus (pseudo-element) doit desormais signaler l onglet actif');
  const tabHaloIdx = cssText.indexOf('.tab-btn.active::before {');
  const tabHaloBlock = cssText.slice(tabHaloIdx, cssText.indexOf('}', tabHaloIdx));
  __assertOk(tabHaloIdx !== -1 && tabHaloBlock.includes('radial-gradient') && tabHaloBlock.includes('rgba(57, 233, 122, 0) 78%') && tabHaloBlock.includes('filter: blur(6px)'), 'le halo doit etre un degrade radial qui s estompe jusqu a transparent, flou, sans aucune frontiere nette');
  console.log('OK: halo diffus (degrade radial flou) remplace l aplat aux bords nets sur l onglet actif');

  // Retour utilisateur : depuis le retour tactile generalise (button:active { transform:
  // scale(0.96) } tout en haut de styles.css), cliquer un onglet du bas provoquait une
  // secousse visuelle genante. Neutralise specifiquement sur les onglets (le fond
  // .bg-card au clic suffit comme retour visuel) - selecteur volontairement plus
  // specifique que la regle generale (voir commentaire dans styles.css), sinon le
  // "transform: none" perdrait silencieusement le bras de fer de specificite CSS.
  const tabClickIdx = cssText.indexOf('.tab-bar button.tab-btn:active {');
  const tabClickBlock = cssText.slice(tabClickIdx, cssText.indexOf('}', tabClickIdx));
  __assertOk(tabClickIdx !== -1 && tabClickBlock.includes('transform: none'), 'le clic sur un onglet ne doit plus provoquer de scale/secousse visuelle de l ecran');
  console.log('OK: la secousse visuelle au clic sur les onglets du bas est desactivee (transform: none, specificite CSS suffisante pour dominer le retour tactile generalise)');

  // --- Garde-fou anti-spam humoristique (retour utilisateur, mascotte Kilito) ---
  // Restaure ICI (uniquement) le VRAI maybeInterceptSpammyTaps() - neutralise par
  // defaut en tete de ce fichier pour ne pas bloquer les tres nombreux addSet()
  // rapproches deja exerces ailleurs dans cette suite (bien plus vite qu un humain,
  // ce qui declencherait sinon la popup a tort - voir le commentaire au tout debut
  // du testDriver).
  maybeInterceptSpammyTaps = __realMaybeInterceptSpammyTaps;
  recentQuickAddTaps = [];
  popupQueue = []; popupOpen = false;
  state = emptyDayState();
  activeToday = new Set([pompes.id]);
  await pickChallenge(pompes.id);

  // 2 premiers taps rapides (30+30=60) : sous le seuil (90), aucune interception -
  // l ajout doit se derouler normalement, sans aucune popup.
  await addSet(30);
  await addSet(30);
  __assertEq(getTotal(), 60, 'les 2 premiers taps rapproches, sous le seuil, doivent s ajouter normalement');
  currentConfirmModalEl = null;

  // 3e tap consecutif (30 de plus = 90 cumules en quelques millisecondes reelles,
  // tres largement sous les 6 secondes de la fenetre) : doit intercepter l ajout
  // AVANT toute ecriture Firestore et afficher la popup Kilito (etat 'warning').
  const spammyAddPromise = addSet(30);
  __assertOk(currentConfirmModalEl !== null, 'le 3e tap rapide (90 cumules en quelques ms) doit declencher la popup de Kilito, AVANT toute validation Firebase');
  __assertOk(currentConfirmModalHtml.includes('kilo-warning'), 'Kilito doit etre affiche dans son etat/mood "warning" (tete suspicieuse)');
  __assertOk(currentConfirmModalHtml.includes('90') && currentConfirmModalHtml.includes(t('exercises.' + pompes.slug + '.name')), 'le message doit etre dynamise avec le nombre EXACT de repetitions tentees et l exercice concerne');
  __assertOk(currentConfirmModalHtml.includes(t('popups.spamGuard.confirmLabel')) && currentConfirmModalHtml.includes(t('popups.spamGuard.cancelLabel')), 'les 2 boutons ("Oups, mon doigt a glisse" / "Je suis vraiment une machine") doivent etre proposes');
  __assertEq(getTotal(), 60, 'tant que la popup n a pas ete refermee, le 3e tap ne doit PAS encore avoir ete comptabilise');

  // "Oups, mon doigt a glisse" (bouton principal/confirmLabel) -> annule CE tap
  // precis, aucune perte des 60 deja legitimement ajoutes avant le seuil.
  currentConfirmModalEl.querySelector('#confirmModalConfirmBtn').onclick();
  await spammyAddPromise;
  __assertEq(getTotal(), 60, '"Oups, mon doigt a glisse" doit annuler le tap suspect, sans jamais toucher aux repetitions deja ajoutees avant');
  console.log('OK: "Oups, mon doigt a glisse" annule le tap suspect sans perdre les repetitions deja ajoutees');

  // Nouveau cycle, exercice remis a zero : reproduit le meme scenario de 3 taps
  // rapides, mais choisit cette fois "Je suis vraiment une machine" (bouton
  // secondaire/cancelLabel) -> l appli reste basee sur la confiance, les points sont
  // quand meme valides (le 3e tap n est PAS perdu, contrairement au scenario precedent).
  recentQuickAddTaps = [];
  state = emptyDayState();
  await pickChallenge(pompes.id);
  await addSet(30);
  await addSet(30);
  currentConfirmModalEl = null;
  const spammyAddPromise2 = addSet(30); // 3e tap : 90 cumules, franchit de nouveau le seuil
  __assertOk(currentConfirmModalEl !== null, 'le nouveau franchissement du seuil doit de nouveau declencher la popup');
  currentConfirmModalEl.querySelector('#confirmModalCancelBtn').onclick();
  await spammyAddPromise2;
  __assertEq(getTotal(), 90, '"Je suis vraiment une machine" doit valider quand meme les points dans Firestore (appli basee sur la confiance), le 3e tap n est pas perdu');
  console.log('OK: "Je suis vraiment une machine" valide quand meme les points malgre le message d avertissement');

  // Neutralise de nouveau pour la fin de fichier (aucun autre test ne doit en tenir compte).
  maybeInterceptSpammyTaps = async () => true;
  recentQuickAddTaps = [];
  currentConfirmModalEl = null;
  state = emptyDayState();
  activeToday = new Set();
  currentChallengeId = null;
  console.log('OK: garde-fou anti-spam humoristique (Kilito) - detection temporelle + interception avant Firebase + retour haptique');

  activeTab = 'today';

  console.log('\\nTous les tests runtime sont passes.');
})().then(() => { __done(); }).catch(e => { __fail(e); });
`;

let finished = false, failure = null;
sandbox.__done = () => { finished = true; };
sandbox.__fail = (e) => { finished = true; failure = e; };

vm.runInContext(appCode + '\n' + testDriver, sandbox, { filename: 'combined-test.js' });

// Attend la fin de l'IIFE async (boucle d'evenements du process Node hote).
function waitAndExit() {
  if (!finished) { setImmediate(waitAndExit); return; }
  if (failure) {
    console.error('ECHEC TEST:', failure && failure.stack || failure);
    process.exit(1);
  }
  process.exit(0);
}
waitAndExit();
