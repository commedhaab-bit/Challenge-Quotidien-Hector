# Défi du Jour — Contexte projet pour Claude Code

## Vue d'ensemble
PWA mono-fichier (`index.html`) de défis fitness quotidiens, en français, thème
sombre + accents vert néon. Déployée sur GitHub Pages, backend Firebase
(Auth Google + Firestore). Développée intégralement en conversation avec
Claude (claude.ai), ce fichier sert de relais de contexte pour continuer via
Claude Code.

## Fichiers du projet
- `index.html` — l'application entière (HTML/CSS/JS vanilla, ~5000 lignes). PAS un
  fichier unique depuis l'extraction du catalogue d'exercices (voir juste en dessous) :
  reste néanmoins la quasi-totalité du rendu/de la logique/du gameplay
- `exercise-data.js` / `exercise-pictograms.js` — catalogue d'exercices
  (`CHALLENGE_LIBRARY`, `QUICK_ADD`, `EXERCISE_ICON_BY_NAME`,
  `PICTOGRAM_ASSET_MISSING`, `getExercisePictogramKey`, `formatSecToReadable`/
  `formatTargetLabel`) et pictogrammes SVG (`EXERCISE_PICTOGRAMS`), extraits de
  `index.html` pour l'alléger. Chargés en **`<script src="...">` CLASSIQUES**
  (surtout PAS `type="module"`, PAS `defer`/`async`) AVANT le script principal dans
  le `<head>` — volontairement PAS de vrais modules ES : ça forcerait le script
  principal à devenir un module (donc `defer` implicite), qui casserait
  silencieusement les fonctions référencées par `onclick="..."` dans le HTML (elles
  ne seraient plus des propriétés globales de `window`) — exactement la classe de
  bug qui a déjà causé un écran noir en production (voir plus bas). Un simple
  script classique garde tout dans la même portée globale partagée, sans ce risque.
  Le harnais de test lit ces fichiers et les concatène AVANT le script principal
  pour reproduire cet ordre de chargement.
- `styles.css` — tout le CSS, extrait du bloc `<style>` autrefois inline dans
  `index.html` (chargé via `<link rel="stylesheet" href="styles.css">`), pour un
  fichier principal moins volumineux et un fichier CSS mis en cache séparément
  par le navigateur/service worker. Contenu inchangé, juste déplacé. Le harnais
  de test lit ce fichier à part (`__cssSource`) : les tests qui vérifient du
  texte CSS cherchent dans `cssText` (= `__rawHtml + __cssSource`), pas dans
  `__rawHtml` seul (qui ne contient plus que le HTML/JS de `index.html`).
- `manifest.json` — manifeste PWA
- `service-worker.js` — réseau-first pour le HTML (mise à jour PWA), cache-first
  (avec alimentation à la volée) pour tout le reste — notamment les images
  `exercices/`, de loin les assets les plus lourds de l'appli
