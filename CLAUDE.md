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

## Incident production (PWA bloquée / pertes de données silencieuses)
Deux symptômes rapportés sur un appareil différent du principal (streak à 0 et
sélection du jour revenue en arrière après fermeture/rechargement, PWA restée
bloquée sur une ancienne version malgré un rechargement classique). Le
`service-worker.js` avait déjà `skipWaiting()`/`clients.claim()`/purge des
anciens caches/réseau-first pour le HTML — donc pas un oubli de ces bonnes
pratiques de base. Root cause non reproduite avec certitude (pas d'accès aux
logs de l'appareil concerné), mais deux failles réelles et confirmées par la
revue de code :
- **Échecs d'écriture Firestore totalement silencieux** : chaque `saveX()`
  catchait déjà ses erreurs, mais seulement via `console.error` — invisible
  pour l'utilisateur. Si `enablePersistence()` échoue sur un appareil (onglets
  multiples, navigation privée, quota IndexedDB, certaines PWA iOS...) — déjà
  best-effort, catché en `console.warn` — chaque écriture doit atteindre le
  réseau AVANT de survivre à une fermeture de l'appli ; fermer l'appli juste
  après avoir validé un défi peut alors perdre cette écriture sans AUCUN
  signal. **Corrigé** : `reportSaveError()` affiche désormais un toast quand
  un échec survient EN LIGNE (hors ligne, Firestore rejoue déjà tout seul,
  pas la peine d'alarmer) ; `firestorePersistenceEnabled` (booléen, mis à jour
  par le `.then()`/`.catch()` de `enablePersistence()`) est diagnostiqué dans
  Paramètres > Dépannage.
- **Aucun filet de secours pour une PWA restée bloquée** : `forceAppUpdate()`
  (Paramètres > Dépannage) désenregistre tous les service workers +vide tout
  le Cache Storage + recharge — un "vider le cache" du navigateur ne touche
  pas forcément ces deux zones de stockage séparées sur toutes les plateformes
  (notamment PWA "ajoutée à l'écran d'accueil" sur iOS). En complément,
  `registration.update()` est maintenant aussi appelé à chaque retour au
  premier plan (`visibilitychange`), pas seulement au chargement — une PWA
  restée ouverte des jours entiers sans navigation complète ne déclenchait
  sinon jamais l'heuristique de vérification du navigateur. `CACHE_NAME` bumpé
  (`v3` → `v4`) pour purger les anciens caches sur les appareils qui reçoivent
  la mise à jour.
- **Non vérifiable depuis ce dépôt** : les règles de sécurité Firestore ne sont
  pas versionnées ici (gérées côté console Firebase). Si un écran d'écriture
  échoue précisément à cause des règles (ex: validation de champ pensée pour
  l'ancien modèle une-clé-par-doc, incompatible avec le nouveau document
  consolidé `appData`), ce serait désormais visible via le toast d'erreur
  ci-dessus au prochain incident — à vérifier côté console si le problème
  revient.

**RÉCIDIVE déjà vécue une fois (`v4`), ne PAS refaire l'erreur** : `styles.css`,
`exercise-data.js` et `exercise-pictograms.js` sont des fichiers "cache-first
avec remplissage" côté service worker (voir plus bas) — **jamais revalidés
contre le réseau une fois en cache**. Modifier l'un de ces 3 fichiers SANS
bumper `CACHE_NAME` dans `service-worker.js` laisse tout appareil ayant déjà
mis ces fichiers en cache continuer d'utiliser l'ANCIENNE version pour
toujours, même après un rechargement classique — un nouveau HTML généré pour
de nouvelles classes CSS, combiné à un vieux `styles.css` qui ne les définit
pas encore, ressemble exactement à "aucun style appliqué, texte brut qui
flotte". **Réflexe systématique : toute modification de `styles.css`,
`exercise-data.js` ou `exercise-pictograms.js` DOIT s'accompagner d'un bump de
`CACHE_NAME`** (`v4` → `v5` etc.) dans le même commit — sinon le bug est
invisible en local (le harnais de test ne passe jamais par le service worker)
et n'apparaît qu'en production, sur les appareils déjà visités.

## Architecture de navigation
Barre d'onglets fixe en bas (4 onglets, variable `activeTab`) :
`today` (accueil + fiche défi) / `history` / `library` (gestion défis) / `account`.
Navigation interne (retour Android/PWA) gérée via l'History API :
`pushNavState()` + `goBackOneLevel()` (popstate). Les onglets eux-mêmes ne
poussent PAS d'état d'historique (pairs, pas une pile) ; seuls les écrans
imbriqués dans un onglet (fiche défi, formulaire, sous-écran bibliothèque,
mode focus) le font.

