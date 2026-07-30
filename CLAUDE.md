# Défi du Jour — Contexte projet pour Claude Code

## Vue d'ensemble
PWA mono-fichier (`index.html`) de défis fitness quotidiens, en français, thème
sombre + accents vert néon. Déployée sur GitHub Pages, backend Firebase
(Auth Google + Firestore). Développée intégralement en conversation avec
Claude (claude.ai), ce fichier sert de relais de contexte pour continuer via
Claude Code.

## Fichiers du projet
- `index.html` — l'application entière (HTML/CSS/JS vanilla, ~4000 lignes, un seul fichier)
- `manifest.json` — manifeste PWA
- `service-worker.js` — cache réseau-first pour le HTML (permet la mise à jour de la PWA)
- `icon-192.png` / `icon-512.png` — icônes d'app
- `generate-static-frames.py` — script Python (Pillow) qui extrait la 1ère image
  de chaque PNG animé du dossier `exercices/` pour créer les versions statiques
  utilisées sur l'accueil (`nom-static.png`)
- `exercices/` — dossier d'images par exercice (voir section dédiée plus bas)

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
`dbGet(key)` / `dbSet(key, value)`.

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
- Toute nouvelle fonctionnalité doit être testée en isolant le bloc `<script>`
  et en l'exécutant avec `node -c` (syntaxe) puis un mock minimal de
  `document`/`window`/`dbGet`/`dbSet` (voir historique du projet pour le
  pattern de test utilisé)
- Jamais de `localStorage`/`sessionStorage` (interdit dans le contexte artifact
  d'origine, habitude conservée) — tout passe par Firestore
