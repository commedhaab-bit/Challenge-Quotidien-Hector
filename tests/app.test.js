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
for (const name of ['exercise-pictograms.js', 'exercise-data.js']) {
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
// Simule localStorage (seul usage de ce mecanisme dans l'app : dismiss de la banniere
// d'installation PWA, une preference propre a CET appareil, cf. commentaire index.html).
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
function makeAppDataDocRef() {
  return {
    async get() {
      return { exists: appDataStore.exists, data: () => JSON.parse(JSON.stringify(appDataStore.data)) };
    },
    async set(fields, opts) {
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
function makeMockCollection(store) {
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
        return {
          empty: arr.length === 0,
          size: arr.length,
          docs: arr.map(({ id, data }) => ({ id, data: () => JSON.parse(JSON.stringify(data)) })),
          forEach(cb) { arr.forEach(({ id, data }) => cb({ id, data: () => JSON.parse(JSON.stringify(data)) })); },
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

  return {
    doc(id) { return makeDocRef(id != null ? String(id) : 'auto_' + Math.random().toString(36).slice(2)); },
    async add(data) {
      const ref = makeDocRef('auto_' + Math.random().toString(36).slice(2));
      await ref.set(data, {});
      return ref;
    },
    where(field, op, value) { return makeQuery([{ field, op, value }], null, null); },
    orderBy(field, dir) { return makeQuery([], { field, dir: dir || 'asc' }, null); },
  };
}
const mockTopCollections = new Map();

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
    firestore(){
      return {
        enablePersistence: () => Promise.resolve(),
        collection(name){
          if (name === 'users') {
            return {
              doc(){
                return {
                  collection(){
                    return { doc: () => makeAppDataDocRef() };
                  },
                };
              },
            };
          }
          if (!mockTopCollections.has(name)) mockTopCollections.set(name, makeMockCollection(new Map()));
          return mockTopCollections.get(name);
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
  __resetCommunityMocks: () => mockTopCollections.clear(),
  alert(msg){ console.log('  [alert]', msg); },
  confirm(msg){ return true; },
  prompt(msg, def){ return def; },
  localStorage: mockLocalStorage,
  __store: store,
  __mockLocalStorageStore: mockLocalStorageStore,
  __appDataStore: appDataStore, // { exists, data } du document consolide simule (voir plus haut)
  __mockCacheKeys: mockCacheKeys, // Cache Storage simule (forceAppUpdate)
  __mockSwRegistrations: mockSwRegistrations, // ServiceWorkerRegistration simulees (forceAppUpdate)
  __rawHtml: html, // fichier source complet de index.html (le <style> a ete extrait dans styles.css, voir __cssSource)
  __cssSource: cssSource, // contenu de styles.css, a part depuis la fusion CSS (#4) : jamais dans __rawHtml
  __swSource: swSource, // contenu de service-worker.js (fichier a part, jamais execute par le vm)
  __externalClassicScripts: externalClassicScripts, // exercise-data.js + exercise-pictograms.js concatenes, pour verifier leur contenu (jamais dans __rawHtml, ce sont des fichiers a part)
  __dbGet: async (key) => {
    if (!store.has(key)) throw new Error('not found: ' + key);
    return { key, value: store.get(key) };
  },
  __dbSet: async (key, value) => {
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
// Depuis la fusion CSS (#4), les regles de style ne sont plus dans __rawHtml (index.html)
// mais dans styles.css (__cssSource) : les tests qui verifient du texte CSS doivent
// chercher dans cssText plutot que dans __rawHtml seul.
const cssText = __rawHtml + __cssSource;

(async () => {
  // --- 1. CHALLENGE_LIBRARY sanity ---
  __assertOk(CHALLENGE_LIBRARY.length > 20, 'CHALLENGE_LIBRARY devrait contenir >20 exercices');
  console.log('OK: CHALLENGE_LIBRARY chargee (' + CHALLENGE_LIBRARY.length + ' exercices)');

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

  // --- 17. Barre d'onglets : nouveaux libellés/icônes, Défis avant Journal ---
  const tabBarHtml = renderTabBar();
  const idxDefis = tabBarHtml.indexOf('Défis');
  const idxJournal = tabBarHtml.indexOf('Journal');
  __assertOk(idxDefis !== -1 && idxJournal !== -1 && idxDefis < idxJournal, 'Défis doit apparaitre avant Journal dans la barre du bas');
  __assertOk(tabBarHtml.includes('🎯'), 'icone cible 🎯 pour l onglet Défis');
  __assertOk(tabBarHtml.includes('🏋️‍♂️'), 'icone haltere pour Aujourd hui');
  __assertOk(tabBarHtml.includes('📓'), 'icone carnet pour Journal');
  __assertOk(!tabBarHtml.includes('📚'), 'ancienne icone livre 📚 ne doit plus apparaitre');
  __assertOk(!tabBarHtml.includes('>Bibliothèque<'), 'le libelle Bibliotheque ne doit plus apparaitre');
  __assertOk(!tabBarHtml.includes('>Historique<'), 'le libelle Historique ne doit plus apparaitre dans la barre');
  __assertOk(tabBarHtml.includes('>Profil<'), 'l onglet Compte doit maintenant s appeler Profil');
  console.log('OK: onglets renommes/reordonnes (Aujourd hui / Défis / Journal / Profil)');

  // --- 18. Trophées déplacés : absents du Journal, présents dans le Profil ---
  activeTab = 'history';
  historyEntries = [];
  historyLoading = false;
  const historyHtml = renderHistoryScreen();
  __assertOk(!historyHtml.includes('Trophées'), 'les trophees ne doivent plus apparaitre dans le Journal');
  __assertOk(historyHtml.includes('>Journal<'), 'le titre de page doit dire Journal (pas Historique)');
  currentUser = { displayName: 'Test', email: 't@test.com', photoURL: '' };
  const accountHtml = renderAccountTabScreen();
  __assertOk(accountHtml.includes('Trophées'), 'les trophees doivent maintenant apparaitre dans Profil');
  __assertOk(accountHtml.includes('>Profil<'), 'le titre de page doit dire Profil (pas Compte)');
  activeTab = 'today';
  console.log('OK: trophées déplacés de Journal vers Profil, titres renommes');

  // --- 19. Journal : plus de "Volume des 7 derniers jours", calendrier avant la heatmap ---
  __assertOk(!historyHtml.includes('Volume des 7 derniers jours'), 'la carte volume 7 jours doit avoir disparu du Journal');
  const idxCalendrier = historyHtml.indexOf('Calendrier du mois');
  const idxHeatmap = historyHtml.indexOf('Activité (6 derniers mois)');
  __assertOk(idxCalendrier !== -1 && idxHeatmap !== -1 && idxCalendrier < idxHeatmap, 'le calendrier du mois doit apparaitre avant la heatmap 6 mois');
  console.log('OK: Journal réorganisé (calendrier avant heatmap, volume 7j retiré)');

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
  __assertEq(GUIDED_TOUR_STEPS.length, 5, 'le tour doit desormais compter 5 cartes (bienvenue + 4 onglets)');
  let overlay = renderGuidedTourOverlay();
  __assertOk(overlay.includes('Bienvenue dans Défi du Jour !'), 'la carte 0 doit etre une bienvenue neutre dediee');
  __assertOk(overlay.includes('tour-overlay intro'), 'la carte 0 doit avoir le fond assombri/floute (intro)');
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
  __assertEq(activeTab, 'history', 'puis sur Journal');
  guidedTourNext();
  __assertEq(activeTab, 'account', 'puis sur Profil');
  overlay = renderGuidedTourOverlay();
  __assertOk(overlay.includes('Terminer'), 'le dernier bouton doit dire Terminer');
  guidedTourNext(); // termine le tour (endGuidedTour() est async : on laisse la chaine se resoudre)
  __assertEq(guidedTourStep, null, 'le tour doit se terminer (plus d etape active), deja vrai de facon synchrone');
  await new Promise(r => setTimeout(r, 10));
  __assertEq(hasSeenTour, true, 'hasSeenTour doit passer a true');
  __assertEq(__appDataStore.data.hasSeenTour, true, 'hasSeenTour doit etre persiste dans le document consolide appData');
  __assertEq(activeTab, 'today', 'le tour termine doit ramener sur Aujourd hui');
  __assertEq(renderGuidedTourOverlay(), '', 'aucune bulle ne doit plus s afficher apres la fin du tour');
  console.log('OK: tour guidé (5 cartes dont bienvenue dediee, marqué vu, ne se relance pas)');

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
  __assertEq(xpTotal, expectedXp, 'xpTotal doit augmenter du montant calcule par xpForChallenge');
  __assertEq(__appDataStore.data.xpTotal, expectedXp, 'xpTotal doit etre persiste dans le document consolide appData');
  __assertOk(popupOpen, 'une popup immersive doit s afficher immediatement a la validation');
  __assertOk(currentPopupHtml.includes('Défi complété'), 'la popup doit annoncer la completion du defi');
  __assertOk(currentPopupHtml.includes('+' + expectedXp + ' XP'), 'la popup doit afficher la carte XP gagnee');
  document.getElementById('appPopupCloseBtn').onclick();
  currentChallengeId = null;
  console.log('OK: XP attribue (+' + expectedXp + ') et popup immersive (carte XP) affichee a la validation d un defi');

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
  await addSet(cForStreak.target);
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
  __assertOk(!popupOpen, 'aucun popup bouclier ne doit s afficher (deja consomme)');
  console.log('OK: sans bouclier disponible, la serie retombe a 0 apres un jour manque');

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
  document.getElementById('appPopupCloseBtn').onclick();

  // Cas explicite : level up SANS changement de titre (niveau 2 -> 3, toujours Recrue)
  popupQueue = []; popupOpen = false;
  enqueueLevelPopups(2, 3);
  __assertOk(currentPopupHtml.includes('Niveau supérieur'), 'popup simple attendue quand le titre ne change pas');
  __assertOk(!currentPopupHtml.includes('NOUVEAU TITRE'), 'pas de popup epique quand le titre est inchange');
  document.getElementById('appPopupCloseBtn').onclick();
  console.log('OK: popups Level Up (simple) et Nouveau Titre (epique) selon le changement de palier');

  // --- 41. Refonte UI du chrono : disque double-anneau cliquable, plus de bouton
  // rectangulaire / texte "en cours" / hints / mode plein ecran / ajout manuel ---
  state = emptyDayState();
  activeToday = new Set([9003]);
  await pickChallenge(9003); // Planche test (unit='sec', target=30, hardcoreTarget=60)
  render(false);
  let detailHtml = document.getElementById('app').innerHTML;
  __assertOk(detailHtml.includes('timer-ring-wrap'), 'le disque du chrono (anneau) doit etre present');
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
  activeTab = 'history';
  historyEntries = [];
  historyLoading = false;
  const monthHtml = renderHistoryScreen();
  const today76 = new Date();
  const daysInMonth76 = new Date(today76.getFullYear(), today76.getMonth() + 1, 0).getDate();
  // Ne pas verifier de chiffre precis dans le texte : si "aujourd'hui" correspond au
  // jour verifie, la cellule affiche "✓" (fait) au lieu du numero — le compte total de
  // cellules (ci-dessous) prouve deja, de maniere fiable, qu aucun jour n est manquant.
  const totalCalCells = (monthHtml.match(/cal-cell/g) || []).length;
  const emptyCalCells = (monthHtml.match(/cal-cell empty/g) || []).length;
  __assertEq(totalCalCells - emptyCalCells, daysInMonth76, 'le calendrier doit contenir exactement une cellule pour chaque jour du mois en cours');
  activeTab = 'today';
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
  activeTab = 'history';
  historyEntries = [];
  historyLoading = false;
  const calMonthHtml = renderHistoryScreen();
  __assertOk(calMonthHtml.includes("showDayDetailModal('"), 'chaque case reelle du calendrier doit ouvrir la modal de detail du jour au clic');
  activeTab = 'today';
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
  __assertEq(firebaseScriptTags.length, 3, 'les 3 SDK Firebase doivent etre presents');
  __assertOk(firebaseScriptTags.every(t => !t.includes('defer') && !t.includes('async')), 'les SDK Firebase doivent rester charges de maniere synchrone (coherent avec le script inline non differe)');
  console.log('OK: SDK Firebase + script inline charges de maniere synchrone (pas de defer/async, ordre garanti)');

  // --- 85. Performance : persistance locale Firestore (IndexedDB) activee ---
  __assertOk(__rawHtml.includes('enablePersistence({ synchronizeTabs: true })'), 'la persistance locale Firestore doit etre activee (cache IndexedDB entre sessions)');
  console.log('OK: persistance locale Firestore activee');

  // --- 86. Performance : le service worker alimente desormais son cache sur un miss
  // (avant, le repli cache-first pour icones/manifest/IMAGES ne populait jamais le
  // cache : aucun gain, ni hors-ligne, pour les assets les plus lourds de l appli) ---
  __assertOk(__swSource.length > 0, 'service-worker.js doit etre lisible pour ce test');
  __assertOk(__swSource.includes("'defi-du-jour-v22'"), 'la version du cache doit avoir ete incrementee suite au changement de logique');
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
  // 5 depuis l ajout de l import de donnees (batch Parametres) : compte x2, defi,
  // suggestion d objectif, + confirmation avant import destructif.
  const confirmModalCallCount = (__rawHtml.match(/await confirmModal\\(\\{/g) || []).length;
  __assertEq(confirmModalCallCount, 6, 'les 6 sites (compte x2, defi, suggestion objectif, import de donnees, forcer la mise a jour) doivent utiliser confirmModal');
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

  // --- 116. Raccourcis PWA (#7) : ?tab=... positionne activeTab au demarrage
  // et nettoie ensuite l URL (evite de re-declencher au prochain rechargement) ---
  location.search = '?tab=library';
  activeTab = 'today';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'library', '?tab=library doit positionner activeTab sur Defis');
  __assertEq(location.search, '', 'l URL doit etre nettoyee apres lecture (history.replaceState)');

  location.search = '?tab=history';
  activeTab = 'today';
  applyShortcutTabFromUrl();
  __assertEq(activeTab, 'history', '?tab=history doit positionner activeTab sur Journal');

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
  __assertOk(__rawHtml.includes('class="exercise-hero-apng"') && __rawHtml.includes('loading="eager"'), 'l image hero de la fiche detail doit etre explicitement loading="eager"');
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
  __assertOk(ageHtml.includes('coach-badge') && ageHtml.includes('Coach Virtuel IA') && ageHtml.includes('🧠'), 'le badge coach virtuel (icone cerveau) doit desormais apparaitre sur l ecran age');
  __assertOk(ageHtml.includes('id="pfAge"'), 'le rouleau d age doit toujours etre present sur cet ecran');
  profileStep = 0;
  console.log('OK: onboarding - ecran de bienvenue condense (3 points cles), coach virtuel explique sur l ecran age');

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
  onboardingTransitionPhase = null;
  console.log('OK: la mini-carte de preview affiche un objectif reellement calcule (pas une valeur fictive codee en dur)');

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
  activeTab = 'history';
  popupQueue = []; popupOpen = false;
  await showDayDetailModal(todayKey);
  __assertOk(!currentPopupHtml.includes('📅'), 'l emoji calendrier avec une date figee (17 JUL) ne doit plus apparaitre');
  __assertOk(currentPopupHtml.includes('🗓️'), 'un icone calendrier sans date figee doit le remplacer');
  document.getElementById('appPopupCloseX').onclick();
  activeTab = 'today';
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
  activeTab = 'history';
  render(false);
  const journalShareHtml = document.getElementById('app').innerHTML;
  __assertOk(journalShareHtml.includes('share-icon') && journalShareHtml.includes('<svg'), 'le bouton de partage des stats doit utiliser une icone SVG');
  __assertOk(!journalShareHtml.includes('📤 Partager'), 'l ancien emoji de partage ne doit plus apparaitre devant le texte du bouton');
  activeTab = 'today';
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
  const dailyDocAfter = await communityDailyChallengeDocRef(todayKey).get();
  __assertOk(dailyDocAfter.exists, 'terminer un defi communautaire doit creer/mettre a jour le doc partage du jour');
  __assertEq(dailyDocAfter.data().completions1, 1, 'completer le defi 1 doit incrementer completions1');
  // Annuler puis re-valider le meme defi le meme jour (undoLast -> addSet) ne doit
  // JAMAIS re-incrementer : sans garde-fou, ce cycle gonflerait artificiellement la
  // preuve sociale partagee par toute la communaute.
  await undoLast();
  await addSet(targetC1);
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

  // --- 146. Classement 3 vues + rang exact avec voisins directs ---
  __resetCommunityMocks();
  await db.collection('leaderboard').doc('uidA').set({ displayName: 'Alice', streakCount: 10, xpTotal: 500, xpWeekly: 50, xpWeekStart: wkNow }, { merge: true });
  await db.collection('leaderboard').doc('uidB').set({ displayName: 'Bob', streakCount: 8, xpTotal: 300, xpWeekly: 90, xpWeekStart: wkNow }, { merge: true });
  await db.collection('leaderboard').doc('test-uid').set({ displayName: 'Moi', streakCount: 5, xpTotal: 150, xpWeekly: 20, xpWeekStart: wkNow }, { merge: true });
  await db.collection('leaderboard').doc('uidD').set({ displayName: 'Dan', streakCount: 3, xpTotal: 50, xpWeekly: 5, xpWeekStart: wkNow }, { merge: true });

  const topStreaks = await fetchLeaderboardTop('streaks', 20);
  __assertEq(topStreaks.map(e => e.displayName), ['Alice', 'Bob', 'Moi', 'Dan'], 'la vue Series doit trier par streakCount decroissant');
  const topAlltime = await fetchLeaderboardTop('alltime', 20);
  __assertEq(topAlltime.map(e => e.displayName), ['Alice', 'Bob', 'Moi', 'Dan'], 'la vue Legendes doit trier par xpTotal decroissant');
  const topWeekly = await fetchLeaderboardTop('weekly', 20);
  __assertEq(topWeekly.map(e => e.displayName), ['Bob', 'Alice', 'Moi', 'Dan'], 'la vue Hebdomadaire doit trier par xpWeekly decroissant');

  const myRankInfo = await fetchMyRankAndNeighbors('alltime');
  __assertEq(myRankInfo.rank, 3, 'mon rang exact (via count()) doit tenir compte de tous les scores superieurs au mien');
  __assertEq(myRankInfo.neighbors.map(e => e.displayName), ['Alice', 'Bob', 'Moi', 'Dan'], 'les voisins directs doivent inclure les 2 au-dessus et en-dessous (ici tout le classement, 4 personnes)');

  activeTab = 'today';
  activeTab = 'community';
  communityLeaderboardView = 'alltime';
  await loadCommunityLeaderboard('alltime');
  const communityHtml = renderCommunityScreen();
  __assertOk(communityHtml.includes('leaderboard-tabs') && communityHtml.includes('leaderboard-row'), 'l ecran Communaute doit afficher les onglets et les lignes de classement');
  // Ici, seulement 4 personnes au total : "Moi" est deja visible dans le top affiche a
  // l ecran (limite 20) -> la barre de rang ancree ne doit PAS se dupliquer par-dessus
  // (2x la meme ligne "Moi" a l ecran serait deroutant).
  __assertOk(!communityHtml.includes('rank-bar'), 'la barre de rang ancree ne doit PAS s afficher quand mon rang est deja visible dans la liste principale (evite le doublon de ma ligne)');
  console.log('OK: classement 3 vues + rang exact avec voisins directs (barre ancree)');

  // --- 146bis. Masquage intelligent : la barre de rang REAPPARAIT si mon rang n est
  // PAS dans le top visible (au-dela de la limite de 20 lignes affichees) ---
  for (let i = 0; i < 25; i++) {
    await db.collection('leaderboard').doc('extra' + i).set(
      { displayName: 'Extra' + i, streakCount: 1, xpTotal: 1000 - i, xpWeekly: 1, xpWeekStart: wkNow },
      { merge: true }
    );
  }
  await loadCommunityLeaderboard('alltime');
  __assertOk(!communityLeaderboardTop.some(e => e.uid === 'test-uid'), 'avec 29 personnes, mon rang (tres bas) ne doit plus faire partie du top 20 affiche');
  const communityHtmlBig = renderCommunityScreen();
  __assertOk(communityHtmlBig.includes('rank-bar') && communityHtmlBig.includes('>Moi<'), 'la barre de rang ancree doit reapparaitre (avec ma ligne) des que mon rang sort du top visible a l ecran');
  activeTab = 'today';
  console.log('OK: la barre de rang ancree ne s affiche que si mon rang n est pas deja visible dans la liste principale');

  // --- 146ter. Empty state du classement : incite a inviter des proches tant que la
  // communaute visible est trop petite (<3) pour etre motivante ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Moi', email: 'a@test.com', photoURL: '' };
  leaderboardOptOut = false;
  await db.collection('leaderboard').doc('test-uid').set({ displayName: 'Moi', streakCount: 2, xpTotal: 10, xpWeekly: 10, xpWeekStart: mondayOfWeek(new Date()) }, { merge: true });
  activeTab = 'community';
  communityLeaderboardView = 'streaks';
  await loadCommunityLeaderboard('streaks');
  __assertOk(communityLeaderboardTop.length < 3, 'ce scenario doit avoir moins de 3 personnes dans le classement pour tester l empty state');
  const smallCommunityHtml = renderCommunityScreen();
  __assertOk(smallCommunityHtml.includes('community-invite-card') && smallCommunityHtml.includes('shareCommunityInvite()'), 'avec moins de 3 personnes, une carte d invitation avec un bouton de partage doit s afficher sous la liste');
  __assertOk(smallCommunityHtml.includes('Inviter des proches pour pimenter le classement'), 'le texte incitatif exact doit etre affiche');

  // Avec 3 personnes ou plus, l empty state ne doit plus s afficher (la communaute
  // est deja assez fournie pour etre motivante).
  await db.collection('leaderboard').doc('uidX').set({ displayName: 'X', streakCount: 1, xpTotal: 1, xpWeekly: 1, xpWeekStart: mondayOfWeek(new Date()) }, { merge: true });
  await db.collection('leaderboard').doc('uidY').set({ displayName: 'Y', streakCount: 1, xpTotal: 1, xpWeekly: 1, xpWeekStart: mondayOfWeek(new Date()) }, { merge: true });
  await loadCommunityLeaderboard('streaks');
  __assertOk(communityLeaderboardTop.length >= 3, 'ce 2e scenario doit avoir 3 personnes ou plus');
  const filledCommunityHtml = renderCommunityScreen();
  __assertOk(!filledCommunityHtml.includes('community-invite-card'), 'la carte d invitation ne doit plus s afficher des que le classement compte 3 personnes ou plus');
  activeTab = 'today';
  console.log('OK: empty state du classement (carte d invitation a partager si moins de 3 membres)');

  // --- 146quater. Contraste du bouton secondaire "Choisir mon propre defi" (#2 CSS) :
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
  let bossDoc = await bossBattleDocRef().get();
  __assertOk(bossDoc.exists && bossDoc.data().currentProgress === 10, 'une simple serie (pas forcement la completion) doit deja contribuer a la jauge collective');
  await addSet(5);
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
  const contribSnap = await bossBattleDocRef().collection('contributions').orderBy('at', 'desc').limit(20).get();
  __assertEq(contribSnap.size, 1, 'chaque contribution doit creer un nouveau document (pas fusionne, contrairement a dailyContributors)');
  __assertEq(contribSnap.docs[0].data().displayName, 'Julie', 'le document de contribution doit garder le nom affiche de l auteur');
  __assertEq(contribSnap.docs[0].data().amount, 40, 'le montant de la contribution doit etre celui reellement ajoute');

  startRecentContributionsListener();
  await Promise.resolve().then(() => {}).then(() => {}).then(() => {});
  __assertEq(communityRecentContributions.length, 1, 'le listener doit alimenter le fil en temps reel');
  currentChallengeId = null;
  activeToday = new Set();
  const feedSectionHtml = renderBossBattleSection();
  __assertOk(feedSectionHtml.includes('boss-battle-feed') && feedSectionHtml.includes('Julie') && feedSectionHtml.includes("vient d'ajouter 40"), 'l ecran Communaute doit afficher le fil des dernieres contributions (FOMO en direct)');
  communityRecentContributions = [];
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

  // --- 154. loadCommunityLeaderboard() : l echec de la requete de rang/voisins ne
  // doit JAMAIS vider le top N alors qu il a reussi (deja vecu en production : un
  // Promise.all englobant les 2 requetes effacait le top 20 a tort a cause d un
  // souci isole au rang) -- chaque requete garde son propre etat d echec ---
  __resetCommunityMocks();
  currentUser = { uid: 'test-uid', displayName: 'Alice', email: 'a@test.com', photoURL: '' };
  await db.collection('leaderboard').doc('test-uid').set({ displayName: 'Alice', streakCount: 3 }, { merge: true });
  const realCurrentUser154 = currentUser;
  currentUser = null; // fait echouer fetchMyRankAndNeighbors() (reference currentUser.uid), sans toucher fetchLeaderboardTop()
  await loadCommunityLeaderboard('streaks');
  currentUser = realCurrentUser154;
  __assertEq(communityLeaderboardTop.length, 1, 'le top N doit rester peuple meme si la requete de rang/voisins echoue independamment');
  __assertEq(communityLeaderboardRank, null, 'le rang doit rester null (pas de valeur fantome) quand sa propre requete a echoue');
  __resetCommunityMocks();
  console.log('OK: le top N du classement et le rang/voisins ont des etats d echec independants');

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
  __assertEq(formatDisplayName(''), 'Athlète', 'nom vide -> repli Athlète (comme l ancien comportement)');
  __assertEq(formatDisplayName(null), 'Athlète', 'nom absent (null) -> repli Athlète');
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