- `icon-192.png` / `icon-512.png` — icônes d'app
- `generate-static-frames.py` — script Python (Pillow) qui extrait la 7ᵉ frame de
  chaque PNG animé du dossier `exercices/`, la redimensionne (128px, 2x la taille
  d'affichage réelle de 64px) et crée la version statique (`nom-static.png`)
  utilisée sur les listes (Aujourd'hui/Défis)
- `generate-webp-assets.py` — génère, EN PLUS de chaque PNG (jamais à la place :
  les .png restent les fichiers maîtres), une version `.webp` — statique ou
  animée selon la source, bien plus légère (voir section Performance). L'appli
  essaie toujours le `.webp` en premier et retombe automatiquement sur le `.png`
  s'il est absent (`onerror`), donc relancer ce script à tout moment est sans
  risque, même partiellement
- `exercices/` — dossier d'images par exercice (voir section dédiée plus bas)
- `package.json` / `eslint.config.js` / `.prettierrc` — outillage local uniquement
  (devDependencies : eslint, prettier). Aucun build, aucun impact sur le
  déploiement GitHub Pages (qui sert directement `index.html`). `npm test` /
  `npm run lint` / `npm run format`. Le lint (ESLint 10, flat config) ne couvre
  QUE les vrais fichiers `.js` (`exercise-data.js`, `exercise-pictograms.js`,
  `tests/`) : le script principal reste inline dans `index.html`, hors de portée
  d'ESLint sans plugin HTML dédié (volontairement non ajouté, hors scope).
- `tests/app.test.js` — harnais de test Node/`vm` (voir section dédiée plus bas) ;
  `tests/extract-script.js` — extrait le script applicatif combiné (scripts
  classiques + inline) pour un `node -c` (vérification de syntaxe) indépendant.
- `.github/workflows/ci.yml` — à chaque push/PR : `node -c` sur le script extrait,
  `npm test` (harnais complet), `npm run lint`.

## Config Firebase (déjà en dur dans index.html, ne PAS mettre de placeholder)
```js
apiKey: "AIzaSyBE0DL8Q6y8Md4R2aM0D1imx_cTUlHP5c4"
authDomain: "challenge-quotidien-hector.firebaseapp.com"
projectId: "challenge-quotidien-hector"
storageBucket: "challenge-quotidien-hector.firebasestorage.app"
messagingSenderId: "613473786890"
appId: "1:613473786890:web:c77ccf3c2d99857df9d3f3"
measurementId: "G-CXQPEGDHW7"
```
Stockage Firestore en clé/valeur : `users/{uid}/kv/{key}` via les fonctions
génériques `dbGet(key)` / `dbSet(key, value)` — encore utilisées telles quelles
pour les documents par jour (`day:{date}`, `activeToday:{date}`, historique
permanent, jamais fusionnés : voir `loadHistoryEntries()`/`showDayDetailModal()`).

**Document consolidé `users/{uid}/kv/appData`** (fusion Firestore, remplace 12
anciennes clés séparées — `profile`, `customChallenges`, `manualTargetOverrides`,
`streakData`, `xpTotal`, `voiceCoachEnabled`, `hasSeenTour`, `lastCompleted`,
`stats`, `badges`, `dailyActivity`, `weights`) : une seule lecture au démarrage
(`loadAppData()`) au lieu de 12, écritures via `saveAppField(field, value)` qui
fait un **merge Firestore natif** (`{merge:true}`) — ne touche JAMAIS les autres
champs du document, donc aucun risque d'écrasement entre deux écrans qui
écrivent des champs différents au même moment (ex: terminer un défi pendant que
Paramètres modifie les poids d'haltères). **Ne jamais revenir à un `.set(obj)`
complet sans `{merge:true}` sur ce document** — ça écraserait silencieusement
tous les autres champs. Migration non destructive : si le document n'existe pas
encore, `loadAppData()` relit les 12 anciennes clés séparées (chaque `loadX()`
garde sa logique de défaut/migration interne inchangée) puis écrit le document
consolidé une seule fois — les anciennes clés ne sont JAMAIS supprimées
(orphelines inoffensives, déjà nettoyées par `deleteMyAccount()` qui vide toute
la sous-collection `kv` sans liste de clés en dur). Un tout nouveau compte
n'écrit rien avant la fin de l'onboarding (le premier `saveProfile()` crée le
document via `merge:true` sur un document inexistant).

## Architecture de navigation
Barre d'onglets fixe en bas (4 onglets, variable `activeTab`) :
`today` (accueil + fiche défi) / `history` / `library` (gestion défis) / `account`.
Navigation interne (retour Android/PWA) gérée via l'History API :
`pushNavState()` + `goBackOneLevel()` (popstate). Les onglets eux-mêmes ne
poussent PAS d'état d'historique (pairs, pas une pile) ; seuls les écrans
imbriqués dans un onglet (fiche défi, formulaire, sous-écran bibliothèque,
mode focus) le font.

## Modèle de données clé
- `CHALLENGE_LIBRARY` — bibliothèque complète des défis disponibles (32 défis,
  15 précochés par défaut à l'onboarding)
- `CHALLENGES` — liste des défis actifs de l'utilisateur (sous-ensemble personnalisé)
- `state.challenges[id]` — progression du jour par défi (sets, done, hardcoreDone)
- Mode Hardcore : objectif = `target × 2`, calculé dynamiquement, jamais stocké en dur
- Système de coach virtuel : profil utilisateur (âge/sexe/taille/poids/niveau)
  → coefficients → objectifs personnalisés (`computeStandardTarget`,
  `computeStandardWeight`), calibrés pour que le profil de référence
  (homme 32 ans intermédiaire IMC~26) redonne ~les anciens objectifs fixes

## Pictogrammes d'exercices (sujet en cours)
Chaque défi a une clé d'icône (`getExercisePictogramKey`), ex: `squats`, `pompes`,
`dumbbell_generic`. Système à 3 niveaux de repli automatique dans
`renderExercisePicto()` :
1. `exercices/{clé}-static.png` (photo/illustration statique, accueil)
2. → si absent, retombe sur `exercices/{clé}.png` raté aussi → SVG stickman dessiné à la main
3. Sur la fiche du défi (pas la liste), `exercices/{clé}.png` est utilisé tel quel
   en HAUT de la fiche, EN ANIMÉ (c'est un PNG animé — garder l'extension `.png`,
   PAS `.apng`, car GitHub Pages ne sait pas forcément servir `.apng` avec le bon
   content-type)

**Statut actuel** : les SVG stickman sont en place et fonctionnels (33 icônes
distinctes). L'utilisateur génère progressivement de vraies illustrations
(PNG animés, personnage vert néon sur fond sombre) via un outil IA externe
(Midjourney/GPT Image), à déposer dans `exercices/{clé}.png`. Le script
`generate-static-frames.py` doit être relancé à chaque ajout pour générer la
version statique correspondante (`python3 generate-static-frames.py`).

Liste des 32 clés attendues : pompes, dips, pompes_iso, pompes_larges,
pompes_diamant, pompes_declinees, pike, superman, triceps, biceps,
epaule_raise, cuban_press, rowing, developpe_epaules, extension_nuque,
squat_goblet, planche, crunchs, gainage_lateral, mountain_climbers,
leg_raises, hollow_hold, vups, bicycle, dead_bug, squats, fentes, chaise,
mollets, fentes_bulgares, squats_sumo, pont_fessier (+ `generic` et
`dumbbell_generic` en repli pour les défis personnalisés).

## Performance (audit + correctifs — voir aussi historique de session)
- **Images** : chaque PNG de `exercices/` a un jumeau `.webp` (généré par
  `generate-webp-assets.py`, ~4-8x plus léger). `renderExercisePicto()` et la
  fiche détail essaient `.webp` → `.png` → SVG dessiné à la main, en cascade via
  `onerror`. `PICTOGRAM_ASSET_MISSING` (index.html) liste les clés sans AUCUN
  fichier sur le disque (encore en attente d'illustration, ou repli permanent
  `generic`/`dumbbell_generic`) : pour elles, le SVG est rendu directement, sans
  requête réseau vouée à un 404 garanti. Penser à retirer une clé de cette liste
  dès que sa vraie image est déposée.
- **Chargement perçu** : `.exercise-picto`/`.exercise-hero-apng` affichent un
  skeleton "shimmer" + fondu à l'arrivée (classe `.loaded`, posée par `onload` ou
  par le dernier repli `onerror`), et réservent leur espace (`aspect-ratio`/taille
  fixe) pour ne jamais provoquer de saut de mise en page (CLS).
- **Service worker** : le fallback cache-first pour les fichiers statiques
  alimente désormais le cache sur un miss (`cache.put`) — avant ce correctif, les
  images n'étaient JAMAIS mises en cache par le SW (aucun gain, ni hors-ligne).
- **Démarrage** : `startApp()` appelle `loadAppData()` en tout premier (une seule
  lecture Firestore du document consolidé `appData`, voir plus haut) — plus
  besoin d'un `Promise.all` séparé de 10 clés dans `continueStartApp()`, qui ne
  fait plus que les documents PAR JOUR (`loadState()`/`loadActiveToday()`,
  dépendants de `todayKey`). `refreshApp()` (pull-to-refresh) appelle aussi
  `loadAppData()` directement, au lieu de dupliquer sa propre liste de loaders
  (ancien risque de désynchronisation entre les deux listes, éliminé par
  construction). Persistance locale Firestore activée (`enablePersistence`) : les
  lectures sont mises en cache IndexedDB côté appareil.
- **Journal** : `loadHistoryEntries()` lit ses 28 jours en parallèle (`Promise.all`),
  plus en séquentiel.
- **Indicateur de synchronisation en attente** : `pendingWriteCount` (incrémenté/
  décrémenté dans `dbSet`/`saveAppField`) n'est exploité QUE hors ligne, dans
  `updateOfflineBanner()` — en ligne, ces écritures se résolvent trop vite
  (persistance locale Firestore) pour qu'un indicateur séparé apporte quoi que ce
  soit ; il ne ferait que clignoter à chaque validation de défi (plusieurs
  écritures séquentielles par `addSet()`). Décision volontaire (pas de file de
  retry maison) : Firestore rejoue déjà automatiquement les écritures hors ligne
  via `enablePersistence({synchronizeTabs:true})`, ceci ne fait qu'en informer
  l'utilisateur avec un compte précis plutôt qu'un message générique.
- **SDK Firebase + fichiers classiques** : chargement synchrone classique (PAS de
  `defer`/`async`) sur les 3 `<script src=...>` Firebase, les 2 `<script src=...>`
  `exercise-data.js`/`exercise-pictograms.js`, NI sur le script inline de l'appli.
  Un essai de `defer` sur les 3 SDK + le script inline a provoqué un écran noir
  total en production : `defer` n'a AUCUN EFFET sur un `<script>` sans `src` (spec
  HTML/MDN) — le script inline continuait donc de s'exécuter immédiatement à sa
  position, avant que les SDK externes (eux bien différés) aient fini de charger,
  d'où un throw immédiat sur `firebase.initializeApp(...)` qui stoppait tout le
  script. Ne pas réintroduire `defer`/`async` sur aucune de ces 6 balises.

## Bugs déjà corrigés — NE PAS RÉINTRODUIRE
- **onAuthStateChanged peut se déclencher 2× au chargement** → déguard via
  `lastAuthUid` dans le listener + garde dans `startApp()` qui ignore les
  appels si un onboarding est déjà affiché. Sans ça, le formulaire de profil
  se réinitialise en pleine saisie (bug de perte de focus déjà vécu).
- **Pull-to-refresh fantôme** : `ptrCurrentY` doit être réinitialisée à CHAQUE
  `touchstart` (pas seulement mise à jour dans `touchmove`), sinon un simple
  tap peut hériter d'une ancienne valeur et déclencher un `refreshApp()`
  complet par erreur (~3s de rechargement séquentiel Firestore).
- **Appels Firestore toujours en parallèle** (`Promise.all`) sauf dépendance
  explicite. `loadState()` calcule les pastilles de la semaine à partir de
  `dailyActivity` déjà chargé, PAS via 7 appels séquentiels jour par jour.

## Style / conventions de code
- Palette CSS via variables `:root` uniquement (`--bg`, `--accent`, etc.) —
  ne jamais coder une couleur en dur, toujours passer par les variables pour
  que les futurs changements de thème restent globaux
- Toute nouvelle fonctionnalité doit être testée : ajouter un cas dans
  `tests/app.test.js` (harnais Node/`vm`, mock minimal de `document`/`window`/
  `dbGet`/`dbSet`), vérifier `npm test` + `node tests/extract-script.js && node -c
  .extracted-script.js`, avant de commit — exactement ce que `.github/workflows/ci.yml`
  automatise à chaque push
- JSDoc sur les fonctions "cœur" partagées (loaders/savers Firestore, calculs du
  coach `computeStandardTarget`/`computeStandardWeight`, `escapeHtml`/
  `escapeJsAttr`, `confirmModal`, `createStore`, etc.) — pas une exigence
  systématique sur les ~167 fonctions du fichier, seulement celles dont le rôle
  n'est pas évident au premier coup d'œil