**Raccourcis PWA** (`manifest.json` → `shortcuts`, appui long sur l'icône) :
`?tab=library`/`?tab=history` sur `start_url`. `applyShortcutTabFromUrl()` (appelée
dans `startApp()` juste après `loadAppData()`) lit `?tab=...`, affecte `activeTab`
**directement** (pas `switchTab()`, dont les effets de bord — vibration, reset du
timer — sont pensés pour un changement d'onglet interactif, pas un démarrage),
puis nettoie l'URL via `history.replaceState()` pour qu'un rechargement manuel
ultérieur ne re-déclenche pas la même redirection.

**Bouton retour minimaliste** (`.nav-back-btn`, icône `‹` seule, cercle
`rgba(255,255,255,0.08)`) : filet de secours car le geste natif "glisser depuis
le bord gauche" n'est pas fiable à 100% sur iOS/Safari. Toujours relié à
`history.back()` (jamais un appel direct à `goBackOneLevel()`, pour rester
symétrique avec le bouton retour physique/`popstate`). Présent sur la fiche
défi (`.floating` — `position:fixed` en haut à gauche, superposé au hero, car
cet écran n'a pas d'en-tête de flux), Paramètres et le formulaire de défi
personnalisé (sans `.floating`, dans le flux, au-dessus du titre).

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

## Communauté (en cours — fondations livrées, UI à venir)
Objectif : dimension communautaire/virale (défi du jour partagé, classement, jauge
collective "Boss Battle") **sans aucun backend** — décision explicite de l'utilisateur
après proposition détaillée (voir plan `generic-riding-gizmo.md`). Conséquences :
- **Génération déterministe** (`hashStringToSeed`/`mulberry32`/`pickDeterministic`,
  `index.html` juste après `daysBetween`) : le défi du jour
  (`getDailyCommunityChallenges(dateStr)`) et la cible hebdo du Boss Battle
  (`getWeeklyBossBattleTarget(weekStartStr)`) sont calculés indépendamment par CHAQUE
  client, seedés par la date/le lundi de la semaine (`mondayOfWeek()`) — tous les
  clients qui évaluent la même seed obtiennent EXACTEMENT le même résultat, sans
  écriture ni lecture Firestore. Le défi 1 est toujours filtré sur
  `cat === 'Gainage / Core'`, jamais un autre filtre.
- **Classement/jauge collective = écritures client directes**, protégées par des
  règles de sécurité Firestore qui bornent les valeurs (jamais de decrease, delta
  plafonné par écriture) plutôt que par une validation serveur. Un utilisateur
  technique pourrait forger de fausses données ; risque assumé pour une app fitness
  sans enjeu financier. Ne jamais réintroduire de Cloud Function sans en rediscuter
  avec l'utilisateur d'abord (changement d'architecture, pas un détail d'implémentation).
- **Nouvelles collections Firestore top-level, additives** (`leaderboard/{uid}`,
  `community/...`) — ne touchent jamais `users/{uid}/kv/*`. Règles de sécurité
  exactes à ajouter dans la console Firebase : voir le plan `generic-riding-gizmo.md`.
- **Mock Firestore générique du harnais de test** (`tests/app.test.js`,
  `makeMockCollection`) : contrairement à la chaîne `users/kv/appData` existante
  (mock dédié, inchangé), toute nouvelle collection top-level (`leaderboard`,
  `community`) passe par ce mock générique qui simule `get`/`set({merge})`/
  `FieldValue.increment`/`where`/`orderBy`/`limit`/`startAt`/`count()`/`onSnapshot`/
  sous-collections/`add()`. Volontairement scopé aux formes de requêtes réellement
  utilisées ici, PAS un émulateur Firestore général. `__resetCommunityMocks()` vide
  tout entre les tests. `onSnapshot` déclenche son callback de façon **asynchrone**
  même pour l'état initial (fidèle au vrai SDK) : un test qui s'abonne doit laisser
  passer au moins un tick de microtask avant de lire la valeur reçue.

**Pilier 1 livré (défi du jour + Hero Banner)** : `renderCommunityHeroBanner()`
remplace `renderTodayEmptyState()` par défaut sur l'accueil (branche `today` sans
`currentChallengeId`, quand `activeToday` est vide) — le repli sur l'ancien écran
vide n'existe plus qu'en cas d'échec de résolution des défis (bibliothèque vide).
`acceptCommunityChallenge(id)` réutilise `toggleActiveToday()` telle quelle, pas de
chemin de données parallèle. La preuve sociale (`communityDailyCounts`, tenue à
jour par `startCommunityDailyListener()` via `onSnapshot`) reste visible même après
acceptation via `.community-card-ribbon` sur la carte (`renderChallengeCard`,
mode `'today'` uniquement). `registerCommunityCompletionIfNeeded()` (appelée dans
`addSet()`) incrémente le compteur partagé une seule fois par défi/par jour via
`state.communityCounted` — **nécessaire** : `undoLast()` peut repasser
`entry.done` à `false`, donc un cycle annuler/revalider peut redéclencher
`willComplete` le même jour pour le même défi ; sans cette garde, la preuve
sociale communautaire serait gonflable artificiellement.

**Hero Banner : un seul compteur de "participants", pas un par exercice** —
`communityDailyCounts.participants` (champ `participants` du doc
`community/dailyChallenge_{date}`) est un compteur **distinct** de
`completions1`/`completions2` : il mesure combien de membres ont cliqué sur
"Relever le défi communautaire du jour" (`acceptAllCommunityChallenges()`), PAS
combien ont fini les 2 exercices. Affiché UNE SEULE FOIS en haut de la carte
(`.community-hero-proof`) — avant, le Hero Banner répétait la preuve sociale sous
chaque exercice avec des chiffres différents (`completions1`/`completions2`), ce qui
créait une confusion ("3 ont validé l'un, 7 l'autre — combien au total ?").
`registerCommunityParticipantIfNeeded()` incrémente une seule fois par jour via
`state.communityJoined`, persisté par un `saveState()` explicite (ce flag vit dans
`state`, pas dans `activeToday` : sans cette sauvegarde, un rechargement de page
aurait permis de recompter la même participation). Le ruban `.community-card-ribbon`
dans la bibliothèque, lui, continue d'afficher `completions1`/`completions2` par
exercice (préservé tel quel — c'est un contexte différent, une fiche par exercice).

**Pilier 2 livré (classement + onglet Communauté)** : 5ᵉ onglet `community`
(`renderTabBar()`/dispatch dans `render()`), écran `renderCommunityScreen()` avec 3
vues (`streaks`/`weekly`/`alltime`, `communityLeaderboardView`) et une barre de rang
fixe (`.rank-bar`, au-dessus de la tab-bar) montrant le rang exact + 2 voisins de
chaque côté. `xpWeekly`/`xpWeekStart` (nouveau champ séparé `appData.xpWeeklyData`,
jamais fusionné dans `xpTotal`) suivent le même mécanisme de reset hebdomadaire que
`lastShieldResetWeek` (comparaison à `mondayOfWeek(new Date())`). `awardXp()` et
`saveStreakData()` appellent `syncLeaderboardEntry()` (écrit UNIQUEMENT
`leaderboard/{uid}`, jamais `appData` — nom/photo/streak/XP publics seulement, rien
de privé) ; `leaderboardOptOut` (toggle Paramètres, défaut désactivé = participation
active) fait un no-op silencieux côté sync ET supprime le document existant côté
`toggleLeaderboardOptOut()` (pas juste ignoré en lecture, pour ne laisser aucune
trace publique).

**Masquage intelligent de la barre de rang + empty state d'invitation** — `.rank-bar`
ne s'affiche QUE si mon rang n'est pas déjà visible dans `communityLeaderboardTop`
(garde `meAlreadyVisible = communityLeaderboardTop.some(e => e.uid ===
currentUser.uid)`, `renderCommunityScreen()`) : avec une petite communauté, le top
affiché (limite 20) contient déjà tout le monde, donc la barre ancrée dupliquait ma
propre ligne (2× "#1 moi" superposées). Sous la liste, une carte
`.community-invite-card` ("Inviter des proches pour pimenter le classement ⚡" +
bouton `shareCommunityInvite()`) apparaît tant que `communityLeaderboardTop.length <
3` — `shareCommunityInvite()` utilise `navigator.share` si disponible, sinon copie
dans le presse-papiers + toast (jamais d'échec silencieux).

**`fetchMyRankAndNeighbors()` : PAS de `.count()`, corrigé après un vrai bug de prod** —
la première version utilisait une requête d'agrégation `count()` pour le rang exact ;
`TypeError: ...count is not a function` observé en production a confirmé que cette API
n'est PAS disponible sur le SDK Firestore **compat** 10.13.0 réellement chargé ici
(malgré la doc officielle qui la présente comme disponible côté SDK modulaire). Ne
JAMAIS réintroduire `.count()` sur une requête compat sans revérifier en conditions
réelles. Remplacé par UNE lecture ordonnée complète de la vue (`orderBy(field).get()`,
sans `limit`) + calcul du rang/des voisins par position dans le tableau côté client —
réutilise exactement la même requête/le même index composite que `fetchLeaderboardTop()`
(une seule vue "Hebdo" à indexer, pas deux). Limite assumée : le coût (lectures) grandit
avec la taille TOTALE du classement, pas seulement le nombre affiché — acceptable pour
une communauté de taille modeste, à revoir si le classement grossit beaucoup.

**Pilier 3 livré (Boss Battle)** : contrairement au schéma initial du plan, le doc
partagé `community/bossBattle_{weekStart}` (`bossBattleDocRef()`) ne stocke QUE
`currentProgress` — `targetChallengeId` reste toujours re-dérivé de façon pure/
déterministe (`getWeeklyBossBattleChallenge()`), ce qui élimine tout risque de course
à l'initialisation ("qui écrit l'exercice en premier cette semaine ?"). `addSet()`
appelle `registerBossBattleContributionIfNeeded()` TÔT (avant le calcul de
`willComplete` — chaque série loggée contribue, pas seulement la complétion du défi),
qui incrémente à la fois `currentProgress` et un agrégat `dailyContributors/{date}_{uid}`
(sert uniquement au badge "Contributeur du jour", `fetchTopContributorToday()`).
`startBossBattleListener()` détecte le franchissement de la cible en comparant la
valeur EN MÉMOIRE avant/après (`previous < target && next >= target`) — ne se
déclenche donc qu'une fois par session au moment réel du franchissement, jamais en
rouvrant l'app sur une cible déjà atteinte. `handleBossBattleVictory()` écrit
`bossBattleArchive/{weekStart}` (Temple de la renommée, batch 5) en vérifiant d'abord
que le document n'existe pas (`existing.exists`) — **nécessaire** : si 2 utilisateurs
sont actifs au moment exact du franchissement, leurs 2 clients détectent chacun la
victoire et appellent `handleBossBattleVictory()` en parallèle ; sans cette garde, le
second écraserait l'archive du premier avec une progression finale différente.

**Cible adaptative du Boss Battle (`targetAmount`)** : n'est plus une constante fixe
(`challenge.target × 500`, irréaliste dès que peu d'utilisateurs sont actifs) mais
calculée à partir du résultat RÉEL de la semaine précédente
(`computeWeeklyBossBattleTarget()`) :
```
ratio = currentProgress_semaine_precedente ÷ target_du_defi_de_la_semaine_precedente
targetAmount = round(max(2, ratio × 1.15) × target_du_defi_de_CETTE_semaine)
```
Le `ratio` est un nombre **sans unité** ("combien de fois l'objectif journalier
standard d'une personne, cumulé sur la semaine") — **indispensable** pour ne jamais
comparer des nombres bruts entre 2 défis différents : deux exercices n'ont pas le même
volume naturel (ex: squats vs pompes), et reps/secondes (ex: Gainage) ne sont de toute
façon jamais comparables directement. On divise TOUJOURS par le target du défi DE LA
SEMAINE QUI A PRODUIT LE NOMBRE, puis on reconvertit dans l'unité du défi de la
semaine EN COURS — piège déjà identifié en revue : diviser/multiplier par le mauvais
target (celui de la mauvaise semaine) casse silencieusement la normalisation. Plancher
`× 2` si aucun historique (1ère semaine, ou lecture échouée).

**Conséquence architecturale : n'est plus pure/synchrone**, contrairement au reste des
fonctions de génération déterministe — nécessite UNE lecture Firestore (le document,
immuable, de la semaine précédente, jamais une requête de comptage). Mis en cache dans
`communityBossBattleTargetCache` (`{weekStart, targetChallengeId, targetAmount}`),
rafraîchi une fois par semaine via `refreshWeeklyBossBattleTargetCache()` (appelée
dans `continueStartApp()`, **avant** `startBossBattleListener()` qui dépend de la
version synchrone `getWeeklyBossBattleTarget()` pour détecter le franchissement).
Cette dernière renvoie `null` tant que le cache n'a pas encore été résolu pour la
semaine demandée (ou s'il contient la valeur d'une AUTRE semaine) — tous les appelants
gèrent déjà ce cas comme "rien à afficher/compter pour l'instant". Aucune course entre
clients à gérer malgré l'aspect "calculé" : le document source (semaine précédente,
terminée) est immuable, donc chaque client calcule indépendamment exactement la même
valeur — contrairement à `bossBattleArchive`, pas besoin de la stocker/protéger
côté serveur.

**⚠️ Règles de sécurité Firestore requises (hors de ce dépôt)** : les collections
`leaderboard`/`community`/`bossBattleArchive` (+ sous-collections `dailyContributors`/
`contributions`) ne fonctionneront PAS en production tant que des règles Firestore
autorisant leur lecture/écriture n'auront pas été ajoutées dans la console Firebase
(texte exact dans le plan `generic-riding-gizmo.md`, à étendre pour `bossBattleArchive`
en `allow create` seul, jamais `update`) — les règles par défaut Firestore refusent
tout accès à une collection non explicitement autorisée. Le harnais de test ne peut
pas vérifier ça (mock local, pas de vraies règles).

**⚠️ Piège déjà vécu une fois sur ces règles, ne pas répéter** : les blocs `match
/leaderboard/{uid}`, `match /community/{docId}` et `match /bossBattleArchive/{weekId}`
doivent être des **frères** de `match /users/{userId}/{document=**}` (même niveau,
directement sous `match /databases/{database}/documents {}`) — PAS imbriqués à
l'intérieur du bloc `users`. En Firestore, l'imbrication d'un `match` suit le chemin
réel des documents, pas une organisation logique : ces 3 collections vivent à la
racine de la base, pas sous `users/{uid}/...`. Les imbriquer par erreur les laisse
sans règle réelle (toujours refusées) tout en semblant "rangé" visuellement.

**Fil des contributions individuelles (Boss Battle)** : `registerBossBattleContributionIfNeeded()`
écrit désormais, en plus de `currentProgress`/`dailyContributors`, un document PAR
évènement dans `community/bossBattle_{weekStart}/contributions/{autoId}` (jamais
fusionné, contrairement à `dailyContributors` qui est un agrégat) — alimente
`communityRecentContributions` (`startRecentContributionsListener()`, `onSnapshot`
sur `orderBy('at','desc').limit(20)`), affiché sur l'écran Communauté
(`.boss-battle-feed`) pour le FOMO en direct ("Untel vient d'ajouter X"). Nécessite la
même règle `dailyContributors` mais sur `contributions` (déjà dans le bloc `community`
ci-dessus).

**Ruban communautaire visible aussi dans la bibliothèque** : `getCommunityDailySlot(c.id)`
dans `renderChallengeCard()` n'est plus restreint à `mode === 'today'` — un utilisateur
parti "choisir son propre défi" (onglet Défis) doit pouvoir quand même repérer le(s)
défi(s) du jour communautaires en parcourant le catalogue, pas seulement une fois de
retour sur l'accueil.

**Hero Banner : un seul CTA active les 2 défis à la fois** : les 2 cartes du Hero
Banner sont désormais purement informatives (icône/nom/objectif/preuve sociale), sans
bouton chacune. Un unique gros bouton `.community-hero-accept-all-btn`
("Relever le défi communautaire du jour", au-dessus de "Choisir mon propre défi")
appelle `acceptAllCommunityChallenges()`, qui ajoute les 2 défis d'un coup dans
`activeToday` puis persiste/rend une seule fois — remplace l'ancien
`acceptCommunityChallenge(id)` par carte (supprimé), qui n'activait qu'UN SEUL des 2
défis et prêtait à confusion (l'utilisateur croyait avoir rejoint "le défi du jour" en
entier en cliquant une seule carte).

**Contraste du bouton "Choisir mon propre défi"** : `.community-hero-choose-btn`
utilisait `border: 1px solid var(--line)` + `color: var(--chalk-dim)` — ces 2 tokens
sont volontairement discrets ailleurs dans l'app (séparateurs, texte secondaire), mais
sur ce fond précis (`.community-hero-banner`, déjà semi-transparent) ils rendaient le
bouton quasi invisible, au point de ressembler à un bouton désactivé alors qu'il est
parfaitement cliquable. Remplacés par `rgba(255, 255, 255, 0.15)` (bordure) et
`var(--chalk)` (texte) — plus contrastés, réservés à CE bouton précis plutôt que de
retoucher `--line`/`--chalk-dim` globalement (qui restent corrects partout ailleurs).

**Bugs de production déjà rencontrés et corrigés sur le classement** :
- `deleteMyAccount()` supprimait les données `users/{uid}/kv/*` mais ignorait
  `leaderboard/{uid}` (créé après coup) — un compte supprimé puis recréé (nouvel uid
  Firebase, même compte Google) laissait une entrée fantôme trainer indéfiniment dans
  le classement (vécu : 2 lignes "même nom" visibles après suppression+recréation).
  Le `batch` de suppression inclut désormais aussi `leaderboard/{uid}`.
- `loadCommunityLeaderboard()` enveloppait `fetchLeaderboardTop()` et
  `fetchMyRankAndNeighbors()` dans un seul `Promise.all` : l'échec de l'UNE (ex: un
  souci propre à la requête d'agrégation du rang) effaçait aussi l'AUTRE alors qu'elle
  avait réussi — vécu en production ("personne à afficher" alors que des documents
  `leaderboard` existaient bel et bien). Chaque requête a maintenant son propre
  try/catch, indépendant.
- **Note test** : `deleteMyAccount()` n'a toujours aucune couverture par le harnais de
  test (pré-existant : nécessiterait de mocker `db.batch()` et une vraie requête sur
  la sous-collection `kv`, jamais fait). Le nouvel appel `batch.delete(leaderboard/{uid})`
  n'est donc validé que par relecture, pas par un test automatisé.

**Les 3 piliers sont livrés** (défi du jour + Hero Banner, classement 3 vues + onglet
dédié, Boss Battle + Temple de la renommée `fetchBossBattleArchive()`/
`renderHallOfFameSection()`, affiché sur l'écran Communauté seulement s'il existe déjà
au moins une victoire archivée — pas d'état "vide" traité comme une erreur). Points
non vérifiables par le harnais de test (mock DOM, pas un vrai navigateur), à confirmer
visuellement à l'usage réel : rendu de la tab-bar à 5 onglets sur un écran étroit.
(L'API d'agrégation `count()` mentionnée ici à l'origine s'est révélée indisponible en
production — voir plus haut, déjà corrigé.)

**Navigation : cliquer sur l'onglet déjà actif réinitialise sa pile** (`switchTab()`) —
avant, `if (tab === activeTab) return;` bloquait TOUT, y compris fermer une sous-vue
ouverte (fiche défi, formulaire, Paramètres) : cliquer "Aujourd'hui" depuis la fiche
détail d'un défi ne faisait rien. Ferme maintenant la sous-vue ET appelle
`history.back()` pour consommer l'entrée poussée par `pushNavState()` à l'ouverture —
sans ça, un bouton retour physique ultérieur se retrouverait désynchronisé (l'app déjà
à la racine, mais une entrée d'historique jamais consommée).

**Confidentialité : `formatDisplayName()`** (`"Prénom Nom"` → `"Prénom N."`, un seul mot
inchangé, idempotent) appliqué à l'ÉCRITURE dans `syncLeaderboardEntry()` et
`registerBossBattleContributionIfNeeded()` (dailyContributors + contributions) — le nom
complet n'atteint JAMAIS les collections communautaires partagées, lisibles par
n'importe quel autre utilisateur authentifié. Ré-appliqué aussi en filet de sécurité
dans `renderLeaderboardRow()`/`renderBossBattleSection()` (idempotent, sans danger) pour
tout document déjà écrit avant ce correctif — se corrige de lui-même à la prochaine
synchronisation de son auteur, sans backfill manuel nécessaire. `renderAccountSection()`
(écran Profil, visible uniquement par soi-même) garde volontairement le nom complet —
seuls les affichages PUBLICS (classement, Contributeur du jour, fil de contributions)
passent par `formatDisplayName()`.

**Bugs de production déjà rencontrés et corrigés sur le classement Hebdo** :
- Vue "Hebdomadaire" : nécessite un index composite Firestore (`xpWeekStart` + `xpWeekly`)
  — Firestore renvoie une erreur `FAILED_PRECONDITION`/"query requires an index" avec un
  lien direct de création tant qu'il n'existe pas. Normal, pas un bug : à créer une fois
  via ce lien (ou proactivement dans la console).

## Verrou d'installation PWA plein écran ("PWA First" strict)
**Décision produit assumée** (pas une simple incitation) : sur un navigateur classique
(non-standalone), l'installation sur l'écran d'accueil est un préalable OBLIGATOIRE
avant même l'écran de connexion — onboarding/création de compte/tour guidé n'ont lieu
que dans la version installée. S'applique à TOUT visiteur non-standalone, y compris un
compte déjà existant qui rouvrirait le site depuis un onglet/favori classique (validé
explicitement, pas une évidence : voir historique de conversation).

`#pwaInstallGate` (`z-index: 99998`, juste sous le filet de sécurité fatal à 99999)
recouvre TOUT le viewport dès `updatePwaInstallGate()` — appelée une fois,
inconditionnellement, tout en haut du script (avant même `firebase.initializeApp`
n'a d'importance : ne dépend d'aucun état d'auth). Bloque par construction toute
interaction avec `#loginScreen`/`#app` en dessous : **aucun besoin de "pauser" la
logique d'auth/Firestore** — elle continue de tourner en arrière-plan pour un
utilisateur déjà connecté, mais reste invisible/inatteignable derrière le recouvrement
opaque. `isRunningStandalonePwa()`/`isIosDevice()` réutilisées telles quelles
(`matchMedia('(display-mode: standalone)')`/`navigator.standalone`, iPad détecté via
`maxTouchPoints > 1` malgré un user-agent "Macintosh" depuis iPadOS 13).

**4 variantes de contenu** (`buildPwaInstallGateHtml()`) : iOS (guide 3 étapes
Partager → Sur l'écran d'accueil → Ouvrir l'app, pas de `beforeinstallprompt` sur
Safari), Android/Chrome (`deferredInstallPrompt.prompt()` via un gros bouton — après
acceptation, affiche un état "Application installée, ouvre l'icône" et ne referme
JAMAIS le verrou tout seul : l'utilisateur est encore dans l'onglet navigateur, pas
dans l'app standalone), **desktop** (`isDesktopDevice()` = ni iOS ni Android via
`/Android/i` sur le user-agent — **prioritaire même si `beforeinstallprompt` est
disponible**, Chrome desktop le supporte aussi, mais le message "installe sur mobile"
n'a de sens que sur ordinateur) avec une échappatoire `.gate-debug-bypass-btn`
**volontairement quasi invisible** (petit lien en coin, opacité 0.35, sert au
développement/débogage — jamais mis en avant comme une vraie option), et un **repli
générique mobile + échappatoire normale** (`.gate-bypass-btn`) pour tout navigateur
MOBILE qui ne proposera jamais d'installation PWA réelle (Firefox mobile, navigateur
intégré d'une app tierce type Instagram/TikTok) — validé explicitement avec
l'utilisateur : sans cette échappatoire (`bypassPwaInstallGate()`, commune aux 2 replis),
ces visiteurs resteraient bloqués sans aucune issue.

**Remplace l'ancienne bannière douce** (ancrée au-dessus de la tab-bar, fermable,
affichée seulement après le tour guidé) — devenue du code mort avec ce verrou strict
placé AVANT même la connexion : `hasSeenTour` ne peut désormais être vrai qu'après
être passé par la version installée, donc l'état où l'ancienne bannière s'affichait
ne peut plus jamais se produire. Supprimée entièrement plutôt que dupliquée
(`maybeShowPwaInstallBanner`/`dismissPwaInstallBanner`/`PWA_INSTALL_COOLDOWN_DAYS`/
`#pwaInstallBanner` et son CSS `.pwa-install-banner*`).

**Seule exception documentée à "pas de localStorage, tout passe par Firestore"** :
l'échappatoire du repli générique (`PWA_INSTALL_GATE_BYPASS_KEY`, mémorisée sans
expiration) est une préférence propre à CET APPAREIL/CE NAVIGATEUR (l'installation
elle-même l'est) — la stocker côté compte Firestore n'aurait aucun sens.

**Bug de test découvert et corrigé lors du lot précédent (bannière), toujours valable
ici** : `applyContent(animate=true)` diffère son swap DOM de 140ms via un vrai
`setTimeout` — un `render(true)` d'un test précédent peut laisser un swap différé
encore en attente, qui s'applique alors À TORT pendant le test suivant s'il vérifie un
état trop tôt après un appel similaire. **Si un futur test qui vérifie un état juste
après un `render(true)` devient flaky, suspecter ce même mécanisme avant toute autre
piste** (déjà corrigé une fois en portant une marge d'attente de test de 10ms à 300ms).

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
- **Champ de recherche/saisie live avec `oninput` → `render()`** : `applyContent()`
  remplace TOUT le innerHTML de `#app` à chaque appel, donc un `<input>` recréé à
  chaque frappe perdrait le focus du navigateur (saisie cassée, un seul caractère
  tapable à la fois) si rien ne le restaure. Voir le champ de recherche de l'onglet
  Défis (`updateLibrarySearch()`/`librarySearchInput`) : `render()` détecte AVANT
  `applyContent()` si `document.activeElement` est ce champ (+ sa position de
  curseur), puis un callback `afterRender` lui redonne le focus après coup. Tout
  nouveau champ de saisie qui déclenche un `render()` complet sur chaque frappe
  doit suivre le même filet, sinon même bug que le formulaire de profil déjà vécu.
- **Cartes de l'onglet Défis et animation d'entrée en cascade** : `.picker-item`
  a `animation: card-pop-in` par défaut (CSS), donc `applyContent()` recréant
  TOUTES les cartes à chaque `render()` rejouerait l'animation même pour un
  simple toggle d'activation dans un accordéon déjà ouvert (clignotement). Filet :
  `libraryAnimatingCat` (posé par `toggleLibraryCategory()` uniquement quand une
  catégorie passe de fermée à ouverte, jamais lors d'une simple mise à jour) +
  4ᵉ paramètre `animate` de `renderChallengeCard()` (classe CSS `.no-anim` sinon)
  — `renderLibraryScreen()` consomme le flag (le remet à `null`) à chaque rendu,
  donc seul CE rendu-là anime. Ne jamais faire animer `shouldAnimate` par défaut
  à `true` dans la boucle des catégories : ça réintroduirait le clignotement.
- **`confirmModal()` doit chercher ses boutons via `el.querySelector('#id')`,
  JAMAIS via `document.getElementById(id)`** : contrairement à
  `drainPopupQueue()` (protégé par `popupOpen`, une seule instance à la fois),
  `confirmModal()` n'a AUCUN garde-fou d'instance unique. Deux appels concurrents
  (ex: terminer 2 défis différents qui atteignent chacun 3 records d'affilée à
  quelques secondes d'écart, chacun via son propre `setTimeout(1400ms)` dans
  `addSet()`) créent deux `<div>` avec les MÊMES id `confirmModalConfirmBtn`/
  `confirmModalCancelBtn`. `document.getElementById()` renvoie alors le PREMIER
  élément en ordre du DOM (donc le popup le plus ancien, visuellement caché
  derrière le second) — les boutons du popup réellement affiché (le second,
  au-dessus) restent inertes (bug déjà vécu et corrigé : "les boutons ne
  déclenchent rien"). `el.querySelector(...)`, scopé à l'élément qu'on vient de
  créer, élimine cette ambiguïté par construction.
- **Roulettes de l'onboarding (âge/taille/poids) réinitialisées en plein
  défilement** : `profileDraft.age`/`heightCm`/`weightKg` n'étaient mis à jour
  qu'au clic sur "Suivant" (`profileNext()`), jamais pendant le défilement lui-
  même. Un re-render de l'écran d'onboarding pendant que l'utilisateur défile
  encore (`initWheelPickers()`, rejoué en `afterRender` à CHAQUE render())
  retombait donc sur le repli par défaut (175cm/75kg), écrasant le choix en
  cours. Cause du re-render intempestif : `initPullToRefresh()` n'avait aucune
  garde contre `showProfileOnboarding` — un simple défilement de roulette
  pouvait être mal interprété comme un geste de pull-to-refresh (l'écran
  d'onboarding ne scrolle pas au niveau de la page, `window.scrollY` reste à 0
  pendant tout le défilement). Double correctif : `onWheelPickerScroll()` écrit
  désormais `profileDraft[...]` EN DIRECT à chaque cran (pas seulement à la
  validation de l'étape), et `initPullToRefresh()` se désactive entièrement
  pendant `showProfileOnboarding`.
- **Ne JAMAIS utiliser l'emoji 📅 à côté d'une date affichée** : son dessin Apple
  (illustration historique d'iCal) grave en dur le texte "17 JUL" dans l'image —
  les utilisateurs croient alors que la date est bloquée au 17 juillet dès qu'il
  apparaît à côté d'une vraie date sélectionnée (`showDayDetailModal()`).
  Utiliser 🗓️ (spirale, aucune date dessinée) à la place.

## Accessibilité (base posée, pas un audit exhaustif)
`role="tablist"`/`role="tab"`/`aria-selected` sur la barre d'onglets,
`aria-label` sur les boutons/champs icône-seule sans texte visible (ex:
`add-custom-fab`, le champ de recherche Défis), `role="dialog" aria-modal="true"`
sur les overlays popup/`confirmModal`, `aria-live="polite"` sur le toast. Portée
volontairement limitée à ces points à fort impact/faible risque — étendre au cas
par cas plutôt que viser une conformité complète d'un coup.

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
- `// @ts-check` en première ligne de `exercise-data.js`/`exercise-pictograms.js`
  (types dérivés du JSDoc, ex: `@type {Record<string, string>}` sur
  `EXERCISE_ICON_BY_NAME`, `@param`/`@returns` sur `formatSecToReadable`/
  `formatTargetLabel`/`getExercisePictogramKey`) : VSCode l'exploite tout de
  suite dans l'éditeur, zéro dépendance/config supplémentaire. Volontairement
  PAS étendu au script principal (inline dans `index.html`, hors de portée d'un
  simple `@ts-check` sur un fichier HTML) ni vérifié en CI (pas de `typescript`
  dans `package.json` — vérification ponctuelle via `npx tsc --allowJs
  --checkJs --noEmit` au moment d'ajouter des types, pas un gate automatique)
- **Design system onboarding** (`renderProfileOnboardingScreen()` /
  `renderOnboardingTransitionScreen()`) : conteneur racine = TOUJOURS les deux
  classes ensemble, `class="profile-onboarding onboarding-screen"`
  (`.profile-onboarding` = modale plein écran `position:fixed`,
  `.onboarding-screen` = tout le layout flex/padding/fond). À l'intérieur,
  `.pf-header` (retour + points de progression) puis **un seul**
  `.onboarding-content` (`flex:1`, centre lui-même son contenu quel que soit le
  nombre de frères — plus besoin de variante "ancrée"/"centrée" séparée comme
  avant) puis, seulement sur les étapes qui en ont besoin (0, 1, 3 de
  `renderProfileOnboardingScreen()` + l'écran de confirmation), un
  `<button class="onboarding-cta">` en frère direct après `.onboarding-content`
  — jamais à l'intérieur. Pur flexbox, pas de `position:fixed/sticky`.
  Cartes/badges "glass" sur fond sombre (`rgba(255,255,255,0.04-0.05)` +
  bordure `rgba(255,255,255,0.08-0.1)`, jamais `var(--bg-card)`/`var(--line)`
  pleins pour ces éléments précis) : `.features-list`/`.feature-item` (écran
  bienvenue, icône dans `.feature-icon` teintée `rgba(57,233,122,0.1)` = accent
  en rgb, carré arrondi 12px PAS un cercle), `.coach-badge` (pilule discrète
  "Coach Virtuel IA" sur l'écran âge — jamais réintroduire un gros bloc/callout
  façon notice, ça compresse le reste de l'écran), `.preview-card`/
  `.preview-title`/`.preview-badge` (écran de confirmation, objectif RÉEL via
  `computeStandardTarget()` sur "Pompes" + `userProfile`, jamais une valeur
  fictive codée en dur, badge plein `var(--accent)` à droite). La carte est
  enveloppée dans `.preview-container` avec une étiquette `.preview-header-tag`
  ("💡 Exemple d'objectif généré") au-dessus + une note de bas d'écran
  `.pf-onboarding-footnote` — sans ça "Pompes" pouvait passer pour LE seul
  défi généré plutôt qu'un exemple parmi ceux qui attendent dans l'appli.
  `.preview-title` contient l'icône + `.exercise-info` (nom `.exercise-name` +
  sous-libellé `.exercise-sub` "Calibré selon ton profil" empilés), pas juste
  un nom seul.

