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

**Cartes du Hero Banner : même format que l'onglet Défis** : `renderCommunityHeroBanner()`
réutilise désormais TELLES QUELLES les classes `.picker-item`/`.picker-item-body`/
`.name`/`.goal`/`.goal-weight` (mêmes que `renderChallengeCard()`, mode `'library'`) —
nom à gauche, reps/poids à droite — plutôt qu'une mise en page dédiée
(`.community-hero-card`/`.community-hero-info`/`.community-hero-name`/
`.community-hero-target`, supprimées). Le poids (`weights[c.id] ?? computeStandardWeight(...)`)
n'apparaît que pour les défis de catégorie `'Haltères'`, exactement comme sur les
cartes du catalogue. `no-anim` est posé sur ces cartes : sans cette classe, l'entrée
en cascade de `.picker-item` (`card-pop-in`) rejouerait à chaque mise à jour temps réel
de `communityDailyCounts` (`onSnapshot`), pas seulement au premier rendu.

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

## Hiérarchie visuelle écran d'exécution (+5/+10 vs saisie personnalisée)

**`.qa-btn` (+5/+10) est le CTA principal, `.custom-add-btn`/`.custom-add-row input`
sont volontairement secondaires (style ghost)** — avant ce correctif c'était
l'inverse : `.qa-btn` utilisait `var(--bg-raised)`/`var(--line)` (discret) tandis que
`.custom-add-btn` utilisait `var(--accent)` plein (donc visuellement PLUS mis en
avant que les boutons rapides), alors que +5/+10 doivent être la méthode
d'interaction privilégiée pendant l'effort. `.qa-btn` est maintenant en
`#00E676` (vert néon, PAS `var(--accent)` : volontairement une valeur dédiée, plus
vive, réservée à ce CTA précis) ; `.custom-add-btn` et `.custom-add-row input` sont en
`rgba(255,255,255,0.08)` + bordure fine `rgba(255,255,255,0.12)`, texte
`var(--chalk-dim)`. `box-shadow` volontairement DISCRET
(`0 2px 8px rgba(0,230,118,0.18)`) : une 1ère version plus prononcée
(`0 4px 16px rgba(0,230,118,0.35)`) a été jugée fatigante pour les yeux — ne pas
réaugmenter sans qu'on le redemande explicitement.

## Bug corrigé : désynchronisation objectif carte accueil / fiche détail

`renderChallengeCard()` avait DEUX chemins de calcul de l'objectif affiché pour le
même défi actif : le libellé `.goal` (toujours visible sous le nom) utilisait
`resolved.target` (objectif STANDARD, recalculé par `resolveChallenge()`), tandis que
la ligne `.status-progress` ("En cours — X/Y", visible seulement après la 1ère série)
et la fiche détail (`getTarget()`) utilisaient `entry.targetOverride || resolved.target`
(objectif DU JOUR, modifiable via le crayon ✏️ `editTarget()`). Résultat : dès qu'un
utilisateur modifiait son objectif du jour sur la fiche détail, la carte d'accueil
continuait d'afficher l'ancien objectif standard à côté du nom — deux chiffres
différents pour le même défi, sur deux écrans différents. Corrigé en calculant UNE
seule fois `displayTarget = (todayEntry && todayEntry.targetOverride) || resolved.target`
en haut de `renderChallengeCard()`, réutilisé par le libellé `.goal` ET la ligne
`.status-progress`. En mode `'library'` (catalogue, pas de notion de "jour en cours"),
`todayEntry` reste `null` et `displayTarget` retombe sur l'objectif standard, comme
avant — inchangé volontairement, pas un contexte où l'objectif du jour a un sens.

**Ce premier correctif était réel mais INCOMPLET** : l'utilisateur a signalé le MÊME
symptôme (accueil vs bibliothèque/fiche détail) alors qu'il n'avait JAMAIS modifié
d'objectif du jour (donc `entry.targetOverride` était `null` des deux côtés — le
correctif ci-dessus n'y était pour rien). Cause réelle, distincte : dans `render()`
(branche `today` sans `currentChallengeId`), `activeChallenges` était construit via
`CHALLENGES.filter(...).map(resolveChallenge)` — déjà résolu — puis passé tel quel à
`renderChallengeCard()`, qui appelle `resolveChallenge(c)` **une 2ᵉ fois** en interne.
`computeStandardTarget()` traite alors `c.target` (déjà mis à l'échelle par
niveau/âge/sexe/IMC) comme s'il s'agissait de l'objectif BRUT de la bibliothèque, et
réapplique les mêmes coefficients PAR-DESSUS → objectif gonflé sur l'accueil
uniquement (le mode `'library'`, lui, passe des défis BRUTS filtrés directement dans
`CHALLENGES`, donc une résolution unique). Exemple concret signalé : Pompes (objectif
standard 110 avec un profil donné) affichait 110×1.1≈120 sur l'accueil. Corrigé en
retirant le `.map(resolveChallenge)` de `activeChallenges` — `renderChallengeCard()`
reste l'unique endroit qui résout, quel que soit le mode. Piège à ne pas réintroduire :
ne JAMAIS pré-résoudre un défi avant de le passer à `renderChallengeCard()`/
`resolveChallenge()`, qui ne sont pas idempotents sur un objectif déjà résolu.

## Pseudo public obligatoire (chantier amis/fil d'activité/kudos, batch 2/6)

Premier étage d'un chantier plus large (voir plan) : pseudo public choisi à la création
du compte (jamais optionnel), permettant une recherche exacte sans jamais exposer le
vrai nom (contrairement à `formatDisplayName()` qui l'anonymise). Modèle :
`usernames/{pseudoEnMinuscules}` = `{ uid }` — le pseudo est TOUJOURS stocké/affiché en
minuscules (pas de casse préservée séparément, volontairement simple), sanitizé À LA
FRAPPE (`sanitizeUsernameInput()` : `[a-z0-9_]` uniquement, 3-20 caractères, aucun
caractère invalide ne peut même être tapé) plutôt que validé après coup.

**`usernameSetupMode` (`null | 'onboarding' | 'gate' | 'rename'`)** distingue 3 contextes
d'un seul et même écran (`renderUsernameSetupScreen()`) :
- `'onboarding'` : nouveau compte, juste après le questionnaire de profil
  (`finishProfileOnboarding()` route ici si `!username` au lieu d'enchaîner directement
  sur `beginOnboardingTransition()` — fonction extraite de l'ancien corps de
  `finishProfileOnboarding()` pour être réutilisable depuis `finishUsernameSetup()`).
- `'gate'` : compte déjà onboardé mais créé avant cette fonctionnalité — `startApp()`
  bloque (verrou plein écran) juste après le check `!userProfile` existant, avant
  `proceedAfterProfile()`.
- `'rename'` : déclenché depuis Paramètres (`openUsernameRename()`), seul contexte
  dismissible via le bouton retour (`goBackOneLevel()` ne referme QUE ce mode —
  `'onboarding'`/`'gate'` sont volontairement infranchissables, même philosophie que
  `#pwaInstallGate`).

Les 3 contextes convergent dans `finishUsernameSetup()` : réserve le nouveau pseudo
(`usernames/{lower}.set(...)`, PAS de merge — un échec ici, ex. pris entre-temps par
quelqu'un d'autre côté vraies règles Firestore, retombe proprement sur l'état "taken"),
libère l'ancien si renommage (`previousUsername !== newUsername`), persiste
`username` via `saveAppField()`, puis route selon le contexte d'origine :
`beginOnboardingTransition()` / `proceedAfterProfile()` / simple fermeture d'écran.

**Piège évité dans le branchement `'gate'`** : la première version appelait `render(true)`
juste avant `await proceedAfterProfile()`. Comme `applyContent(animate=true)` DIFFÈRE le
swap DOM réel de 140ms (`setTimeout`, cf. avertissement plus haut sur les tests
intermittents), ce `render(true)` programmait un repaint périmé qui s'exécutait ~140ms
*après* le vrai render (immédiat, `animate` par défaut) déclenché par
`continueStartApp()` à la fin de `proceedAfterProfile()` — écrasant l'app fraîchement
chargée avec le contenu du verrou déjà fermé. Corrigé en supprimant ce `render(true)`
intermédiaire, inutile (rien à afficher entre la fermeture du verrou et le prochain
render réel).

**Vérification en direct de la disponibilité** (`updateUsernameDraft()` → debounce
400ms → `checkUsernameAvailability()`) : `usernameCheckSeq` (incrémenté à chaque
frappe) évite qu'une vérification périmée (réseau plus lent, déclenchée par une frappe
précédente) n'écrase le résultat d'une vérification plus récente. Le champ
`#usernameSetupInput` réutilise EXACTEMENT le filet de restauration du focus/curseur du
champ de recherche Défis (`render()` capture `document.activeElement`/`selectionStart`
avant `applyContent()`, les restaure dans le callback `afterRender`) — sans ça,
`render()` appelé à chaque frappe (pour la vérif en direct) ne laisserait taper qu'un
seul caractère à la fois.

**Leçon de test importante** : un test qui appelle le VRAI `startApp()` (pour tester le
verrou `'gate'` tel qu'il se déclenche réellement) déclenche `loadAppData()`, qui
ÉCRASE en mémoire une bonne quinzaine de globals (`badges`, `stats`, `xpTotal`,
`customChallenges`, `weights`, etc.) avec l'état le plus récemment PERSISTÉ dans
`__appDataStore` (partagé par TOUT le fichier de test) — potentiellement périmé par
rapport aux mutations directes faites par des tests précédents qui n'appellent pas
systématiquement `saveX()` à chaque étape. Observé concrètement : un test XP bien plus
loin dans le fichier recevait un bonus de trophée inattendu (+100 XP), causé par cette
contamination silencieuse. Tout futur test qui appelle `startApp()`/`loadAppData()` au
milieu du fichier DOIT snapshotter (clone JSON) puis restaurer l'intégralité de ces
globals + `__appDataStore.data`/`.exists` — voir le test "pseudo public obligatoire"
pour le patron exact à copier.

## Amis (demande mutuelle) — batch 3/6 du chantier amis/fil d'activité/kudos

`friendships/{uidA}_{uidB}` (uidA/uidB **triés lexicographiquement**, `friendshipPairId()`)
= UN SEUL document par paire, jamais besoin d'écrire dans le document personnel de
l'autre utilisateur — c'est la décision de conception la plus importante de ce batch :
une alternative "ajouter chacun à un tableau `friendUids` sur le profil de l'autre"
aurait exigé d'accorder à n'importe quel utilisateur authentifié le droit d'écrire
dans le document personnel d'un autre (surface de règles Firestore beaucoup plus
risquée). `friendRequests/{fromUid}_{toUid}` (`friendRequestId()`) : ID déterministe —
permet un `exists()` direct dans les règles (sans query), et empêche naturellement le
double-envoi (`create` sur un ID déjà existant échoue).

**`acceptFriendRequest(fromUid)`** : `db.batch()` (1ᵉʳ vrai usage produit, après son
ajout au mock au batch 1) — crée `friendships/{paire}` ET supprime
`friendRequests/{from}_{to}` en un seul `commit()` atomique. **`declineFriendRequest()`**
supprime juste la demande (aucune trace). **`removeFriend()`** passe par `confirmModal()`
(7ᵉ site du projet à l'utiliser, cf. test de comptage exact des sites `await
confirmModal({` — à incrémenter à chaque nouveau site, sinon ce test échoue par
construction) puis supprime le document `friendships` partagé.

**Recherche = exact uniquement, jamais de préfixe/autocomplete** (`submitFriendSearch()`,
déclenché par un bouton, pas par la frappe — contrairement au check de disponibilité du
pseudo qui, lui, est bien live/debounced) : `usernames/{pseudo}.get()` → uid → 
`fetchPublicProfile(uid)`. Cette dernière réutilise `leaderboard/{uid}` comme source
d'affichage (avatar + `formatDisplayName()`) — **effet de bord volontaire** : un
utilisateur qui a désactivé le classement (`leaderboardOptOut`, qui supprime son
document `leaderboard`) devient de facto introuvable/non affichable dans la recherche
d'amis aussi. L'opt-out classement vaut opt-out découverte, plutôt que 2 réglages de
vie privée séparés à maintenir en cohérence.

**Badge de notification** (`.friends-btn`/`.friends-badge`, en-tête
`renderCommunityScreen()`) : `incomingFriendRequests` est chargé au DÉMARRAGE
(`continueStartApp()` appelle `refreshFriendsData()` sans l'attendre — juste pour ce
badge, ne doit jamais bloquer le premier rendu), pas seulement à l'ouverture de l'écran
Amis, sinon l'utilisateur ne remarquerait jamais une demande reçue sans ouvrir l'écran
en question.

## Fil d'activité global (amis) — batch 4/6 du chantier amis/fil d'activité/kudos

`activityFeed/{autoId}` : UN document PAR défi **complété** (`addSet()`, dans le bloc
`if (willComplete)`, juste après `registerCommunityCompletionIfNeeded()`) — **jamais par
série**, contrairement à `registerBossBattleContributionIfNeeded()` (Boss Battle) qui
compte chaque série pour la jauge collective. Un fil qui vibrerait à chaque répétition
loggée serait bien trop bruyant ; seule la ligne d'arrivée compte ici. `kudosCount: 0`
est déjà initialisé à l'écriture (batch kudos à venir).

**Lecture filtrée par amis, jamais un fil public** (`startActivityFeedListener()`) :
`activityFeed.where('uid', 'in', mesAmisUids.slice(0, 30)).orderBy('at', 'desc').limit(30)`.
Le `.slice(0, 30)` reflète la limite dure de Firestore sur la taille d'un tableau
`'in'` — largement suffisant pour une liste d'amis personnelle. **Garde
obligatoire** : Firestore rejette un `where(champ, 'in', [])` avec un tableau vide (pas
juste "aucun résultat", une vraie erreur) — `startActivityFeedListener()` court-circuite
donc AVANT toute requête si `myFriends` est vide (`communityActivityFeed = []` direct,
état vide dédié côté rendu). Ce garde-fou n'est pas vérifiable par le harnais de test
(le mock accepte un tableau vide sans broncher, contrairement au vrai SDK) — à garder en
tête si ce code est un jour retouché sans repasser par la prod.

**Redémarrage du listener à chaque changement d'amis** : `refreshFriendsData()` appelle
`startActivityFeedListener()` en toute fin (après avoir mis à jour `myFriends`) — un
nouvel ami accepté élargit immédiatement le filtre `'in'`, un ami retiré le réduit.
`startActivityFeedListener()` désabonne systématiquement l'ancien listener en premier
(`communityActivityFeedUnsub`), même pattern que les autres listeners communautaires.

**2 états vides distincts, pas le même message** (`renderActivityFeedSection()`) :
"aucun ami" (CTA `openFriendsScreen()` — la cause est un manque d'amis) vs "amis mais
aucune activité récente" (message neutre — la cause est juste l'inactivité récente du
groupe). Confondre les deux serait trompeur : le 2ᵉ cas n'a pas besoin qu'on pousse
l'utilisateur vers l'écran Amis, il en a déjà.

## Kudos 👏 — batch 5/6 du chantier amis/fil d'activité/kudos (chantier complet)

2 mécanismes distincts selon ce qui est "kudos-able" :

- **Événementiel** (fil d'activité + contributions Boss Battle) : 1 kudos PERMANENT par
  votant et par événement, retrait possible (2ᵉ tap = retire, symétrie avec Strava sur
  une activité). `giveKudosToEvent(docRef)`/`removeKudosFromEvent(docRef)` sont
  **génériques, paramétrées par la référence du document** — réutilisées telles quelles
  sur `activityFeed/{id}` ET `community/bossBattle_{semaine}/contributions/{id}` (même
  forme exacte : `kudosCount` sur le doc parent + sous-collection `kudosBy/{voterUid}`),
  plutôt que dupliquées. `communityRecentContributions` (fil Boss Battle) a dû être
  corrigé pour inclure `id: d.id` (jusqu'ici `snap.docs.map(d => d.data())` jetait
  l'ID du document, indispensable pour cibler un kudos précis).
- **Personne** (classement) : 1 kudos par JOUR et par cible
  (`kudosGiven/{jour}_{votant}` — l'ID intègre déjà la date, donc AUCUN code de reset à
  écrire, demain = un nouveau doc), cumul affiché à vie (`kudosTotal`), **pas de
  retrait** (décision assumée : plus simple, moins de valeur qu'un like sur un
  événement ponctuel). `giveKudosToPerson(targetUid)`, jamais sur soi-même.

**`db.runTransaction()` (1ᵉʳ vrai usage produit, mock ajouté au batch 1)** pour les 3
actions : lit la preuve d'un kudos déjà donné, **avorte sans écrire** si c'est déjà le
cas (ou si rien à retirer), sinon écrit les 2 documents liés atomiquement et vérifié
côté serveur — ferme le trou qu'un `batch()` simple laisserait ouvert (2 écritures
indépendantes que rien ne lie vraiment). Vérifié par régression : sans ce garde
(`if (existing.exists) return;`), un 2ᵉ appel sans retrait entre les deux
re-incrémente à tort.

**`renderKudosButton(docRefJsExpr, entryId, kudosCount, isMine)`** : composant partagé
par le fil d'activité et le fil Boss Battle (le classement, cas à part — personne, pas
événement — a son propre bouton inline dans `renderLeaderboardRow()`). `docRefJsExpr`
est une **chaîne de code JS**, pas une valeur : un `DocumentReference` ne peut pas
transiter par un attribut HTML, donc l'expression qui le reconstruit
(`db.collection('activityFeed').doc('...')` ou
`bossBattleDocRef().collection('contributions').doc('...')`) est injectée telle quelle
dans `onclick`, réévaluée au clic. Jamais affiché sur son propre événement/sa propre
ligne (`isMine`/`highlight`).

**Suivi "ai-je déjà kudos ceci" volontairement SIMPLIFIÉ** : `myKudosGivenEventIds`/
`myKudosGivenToday` sont des `Set` en mémoire, peuplés UNIQUEMENT par mes propres
actions de la session courante — jamais re-vérifiés depuis Firestore à l'affichage
(pas de lecture supplémentaire par ligne visible). Conséquence acceptée : après un
rechargement de page, un kudos déjà donné une session précédente peut réafficher un
bouton "pas encore donné" — **sans risque de double-comptage réel**, la transaction
revérifie toujours l'état serveur avant d'écrire. Compromis délibéré pour une feature
sociale à faible enjeu plutôt que de multiplier les lectures Firestore.

**Chantier amis/fil d'activité/kudos complet** (batches 1 à 6, y compris les règles
Firestore finales publiées par l'utilisateur) : pseudo obligatoire, amis à demande
mutuelle, fil d'activité global filtré par amis, kudos sur les 3 surfaces.

**Bug de règle Firestore vécu en prod, corrigé** : la règle `leaderboard/{uid} allow
update` (kudosTotal) calculait `request.resource.data.kudosTotal -
resource.data.kudosTotal` — fonctionne pour un utilisateur ayant déjà reçu un kudos,
mais **rejette systématiquement le tout premier kudos jamais reçu par quelqu'un**
(`kudosTotal` n'existe pas encore sur `resource.data`, Firestore refuse d'évaluer la
soustraction et retombe sur `permission-denied`). Le code applicatif gérait déjà ce cas
(`kudosTotal || 0`), pas la règle. Corrigé en distinguant explicitement le cas
`!('kudosTotal' in resource.data)` (doit valoir exactement `1`) du cas normal (doit
augmenter exactement de `1`) — **tout futur champ borné par `allow update` sur un
document pré-existant doit prévoir ce cas "champ jamais initialisé"**, sans quoi le
premier utilisateur à déclencher le chemin est bloqué silencieusement (erreur
`permission-denied` générique côté client, aucun indice sur la cause réelle sans lire
la règle).

## Notifications : sous-collection dédiée `users/{uid}/notifications`, listener unique

**Refonte complète** de la première version (listeners dispersés — 1 par document
surveillé, voir historique git) : celle-ci fonctionnait mais (a) multipliait les
listeners actifs au fil de la session (1 de plus par défi complété), et (b) n'offrait
strictement AUCUN rattrapage — un kudos ou une demande d'ami reçus hors ligne ne
généraient jamais de popup, ni sur le moment ni à la prochaine ouverture. Remplacée par
un modèle "boîte de réception" :

```
users/{uid}/notifications/{autoId}
  { type: 'kudo' | 'friend_request', fromUid, fromName, read: false, createdAt }
```

**Le nom de l'émetteur (`fromName`) est stocké DIRECTEMENT dans la notification au
moment de sa création** (`formatDisplayName(currentUser.displayName)`, déjà anonymisé
— "Prénom N."), jamais relu via `fetchPublicProfile()` à l'affichage. Avantage direct :
fonctionne même si l'émetteur désactive ensuite son classement (`leaderboardOptOut`,
qui aurait rendu `fetchPublicProfile()` introuvable dans l'ancienne version) — plus
d'anonymat forcé rétroactif, et une lecture Firestore de moins par notification.

**Écriture** : la notification est créée par l'ÉMETTEUR, dans l'espace du
DESTINATAIRE — `notificationsCollRef(targetUid).doc()` (ID auto-généré), toujours dans
la MÊME transaction/écriture que l'action elle-même pour rester cohérent :
- `giveKudosToEvent(docRef)` : notifie le **propriétaire de l'événement** (son champ
  `uid`, lu dans la même transaction via `eventDoc.data().uid` — pas de lecture
  supplémentaire), jamais le votant. Re-vérifié côté données (`ownerUid !==
  currentUser.uid`) même si l'UI (`renderKudosButton`) empêche déjà de se
  kudos-er soi-même.
- `giveKudosToPerson(targetUid)` : notifie `targetUid` directement.
- `sendFriendRequest(targetUid)` : notifie `targetUid` directement (écriture séparée,
  pas transactionnelle avec la création de la demande — si elle échoue, la demande
  reste quand même fonctionnelle via le badge existant sur le bouton "Amis").

**Lecture : UN SEUL listener au démarrage** (`startNotificationsListener()`, appelé
depuis `continueStartApp()`) : `notificationsCollRef(monUid).where('read','==',false)`.
Une simple égalité est auto-indexée par Firestore — **aucun index composite à créer**
pour cette fonctionnalité (contrairement à `activityFeed`, qui en a besoin pour son
`where('in',...) + orderBy`).

**Rattrapage natif, sans aucune logique de date/dernier-vu** (`processUnreadNotifications()`) :
CHAQUE document reçu à CHAQUE instantané (y compris le tout premier, contrairement à
l'ancien système) est traité — trié du plus ancien au plus récent, marqué `read: true`
AVANT d'être affiché (jamais de ré-affichage en cas de re-déclenchement rapide du
listener ; si le marquage échoue, on n'affiche pas non plus, pour éviter une boucle),
puis affiché selon son `type` :
- `'kudo'` → `enqueuePopup()` (moteur de popups gamification existant, réutilisé tel
  quel — file d'attente naturelle si plusieurs kudos à rattraper).
- `'friend_request'` → `confirmModal()` : "Accepter" appelle `acceptFriendRequest()`
  directement ; "Plus tard" ne fait RIEN sur la demande sous-jacente (pas de refus
  silencieux, elle reste visible normalement dans l'écran Amis) — mais la notification,
  elle, passe quand même à `read: true` dans les deux cas (jamais reproposée en boucle).

**Piège de mock corrigé en cours de route** : le mock Firestore de test avait un cas
spécial câblé en dur pour `db.collection('users').doc(uid).collection(...)`, qui
renvoyait TOUJOURS le même mock `appData` unique quel que soit le nom de la
sous-collection demandée — hérité du fait que seul `kv/appData` existait jusqu'ici sous
`users/{uid}`. Étendu pour dispatcher : `kv` garde son comportement historique
(singleton partagé, sans distinction d'uid — ne JAMAIS lui ajouter d'isolation, ça
casserait tous les tests existants qui simulent plusieurs comptes via de simples
réassignations de `currentUser`), toute AUTRE sous-collection (`notifications`) passe
par un mock générique complet, isolé PAR UTILISATEUR (`usersSubcollections`, une `Map`
séparée de `mockTopCollections`, réinitialisée par `__resetCommunityMocks()`).

**Règle Firestore associée** : `users/{userId}/{document=**}` (existante) couvre déjà
la lecture/écriture du PROPRIÉTAIRE sur ses propres notifications (marquer `read`) —
il ne manque qu'un `allow create` explicite pour permettre à un ÉMETTEUR d'écrire chez
quelqu'un d'autre :
```
match /users/{userId}/notifications/{notifId} {
  allow create: if request.auth != null && request.resource.data.fromUid == request.auth.uid;
}
```

## Internationalisation (i18n) FR/EN/ES — chantier en cours (batch 1/7 livré)

Chantier en 7 batches (voir plan `generic-riding-gizmo.md`) pour rendre l'app
multilingue sans aucune dépendance Firebase pour les traductions, sans régression du
FR actuel, et extensible (ajouter une langue = un nouveau fichier, jamais de code de
composant à toucher). **Batch 1 (fondations) livré : moteur de traduction + détection/
persistance + branchement fichiers/service worker/tests — aucun écran encore migré,
zéro changement visible pour l'instant.**

**Décision technique : fichiers JS classiques (`locale-fr.js`/`locale-en.js`/
`locale-es.js`), PAS de JSON chargé par `fetch()`** — écart assumé par rapport à la
suggestion initiale de fichiers JSON. Raison concrète : `exercise-data.js`/
`exercise-pictograms.js` sont déjà chargés en `<script src>` CLASSIQUE (jamais
`type="module"`/`defer`) précisément parce qu'un chargement asynchrone a déjà causé un
écran noir total en production une fois (voir plus haut, "SDK Firebase + fichiers
classiques") — un `fetch()` de JSON de traduction reproduirait exactement ce risque
sur le chemin de démarrage. Chaque `locale-XX.js` définit un simple global
`const LOCALE_XX = {...}` (même pattern que `CHALLENGE_LIBRARY`), chargé juste après
`exercise-data.js` dans le `<head>` — disponible de façon SYNCHRONE avant le script
principal. Reste "0 lecture Firebase, 100% frontend" : mis en cache par le service
worker exactement comme `exercise-data.js` (cache-first avec remplissage au 1er accès,
pas pré-caché dans `ASSETS`).

**Moteur `t(key, params)`/`tn(key, count, params)`** (`index.html`, juste après
`let currentUser = null;`) : résolution par chemin pointé (`getNestedValue`, ex.
`'common.cancel'`), interpolation `{{placeholder}}` (`interpolate`), repli en cascade
`langue active → français → clé brute` — **aucune clé manquante dans une langue ne
casse jamais un écran**, elle retombe sur le français puis, en dernier recours, sur
son propre nom. `tn()` résout la même chose mais attend une valeur `{ one, other }` en
bout de chemin, sélectionne la forme selon `count`. Couvert par un test dédié
(`tests/app.test.js`, bloc "1bis", juste après le test CHALLENGE_LIBRARY) qui vérifie
explicitement le repli FR (en supprimant temporairement une clé de `LOCALE_EN` en
mémoire pendant le test, restaurée juste après) et le repli sur la clé brute — **piège
à surveiller** : tant que les 3 dictionnaires ont des clés strictement identiques (cas
du batch 1), aucun test qui lit une clé au hasard ne peut détecter une régression du
repli EN/ES→FR ; le test manipule donc volontairement `LOCALE_EN` pour créer
artificiellement l'asymétrie et exercer réellement ce chemin.

**Détection/persistance** (`detectPreferredLanguage()`/`setPreferredLanguage()`) :
ordre de repli `localStorage('preferredLanguage') → navigator.language (2 lettres) →
'en'`. `PREFERRED_LANGUAGE_KEY` est la **2ᵉ exception documentée** à "pas de
localStorage dans cette app" (la 1ʳᵉ est `PWA_INSTALL_GATE_BYPASS_KEY`) — même
rationale : une préférence propre à CET APPAREIL/CE NAVIGATEUR, pas une donnée de
compte, n'a pas sa place dans Firestore. `document.documentElement.lang` est posé au
tout premier chargement (pas seulement au changement manuel via
`setPreferredLanguage()`, qui persiste + relance `render()`).

**Identité stable des exercices (à traiter aux batches 5 et 7, pas encore fait)** :
`activityFeed/{id}.challengeName` stocke aujourd'hui le nom d'exercice EN FRANÇAIS en
dur, comme si c'était un identifiant stable — dès qu'un nom devient traduit, ce serait
incohérent pour un lecteur dans une autre langue. Plan retenu : `CHALLENGE_LIBRARY`
gagne un champ `slug` stable (ex. `'pushups'`, indépendant du `name` affiché ET du
`id` numérique déjà utilisé comme clé Firestore/`activeToday`) ; `activityFeed` écrira
`exerciseSlug` EN PLUS de (jamais à la place de) `challengeName`/`cat` ; l'affichage
préfère `exerciseSlug` s'il existe, retombe sur le `challengeName` littéral déjà
stocké sinon — repli gracieux natif pour tout document écrit AVANT ce correctif,
aucune migration de données nécessaire.

**`CACHE_NAME` bumpé `v25` → `v26`** (nouveaux fichiers statiques `locale-*.js`, même
règle que pour `exercise-data.js`/`exercise-pictograms.js`/`styles.css`).

**Batch 2 livré : navigation (`renderTabBar()`) + écran Paramètres + sélecteur de
langue** — 1ᵉʳ écran migré bout-en-bout, valide le mécanisme en conditions réelles.
`renderSettingsSection()`/`renderDataManagementSection()`/
`renderTroubleshootingSection()`/`renderAccountActionsSection()`/`renderSettingsScreen()`
et le modal de `forceAppUpdate()` passent tous par `t()`. **Sélecteur de langue
réutilise TELLES QUELLES les classes `.leaderboard-tabs`/`.leaderboard-tab-btn`**
(déjà utilisées pour les 3 vues du classement, `renderCommunityScreen()`) plutôt que
d'en créer des quasi-identiques — même rationale que la réutilisation de
`.picker-item` par le Hero Banner communautaire : visuellement identique (3 boutons
segmentés, un seul actif), zéro CSS nouveau, donc zéro bump `CACHE_NAME` motivé par
`styles.css` pour ce batch. **`LOCALE_NATIVE_NAME`** (à côté de `LOCALE_TO_INTL`) :
les noms de langue dans le sélecteur ("Français"/"English"/"Español") sont TOUJOURS
affichés dans leur PROPRE langue, jamais traduits — convention standard de tout
sélecteur de langue (iOS/Android/navigateurs), pour qu'un utilisateur ne lisant pas la
langue actuellement active puisse quand même repérer la sienne.

**`CACHE_NAME` bumpé `v26` → `v27`** — pas pour `styles.css` (inchangé ce batch) mais
parce que le CONTENU de `locale-fr.js`/`locale-en.js`/`locale-es.js` a changé (nouvelles
clés `nav`/`settings`) : ce sont des assets cache-first-avec-remplissage au même titre
que `exercise-data.js`, donc toute modification de leur contenu suit la même règle,
pas seulement leur toute première création (batch 1).

**Batch 3 livré : Aujourd'hui (accueil) + fiche d'exécution d'exercice** — inclut
`renderChallengeCard()`, composant PARTAGÉ entre l'onglet Aujourd'hui (`mode='today'`)
et l'onglet Défis (`mode='library'`) : migré une seule fois ici plutôt que dupliqué au
batch 4, le batch 4 n'aura donc qu'à VÉRIFIER cet écran, pas à le retraduire.
**Piège de shadowing rencontré et corrigé** : `renderChallengeCard()` avait une
variable locale nommée `t` (`const t = todayEntry.sets.reduce(...)`, la somme des
séries) qui masquait complètement la fonction globale `t()` de traduction dans cette
portée — tenter d'y appeler `t('card.inProgress', ...)` aurait levé une `TypeError`
("t is not a function") au premier rendu d'une carte "en cours". Renommée en
`sumSoFar`. **Leçon générale pour la suite du chantier** : avant d'ajouter un appel
`t(...)` dans une fonction existante, vérifier qu'aucune variable locale ne s'appelle
déjà `t` dans la même portée (le nom court était déjà utilisé ailleurs dans ce fichier
avant l'i18n, pour des sommes/totaux).

**Casse de l'unité "secondes" à 2 variantes distinctes, déjà présentes AVANT l'i18n,
préservées** : `unitSecLabel` ('SEC', majuscules — barre de progression) et
`unitSecLabelLower` ('sec'/'seg', minuscules — `armModeSentence()`) sont 2 clés
séparées, pas une seule avec un `.toUpperCase()` à la volée : le code original avait
déjà ces 2 casses différentes dans 2 contextes différents, donc 2 clés distinctes
préservent exactement le rendu FR d'origine (zéro régression) sans supposer qu'une
langue future ne changerait pas *que* la casse en traduisant.

**Opportunément corrigé au passage** : `stats[c.id].lifetimeTotal.toLocaleString('fr-FR')`
(fiche détail) devient `.toLocaleString(LOCALE_TO_INTL[currentLocale])` — cette ligne
était de toute façon réécrite pour passer par `t('exercise.lifetimeTotal', ...)`, donc
plutôt que de laisser un `'fr-FR'` en dur dans une chaîne fraîchement traduite (prévu
pour le batch 7 sinon), la table `LOCALE_TO_INTL` (déjà posée au batch 1) a été
branchée ici directement.

**Batch 4 livré : Défis (bibliothèque) + formulaire de défi personnalisé + Journal** —
`renderLibraryScreen()`/`renderChallengeForm()`/`renderHistoryScreen()`/
`renderHeatmap()` (hors vocabulaire de dates) migrés vers `t()`/`tn()`.
`renderChallengeCard()` n'a pas eu besoin d'être retouché (déjà migré au batch 3, ce
batch n'a fait que vérifier son bon fonctionnement dans le contexte `mode='library'`
via le test dédié). Le nom "Défi supprimé" (`loadHistoryEntries()`, un historique
pointant vers un défi personnalisé depuis supprimé) est traduit ici aussi, car il
alimente directement la liste du Journal — mais son équivalent dans
`showDayDetailModal()` (une popup) reste volontairement en dur jusqu'au batch 7, pour
garder tous les sites de popups groupés dans un seul batch.

**Délibérément PAS touchés dans ce batch, réservés au batch 7** : `MONTH_ABBR`
(`renderHeatmap()`) et les lettres de jour `['L','M','M','J','V','S','D']`
(`renderHistoryScreen()`, en-tête du calendrier mensuel) — même famille que
`DOW_LABELS`/`formatDateLabel()`/`formatRelative()`, tout le "vocabulaire de dates"
est volontairement regroupé dans un seul batch dédié plutôt que dispersé.

**Guillemets adaptés par langue, pas juste le texte** : `library.searchEmpty` utilise
des guillemets français « » en FR mais des guillemets droits `"..."` en EN/ES — le
caractère de ponctuation fait partie de la chaîne traduite elle-même (pas un
symbole codé en dur autour de `{{query}}` dans `index.html`), pour respecter la
convention typographique de chaque langue plutôt qu'imposer la ponctuation française
partout.

**`CACHE_NAME` bumpé `v28` → `v29`** (contenu des `locale-*.js` modifié, nouvelles clés
`library`/`challengeForm`/`history`).

**Batch 5 livré : Communauté complète (classement, Boss Battle, Temple de la renommée,
fil d'activité, Amis) + correctif `exerciseSlug`** — `renderLeaderboardRow()`/
`renderBossBattleSection()`/`renderHallOfFameSection()`/`renderActivityFeedSection()`/
`renderActivityFeedRow()`/`renderCommunityScreen()`/`renderFriendActionRow()`/
`renderFriendsScreen()`/`shareCommunityInvite()` migrés vers `t()`/`tn()`.

**Correctif `exerciseSlug` implémenté exactement comme prévu au plan, en 2 moitiés
volontairement asymétriques** :
- **Écriture** (`registerActivityFeedEntryIfNeeded()`) : ajoute `exerciseSlug: c.slug ?? null`
  à chaque nouveau document `activityFeed`, EN PLUS de (jamais à la place de)
  `challengeName`/`cat`. Puisque `CHALLENGE_LIBRARY` n'a PAS ENCORE de champ `slug`
  réel (prévu batch 7), `c.slug` est actuellement toujours `undefined` → tous les
  nouveaux documents écrivent `exerciseSlug: null`, strictement équivalent au
  comportement d'avant ce correctif. Ce n'est PAS un bug ni un oubli : c'est
  l'infrastructure posée en avance, qui s'activera automatiquement dès que le batch 7
  peuplera `c.slug` pour de vrai — sans toucher à nouveau `registerActivityFeedEntryIfNeeded()`.
- **Lecture** (`renderActivityFeedRow()`) : `entry.exerciseSlug ? t('exercises.' +
  entry.exerciseSlug + '.name') : escapeHtml(entry.challengeName)` — repli gracieux
  natif déjà fonctionnel et testé (voir le test dédié, qui ajoute temporairement une
  clé `LOCALE_EN.exercises.pompes.name` pour prouver que le chemin de résolution
  fonctionne, sans attendre le batch 7 pour le vérifier).

**Boss Battle/Temple de la renommée : `unitLabel` (`'sec'`/`'reps'`) traduit via
`exercise.unitSecLabelLower`/`exercise.unitRepsLabel`** (déjà posées au batch 3),
plutôt que de dupliquer ces 2 mots dans un nouveau namespace `community` — même
rationale que la réutilisation de `.leaderboard-tabs` au batch 2 : ne pas dupliquer un
concept déjà traduit ailleurs. `.toLocaleString('fr-FR')` (progression Boss Battle,
valeur Temple de la renommée) opportunément basculé sur `LOCALE_TO_INTL[currentLocale]`
au passage, même geste qu'au batch 3.

**Guillemets par langue pour `friends.notFound`**, même principe que
`library.searchEmpty` au batch 4 (FR : `"..."`, EN/ES : `"..."` droits — ici FR et
EN/ES utilisent en fait les mêmes guillemets droits pour ce message précis, mais la clé
reste dans son propre namespace `friends`, pas partagée avec `library`, pour ne pas
coupler 2 écrans indépendants).

**`CACHE_NAME` bumpé `v29` → `v30`** (contenu des `locale-*.js` modifié, nouvelles clés
`community`/`friends`).

**Batch 6 livré : Profil + onboarding complet (profil coach virtuel, transition,
tour guidé) + pseudo (setup/renommage)** — `renderGuidedTourOverlay()`/
`renderOnboardingTransitionScreen()`/`renderUsernameSetupScreen()`/
`renderProfileOnboardingScreen()`/`renderAthleteCard()`/`renderLevelRoadmapSheet()`/
`renderTrophiesGrid()`/`renderAccountSection()`/`renderAccountTabScreen()` migrés vers
`t()`/`tn()`.

**`GUIDED_TOUR_STEPS` : restructuré de `{tab, emoji, title, text}` figés en dur vers
`{tab, key, emoji}`**, `title`/`text` résolus au RENDU via `t('tour.' + step.key +
'.title'/'.text')` dans `renderGuidedTourOverlay()` — nécessaire car ce tableau est un
`const` évalué UNE SEULE FOIS au chargement du script : y garder du texte français en
dur aurait figé le tour guidé dans la langue de démarrage, ignorant tout changement de
langue ultérieur en cours de session. `emoji` reste dans le tableau JS (décoratif,
langue-agnostique, pas besoin de passer par `t()`).

**2ᵉ occurrence du piège de shadowing de variable locale `t`** (1ʳᵉ fois au batch 3,
`renderChallengeCard()`) : `renderLevelRoadmapSheet()` avait `ATHLETE_TITLE_TIERS.map(t
=> ...)`, masquant la fonction globale `t()` À L'INTÉRIEUR de ce callback — un appel à
`t('profileTab.roadmap...')` y aurait levé une `TypeError`. Renommé en `tier`. **Ce
piège est maintenant confirmé récurrent** : avant d'ajouter un appel `t(...)` dans
n'importe quelle fonction existante de ce fichier, vérifier qu'aucun paramètre/variable
local ne s'appelle déjà `t` dans la portée englobante (recherche
courte/passe-partout, utilisée à plusieurs endroits dans ce fichier avant l'i18n).

**Volontairement PAS traduits dans ce batch, laissés en dur** : le nom d'exercice
"Pompes" et l'unité "REPS" dans la mini-carte de preview de
`renderOnboardingTransitionScreen()` (exemple concret figé, dépend du même
correctif noms/unités d'exercices que le reste de l'app — batch 7) ; `tier.title`
dans `renderLevelRoadmapSheet()` et `b.label` dans `renderTrophiesGrid()` (données de
`ATHLETE_TITLE_TIERS`/`BADGE_DEFS`, mêmes tables de données à texte français en dur que
`BADGE_DEFS` déjà explicitement réservé au batch 7).

**`CACHE_NAME` bumpé `v30` → `v31`** (contenu des `locale-*.js` modifié, nouvelles clés
`tour`/`username`/`onboarding`/`profileTab`).

**Batch 7 livré — chantier i18n FR/EN/ES COMPLET (7 batches, tous livrés)** : dernier
batch, découpé en 5 sous-parties (7a-7e), un seul commit/bump `CACHE_NAME` final.

**7a — vocabulaire de dates** : `formatDateLabel()`/`formatRelative()` migrés vers
`t('dates.daysFull')`/`t('dates.monthsAbbr')`/`t('dates.relative.*')` (ces 2 premiers
sont des TABLEAUX retournés tels quels par `t()` — `t()` ne fait `interpolate()` QUE
sur les valeurs `string`, une valeur non-string comme un tableau est renvoyée
telle quelle, voir sa propre implémentation). `DOW_LABELS` (const figée) supprimée,
remplacée par `t('dates.dowShort')[d.getDay()]` directement au point d'usage —
nécessaire pour réagir à un changement de langue en session, même raison que la
restructuration de `GUIDED_TOUR_STEPS` au batch 6. Idem pour les lettres du calendrier
mensuel (`renderHistoryScreen()`) et `MONTH_ABBR` (`renderHeatmap()`).

**7b — `exercise-data.js` : vrai `slug` sur les 29 entrées + traduction complète** —
réutilise TELLES QUELLES les clés déjà existantes de `EXERCISE_ICON_BY_NAME` comme
valeurs de `slug` (déjà stables/uniques/langue-agnostiques par construction, aucune
nouvelle nomenclature à inventer). **Active rétroactivement le correctif
`exerciseSlug` du batch 5** sans y retoucher : `c.slug` n'était `undefined` que
temporairement, en attendant ce batch. Nouvelle fonction `challengeDisplayName(c)`
(juste après `resolveChallenge()`) : SEUL point d'affichage traduit — `c.name`
lui-même n'est JAMAIS modifié (reste le nom canonique français, utilisé par les
nombreux `CHALLENGE_LIBRARY.find(c => c.name === '...')` dispersés dans le fichier ;
le traduire à la source aurait cassé tous ces lookups). Même principe pour les 4
catégories fixes via `translateCategoryName()`/`CATEGORY_SLUG_BY_NAME` — **piège
évité explicitement** : ne jamais l'utiliser dans le `<datalist>` de suggestion de
catégorie du formulaire de défi personnalisé (`renderChallengeForm()`), la valeur
choisie y devient la valeur RÉELLEMENT stockée dans `cat`, la traduire créerait une
catégorie distincte au lieu de rejoindre la catégorie canonique existante.
`formatTargetLabel()` (`exercise-data.js`) appelle désormais `t()`/`tn()` — **1er cas
d'un fichier externe autre qu'`index.html` qui appelle le moteur i18n** : sûr car les
corps de fonctions ne s'évaluent qu'à l'APPEL (jamais à la définition), et cette
fonction n'est jamais appelée avant que le script principal ait fini de s'exécuter,
malgré l'ordre de chargement (`exercise-data.js` avant le script inline). `t`/`tn`
ajoutés aux globals ESLint de ce fichier (`eslint.config.js`) pour que `no-undef` ne
lève pas d'erreur sur cet usage légitime.

**7c — `BADGE_DEFS` (`badgeLabel(b)`, id déjà stable réutilisé tel quel) +
`ATHLETE_TITLE_TIERS`** (`title: 'Recrue 🥉'` figé → `{id: 'recrue', icon: '🥉'}`
séparés, résolus au rendu via `t('athleteTitles.' + tier.id) + ' ' + tier.icon`).
**3ᵉ occurrence du piège de shadowing de variable locale `t`** (après
`renderChallengeCard()` batch 3 et `renderLevelRoadmapSheet()` batch 6) :
`ATHLETE_TITLE_TIERS.find(t => level <= t.maxLevel)` dans `athleteTitle()` — renommé
`tier`. **Ce piège est maintenant confirmé récurrent à 3 reprises** : le nom court `t`
était déjà largement utilisé comme variable locale/paramètre de callback dans ce
fichier avant l'i18n (sommes, itérations) — vérifier systématiquement avant d'ajouter
un appel `t(...)` dans une fonction existante.

**7d — les 39 sites `alert()`/`confirmModal()`/`enqueuePopup()`/`showToast()`** (compte
exact prédit par le plan initial, confirmé par grep). Tous migrés, y compris :
`confirmModal()` elle-même (ses paramètres par défaut `confirmLabel`/`cancelLabel`
passent de `'Confirmer'`/`'Annuler'` figés à `t('common.confirm')`/`t('common.cancel')`
— valeurs par défaut ES2015, réévaluées à CHAQUE appel sans argument, donc toujours la
langue courante, jamais figées à la définition) ; `shareStatsImage()` (image PNG
générée via `<canvas>`, entièrement traduite — titre, libellés de stats, catégorie
favorite via `translateCategoryName()`, sauf le branding `'DÉFI DU JOUR'`/`'Défi du
Jour'`, volontairement conservé partout dans l'app comme un nom propre) ;
`showDayDetailModal()` (reprend `challengeDisplayName(c)`, comme `loadHistoryEntries()`
au batch 4). **Bug d'inattention corrigé pendant ce batch** : le popup de complétion
Hardcore (`addSet()`, "MODE HARDCORE complété !") avait été oublié dans un premier
passage — repéré par une relecture systématique bloc par bloc de tous les sites
listés par `grep`, pas par un test (leçon : pour un balayage exhaustif comme celui-ci,
relire CHAQUE site un par un après le premier passage, ne pas se fier uniquement à la
mémoire du grep initial).

**7e — audit final, 4 sites supplémentaires repérés par relecture systématique du
fichier entier (heuristique grep sur les caractères accentués français, hors
commentaires) APRÈS 7a-7d, tous manqués une première fois** :
- Bandeau hors ligne (`updateOfflineBanner()`) — `tn('popups.offlineBanner.pending',
  pendingWriteCount)` / `t('popups.offlineBanner.idle')`.
- Badge de série (`🔥 {{n}} j`) sur l'écran Aujourd'hui — **2ᵉ occurrence** du même
  motif déjà migré ailleurs (Communauté au batch 5, Profil au batch 6) mais oubliée
  sur CET écran précis lors du batch 3 ; les 2 occurrences réutilisent
  `t('community.streakValue', ...)`.
- Coach vocal (`speak()`) : `utterance.lang` passait de `'fr-FR'` figé à
  `LOCALE_TO_INTL[currentLocale]` (essentiel pour une prononciation correcte de la
  synthèse vocale, pas seulement le TEXTE prononcé) + les 4 phrases annoncées
  (`beginPrepCountdown()`/`announceTimerVoiceCues()`/`toggleTimer()`), désormais
  traduites via `t('popups.voiceCoach.*')`. Les chiffres du décompte ("3"/"2"/"1")
  restent des chiffres bruts, universels, aucune traduction nécessaire.
- Repli client "Athlète" (`refreshFriendsData()`, `fetchPublicProfile()` introuvable —
  ex: ami ayant désactivé son classement) → `t('friends.unknownProfile')`. **Distinct
  du repli `'Athlète'` de `formatDisplayName()`** (délibérément laissé en dur,
  documenté ci-dessous — décision différente pour une raison différente).
- Verrou d'installation PWA plein écran (`buildPwaInstallGateHtml()`) — 1ʳᵉ chose
  qu'un nouveau visiteur non-standalone voit, avant même la connexion. Vérifié sûr à
  traduire : `updatePwaInstallGate()` n'est appelée qu'après l'initialisation complète
  du moteur i18n (ligne de code, pas juste la définition) dans l'ordre d'exécution du
  script.

**2 exceptions délibérées, NE PAS traduire par la suite** (décisions prises et
documentées pendant l'audit, pas des oublis) :
- `formatDisplayName()` (repli `'Athlète'` quand `fullName` est vide) — cette valeur
  est ÉCRITE dans Firestore (collections communautaires partagées : leaderboard,
  dailyContributors, contributions...), lue par TOUS les autres utilisateurs quelle
  que soit LEUR langue. La traduire ferait apparaître des noms de repli dans des
  langues différentes selon la langue de l'auteur au moment de l'écriture, sans
  mécanisme de re-traduction à la lecture (contrairement à `exerciseSlug`, construire
  un tel mécanisme pour ce cas marginal serait disproportionné). Reste figée en
  français, comme une constante technique plutôt qu'un texte d'interface.
- `showFatalErrorScreen()` (écran de secours si une erreur JS non interceptée
  survient) — son propre commentaire dans le code l'explique déjà : "aucune dépendance
  à une fonction de l'appli plus bas, qui pourrait elle-même être à l'origine du
  crash". Ce filet de sécurité doit fonctionner même si le moteur i18n lui-même (ou
  n'importe quoi d'autre) est la cause du crash — y introduire un appel à `t()`
  romprait cette garantie d'isolation. Reste en français en dur, volontairement.

**`CACHE_NAME` bumpé `v31` → `v32`** (un seul bump pour tout le batch 7, 7a à 7e).

## Chantier i18n FR/EN/ES — TERMINÉ (7/7 batches livrés)

Application entièrement traduite en français/anglais/espagnol : navigation, tous les
écrans (Aujourd'hui, fiche d'exécution, Défis, Journal, Communauté, Amis, Profil,
onboarding, tour guidé, Paramètres), les 39 sites de popups/toasts/alertes, les
trophées et titres d'athlète, le vocabulaire de dates, le catalogue d'exercices
(noms + catégories), le coach vocal (texte ET langue de synthèse), le verrou
d'installation PWA. Sélecteur de langue dans Paramètres (`renderSettingsSection()`).
Détection automatique (`localStorage` → `navigator.language` → anglais) au premier
lancement. Voir les sections précédentes (batches 1 à 7) pour le détail technique de
chaque étape ; les 2 exceptions volontaires ci-dessus (`formatDisplayName()`,
`showFatalErrorScreen()`) sont les seuls textes intentionnellement non traduits.

## Migration Firestore SDK compat → SDK modulaire : TENTÉE PUIS ANNULÉE — NE PAS RÉINTRODUIRE de cette façon

But recherché : faire disparaître le warning de dépréciation `enablePersistence()`
(remplacé par `FirestoreSettings.cache`/`persistentLocalCache`, qui n'existe QUE dans
le SDK modulaire). Tentative complète (6 batches, ~90 sites migrés) faite, puis
**intégralement annulée en production suite à un bug réel** qui cassait la lecture
des données pour TOUS les comptes existants (renvoyés à tort vers l'onboarding,
avec un risque réel d'écrasement de profil).

**Cause racine confirmée (pas une supposition)** : le SDK compat
(`firebase-*-compat.js`, chargé en `<script src>` classique) et le SDK modulaire
(chargé via `import()` dynamique depuis gstatic) sont **deux exécutions de module
JS totalement séparées, qui ne partagent AUCUN état interne** — même en ciblant la
même version (10.13.0). Preuve : passer `firebase.app()` (compat) à
`initializeFirestore()` (modulaire) ne lève pas d'erreur immédiate mais produit un
objet cassé qui échoue plus tard sur le premier `doc()`/`collection()` réel
("Expected first argument to collection() to be a CollectionReference...") ;
essayer `getApp()` modulaire (en important aussi `firebase-app.js` modulaire) échoue
de façon encore plus explicite : `"No Firebase App '[DEFAULT]' has been created"`,
car le registre interne du module dynamiquement importé est vide — `firebase.
initializeApp()` (compat) n'y a jamais rien enregistré.

**Conclusion** : l'interop compat/modulaire documentée par Firebase suppose un
bundler (webpack/vite/rollup) qui déduplique le paquet `@firebase/app` partagé —
elle NE FONCTIONNE PAS entre un `<script>` classique et un `import()` dynamique
chargés séparément depuis un CDN, quelle que soit la façon d'écrire le code
applicatif autour. Pour vraiment supprimer ce warning un jour, les seules voies
réelles seraient : (a) migrer `auth` (et donc tout le flux de connexion) vers le
SDK modulaire aussi, pour n'avoir plus qu'un seul SDK — chantier bien plus large et
plus risqué que le bénéfice (un warning cosmétique) ne le justifie ; ou (b)
introduire un bundler — contredit le choix architectural délibéré de ce projet
(zéro build, scripts classiques uniquement, voir plus haut). Le warning de
dépréciation reste donc un inconvénient cosmétique accepté, pas un bug.

## Optimisation quota Firestore (plan Spark gratuit) — 8 mesures livrées, 100% invisibles

**Contexte** : audit demandé pour maximiser le nombre d'utilisateurs actifs/jour sur
le plan gratuit (50k lectures, 20k écritures/jour) sans aucun changement visible.
Diagnostic : `fetchMyRankAndNeighbors()` relit tout le classement (aucun `.limit()`,
déjà documenté comme limite assumée) à CHAQUE visite/changement de vue de l'onglet
Communauté — coût qui grandit avec le nombre TOTAL de membres du classement (pas
seulement le DAU), rendant la capacité inversement proportionnelle au succès de
l'appli. `addSet()` (tap +5/+10, l'action la plus fréquente) écrivait aussi jusqu'à 7
fois le même document `appData` par complétion d'exercice (`saveStats`/
`saveLastCompleted`/`saveDailyActivity`/`saveBadges`/`saveXp`/`saveXpWeeklyData`/
`saveStreakData`, tous de simples wrappers de `saveAppField()`), sans aucun debounce
même pour des taps rapprochés. Estimation avant/après : ~166 → ~450-600 DAU pour une
communauté de ~100 membres (voir l'audit complet donné à l'utilisateur pour le détail
par taille de communauté) ; le plafond structurel lié à la taille du classement (O(N)
par visite) subsiste et redescendra si la communauté grossit beaucoup — seul un
agrégat calculé côté serveur (Cloud Function programmée) le supprimerait
complètement, hors scope d'un changement "invisible côté client".

1. **Regroupement des écritures `appData`** (`beginAppDataBatch()`/`endAppDataBatch()`/
   `flushAppDataBatchNow()`) : tous les `saveAppField()` appelés à l'intérieur d'un lot
   (compteur de profondeur, supporte les appels imbriqués comme
   `addSet()` → `registerDailyStreak()` → `saveStreakData()`) sont fusionnés en UN
   SEUL `.set({...},{merge:true})`, au lieu d'un appel par champ. Jusqu'à 7→1 sur une
   complétion d'exercice.
2. **Debounce des écritures haute fréquence** (`scheduleWorkoutWriteFlush()`/
   `flushWorkoutWrites()`, `WORKOUT_WRITE_DEBOUNCE_MS` = 1500ms — relevé depuis 800ms
   à la demande explicite de l'utilisateur pour plus de marge, sans risque
   supplémentaire réel puisque c'est le flush forcé ci-dessous, pas la durée du
   timer, qui garantit l'absence de perte) : `addSet()`/`undoLast()` ne déclenchent plus
   l'écriture réseau immédiatement à chaque tap — la mise à jour LOCALE reste
   instantanée, seul l'aller-retour Firestore est différé et fusionné si plusieurs
   taps se suivent. **Flush forcé, jamais de perte** : `visibilitychange` (vers
   "hidden" — signal le plus fiable cross-plateforme, y compris PWA mobile) et
   `pagehide` déclenchent un flush immédiat. Limite connue du mock de test :
   `document.addEventListener`/`window.addEventListener` sont des no-op dans le
   harnais (voir `tests/app.test.js`), donc le déclenchement RÉEL par ces événements
   navigateur n'est testé qu'indirectement (la fonction `flushWorkoutWrites()`
   elle-même est testée directement) — à vérifier de visu en navigateur réel si
   possible.
3. **Classement : un seul scan par visite** (`fetchLeaderboardFullScan()`, cache par
   vue) : Top N et rang/voisins réutilisent désormais LA MÊME lecture complète
   (supprime l'ancienne requête `limit(20)` séparée, redondante) ; un changement de
   vue (streaks/hebdo/all-time) pendant la MÊME visite réutilise le scan déjà en
   cache. **Zéro perte de fraîcheur** : `invalidateLeaderboardScanCache()` est appelée
   à CHAQUE entrée sur l'onglet (`switchTab()`) et juste après
   `syncLeaderboardEntry()` (jamais son propre classement obsolète après une action) —
   cet écran n'a jamais été temps réel (lecture ponctuelle, jamais un `onSnapshot`),
   donc aucun changement de comportement pour l'utilisateur, seulement moins de
   requêtes.
4. **Cache du Journal** (`historyDayCache`) : les 27 jours PASSÉS (immuables une fois
   le jour terminé) ne sont lus qu'une fois par session ; seul "aujourd'hui" (encore
   modifiable) est relu à chaque ouverture. 28 → 1 lecture dès la 2e ouverture de
   l'onglet dans la même session. Vidé au logout (données par utilisateur).
5. **Déduplication `syncLeaderboardEntry()`** : `awardXp()` ET
   `registerDailyStreak()` l'appellent toutes les deux pour un même événement
   (1ère complétion du jour) — la 2de est désormais différée dans le même lot que #1
   et fusionnée (1 seule écriture réelle au lieu de 2).
6. **Cache mémoire `fetchPublicProfile(uid)`** : un même uid (ami visible dans
   plusieurs listes, `refreshFriendsData()` rappelée après chaque action ami) n'est
   relu qu'une fois par session.
7. **Persistance `localStorage` du cache profils** (`publicProfileCacheV1`, TTL 6h) —
   **3e exception documentée à "pas de localStorage"** (les 2 premières :
   `PWA_INSTALL_GATE_BYPASS_KEY`, `PREFERRED_LANGUAGE_KEY`), de nature différente :
   pas une préférence de cet appareil, un cache d'un résultat déjà PUBLIC. Survit à
   une fermeture/réouverture de la PWA. Les RELATIONS (qui est ami, qui a envoyé une
   demande) ne sont volontairement JAMAIS mises en cache ainsi — seulement les
   données de profil (nom/photo, dérivées de Google, qui changent rarement) —
   pour ne perdre aucune fraîcheur sur ce qui compte réellement (nouvelle demande
   d'ami visible immédiatement).
8. **Suspension des listeners `activityFeed`/`contributions Boss Battle` hors de
   l'onglet Communauté** : ces 2 listeners (les plus "bruyants" en écritures d'autres
   utilisateurs) ne s'attachent plus au démarrage ni ne restent actifs pendant qu'un
   autre onglet est affiché (garde `if (activeTab !== 'community') return;` dans
   `startActivityFeedListener()`/`startRecentContributionsListener()`, détachement
   explicite en quittant l'onglet dans `switchTab()`, rattachement à la ré-entrée).
   Le listener de progression Boss Battle (détection de victoire) et les
   notifications restent volontairement toujours actifs, aucune perte de popup/alerte.

## Classement sans scan complet (Top 50 + voisins ciblés) — suite de l'optimisation quota, 1 changement visible assumé

**Contexte** : la mesure #3 ci-dessus réduisait déjà le nombre de scans complets du
classement, mais le scan lui-même (coût O(N), croissant avec la taille TOTALE du
classement) restait la limite structurelle identifiée dans l'audit. Discuté avec
l'utilisateur, qui a validé un changement UX ciblé pour l'éliminer complètement côté
client (sans Cloud Function, pour rester sur le plan Spark) :

- **Top 50 direct** (`fetchLeaderboardTop(view, 50)`) : simple `.limit(50)`, plus
  jamais de lecture complète — coût désormais BORNÉ, indépendant de la taille du
  classement.
- **Voisins par requêtes ciblées** (`fetchMyLeaderboardNeighbors()`) : si je ne suis
  pas dans le Top 50, 2 requêtes indépendantes (`where(champ,'>',maValeur)
  .orderBy(champ,'asc').limit(1)` et l'inverse en `'<'`/`'desc'`) trouvent le voisin
  immédiat au-dessus/en-dessous — coût FIXE (2 lectures), jamais O(N).
- **Changement visible assumé** : plus de rang numérique exact hors Top 50 (ex:
  "#1234") — impossible à calculer sans scanner tout le classement OU sans `.count()`,
  qui est **confirmé absent du SDK compat 10.13.0 réellement chargé ici** (déjà
  documenté ailleurs dans ce fichier : `TypeError: count is not a function` observé en
  production). Remplacé par un badge **"Hors Top 50"** sur ma ligne, et des labels
  relatifs **"Juste devant"/"Juste derrière"** sur mes 2 voisins (au lieu d'un rang
  qu'on ne connaît plus) — décision explicitement validée par l'utilisateur. Écart de
  points avec la personne juste au-dessus affiché en plus (`rank-gap-hint`), pour
  garder le côté stimulant sans rang exact.
- **Limite assumée sur les égalités** : les requêtes `>`/`<` strictes peuvent sauter
  par-dessus des personnes à égalité EXACTE de score — acceptable pour un indicateur
  motivationnel, pas un classement audité au document près.
- **Cache TTL 15 minutes** (`leaderboardTopCache`/`leaderboardNeighborsCache`,
  `invalidateLeaderboardCache()`) : remplace l'ancienne politique "toujours frais à
  chaque entrée sur l'onglet" par un compromis explicitement demandé par
  l'utilisateur — les données des AUTRES membres peuvent avoir jusqu'à 15 min de
  retard entre 2 visites, en échange de moins de lectures. **Invalidation immédiate**
  dès que MES propres données changent (`syncLeaderboardEntry()` appelle
  `invalidateLeaderboardCache()`), pour ne jamais retarder l'affichage de mon propre
  score après une séance.
- **Résilience préservée** : le calcul "suis-je dans le Top N" + la requête voisins
  restent dans le MÊME `try/catch`, indépendant de celui du Top N (déjà un incident
  de prod par le passé : un `Promise.all` englobant les 2 effaçait le Top N à tort en
  cas d'échec isolé de l'autre requête — voir le test dédié `#154`).

**⚠️ Action manuelle requise (une fois, en dehors du code)** : la requête "voisin
au-dessus" pour la vue **Hebdomadaire** (`where('xpWeekStart','==',...)
.where('xpWeekly','>',...).orderBy('xpWeekly','asc')`) nécessite un **nouvel index
composite Firestore** (`xpWeekStart` Ascendant + `xpWeekly` Ascendant) qui n'existe
probablement pas encore — l'ancien scan complet utilisait le tri inverse (`xpWeekly`
Descendant), déjà indexé, mais PAS ce sens-ci. Sans cet index, la requête échoue
proprement (gérée par le `try/catch` ci-dessus : le bloc "Hors Top 50" reste
simplement invisible pour la vue Hebdomadaire, aucun crash) jusqu'à ce que l'index
soit créé — via le lien que Firebase affiche dans la console au premier échec, ou en
l'ajoutant proactivement dans Firestore > Index > Composites. Les vues Séries/
Légendes n'ont besoin d'aucun nouvel index (un seul champ, sans filtre d'égalité —
couvertes par l'index automatique à champ unique que Firestore crée pour chaque
champ, dans les deux sens de tri).

## Fiche profil d'un ami (clic sur une ligne dans l'onglet Amis) — nouvelle fonctionnalite visible

**Demande** : dans l'onglet "Amis", un clic sur un ami de la liste "Mes amis" ouvre
desormais une fiche (overlay plein ecran, meme pattern que "Parcours de niveau" —
`openLevelRoadmap()`) affichant son niveau/titre d'athlete, sa serie en cours et ses
activites recentes.

- **Aucune nouvelle ecriture Firestore.** Les donnees XP/serie etaient deja presentes
  sur le document public `leaderboard/{uid}` (ecrit par `syncLeaderboardEntry()`) mais
  `fetchPublicProfile(uid)` ne les extrayait pas encore — il expose desormais aussi
  `xpTotal`/`streakCount`, reutilisant tel quel le cache deja en place (memoire +
  `localStorage`, TTL 6h).
- **Nouvelle requete ciblee pour l'activite recente** (`fetchFriendRecentActivities(uid)`,
  `where('uid','==',uid).orderBy('at','desc').limit(10)`), declenchee uniquement a
  l'ouverture de la fiche — differente du fil `activityFeed` deja existant qui fusionne
  l'activite de TOUS les amis (`where('uid','in',...)`) en un seul flux temps reel.
- **Repli si l'ami a desactive le classement** (`leaderboardOptOut`, doc
  `leaderboard/{uid}` absent) : la fiche affiche "Profil indisponible" et **n'interroge
  meme pas** l'activite recente — traite l'opt-out du classement comme un signal de
  confidentialite general, plutot que de continuer a exposer d'autres donnees de cette
  personne.
- **Declenchement limite a la liste "Mes amis"** : `renderFriendActionRow(...,
  clickable)` n'ajoute l'`onclick` d'ouverture de fiche que si `clickable=true` — les
  lignes de resultat de recherche et de demande recue restent volontairement non
  cliquables (seuls des amis confirmes ont une fiche consultable). Le bouton "retirer"
  (🗑️) stoppe la propagation pour ne pas ouvrir la fiche en meme temps qu'on retire
  l'ami.
- **Resilience preservee** : fetch du profil et fetch de l'activite recente restent
  dans des `try/catch` independants (meme principe que Top 50/voisins du classement) —
  un echec de la requete d'activite n'empeche jamais l'affichage du niveau/titre.

**⚠️ Action manuelle requise (une fois, en dehors du code)** : la requete d'activite
recente d'un ami (`where('uid','==',uid).orderBy('at','desc')`) combine egalite + tri
sur un autre champ, comme la requete "voisin" du classement ci-dessus — elle necessite
probablement un **nouvel index composite Firestore** (`activityFeed`, `uid` Ascendant +
`at` Descendant, scope Collection). Sans cet index, la requete echoue proprement (geree
par le `try/catch` : la fiche affiche juste "Aucune activite recente", aucun crash)
jusqu'a ce que l'index soit cree, via le lien Firebase dans la console au premier echec
ou proactivement dans Firestore > Index > Composites.

## Groupes & Defis Collectifs Gamifies + couche Cloud Functions (Blaze) — Phase 0 en cours

**Chantier en cours, le plus gros jamais entrepris sur cette appli.** Cahier des charges complet et plan d'architecture detaille dans une conversation dediee (groupes fermes, Ardoise cumulative, Hall of Fame, jokers tactiques, Raids Express). **Revirement architectural valide** : passage du plan Spark (gratuit, 100% client) au plan **Blaze** + **Cloud Functions**, pour precalculer le classement general cote serveur, cloturer/regler automatiquement les defis de groupe a echeance fixe (Scheduled Functions), et alleger le JS client.

**Nouveaute pour ce depot** : jusqu'ici, AUCUNE infrastructure serveur n'existait — tout etait gere a la main dans la Console Firebase, seul `index.html` etait deploye (GitHub Pages, simple push). Cette Phase 0 introduit pour la premiere fois :
- `functions/` — package Node independant (Cloud Functions), son propre `package.json`/`eslint.config.js`/tests, exclu du lint/tests du client racine (voir `ignores: ['functions/**']` dans `eslint.config.js` racine).
- `firebase.json` / `.firebaserc` — outillage CLI Firebase (projet `challenge-quotidien-hector`), scope volontairement limite a `functions` + `firestore` (rules/indexes) — **pas de bloc `hosting`**, GitHub Pages reste le seul hebergeur du front, inchange.
- `firestore.rules` / `firestore.indexes.json` — **rapatries dans le depot pour la premiere fois**, alors qu'ils n'existaient jusque-la que dans la Console.
- `.github/workflows/deploy-functions.yml` — CI separee du workflow client existant (`ci.yml`), declenchee uniquement sur des changements sous `functions/**`.

**`firestore.rules` verifie** : le texte reel des regles en production a ete fourni et compare ligne a ligne — `firestore.rules` reflete desormais fidelement la prod existante (users/{uid} wildcard, kudos par increment borne a +1 sur `kudosTotal`, usernames/friendRequests/friendships avec preuve d'existence de la demande, activityFeed/community ouverts a tout utilisateur authentifie, etc.), avec un seul AJOUT Phase 0/1 (`leaderboardCache/{view}`, lecture seule cote client) et un STUB Phase 2+ (Groupes) explicitement marque comme non encore verifie en production (la fonctionnalite n'existe pas encore cote client). **Mis a jour en Phase 1** : `deploy-functions.yml` deploie desormais aussi `firestore:rules,firestore:indexes` (plus seulement `functions`) — decision explicite prise au moment ou le classement precalcule (Phase 1) a eu besoin d'une regle de lecture (`leaderboardCache`) qui n'existait pas encore en prod. Le fichier reste verifie contre la prod reelle avant chaque changement ; le declencheur du workflow inclut maintenant aussi `firestore.rules`/`firestore.indexes.json`.

**Authentification CI** : compte de service Google Cloud (cle JSON generee depuis la Console, sans terminal), stockee dans le secret GitHub `GCP_SA_KEY`, utilisee via l'action `google-github-actions/auth` (remplace l'approche `firebase login:ci`/`FIREBASE_TOKEN` envisagee initialement).

**Fonctions Cloud prevues** (voir le plan pour le detail complet) : `aggregateLeaderboard` (Scheduled, 15 min — ecrit UNIQUEMENT `leaderboardCache/{view}`, jamais sur les documents individuels `leaderboard/{uid}`, pour ne jamais risquer d'exploser le quota gratuit d'ecritures ; rang exact hors Top 100 calcule a la demande via `getMyRank`, un Callable qui utilise `.count()` cote Admin SDK — fonctionnel contrairement au bug du SDK compat client deja documente plus haut), `closeExpiredGroupChallenges` (Scheduled, reglement automatique 50/50 + Ardoise + Hall of Fame), `applyGroupJoker` (Callable, usage unique securise cote serveur), `aggregateGroupContribution` (Trigger, allegement JS client, phase tardive).

**Decisions actees** : plafond de groupe 20 membres, appartenance a un groupe prime sur l'opt-out classement (visible par les co-membres), nouvel onglet dedie "Groupes", 5 titres Hall of Fame des la Phase 3 (Mecene, Roi des Repets, Clutch Player, Fantome, Metronome), Raids Express a duree configurable au lancement (24h/48h, defaut 24h). Cout Cloud Functions estime a l'echelle actuelle : negligeable (tres largement sous le palier gratuit 2M invocations/mois).

**Phase 0 : TERMINEE.** `functions/index.js` expose `helloWorld` (Callable, region `europe-west1`), **deploye avec succes en production** via `deploy-functions.yml` le jour de la mise en place. La chaine outillage -> CI -> deploiement Blaze est validee de bout en bout.

**Roles IAM necessaires sur le compte de service de deploiement** (`firebase-adminsdk-fbsvc@challenge-quotidien-hector.iam.gserviceaccount.com`), decouverts un par un au fil des echecs reels de deploiement — a reproduire si ce compte de service est un jour recree :
- **Editeur** (`roles/editor`) — couvre la quasi-totalite des operations (activation d'API, Cloud Build, Artifact Registry, etc.), mais PAS les actions de type "definir une policy IAM" (exclues par conception de ce role).
- **Utilisateur du compte de service** (`roles/iam.serviceAccountUser`) — necessaire pour executer les fonctions en tant que `challenge-quotidien-hector@appspot.gserviceaccount.com` (erreur `iam.serviceAccounts.ActAs` sinon).
- **Administrateur Cloud Functions** (`roles/cloudfunctions.admin`) — necessaire specifiquement pour definir la policy IAM d'invocation de la fonction (`roles/cloudfunctions.developer` ne suffit pas, message d'erreur explicite a ce sujet).

**APIs Google Cloud a activer manuellement une fois** (le compte de service ne peut pas les activer lui-meme, action reservee au proprietaire du projet) : Cloud Functions, Cloud Build, Artifact Registry, Cloud Run Admin, Eventarc, Cloud Scheduler, Pub/Sub — toutes deja activees a ce stade.

**Bindings IAM supplementaires necessaires sur les SERVICE AGENTS** (pas le compte
de service de deploiement lui-meme cette fois) **des le premier trigger Firestore**
(`onDocumentCreated`, ex: `sendPushOnNotificationCreate`, notifications push) -
un trigger `onCall`/`onSchedule` seul n'en a jamais eu besoin. Meme cause que
ci-dessus (le compte de service de deploiement ne peut pas definir de policy
IAM) : le deploiement echoue avec `Failed to verify the project has the
correct IAM bindings...`, et Firebase donne lui-meme les 3 commandes exactes
(numero de projet `613473786890`) - accordees UNE FOIS, via la Console
(IAM & Admin > IAM > "Accorder l'acces"), par le proprietaire du projet :
- `service-613473786890@gcp-sa-pubsub.iam.gserviceaccount.com` -> role `roles/iam.serviceAccountTokenCreator`
- `613473786890-compute@developer.gserviceaccount.com` -> roles `roles/run.invoker` ET `roles/eventarc.eventReceiver`

Runtime des fonctions : Node 22 (bascule depuis Node 20, deprecie et decommissionne le 2026-10-30).

## Phase 1 : classement precalcule cote serveur (aggregateLeaderboard + getMyRank)

Remplace l'ancien mecanisme 100% client (Top 50 par `.limit()` + 2 requetes ciblees
"voisins" pour approximer la position hors Top 50, sans jamais afficher de rang
exact - `.count()` indisponible sur le SDK compat client) par une agregation
planifiee cote serveur : le client ne fait plus qu'UNE lecture d'un document deja
calcule.

- **`aggregateLeaderboard`** (Scheduled Function, 15 min) : lit `leaderboard` en
entier (1 passage partage par tout le monde), ecrit UNIQUEMENT 3 documents
`leaderboardCache/{streaks|weekly|alltime}` (Top 100 + `totalCount`) — **n'ecrit
jamais** sur les documents individuels `leaderboard/{uid}` (aurait fait exploser
le quota gratuit d'ecritures des quelques centaines d'utilisateurs).
- **`getMyRank`** (Callable) : rang exact pour qui n'est pas dans le Top 100,
calcule A LA DEMANDE via `.count()` cote Admin SDK (fonctionnel, contrairement au
SDK compat client - voir le bug deja documente plus haut). `weekStart` est fourni
par le CLIENT (coherent avec sa propre notion locale de "cette semaine"), jamais
recalcule cote serveur (fuseau horaire).
- **UI simplifiee** : rang numerique EXACT partout desormais (gratuit dans le Top
100, via `getMyRank` sinon) — retrait complet du badge "Hors Top 50"/voisins
"Juste devant"/"Juste derriere" et de `rank-gap-hint` (renomme `rank-bar-hint`,
reutilise pour afficher "sur N participants", desormais disponible sans cout
supplementaire dans le meme document `leaderboardCache`).
- **Ma propre ligne toujours a jour** : `leaderboardCache` n'etant rafraichi que
toutes les 15 min cote serveur, `loadCommunityLeaderboard()` PATCHE ma propre
entree (si visible dans le Top N) avec ma valeur EN MEMOIRE a jour, cote client,
sans lecture supplementaire - garantit que je vois toujours mon propre score a
jour meme si le cache serveur ne l'a pas encore rattrape. Mon RANG (si hors Top
100) reste lui invalide/recalcule immediatement via `invalidateLeaderboardCache()`
(deja appele par `syncLeaderboardEntry()`), puisque `getMyRank` lit toujours des
donnees live.
- **Aucun nouvel index Firestore necessaire** : l'index composite
`xpWeekStart`+`xpWeekly` deja cree pour l'ancien mecanisme couvre aussi la
requete hebdomadaire de `getMyRank` (memes champs, direction compatible avec une
inegalite simple sans `orderBy` explicite).
- **Client** : ajout du SDK `firebase-functions-compat.js` (4e script Firebase,
meme discipline de chargement synchrone que les 3 autres - voir l'avertissement
`defer` en tete du fichier) + `functionsClient = firebase.app().functions(
'europe-west1')` (la region DOIT correspondre exactement a `setGlobalOptions()`
dans `functions/index.js`).

## Incident post-Phase 1 : `firestore:indexes` a supprime un index non documente (dailyContributors)

**Ce qui s'est passe** : le premier `firebase deploy --only firestore:indexes` via
la CI (ajoute en meme temps que la Phase 1) a fait planter tout l'onglet
Communaute en production (`FirebaseError: The query requires an index`) sur
`fetchTopContributorToday()` (badge "Contributeur du jour", fonctionnalite Boss
Battle deja existante, aucun rapport avec le classement precalcule).

**Cause reelle** : `firestore.indexes.json` ne listait que les 2 index connus
(`leaderboard` xpWeekStart+xpWeekly, `activityFeed` uid+at), tous deux
documentes dans ce fichier depuis leur creation manuelle via la Console. Un
3e index (`dailyContributors` : `date` Ascendant + `amount` Descendant),
necessaire pour `where('date','==',...).orderBy('amount','desc')`, existait
probablement DEJA en production (cree manuellement au moment du developpement
du Boss Battle) mais n'avait jamais ete consigne nulle part. `firebase deploy
--only firestore:indexes` traite le fichier local comme l'etat COMPLET desire
et supprime tout index existant qui n'y figure pas — ce 3e index a donc ete
supprime des le premier deploiement via la CI.

**Corrige** : index rajoute dans `firestore.indexes.json` (a recreer
immediatement en prod via le lien direct fourni par l'erreur Firebase, plus
rapide qu'attendre un nouveau deploiement CI) + `fetchTopContributorToday()`/
`fetchBossBattleArchive()` protegees par un `.catch()` (index.html, ~ligne 1730)
- un souci sur l'un de ces 2 badges annexes ne doit plus jamais faire planter
tout l'onglet Communaute via l'ecran d'erreur fatale globale, meme cause qui
avait deja motive la meme protection sur le Top N/mon rang du classement.

**Lecon retenue** : avant tout futur `firebase deploy --only firestore:indexes`,
verifier la liste REELLE des index dans Firebase Console > Firestore Database >
Index plutot que de se fier uniquement a une relecture du code — un index cree
manuellement par le passe et jamais documente peut toujours exister sans que
personne (y compris moi) ne le sache.

## Phase 2 : Groupes & Defis Collectifs Gamifies (fondations)

Nouvel onglet **Groupes** dedie (tab-bar) : creation/adhesion par code, roster,
premier defi collectif simple, reglement automatique cote serveur, bilan +
"Gage honore !". Prochaines phases (non livrees ici) : Ardoise/Hall of Fame
(Phase 3), Jokers (Phase 4), Raids Express (Phase 5).

**Schema Firestore** : `groups/{groupId}` (name/emoji/code/memberCount) +
`groups/{groupId}/members/{uid}` (jamais un tableau - chaque membre n'ecrit QUE
son propre doc, meme principe que `friendships`) ; `groups_by_code/{CODE}`
(reservation create-only, meme pattern que `usernames/{pseudo}`) ;
`users/{uid}/myGroups/{groupId}` (index personnel, evite une collectionGroup
query pour "mes groupes") ; `groups/{groupId}/challenges/{challengeId}` +
`.../participants/{uid}` (chaque membre n'ecrit que SON PROPRE `totalAmount`) ;
`groups/{groupId}/ledger/{entryId}` (ID deterministe `{challengeId}_{fromUid}_{toUid}`,
ecrit uniquement par la Cloud Function, le client ne peut que marquer
`honoredAt`/`honoredBy`).

**`closeExpiredGroupChallenges`** (Scheduled Function, 15 min, nouvelle) :
`collectionGroup('challenges').where('status','==','active')
.where('endDate','<=',now)` (necessite l'index collection-group `challenges`
`status`+`endDate`, ajoute proactivement des ce chantier — pas une redecouverte
a la dailyContributors). Pour chaque defi expire : classe les participants,
calcule le reglement (`computeSettlementPairs()`, logique PURE testee en
isolation - un seul algorithme couvre le mode 50/50 pair ET impair : le i-eme
depuis le haut est appaire au (n-1-i)-eme depuis le bas, le milieu exact d'un N
impair n'est simplement jamais touche par la boucle = Zone Neutre), ecrit les
entrees `ledger` + marque le defi `settled`, dans une transaction (protege contre
une re-execution de la fonction elle-meme - Scheduled Functions "at-least-once").

**Contribution** : `registerGroupChallengeContributionsIfNeeded()`, appelee depuis
`addSetInner()` comme `registerBossBattleContributionIfNeeded()` — chaque serie
loguee compte, pas seulement la complétion du défi. Un meme exercice peut
contribuer a PLUSIEURS defis de groupe simultanement (contrairement au Boss
Battle, un seul defi communautaire a la fois). `myActiveGroupChallenges`
(charge au demarrage + a chaque changement de mes groupes/defis) permet a une
serie loguee depuis N'IMPORTE QUEL onglet de contribuer, sans passer par l'onglet
Groupes.

**Simplification assumee** : un membre qui n'a JAMAIS ouvert le detail du groupe
ni contribue pendant tout un defi n'aura aucun doc participant, et n'apparait donc
pas au reglement final (ni dette ni recompense) — chaque membre n'ecrivant QUE
son propre doc participant (regle Firestore), le createur du defi ne peut pas
pre-lister tous les membres a la creation (aurait exige d'ecrire dans le doc
d'autrui). Pas un bug, un compromis delibere pour garder les regles simples.

**Aucune notification push OS** : les invitations de groupe et les bilans de defi
regle passent par le canal de notifications in-app deja existant (`users/{uid}/
notifications`), pas de nouvelle infrastructure - toujours pas de push reel
(voir le plan : hors perimetre sauf demande explicite).

**Nouveau dans le harnais de test** (`tests/app.test.js`) : `makeMockCollection()`
memoise desormais son wrapper PAR INSTANCE de store (Map), pas seulement la
donnee sous-jacente - un vrai bug de mock decouvert par les Groupes (1er
chantier a imbriquer 3 niveaux de sous-collections,
`groups/{id}/challenges/{id}/participants`) : sans cette memoisation, chaque
nouvel appel a `.collection('challenges')` sur le meme doc parent perdait le
suivi de SES PROPRES sous-collections (participants), meme si la donnee du
niveau `challenges` lui-meme restait bien partagee. Egalement ajoute : `.get()`
direct sur une collection (sans `where`/`orderBy` prealable) — valide en vrai
Firestore, jamais necessaire avant (toutes les fonctionnalites precedentes
filtraient/triaient toujours avant de lire).

## Phase 3 : Ardoise Globale + Hall of Fame

Ajoute 2 sous-onglets au detail d'un groupe (Defi / Ardoise / Palmares, bascule
`groupDetailView`) : **Ardoise Globale** (historique COMPLET des gages du
groupe, tous defis confondus - contrairement au bilan d'un defi, qui reste
scope a UN seul defi) et **Hall of Fame** (5 titres : Le Mecene, Le Roi des
Repets, Le Clutch Player, Le Fantome, Le Metronome).

**Rollups cumulatifs** sur `groups/{groupId}/members/{uid}` (`debtsOwed`,
`totalVolume`, `challengesParticipated`, `clutchWins`) : maintenus
UNIQUEMENT par `closeExpiredGroupChallenges` (Admin SDK) a chaque reglement -
le CLIENT ne fait que LIRE ces champs, deja charges avec le roster
(`groupDetailMembers`), donc **zero lecture supplementaire** pour calculer les
5 titres (`computeGroupHallOfFameTitles()`, logique pure cote client).

**Clutch Player** : seul titre necessitant une nouvelle donnee - un historique
horodate des contributions (`groups/{id}/challenges/{id}/contributions/{id}`,
meme pattern que le fil de contributions du Boss Battle), ecrit par le CLIENT
(`registerGroupChallengeContributionsIfNeeded()`, en plus de l'increment
`totalAmount` deja existant depuis la Phase 2), mais lu UNIQUEMENT par
`closeExpiredGroupChallenges` (jamais par un client). `detectClutchWin()`
(logique pure, testee en isolation) definit un "Clutch Win" comme un VRAI
comeback : si on retire tout ce que le 1er a contribue pendant la derniere
fenetre (les derniers 25% de la duree du defi, mesuree depuis `createdAt` -
PAS `startDate`, simple chaine cosmetique saisie a la creation, pas un
timestamp), le 2e serait-il passe devant ? Si oui, la fin de defi a
reellement fait gagner le 1er - pas juste "actif en fin de defi" alors qu'il
etait deja tres largement devant.

**Aucun nouvel index Firestore necessaire** : l'Ardoise Globale trie sur un
seul champ (`createdAt`), et le Hall of Fame ne fait aucune requete du tout
(donnees deja chargees).

## Correctif post-Phase 3 : reglement uniquement declenche par l'echeance, pas par l'objectif atteint

**Bug reel signale en prod** : un groupe de 2 personnes a lance un defi "100
pompes", atteint 125/100, et l'app affichait le defi comme "termine" (barre de
progression pleine) mais l'Ardoise restait vide ("aucun gage") et le Palmares
ne montrait aucun titre. `closeExpiredGroupChallenges` ne cherchait QUE les
defis dont `endDate <= now` (`.where('status','==','active').where('endDate',
'<=',now)`) — atteindre l'objectif chiffre n'avait strictement aucun effet sur
le declenchement du reglement, qui n'arrivait qu'a l'echeance choisie a la
creation (souvent plusieurs jours plus tard). La barre de progression a 125%
donnait l'illusion d'un defi cloture, alors que `status` restait `'active'`
tant que l'echeance n'etait pas atteinte.

**Corrige** en ajoutant un 2e declencheur, `shouldSettleChallenge(totalProgress,
targetTotal, endDate, now)` (logique pure, testee en isolation dans
`functions/test/groups.test.js`) : reglement des que l'objectif est atteint
OU que l'echeance est depassee (peu importe lequel arrive en premier).
`closeExpiredGroupChallenges` interroge desormais TOUS les defis `status==
'active'` (un seul filtre d'egalite — servi par le PREFIXE de l'index
composite `status`+`endDate` deja deploye, aucun nouvel index necessaire),
calcule `totalProgress` a partir des participants deja lus pour le classement,
et ne procede au reglement que si `shouldSettleChallenge()` renvoie vrai.
L'echeance reste un filet de securite : un defi dont personne n'atteint la
cible se cloture quand meme a la date prevue.

**Cote client** : un message d'attente (`groups.targetReachedAwaitingSettlement`)
s'affiche des que la somme des participants atteint la cible, meme si le defi
est encore `active` — evite qu'un utilisateur croie a un bug pendant le court
delai (jusqu'a 15 min) avant le prochain passage de la fonction planifiee.

**Annulation d'un defi bloquant** (`cancelGroupChallenge()`/
`cancelGroupChallengeConfirm()`) : ajoutee suite a ce meme bug — pendant qu'un
defi teste en prod restait coince "actif" en attendant le prochain passage de
la fonction planifiee, aucun moyen de le supprimer ni d'en lancer un autre pour
retester (un groupe n'affiche le bouton "Nouveau defi" que si aucun defi
`active`/`settled` n'est trouve). Seul `createdBy` peut desormais annuler SON
propre defi tant qu'il est encore `active` — transition stricte `active` ->
`cancelled`, gardee cote regles (`firestore.rules`, `affectedKeys().hasOnly(
['status','cancelledAt'])`) en plus du bouton conditionnel cote client. Un defi
`cancelled` ne correspond a aucun des 2 statuts recherches par `loadGroupDetail()`
(`active` ou `settled`), donc il est simplement ignore — le defi actif suivant
(ou le bouton "Nouveau defi" si aucun) reprend sa place immediatement, sans
attendre la Cloud Function.

## Correctif : plafond exact des contributions + reglement instantane (logGroupChallengeContribution)

**Bug reel signale en prod, 2e episode** : avec la cible atteinte declenchant deja
le reglement (correctif precedent), un test reel a quand meme montre "120/100" qui
persistait plusieurs heures. Cause racine : chaque membre incrementait DIRECTEMENT
son propre doc `participants/{uid}.totalAmount` (ecriture Firestore cliente,
fonctionnant hors-ligne) sans jamais voir le total des AUTRES membres — 2 membres
loguant chacun 60 sur un objectif de 100 faisaient donc 120/100 (au lieu du
plafond exact attendu : 60 + 40). Le reglement lui-meme fonctionnait, mais le
TOTAL enregistre depassait la cible.

**Decision produit (validee explicitement malgre le compromis)** : un plafond
exact et sans race condition entre 2 contributions quasi-simultanees exige une
autorite SERVEUR unique - impossible a garantir avec 2 clients qui ecrivent
chacun sans se voir. Bascule donc `registerGroupChallengeContributionsIfNeeded()`
d'une ecriture Firestore directe vers un appel a une nouvelle Cloud Function
Callable, `logGroupChallengeContribution` (Admin SDK, transaction). **Compromis
assume** : cette action necessite desormais une connexion reseau au moment du tap
(contrairement au reste de l'app, 100% hors-ligne) - accepte explicitement au
profit de l'exactitude du plafond.

**Cote serveur** (`functions/index.js`) : `logGroupChallengeContribution` lit le
defi + RESOMME tous les participants existants (borne par la taille du groupe,
<=20 - jamais un champ separe `currentProgress` a maintenir en parallele, donc
toujours coherent avec la verite `participants/{uid}.totalAmount`, y compris pour
un defi deja en cours AVANT ce chantier), plafonne via `computeCreditedAmount()`
(logique pure, testee en isolation : sous la cible -> montant complet, depasserait
-> ne credite que le restant exact, cible deja atteinte -> 0), puis appelle
`settleChallengeIfNeeded()` **immediatement** si la cible est desormais atteinte -
fini le "jusqu'a 15 min d'attente". `settleChallengeIfNeeded()` (extrait de
l'ancien corps de `closeExpiredGroupChallenges`, desormais partage entre les 2
chemins) reste inchangee dans sa logique de reglement elle-meme.
`closeExpiredGroupChallenges` (toujours planifiee, 15 min) devient un pur FILET DE
SECURITE : ne reste utile que pour les defis dont l'ECHEANCE se depasse SANS que
personne n'atteigne la cible (aucune ecriture pour reagir dans ce cas).

**Regles Firestore resserrees en consequence** : `participants/{uid}` passe de
`allow write` (le membre pouvait tout modifier sur son propre doc) a `allow
create` uniquement (creation initiale `totalAmount:0` via `ensureMyParticipantDoc`,
toujours cote client) - toute INCREMENTATION passe desormais exclusivement par la
Cloud Function. `contributions/{id}` perd entierement son `allow create` client
(plus aucune ecriture directe, tout passe par la meme transaction serveur).

**Popup de felicitations enrichie** : `settleChallengeIfNeeded()` embarque
desormais `winnerName` (1er contributeur par volume) dans la notification
`group_challenge_settled` - le popup cote client affiche un message different
("{{winner}} remporte le defi...") quand ce champ est present, sinon repli sur le
message generique (compatibilite avec d'anciennes notifications sans ce champ).
Comme le reglement est desormais instantane, cette popup arrive quasi
immediatement a TOUS les participants via le canal de notifications temps reel
deja existant (`listener unique`) - aucune nouvelle infrastructure necessaire.

## Phase 4 : Jokers tactiques (applyGroupJoker)

Ajoute une section "Jokers tactiques" a l'ecran d'un defi de groupe ACTIF : Le
Doublon, Le Boulet, L'Immunite Swiss. **UN SEUL joker par participant et par
defi** (ressource rare, choix tactique) - une fois utilise, la section affiche un
statut au lieu des 3 boutons.

**Ecrit exclusivement via `applyGroupJoker`** (Callable, Admin SDK, transaction) -
meme raisonnement que `logGroupChallengeContribution` : `participants/{uid}` est
deja verrouille en `create`-only cote client (Phase precedente), donc AUCUN effet
croise entre participants (Le Boulet ecrit sur le doc d'un TIERS) n'aurait pu
passer par les regles Firestore de toute facon. La fonction verifie le defi encore
`active`, qu'aucun joker n'a deja ete utilise (`jokerUsed`), et pour Le Boulet que
la cible existe et n'est jamais soi-meme.

- **Le Doublon** (x2 pendant 2h) : `doublonActiveUntil = now + 2h` sur MON propre
  doc participant. Applique par `applyDoublonMultiplier()` (logique pure) DANS
  `logGroupChallengeContribution`, AVANT le plafonnage (`computeCreditedAmount()`) -
  double donc aussi bien ma contribution a la cible partagee que mon totalAmount
  reel pour le classement.
- **Le Boulet** (+20 de handicap) : cible un ADVERSAIRE (`targetUid`, jamais
  soi-meme) - `handicap: increment(20)` ecrit sur le doc du CIBLE, jamais le mien.
  Le handicap ne touche QUE le classement de reglement (`rankForSettlement()`,
  logique pure) : `effectiveAmount = max(0, totalAmount - handicap)` sert
  uniquement a `computeSettlementPairs()` - le vrai `totalAmount` (Hall of Fame,
  progression partagee) n'est jamais modifie.
- **L'Immunite Swiss** : `immune: true` sur mon propre doc - `rankForSettlement()`
  me retire ENTIEREMENT du tableau passe a `computeSettlementPairs()` (ni dette ni
  recompense possible), mais mes vraies statistiques (Hall of Fame,
  `challengesParticipated`, etc.) restent comptees normalement via `ranked` (le
  classement BRUT, toujours utilise pour tout le reste : Clutch Win, rollups,
  `winnerName`).

**Separation cle** : `ranked` (brut, par `totalAmount`) sert a TOUT sauf le
reglement financier lui-meme ; `rankForSettlement(ranked)` (immunite retiree,
handicap applique) ne sert QUE pour `computeSettlementPairs()`. Cette distinction
evite qu'un joker fausse les vraies statistiques de performance (Hall of Fame)
tout en modifiant reellement qui doit quoi a qui.

**Cote client** : section Jokers dans `renderGroupDetailScreen()`
(`renderGroupJokerSection()`) - 3 boutons si `!myParticipant.jokerUsed`, sinon un
statut (Doublon actif/utilise avec minutes restantes, Immunite activee, Boulet
lance sur untel). Le Boulet necessite un picker de cible (`pickingBouletTarget`,
liste les AUTRES participants uniquement) avant confirmation. Badges informatifs
sur `renderGroupParticipantRow()` (🛡️ immunite, `-N` handicap) pour que les autres
membres comprennent l'ecart entre le total affiche et le classement de reglement
reel. Aucun nouvel index Firestore necessaire (aucune nouvelle requete, seulement
des lectures de documents individuels deja connus par leur ID).

## Phase 5 (Raids Express) implementee puis retiree

Une Phase 5 "Raids Express" (mini-defi spontane 24h/48h, enjeu fixe et inverse -
le createur offre en cas de succes) a ete implementee, testee, deployee en prod,
puis **retiree a la demande explicite de l'utilisateur** (`git revert`) apres un
premier test reel : l'enjeu "inverse" (le createur, qui a lui-meme fait le travail
et "gagne", doit pourtant payer) s'est avere contre-intuitif en pratique, et
l'utilisateur a juge la fonctionnalite peu interessante dans l'ensemble. **Ne pas
la re-proposer sans qu'elle soit explicitement redemandee** - si elle revient un
jour, repartir du principe INVERSE (succes -> le groupe doit au createur, coherent
avec le mode `winnerTakesAll` des defis classiques) plutot que le sens original du
plan initial.

## Correctif : perte de focus/clavier a chaque frappe (onglet Groupes)

**Bug reel signale en prod** : dans TOUS les formulaires texte de l'onglet Groupes
(creer un groupe, rejoindre par code, creer un defi collectif - nom/objectif/gage),
taper une lettre faisait disparaitre le clavier/focus, obligeant a recliquer dans
le champ a chaque caractere. Cause racine : `render()` remplace INTEGRALEMENT le
`innerHTML` de `#app` a chaque frappe (chaque `updateXxxDraft()` appelle `render()`
en direct) - un `<input>` recree perd toujours son focus navigateur. Ce probleme
etait deja identifie et corrige au cas par cas pour la recherche Defis
(`librarySearchInput`), la recherche d'amis (`friendSearchInput`) et le pseudo
(`usernameSetupInput`), mais **la branche `activeTab === 'groups'` n'avait jamais
recu ce filet** - oubli lors de l'implementation initiale des Groupes (Phase 2).

**Corrige** en **generalisant** le filet plutot qu'en dupliquant un 4e bloc
quasi-identique : `applyContentPreservingFocus(app, html, animate)` capture
`document.activeElement` AVANT le re-rendu (id + position du curseur), puis le
retrouve par son `id` APRES et lui rend le focus - fonctionne pour N'IMPORTE quel
champ, peu importe l'ecran, contrairement aux 3 filets precedents qui ciblaient un
seul id fixe chacun. Les 3 blocs existants (username/friends/library) ET le
nouveau bloc Groupes utilisent desormais cette meme fonction. **Piege identifie en
implementant** : ce mecanisme necessite que le champ concerne ait un `id="..."`
explicite (recherche par `getElementById` apres le re-rendu) - `groupCreateNameInput`,
`groupJoinCodeInput`, `groupChallengeNameInput`, `groupChallengeTargetInput` et
`groupChallengeStakeDescInput` ont ete ajoutes a cet effet. **Tout futur champ
texte dont le `oninput` appelle `render()` en direct doit recevoir un `id`
explicite**, sinon `applyContentPreservingFocus()` ne peut pas le retrouver et le
meme bug reapparaitra silencieusement.

## Gage structure ('beer' / 'custom') a la creation d'un defi de groupe

**Demande utilisateur** : le champ de gage 100% texte libre fragmentait les
saisies (variations de casse/orthographe/espaces) - impossible de sommer
proprement dans l'Ardoise (ex: afficher "3 bieres" au lieu de 3 lignes quasi
identiques mais techniquement distinctes).

**Remplace le texte libre par un selecteur structure** sur le defi
(`challenge.stakeType: 'beer' | 'custom'`) :
- `'beer'` (defaut) : aucune saisie necessaire, `stakeDescription` force a `''` a
  la creation (`createGroupChallenge()`) - le libelle affiche ("🍺 Une biere" /
  "🍺 N bieres") est TOUJOURS derive via `tn('groups.stakeTypes.beerLabel', count)`,
  jamais stocke comme texte - donc jamais de variation possible, agregation fiable
  a 100%.
- `'custom'` ("Autre..." dans le selecteur) : revele le champ texte libre
  historique (`groupChallengeStakeDescInput`), soumission bloquee si vide
  (`submitGroupChallengeForm()`). Les gages custom identiques MOT POUR MOT se
  regroupent aussi (comportement naturel de l'algorithme de regroupement,
  pas de traitement special), mais 2 textes differents ne fusionnent jamais.

**Le reglement (`settleChallengeIfNeeded`, Cloud Function) copie `stakeType` sur
chaque entree `ledger`** exactement comme il copiait deja `stakeDescription` -
`stakeType` absent (defis crees AVANT ce champ) => traite comme `'custom'` a
l'affichage, texte historique inchange, **retro-compatible sans migration**.

**Agregation cote client, PUREMENT a l'affichage** (aucune ecriture
supplementaire, aucun changement du nombre de documents `ledger` reellement
ecrits - toujours un document par paire gagnant/perdant et par defi regle) :
`groupLedgerEntriesForDisplay(entries)` (logique pure) regroupe les entrees
IDENTIQUES - meme `(fromUid, toUid, stakeType, stakeDescription-si-custom,
honore-ou-non)` - en une seule ligne avec un compteur. **Ne fusionne JAMAIS un
gage honore avec un gage en attente** (statuts distincts dans la cle de
regroupement) - eviterait l'illusion qu'honorer 1 gage sur 3 les honore tous.
Reutilisee identiquement par le bilan d'UN defi (`groupDetailLedger`) ET
l'Ardoise Globale (`groupDetailLedgerHistory`, tous defis confondus) via
`renderLedgerEntriesList()` - meme fonction, memes garanties.

**Honorer une ligne agregee honore TOUS les gages qu'elle represente en un seul
geste** : `honorLedgerEntries(groupId, entryIds)` (batch Firestore, remplace
l'ancienne `honorLedgerEntry()` a un seul document) - correspond au modele mental
"je regle toute mon ardoise de bieres aupres de cette personne d'un coup", plutot
que de forcer un clic par biere individuelle.

## Correctifs : Le Boulet cible vide + curseur casse sur l'objectif chiffre

**Bug reel signale en prod (Le Boulet)** : "je clique sur Le Boulet, rien ne se
passe". En realite le picker de cible s'ouvrait bien (`pickingBouletTarget =
true`), mais restait **VIDE** des que l'adversaire vise n'avait jamais ouvert le
detail du groupe NI contribue a CE defi precis - il n'avait alors AUCUN doc
`participants/{uid}` (voir la simplification assumee documentee en Phase 2), et le
picker listait `challenge.participants` (les seuls a avoir un doc) au lieu de
`groupDetailMembers` (TOUS les membres du groupe). Un groupe fraichement cree,
juste apres avoir lance un defi, tombe systematiquement dans ce cas (aucun autre
membre n'a encore eu l'occasion d'ouvrir/contribuer).

**Corrige cote client** : le picker liste desormais `groupDetailMembers` (tous les
membres reels du groupe), plus jamais seulement les participants deja actifs sur
ce defi - avec un message vide explicite (`groups.jokers.pickTargetEmpty`) pour le
cas (rare) d'un groupe a un seul membre.

**Corrige cote serveur** (`applyGroupJoker`, cas `'boulet'`) : si la cible n'a
aucun doc participant, la Cloud Function le **cree a la volee** (`totalAmount:0`,
`handicap:20` directement, pas un increment) a partir de son profil de membre
(`groups/{groupId}/members/{uid}`, toujours disponible pour n'importe quel membre)
- au lieu de rejeter l'appel avec une erreur 'not-found' que le client n'affichait
nulle part de facon visible (autre cause du "rien ne se passe" ressenti).

**Reponse a la question posee** ("si la cible a 0 pompes, est-ce que ca la met a
-20 ?") : NON - `rankForSettlement()` plafonne deja `effectiveAmount` a
`Math.max(0, totalAmount - handicap)`, jamais negatif. Une cible a 0 contributions
qui recoit un handicap de 20 reste simplement a effectiveAmount 0 (aucun effet
concret) **jusqu'a ce qu'elle contribue elle-meme au moins 20** - a partir de la,
chaque contribution supplementaire compte normalement, moins les 20 de handicap.
Le texte de confirmation (`bouletConfirmSubtitleTarget`) precise desormais
explicitement "jamais en dessous de 0, aucun effet sur ses vraies repetitions".

**Bug reel signale en prod (curseur)** : dans le champ "objectif" (nombre de
repetitions) du formulaire de defi de groupe, taper un chiffre faisait sauter le
curseur au DEBUT du champ, rendant la saisie de nombres a plusieurs chiffres
impossible (taper "1" puis "0" donnait "01" au lieu de "10"). Cause : ce champ
etait en `type="number"`, qui NE SUPPORTE PAS `setSelectionRange()` (restriction du
DOM standard, contrairement a `type="text"`) - `applyContentPreservingFocus()` (le
correctif de perte de focus documente plus haut) ne pouvait donc jamais restaurer
la position du curseur pour ce champ specifiquement, et le navigateur retombait
sur son comportement par defaut (debut du champ). **Corrige** en passant ce champ
en `type="text" inputmode="numeric" pattern="[0-9]*"` (meme clavier numerique
mobile, mais support complet de la position du curseur) + un filtre JS
(`updateGroupChallengeDraft()`) qui retire les caracteres non numeriques, pour
compenser la perte de la contrainte native du navigateur sur `type="number"`. Les
AUTRES champs numeriques de l'app (`cfTarget`, `customAddInput`) n'ont pas ce
probleme : ils sont "non controles" (lus directement via `.value` au moment du
clic, jamais re-rendus en direct pendant la frappe) - seul ce champ reactif
(`oninput` -> `render()` a chaque frappe, pour le calcul EN DIRECT de "~X par
personne") avait besoin de ce traitement particulier.

## Journal fusionne dans l'onglet Profil (5 onglets au lieu de 6)

**Demande explicite de l'utilisateur** (retour UX) : 6 onglets dans la barre du bas
etait juge excessif. Le Journal (calendrier, heatmap, historique) et le Profil
(carte athlete, trophees, compte) sont tous les 2 des ecrans "retrospectifs, a
propos de moi", visites moins souvent que les 4 autres onglets (Aujourd'hui/
Défis/Communaute/Groupes, tous "actifs, au quotidien") - candidat de fusion le
plus sur, contrairement a Groupes+Communaute (deja tres charges chacun, fusionner
aurait echange "trop d'onglets" contre "un onglet trop profond") ou Défis+Aujourd'hui
(taches trop differentes : execution du jour vs curation du catalogue).

**Implementation** : `profileView` ('profile' | 'journal') - meme principe que
`groupDetailView` pour les Groupes (sous-onglet, PAS une vue imbriquee avec pile
d'historique/bouton retour). `renderAccountTabScreen()` affiche desormais 2
boutons de sous-onglet (reutilisent directement `profileTab.title`/`history.title`
comme libelles, aucune nouvelle cle i18n necessaire) et le contenu correspondant :
`renderJournalSection()` (ex-`renderHistoryScreen()`, prive de son propre h1/
sous-titre - geres par l'ecran englobant) ou la carte athlete + trophees + compte
habituelle. **Contrairement aux Groupes** (h1 = nom du groupe, inchange quel que
soit le sous-onglet), le h1/sous-titre de Profil changent selon `profileView` -
il n'y a pas d'equivalent "nom de l'entite" pour Profil, donc le titre lui-meme
porte l'information de la vue active (reutilise tel quel `profileTab.title/
subtitle` et `history.title/subtitle` existants).

`switchProfileView(view)` recharge le Journal a la demande en entrant dessus
(`loadHistoryEntries()`, meme mecanisme que l'ancien `switchTab('history')`
dedie - `historyLoading` gere le meme etat de chargement qu'avant).
`switchTab()` reinitialise `profileView` a `'profile'` en quittant l'onglet
Profil (meme discipline que `librarySearchQuery`/`openGroupId`/etc. - chaque
onglet repart de son ecran racine).

**Retro-compatibilite** : le raccourci PWA "Journal" (`manifest.json`, appui long
sur l'icone) pointe toujours vers `?tab=history` - **volontairement inchange**
(`applyShortcutTabFromUrl()` traduit desormais cet alias vers `activeTab='account'`
+ `profileView='journal'`), pour ne pas avoir a mettre a jour le manifest ni
attendre qu'un PWA deja installee recharge son raccourci en cache. Le tour guide
perd sa carte dediee au Journal (4 cartes au lieu de 5) - la carte "Profil"
mentionne desormais le Journal au passage.

## Passe UX premium sur l'onglet Groupes

**Demande explicite de l'utilisateur** (retour UX) : l'onglet Groupes reutilisait
uniquement des composants generiques (`.leaderboard-row`, `.history-empty`,
`.friend-action-btn`) partout - un defi collectif, une ligne d'ardoise, un titre
du Hall of Fame et un membre du roster se rendaient tous de facon identique et
plate, "effet page web" plutot qu'ecran de jeu. 6 ameliorations cote CSS/rendu
uniquement (aucun changement de donnees/architecture Firestore) :

1. **Barres de progression animees** : `.athlete-xp-fill` (deja partagee entre le
   defi/raid de groupe ET l'XP du Profil) recoit une animation `scaleX(0)->1` a
   chaque affichage. Choix technique important : une transition CSS classique sur
   `width` NE FONCTIONNE PAS dans cette appli, puisque `render()` remplace tout le
   `innerHTML` a chaque rendu - un nouveau noeud DOM apparait deja a sa largeur
   finale, aucune transition ancien->nouveau n'est possible sans changer
   l'architecture de rendu. `transform: scaleX()` contourne ca : la largeur reelle
   (deja fixee via `style="width:X%"` inline) sert de reference, l'animation ne
   fait que faire *grandir* visuellement cette largeur depuis 0 a chaque montage -
   c'est le MEME contournement utilise pour les points 3/5/6 ci-dessous (toutes les
   animations "entrantes" de cette appli sont necessairement des animations
   "a chaque montage", jamais de vraie transition entre 2 etats sur un meme noeud).
2. **Celebration a l'objectif atteint** : `renderConfettiBurst()` (positions FIXES,
   pas de `Math.random()` - deterministe et testable) accompagne le message
   "objectif atteint" (`.groups-celebrate`), pas le bilan deja regle (aurait rejoue
   a chaque reconsultation, effet gadget plutot que moment specifique).
3. **Identite visuelle des jokers** : `.joker-card` + classe `doublon`/`boulet`/
   `immunite` (couleur/glow distincts : bleu electrique, rouge impact, dore) au
   lieu du meme bouton generique repete 3x - le statut (joker deja utilise) garde
   la meme identite visuelle que le bouton d'origine.
4. **Etats vides "premium"** : `renderGroupsEmptyState(icon, text, ctaHtml)`
   (reutilisable, meme esprit que `.today-empty-*` mais sans nouvelle cle i18n -
   reutilise le texte existant de chaque etat vide) remplace `.history-empty` pour
   : aucun groupe, aucun defi actif (CTA "Lancer un defi" integre), aucun gage
   (Ardoise), aucun titre (Palmares), aucune cible disponible (picker du Boulet).
5. **Transition de sous-onglet** : `.groups-subtab-content` (reutilise
   `card-pop-in`, deja utilisee pour l'entree en cascade des cartes Defis/
   Aujourd'hui) enveloppe le contenu du sous-onglet actif de Groupes ET de Profil
   (meme mecanisme de sous-onglet, meme correctif applicable) - re-joue a chaque
   bascule (meme limite architecturale qu'au point 1 : pas de vrai crossfade
   ancien/nouveau noeud possible).
6. **Liste "mes groupes" en cartes** : `.group-card` (degrade, coins arrondis,
   entree en cascade) remplace la liste de simples lignes de leaderboard - un
   badge "⚡ Defi en cours" apparait si `myActiveGroupChallenges` contient deja ce
   groupe (aucune lecture Firestore supplementaire, donnee deja chargee).

Toutes les animations respectent `prefers-reduced-motion: reduce` (meme
discipline que les animations existantes de l'appli - `.picker-item`,
`.gate-arrow`).

**Limite de verification connue** : ce chantier a ete verifie par la suite de
tests (regression sur les classes/contenus attendus) + lint + relecture du code,
mais **pas visuellement dans un vrai navigateur** - ce depot n'a ni serveur de
developpement ni outillage de capture d'ecran/navigateur automatise. A confirmer
visuellement par l'utilisateur avant de considerer le rendu final valide.

## Restructuration de l'onglet Groupes (hierarchie visuelle)

**Demande explicite de l'utilisateur** (suite au retour ci-dessus) : rejoindre/
creer un groupe ne devrait pas avoir la meme place que les cartes groupe (action
rare), et dans le detail d'un groupe, le roster (liste des membres) est accessoire
et prenait toute la place en tete d'ecran alors que le defi du moment devrait
dominer visuellement, a l'image de la Boss Battle en Communaute ou du "defi du
boss" - comparaison explicite de l'utilisateur avec l'ecran d'info d'un groupe
WhatsApp (accessible via un bouton, jamais affiche par defaut).

1. **Racine de l'onglet Groupes** : les 2 blocs "rejoindre avec un code"/"creer un
   groupe" (toujours visibles, meme poids que la liste des groupes) sont remplaces
   par 2 icones haut-droite (loupe 🔍 / plus ➕, `.add-custom-fab` deja utilisee
   pour l'ajout de defi personnalise dans la Bibliotheque) qui revelent chacune
   leur formulaire au clic - `joiningGroupOpen`/`creatingGroupOpen`, mutuellement
   exclusifs (`toggleJoiningGroupOpen()`/`toggleCreatingGroupOpen()` ferment l'autre
   en s'ouvrant). Cle i18n `groups.createBtn` (bouton pleine largeur) supprimee,
   devenue inutile.
2. **Detail d'un groupe : carte "hero" du defi actif** (`.group-challenge-hero`) -
   remplace la simple barre `.athlete-xp-track`/`.athlete-xp-label` par une carte
   proeminente (degrade, glow vert) avec pourcentage en gros (40px), barre de
   progression plus epaisse, ET **le temps restant avant l'echeance**
   (`formatGroupChallengeTimeRemaining()`, pure : "X jours restants" ou "Dernier
   jour !" sous 24h) - absent de l'ancien affichage. La barre garde la classe
   `athlete-xp-fill` (animation `scaleX` du point precedent) en plus de sa propre
   classe de couleur/taille.
3. **Detail d'un groupe : roster/invitations releques dans un panneau "info"**
   (`renderGroupInfoSheet()`) ouvert via un bouton "⋯" (`openGroupInfoOverlay()`/
   `closeGroupInfoOverlay()`), exactement le meme mecanisme DOM que la fiche ami
   (`openFriendProfile()`/`.level-roadmap-overlay` reutilisee telle quelle, aucune
   nouvelle classe CSS necessaire) : un `<div>` cree via `document.createElement`
   et ajoute a `document.body`, en dehors du `#app` remplace par `render()`. Le
   code du groupe (`groups.codeLabel`), auparavant dans l'en-tete principal, vit
   desormais uniquement dans ce panneau (evite la duplication). `groupInfoOverlayOpen`
   (booleen) suit le meme role que `friendProfileOpenUid` : un simple garde-fou
   d'etat, PAS necessaire au fonctionnement reel (les donnees membres/amis sont
   deja en memoire, aucun fetch asynchrone), mais indispensable pour rester
   testable avec le mock DOM des tests (`document.getElementById()` y cree
   toujours un element a la demande et ne reflete jamais un vrai `appendChild()` -
   voir `tests/app.test.js`, meme limite deja documentee pour la fiche ami).

Aucun changement de donnees/architecture Firestore - uniquement du rendu/etat
client. CACHE_NAME -> v61. Meme limite de verification que le chantier
precedent : valide par tests+lint, **pas visuellement dans un vrai navigateur**.

## Formulaire "Nouveau defi collectif" regroupe en 3 sections

**Demande explicite de l'utilisateur**, capture d'ecran a l'appui : le formulaire
etait une liste plate de champs visuellement identiques (nom, exercice, 2 champs
date sans libelle distinctif, objectif, mode, gage) - impossible de deviner d'un
coup d'oeil ce qui relevait de la definition du defi, des dates, ou de la
recompense. `renderCreateGroupChallengeForm()` regroupe desormais les champs en 3
blocs `.group-challenge-form-section` (carte + petit intitule en majuscules,
couleur accent) :

1. **🎯 Le defi** : nom, exercice, objectif global (+ l'indication "~X par
   personne" deja existante) - place ici plutot que dans une 4e section, car
   l'objectif definit CE QU'EST le defi, ni une date ni une recompense.
2. **📅 Date & duree** : debut, fin - chaque champ recoit desormais un petit
   libelle au-dessus (`.group-challenge-field-label`, "Debut"/"Fin") : avant ce
   correctif, les 2 `<input type="date">` etaient visuellement indiscernables
   tant qu'aucune date n'etait choisie (capture d'ecran utilisateur : 2 lignes
   vides identiques).
3. **🎁 Recompense** : mode de partage (50/50, dernier paye tout...) + gage
   (biere/personnalise).

Purement visuel (memes ids/noms de champs, meme logique de soumission/validation)
- aucun test existant sur `submitGroupChallengeForm()`/`updateGroupChallengeDraft()`
n'a du etre modifie, seules de nouvelles assertions structurelles ont ete
ajoutees. CACHE_NAME -> v62. Meme limite de verification que les chantiers
precedents : valide par tests+lint, **pas visuellement dans un vrai navigateur**.

## Resume des soldes (Ardoise) + celebration epique de victoire de groupe

**Demande explicite de l'utilisateur**, 2 idees choisies parmi une liste de
recommandations inspirees de grandes applications :

1. **Resume des soldes façon Splitwise** (`computeGroupNetBalances()`, pure) :
   au lieu de forcer a parcourir toute l'Ardoise Globale chronologique pour
   comprendre "qui doit quoi", un nouveau bloc "Resume des soldes" en tete
   nette les gages EN ATTENTE (les gages deja `honoredAt` sont totalement
   exclus - deja regles) entre les 2 sens d'UNE MEME paire de membres ET d'UN
   MEME type de gage EXACT (meme `stakeType` + meme `stakeDescription` si
   'custom'). **Choix assume, different de Splitwise** : un gage "biere" ne se
   compense JAMAIS avec un gage "vaisselle" de l'autre sens - contrairement a
   de l'argent, un gage n'est pas fongible, donc netter des types differents en
   un seul nombre serait trompeur. La liste detaillee/chronologique existante
   (avec le bouton "Gage honore !") reste inchangee en dessous : **le resume
   est purement informatif, honorer un gage se fait toujours sur la liste
   detaillee** - decision volontaire pour eviter un flou sur QUELLES entrees
   precises seraient marquees honorees si le bouton agissait sur un solde deja
   nette (ex: nettent 3 gages de a vers b et 1 de b vers a en "a doit 2 a b" -
   honorer ce "2" ne correspond a aucun sous-ensemble evident des 4 entrees
   brutes sous-jacentes). Etat "tout le monde est quitte" via
   `renderGroupsEmptyState()` (composant deja existant) si aucun solde ne
   subsiste.
2. **Celebration plein ecran a la victoire d'un defi de groupe** : le systeme de
   popups "plein ecran style Duolingo" (`enqueuePopup()`/`.app-popup-overlay`,
   deja existant, deja utilise pour les trophees/changements de niveau/de
   titre) est etendu au reglement d'un defi de groupe. `settleChallengeIfNeeded()`
   (Cloud Function) calcule desormais `targetReached` (objectif chiffre
   reellement atteint, pas juste une echeance expiree) et l'embarque dans la
   notification `group_challenge_settled`. Cote client, `targetReached: true`
   declenche une popup `variant:'trophy', epic:true` (memes confettis/effets
   dores qu'un trophee debloque) au lieu du bilan neutre habituel - une
   victoire collective merite mieux qu'un simple "Bilan disponible". Un
   reglement par simple expiration d'echeance (sans objectif atteint) garde le
   bilan neutre existant. **Les 2 autres "paliers" mentionnes dans la demande
   initiale (niveau, serie de 30 jours) etaient deja epiques** :
   `enqueueTrophyPopups()` couvre deja tout badge fraichement debloque
   (y compris `streak_30`) avec confettis, et `enqueueLevelPopups()` bascule
   deja en variante epique des qu'un changement de TITRE d'athlete survient
   (pas chaque niveau individuel, volontairement - reserver l'epique aux
   moments reellement rares evite la lassitude/l'inflation de l'effet).
   **Correctif de securite associe** (remarque en modifiant ce code) : le nom
   du defi et le nom du gagnant (texte libre utilisateur) etaient interpoles
   SANS echappement dans `t()`/`interpolate()` avant d'etre injectes en
   `innerHTML` (popup de reglement) - corrige par `escapeHtml()` sur les 2
   variantes (gagnante et neutre) de cette popup precise.

CACHE_NAME -> v63. Aucun changement de regles Firestore. Meme limite de
verification que les chantiers precedents : valide par tests+lint (client ET
Cloud Functions), **pas visuellement dans un vrai navigateur**.

## Notifications push OS (Firebase Cloud Messaging) — Phase A

**Demande explicite de l'utilisateur** : un systeme de notifications **push OS**
(recues meme app fermee), au minimum pour un defi de groupe cree, une demande
d'ami, un defi de groupe reussi, et un rappel avant echeance. Plan complet
ecrit et valide avant implementation - voir historique de conversation. Cette
Phase A couvre toute la plomberie qui ne depend PAS de la cle VAPID (Phase B,
separee, activera reellement l'envoi - voir plus bas).

**Principe central : un seul point d'envoi pour tous les push.** Plutot que
d'ajouter un appel FCM a chaque endroit du code qui ecrit une notification
in-app (fragile, facile a oublier), un unique trigger Firestore
`sendPushOnNotificationCreate` (`onDocumentCreated` sur
`users/{uid}/notifications/{notifId}`) intercepte TOUTE notification deja
ecrite - par le client ou par une autre Cloud Function - et delegue a
`sendPushToUser()`. Ajouter un futur type de notification n'importera donc
qu'une entree dans `PUSH_MESSAGES` (table `{fr,en,es} -> type -> (data) =>
{title,body}`, miroir simplifie et maintenu a la main des textes deja utilises
cote client dans `locale-*.js` - aucun import possible entre un script
navigateur et ce module Node), jamais un nouveau point d'envoi.

`sendPushToUser(db, uid, type, data)` lit `users/{uid}/kv/appData.preferredLanguage`
(repli 'fr' si absent) pour choisir la langue, lit `users/{uid}/pushTokens`
(un doc par appareil, alimente en Phase B), envoie via
`admin.messaging().sendEachForMulticast()`, et **supprime les tokens invalides**
retournes par la reponse (appareil desinstalle/permission revoquee) - evite
l'accumulation silencieuse de tokens morts.

**Rappels d'echeance (24h/3h)** : integres directement dans la boucle deja
existante de `closeExpiredGroupChallenges` (meme balayage planifie 15 min,
meme requete - aucun nouvel index). `computeDueReminderThresholds(remainingMs,
remindersSent)` (pure, testee) determine quels paliers viennent d'etre
franchis et pas encore notifies ; `remindersSent` (tableau sur le doc defi,
`arrayUnion`) evite toute re-notification. `settleChallengeIfNeeded()` renvoie
desormais `true`/`false` (a-t-il reellement regle le defi a CET appel ?) pour
que `closeExpiredGroupChallenges` sache si un rappel a encore un sens juste
apres (jamais de rappel sur un defi qui vient d'etre regle).

**3 trous reels combles** (aucune notification n'etait ecrite du tout avant,
ni in-app ni push - reperes en explorant le code avant d'ecrire le plan) :
- `createGroupChallenge()` : previent desormais les AUTRES membres du groupe
  (`group_challenge_created`) - hors du try/catch critique de creation (un
  echec de notification ne doit jamais faire croire que le defi n'a pas ete
  cree, alors qu'il l'a ete).
- `acceptFriendRequest()` : previent desormais le demandeur original
  (`friend_request_accepted`) - integre au meme batch atomique que le reste
  (rien n'est encore ecrit a ce stade, contrairement au cas ci-dessus).
- `performJoinGroup()` : previent desormais les membres DEJA presents
  (`group_member_joined`) - une lecture du roster existant AVANT le batch
  (le nouveau membre n'y figure pas encore), meme batch atomique.

**i18n des push** : `setPreferredLanguage()` appelle desormais aussi
`saveAppField('preferredLanguage', code)` en plus de `localStorage` (source de
verite UI, inchangee) - pure synchronisation pour que le serveur puisse lire
cette preference (localStorage n'est jamais lisible cote Cloud Function).

**Explicitement exclu de cette version** (decision actee avec l'utilisateur) :
rappel quotidien "defi pas encore fait" - chantier bien plus lourd (fonction
planifiee visitant TOUS les utilisateurs chaque jour, risque reel de lassitude/
desinstallation si mal calibre) - a rediscuter separement si voulu apres avoir
vu le reste tourner en conditions reelles.

**Phase B (a venir, bloquee par la cle VAPID que l'utilisateur doit generer
dans la Console Firebase)** : scripts `firebase-messaging-compat.js` (page +
service worker), reglage Settings "Notifications push",
`enablePushNotifications()`/`disablePushNotifications()`, gestion
`notificationclick`, repli iOS Safari (Web Push uniquement en PWA installee,
16.4+).

CACHE_NAME -> v64. Aucune regle Firestore modifiee (`users/{userId}/{document=**}`
couvre deja la nouvelle sous-collection `pushTokens`, et les 3 nouvelles
ecritures de notification respectent deja `fromUid == request.auth.uid`).
**Limite de verification non contournable** : l'envoi reel d'un push (FCM ->
navigateur -> notification OS) ne peut etre verifie que par l'utilisateur, sur
un vrai deploiement avec sa vraie cle VAPID, sur un vrai appareil - aucun
emulateur Firestore/FCM n'est en place ici. `npm test` (client + Cloud
Functions) valide toute la logique metier (qui est notifie, quel texte, quels
paliers, pas de doublon/auto-notification), jamais la livraison OS elle-meme.

**Deploiement reel effectue** : le premier `sendPushOnNotificationCreate` a
echoue 2 fois avant de reussir - d'abord bindings IAM manquants (voir
ci-dessus), puis "Permission denied while using the Eventarc Service Agent"
(propagation du role fraichement accorde, message Firebase explicite invitant
a reessayer quelques minutes plus tard) - un simple redeploiement a suffi la
2e fois. Ces 2 echecs sont specifiques au TOUT PREMIER trigger Firestore de ce
projet, ne devraient plus jamais se reproduire pour les triggers suivants.

## Notifications push OS — Phase B (activation reelle)

Cle VAPID fournie par l'utilisateur (Console Firebase > Parametres du projet >
Cloud Messaging > Configuration web > "Generer une paire de cles"), en dur
dans `index.html` (`VAPID_PUBLIC_KEY`) - **cle PUBLIQUE par construction**
(comme `apiKey` juste au-dessus, deja en dur depuis le debut du projet), rien
a proteger.

- **`firebase-messaging-compat.js`** ajoute a la fois dans `index.html` (page
  principale) ET `service-worker.js` (`importScripts`, config Firebase
  dupliquee - un service worker a son propre scope global, aucun partage de
  code possible avec le script principal).
- **Etat du reglage volontairement JAMAIS mis en cache dans une variable
  globale persistante** (`isPushNotificationsEnabledOnThisDevice()`, calculee
  a la demande a chaque rendu) : contrairement a `voiceCoachEnabled` (synchronise
  via `saveAppField`/le document `appData` consolide, partage entre tous les
  appareils du compte), l'activation du push est **intrinsequement par
  appareil** (chaque appareil a son propre token FCM, stocke dans
  `users/{uid}/pushTokens/{token}`) - synchroniser un simple booleen entre
  appareils aurait donne une fausse impression qu'activer sur son telephone
  active aussi sur son ordinateur. Le token de CET appareil est mis en cache
  dans `localStorage` (`fcmPushToken`), jamais dans Firestore appData.
- **Support detecte une seule fois, en tache de fond, au demarrage**
  (`detectPushNotificationsSupport()`, appelee sans `await` dans
  `continueStartApp()`) : `firebase.messaging.isSupported()` est **asynchrone
  depuis la SDK v9+** (contrairement aux versions precedentes) et couvre deja
  precisement le cas iOS Safari (false hors PWA installee sur l'ecran
  d'accueil, iOS <16.4) - aucune detection manuelle supplementaire necessaire.
  Le reglage Parametres reste **masque** (pas juste desactive) tant que ce
  resultat n'est pas connu, pour ne jamais afficher un toggle qui pourrait ne
  rien faire.
- **Permission demandee UNIQUEMENT sur le tap explicite** du reglage, jamais
  au chargement de l'app - une demande de permission non sollicitee est le
  plus sur moyen de se faire refuser definitivement (la plupart des
  navigateurs ne re-proposent plus la question apres un refus). Si refusee,
  le reglage bascule sur un texte explicatif ("bloquees dans les reglages de
  ton navigateur") plutot qu'un toggle inerte.
- **`messaging.onMessage(() => {})` deliberement no-op** : le premier plan
  (app deja ouverte) est deja couvert par le listener Firestore existant
  (`startNotificationsListener()`, popup in-app en temps reel) - ce handler
  existe uniquement pour eviter un avertissement console de la SDK, jamais
  pour afficher quoi que ce soit lui-meme.
- **`service-worker.js`** : `firebase.messaging()` suffit a afficher
  automatiquement la notification OS en arriere-plan (le payload envoye par
  `sendPushToUser()` contient un champ `notification`) - aucun handler
  `onBackgroundMessage` explicite necessaire pour ce cas simple (titre/corps
  fixes, pas d'action personnalisee). Nouveau `notificationclick` : focus
  l'onglet deja ouvert s'il y en a un, sinon en ouvre un nouveau - pas de
  deep-link precis vers le bon groupe/defi dans cette 1ere version (garder
  simple, ameliorable plus tard si demande).

CACHE_NAME -> v65 (5 SDK Firebase desormais charges au lieu de 4). Meme limite
de verification que la Phase A : l'activation reelle (permission navigateur,
obtention d'un token, reception effective) ne peut etre testee que par
l'utilisateur, sur un vrai appareil - `npm test` valide uniquement le rendu du
reglage (masque/explicatif/toggle selon le support) et le comportement
defensif en l'absence des APIs navigateur (jamais de throw).

## Notifications push OS — demande automatique au demarrage

**Demande explicite de l'utilisateur** apres test reel (reinstallation de
l'app) : le toggle Parametres seul ne suffisait pas - la plupart des grandes
apps redemandent la permission a chaque ouverture tant que l'utilisateur n'a
pas encore tranche, au lieu d'attendre un tap manuel dans un ecran de reglages
que personne ne visite spontanement.

`maybePromptPushNotificationsOnStartup()` (appelee automatiquement a la fin de
`detectPushNotificationsSupport()`, elle-meme deja declenchee sans `await`
dans `continueStartApp()` - donc a CHAQUE demarrage de l'app, pas seulement le
tout premier) declenche `enablePushNotifications()` (meme fonction que le
toggle manuel, reutilisee telle quelle) uniquement quand
`shouldAutoPromptPushNotifications(supported, permission)` (pure, testee)
renvoie vrai - c'est-a-dire : support confirme ET `Notification.permission
=== 'default'` (aucune decision prise). Jamais si deja `'granted'` (inutile)
ni si deja `'denied'` : **restriction navigateur non contournable** - une fois
la permission refusee, `Notification.requestPermission()` resout
immediatement `'denied'` sans jamais reafficher le prompt natif, quel que soit
le nombre de tentatives cote code ; seul l'utilisateur peut la reactiver
lui-meme depuis les reglages de son navigateur (le texte explicatif du
reglage Parametres, deja en place, couvre ce cas). Le toggle manuel dans
Parametres reste disponible en plus (desactivation, ou reactivation si le
support n'etait pas encore determine au moment du 1er demarrage).

CACHE_NAME -> v66.

## Notifications push — 2 bugs reels signales par l'utilisateur, corriges

1. **`service-worker.js` : initialisation Firebase Messaging isolee dans un
   try/catch** (v67). Non protegee auparavant, un echec (reseau bloquant
   gstatic.com, contexte sans support Push API) aurait pu faire planter
   l'evaluation du script entier - `install`/`activate`/`fetch` ne se
   seraient alors plus jamais enregistres non plus (tout le cache/offline de
   l'app avec). Symptome observe cote utilisateur avant ce correctif : le
   toggle Parametres restait bloque sur "desactive" quel que soit le nombre
   de clics (`enablePushNotifications()` restait bloquee indefiniment sur
   `await navigator.serviceWorker.ready`, qui ne resout jamais si aucun
   service worker n'a pu s'activer).
2. **`kudo` totalement absent de `PUSH_MESSAGES`** (`functions/index.js`) -
   oubli reel lors de la mise en place initiale des notifications push :
   `sendPushToUser()` abandonnait SILENCIEUSEMENT (`if (!buildMessage)
   return;`, aucune erreur visible) des qu'un kudos etait donne, alors que la
   notification IN-APP fonctionnait normalement (systeme distinct, deja
   existant avant ce chantier). Corrige dans les 3 langues.
   **Regression ajoutee** (`functions/test/notifications.test.js`, nouveau
   fichier) : verifie que `PUSH_MESSAGES.fr` couvre TOUS les types de
   notification reellement ecrits dans le code (liste explicite
   `KNOWN_NOTIFICATION_TYPES`, a mettre a jour a chaque nouveau type), que
   les 3 langues couvrent exactement le meme jeu de types, et que chaque
   constructeur produit bien un `{title, body}` non-vide - ce test aurait
   immediatement attrape ce bug precis avant deploiement.

## Notifications push — token FCM invalide sans que la permission ne change

**Diagnostic en 2 temps avec l'utilisateur** : le correctif du type `kudo`
manquant n'a pas suffi (toujours aucun push recu) - ajout de logs explicites
dans `sendPushToUser()` (`console.log`/`console.error` a chaque etape, un 200
HTTP sur la fonction ne prouvait PAS qu'un push avait ete envoye) pour
diagnostiquer via les Journaux Cloud Functions. Log obtenu :
`sendPushToUser: aucun token pushTokens pour uid=... - rien a envoyer`.

**Cause racine reconstituee** : (1) token FCM obtenu et sauvegarde a
l'activation du reglage, push confirme fonctionnel ("defi de groupe reussi")
; (2) l'utilisateur utilise "Forcer la mise a jour de l'appli" (Depannage)
pour corriger le bug du service worker plus haut - desinscrit l'ancien
service worker, ce qui invalide le token FCM associe cote Google (independant
de `Notification.permission`, qui reste `'granted'`) ; (3) `sendPushToUser()`
detecte ce token invalide lors d'un envoi suivant et supprime le doc
`pushTokens` correspondant (comportement voulu, evite l'accumulation de
tokens morts) ; (4) **rien ne le regenerait automatiquement** - le reglage
Parametres continuait d'afficher "actif" (calcule uniquement depuis
`localStorage`/`Notification.permission`, jamais depuis la presence reelle
du token cote serveur), laissant croire que tout fonctionnait alors que plus
aucun push n'arrivait, silencieusement.

**Correctif** : `shouldRefreshPushToken(supported, permission)` (pure, testee)
declenche desormais un rafraichissement silencieux du token (reappel de
`enablePushNotifications()`, qui gere deja correctement le cas "permission
deja accordee" - `Notification.requestPermission()` resout alors
immediatement sans rien afficher) a **chaque demarrage de l'app** tant que la
permission est deja accordee - pas seulement lors du tout premier octroi
(`shouldAutoPromptPushNotifications()`, cas `'default'`, inchangee). Les 2
fonctions sont combinees dans `maybePromptPushNotificationsOnStartup()`.
Cout accepte : 1 ecriture Firestore (`pushTokens/{token}.set()`) par demarrage
d'app pour un utilisateur ayant active le push - volontairement PAS
optimise/court-circuite meme si le token local n'a pas change, car c'est
justement ce cas precis (token local inchange mais doc serveur supprime) qui
causait le bug.

## Incident deploiement GitHub Pages (infrastructure, pas notre code)

Le commit du correctif ci-dessus (`8f5241a`) a echoue a se deployer sur
GitHub Pages a 3 reprises consecutives (timeout de file d'attente, puis 2x
"Deployment cancelled" quasi instantane, y compris apres "Re-run all jobs") -
toujours pour le MEME `artifact_id`/`pages_build_version`. `Deploy Cloud
Functions` (workflow distinct, meme commit) et `CI` ont toujours reussi sans
probleme sur ce meme commit, ce qui pointe vers un souci cote infrastructure
GitHub Pages specifique a ce deploiement precis, pas vers le code ou la
config du depot. Resolu en poussant un nouveau commit (celui-ci) : un nouvel
`artifact_id` genere un nouveau deploiement, contournant le blocage. A garder
en tete si ca se reproduit : re-run ne suffit pas toujours, un nouveau commit
peut etre necessaire.

## Lot de retours utilisateur (UX/bugs) - 1ere vague

**Le Boulet : score de reglement desormais REELLEMENT negatif** - decision
explicite de l'utilisateur (question posee, 2 options presentees). Avant :
`rankForSettlement()` plafonnait `effectiveAmount` a 0
(`Math.max(0, totalAmount - handicap)`). Retire le plancher - un handicap de
20 sur quelqu'un a 5 le classe desormais a -15. Verifie sans risque :
`computeSettlementPairs()` ne se base QUE sur l'ordre relatif (positions dans
le tableau deja trie), jamais sur la valeur numerique brute, donc un
`effectiveAmount` negatif ne casse rien en aval (tri/appairage). Texte du
joker simplifie en meme temps (bouton "-20" au lieu de "+20", qui etait
trompeur sur le signe ; description raccourcie, retrait de la mention
"jamais en dessous de 0" devenue fausse).

**Trophee "500 pompes" declenche par un autre exercice : pas un bug de
comptage, diagnostic transmis a l'utilisateur.** `PUSHUP_FAMILY_IDS = [1,
1001, 1002, 1003]` (Pompes, diamant, declinees, pike) ne contient PAS "Leg
raises" (id 13). Explication retenue : `checkNewBadges()` ne se declenche
qu'a la completion du defi DU JOUR (n'importe lequel), et verifie TOUS les
badges a ce moment-la - si le cumul de pompes avait deja franchi 500 lors de
seances anterieures, le popup peut legitimement apparaitre au moment d'un
AUTRE exercice, simplement parce que c'est la completion suivante qui
declenche la verification. Aucun changement de code (le calcul lui-meme est
correct).

**Fil d'activite en francais brut : deja resolu pour les nouvelles entrees,
aucun changement de code necessaire.** Verifie : `renderActivityFeedRow()`
utilise deja `t('exercises.' + entry.exerciseSlug + '.name')` en priorite
quand `exerciseSlug` est present (traductions EN/ES confirmees completes pour
les 2 exercices cites en exemple par l'utilisateur). Les occurrences
observees viennent forcement d'entrees ecrites AVANT l'ajout de ce champ
(`exerciseSlug: null` sur ces vieux documents, repli attendu sur le texte
francais deja stocke) - pas de backfill retroactif entrepris (cout/risque
disproportionne pour des entrees qui defilent hors du fil au fil du temps).

**Fiche d'un ami : texte "appuie pour voir ta progression" trompeur, corrige.**
`renderAthleteLevelBlock(xpTotalValue, clickable = true)` accepte desormais
un 2e parametre : `true` sur sa propre carte (`renderAthleteCard()`,
reellement cliquable -> `openLevelRoadmap()`), `false` sur la fiche d'un ami
(`renderFriendProfileSheet()`, jamais cliquable - ce serait TON parcours de
niveau, pas le sien). Nouvelle cle `profileTab.xpProgressPlain` (memes
valeurs, sans l'indice de clic) pour le cas `false`.

**En-tete du detail groupe : espacement + contraste du bouton "..".** Nouvelle
classe `.group-detail-header-row` (marge sous le nom du groupe, avant les 3
onglets Defi/Ardoise/Palmares juste en dessous - `.library-header-row`,
partagee avec d'autres ecrans, reste inchangee pour ne rien casser ailleurs)
et `.group-info-btn` (bordure accent, fond plus contraste, glyphe plus grand).

CACHE_NAME -> v69.

## Lot de retours utilisateur (nouvelles fonctionnalites) - 1ere vague

**Suppression de groupe** (`deleteGroup`, Callable Admin SDK) - reservee au
createur (`groupSnap.data().createdBy !== uid` -> `permission-denied`), bouton
dans le panneau "info groupe" (`renderGroupInfoSheet()`) avec confirmation
dangereuse (`confirmModal({danger:true})`). Un client ne peut ni supprimer
recursivement les sous-collections d'un document Firestore, ni ecrire dans le
`myGroups` d'un AUTRE membre (regle `users/{userId}/{document=**}`
owner-only) - la fonction lit les membres AVANT de les supprimer (batch sur
chaque `users/{uid}/myGroups/{groupId}` + `groups_by_code/{code}`), puis
`db.recursiveDelete(groupRef)` (Admin SDK) purge le groupe et TOUTES ses
sous-collections (membres, defis + leurs participants/contributions,
ardoise). Cote client, `deleteGroup(groupId)` nettoie `myGroups`/
`myActiveGroupChallenges` localement puis `closeGroupInfoOverlay()` +
`history.back()` (jamais un reset direct de `openGroupId` - garde la pile
`pushNavState()`/`popstate` coherente, meme discipline que partout ailleurs).

**Palmares (Hall of Fame) explicatif** : chaque ligne de titre est desormais
cliquable (`showGroupHallOfFameTitleModal()`, reutilise le meme moteur de
popup plein ecran que `showTrophyDetailModal()` - `enqueuePopup()`) et ouvre
une explication concrete de ce que represente le titre (ex: "Le Metronome"
n'est pas evident au premier coup d'oeil). Reutilise directement la classe
CSS `.leaderboard-row.clickable` deja existante (curseur pointeur) plutot que
d'en creer une nouvelle - aucun CSS ajoute pour cette fonctionnalite.

**Defi de groupe "Mode infini"** (`targetTotal:0`) : case a cocher a la
creation d'un defi collectif - dans ce mode, aucune cible chiffree, le
classement se fait uniquement sur le volume total cumule avant l'echeance (le
1er est celui qui en a fait le plus). **Decouverte cle en l'implementant** :
toute la logique de reglement cote Cloud Function traitait DEJA `targetTotal`
absent/0 comme "aucun plafond, reglement uniquement a l'echeance" -
`shouldSettleChallenge()` (`targetReached` toujours faux si `targetTotal<=0`,
seule `deadlinePassed` compte), `computeCreditedAmount()` (`!(targetTotal>0)`
-> credite le montant complet, jamais de plafond), `rankForSettlement()`/
`computeSettlementPairs()` (classement par ordre relatif de `totalAmount`,
independant de toute cible) - **aucun changement cote `functions/index.js`
n'a ete necessaire**, uniquement de la validation/du rendu cote client :
- `renderCreateGroupChallengeForm()` : case `groups.unlimitedModeLabel`
  masque le champ objectif chiffre et affiche un texte explicatif
  (`groups.unlimitedModeHint`) a la place.
- `submitGroupChallengeForm()` : bypass la validation "objectif requis"
  quand `unlimited` est coche, transmet `targetTotal: 0` explicitement.
- `createGroupChallenge()` : le plancher `Math.max(1, ...)` devient
  `Math.max(0, ...)` - 0 est desormais une valeur legitime (Mode infini),
  plus seulement le resultat d'un champ vide non valide.
- `renderGroupDetailScreen()` (carte hero du defi actif) : `isUnlimited =
  !(target > 0)` bascule l'affichage - volume total cumule en gros a la
  place du pourcentage, aucune barre de progression (n'aurait aucun sens
  sans cible), libelle `groups.unlimitedProgress` ("{{total}} au total") a
  la place de "X / Y". Le message "objectif atteint, reglement en cours"
  reste naturellement gate sur `target > 0`, donc jamais affiche en Mode
  infini (coherent : ce mode ne se regle qu'a l'echeance).

CACHE_NAME -> v70. Aucun changement de regles Firestore, aucun nouvel index.
Meme limite de verification que les chantiers precedents : valide par
tests+lint (client ET Cloud Functions), **pas visuellement dans un vrai
navigateur**.

## Lot de retours utilisateur - 2e vague (notification d'attaque, bug d'affichage du handicap, date de debut par defaut)

**Notification "tu te fais attaquer" (Boulet)** : `applyGroupJoker` (Cloud
Function, cas `'boulet'`) ecrit desormais aussi une notification
`boulet_attack` vers la CIBLE, dans la MEME transaction que l'application du
handicap - meme canal que tout le reste (`sendPushOnNotificationCreate`
l'intercepte automatiquement, in-app si l'appli est ouverte, push OS sinon).
Necessite 2 lectures supplementaires DANS la transaction, uniquement pour le
cas `'boulet'` (regle des transactions Firestore : tous les reads avant le
premier write) : le nom de l'ATTAQUANT (lu depuis son doc MEMBRE, `groups/
{groupId}/members/{uid}`, jamais son doc participant - qui peut ne pas encore
exister, `applyGroupJoker()` n'appelant jamais `ensureMyParticipantDoc()`
contrairement a `logGroupChallengeContribution()`) et le nom du groupe (doc
`groups/{groupId}`). Nouvelle entree `boulet_attack` dans `PUSH_MESSAGES`
(fr/en/es) + `KNOWN_NOTIFICATION_TYPES` (regression test deja en place, voir
plus haut "kudo totalement absent de PUSH_MESSAGES" - ce test aurait
immediatement attrape un oubli similaire ici). Cote client,
`processUnreadNotifications()` gagne une 5e branche (`boulet_attack`),
popup nommant l'attaquant + le handicap + le defi concerne.

**Bug reel signale : le nombre affiche ne refletait jamais le handicap du
Boulet deja inflige.** Une victime ayant fait 10 repetitions reelles avec un
handicap de -20 continuait d'afficher "10" (le `totalAmount` BRUT) sur sa
ligne de classement EN DIRECT (pendant que le defi est encore actif) -
donnant l'impression trompeuse de "gagner" alors que le reglement final la
placerait tres loin derriere. Cause : `renderGroupParticipantRow()` affichait
`p.totalAmount` brut, et `loadGroupDetail()` triait les participants par ce
meme `totalAmount` brut - le handicap n'etait jamais applique AVANT le
reglement final (`rankForSettlement()`, Cloud Function). **Corrige** par une
nouvelle fonction pure cote client, `computeGroupParticipantDisplayAmount(p)`
= `(p.totalAmount||0) - (p.handicap||0)` (meme formule que
`rankForSettlement()`, volontairement dupliquee - aucun import possible entre
`index.html` et `functions/index.js`), utilisee a la fois pour le TRI des
participants dans `loadGroupDetail()` et pour la VALEUR affichee dans
`renderGroupParticipantRow()` - le classement en direct (et le bilan, qui
reutilise la meme fonction de rendu) reflete desormais la meme realite que le
reglement final, pas seulement apres coup. **Le vrai `totalAmount` Firestore
n'est jamais modifie** (Hall of Fame, cible partagee du defi affichee en haut
de la carte hero - voir Phase 4 plus haut : cette separation etait deja
deliberee, seul l'AFFICHAGE en direct manquait le correctif).

**Date de debut par defaut = "Aujourd'hui" (texte), pas des chiffres.**
`renderCreateGroupChallengeForm()` : le champ "Debut" n'est plus un
`<input type="date">` natif directement visible (dont le navigateur impose
son propre rendu numerique de la valeur, aucun moyen de le personnaliser) -
c'est desormais un BOUTON stylise comme `.library-search-input`
(`.group-challenge-date-btn`) affichant `t('nav.today')` ("Aujourd'hui",
reutilise tel quel - meme mot que l'onglet, aucune nouvelle cle necessaire)
tant que la date choisie est aujourd'hui, ou la date formatee normalement
sinon (`formatGroupChallengeStartDateLabel()`, pure). Le VRAI champ
`<input type="date">` (`#groupChallengeStartDateInput`) existe toujours,
mais rendu invisible (`.group-challenge-hidden-date-input` : `opacity:0` +
1x1px + `pointer-events:none`, **jamais `display:none`** - necessaire pour
que `showPicker()`/`.click()` fonctionnent) ; le bouton visible delegue au
picker natif via `openGroupChallengeStartDatePicker()`
(`input.showPicker()` si disponible, repli `focus()+click()` sinon - Safari
16.4+, deja le plancher iOS retenu pour le push, voir plus haut). La valeur
REELLEMENT stockee (`groupChallengeFormDraft.startDate`) est inchangee -
seul le LIBELLE affiche change, jamais la donnee.

CACHE_NAME -> v71. Aucun changement de regles Firestore, aucun nouvel index.
Meme limite de verification que les chantiers precedents : valide par
tests+lint (client ET Cloud Functions) - le nouveau bouton date/picker natif
cache n'a pas pu etre verifie visuellement dans un vrai navigateur (limite
deja documentee ailleurs dans ce fichier), a confirmer par l'utilisateur.

## Pont "défi de groupe -> exécution de l'exercice" (friction reelle signalee)

**Demande explicite de l'utilisateur** : avant ce correctif, contribuer a un
defi de groupe (ex: "100 pompes") exigeait d'aller ACTIVER soi-meme
l'exercice dans l'onglet Défis, PUIS de retourner sur Aujourd'hui pour
trouver la carte et enfin logger une serie - beaucoup de friction pour un
geste cense etre immediat depuis l'ecran du defi lui-meme, ou l'utilisateur
voit deja le classement/la progression.

**Bouton "S'entrainer : {{exercice}}" sur la carte hero d'un defi actif**
(`startGroupChallengeExercise(slug)`) : reutilise TELLES QUELLES 2 fonctions
deja existantes, enchainees - `toggleActiveToday(id)` (appelee UNIQUEMENT si
`!activeToday.has(id)`, donc jamais un toggle qui desactiverait par erreur un
exercice deja actif) puis `pickChallenge(id)` (navigation directe vers la
fiche d'execution). Aucune nouvelle logique d'activation/navigation - juste
la composition de 2 briques deja solides. `CHALLENGE_LIBRARY.find(x =>
x.slug === slug)` resout l'id numerique necessaire aux 2 fonctions (fiable :
`exerciseSlug` d'un defi de groupe pointe TOUJOURS vers une entree
`CHALLENGE_LIBRARY` canonique, jamais un defi personnalise - le `<select>`
du formulaire de creation n'en propose pas d'autres).

**Progression du defi de groupe affichee SOUS l'objectif personnel du jour,
sur la fiche de l'exercice** (retour utilisateur, 2e moitie de la demande) :
sans ca, cliquer "S'entrainer" emmenait vers un ecran qui ne montre QUE
l'objectif personnel (ex: 120 pompes), sans aucune trace du defi de groupe -
impression de 2 mondes separes, aucune garantie visible que la serie
compte vraiment pour le defi. Nouvel etat `activeExerciseGroupChallenges`
(`[{groupId, challengeId, groupName, targetTotal, currentTotal}]`,
generique : gere aussi le cas rare de PLUSIEURS defis de groupe actifs sur
le meme exercice, dans des groupes differents), rempli par
`loadActiveExerciseGroupChallenges(slug)` - appelee en fire-and-forget
depuis `pickChallenge()` (jamais bloquante pour la navigation, le reste de
l'ecran s'affiche immediatement). **Necessite une lecture Firestore par defi
lie** (somme des `totalAmount` de tous les participants) : contrairement a
`myActiveGroupChallenges` (simples metadonnees deja en memoire, alimentees
par `refreshMyGroupsAndActiveChallenges()`), le total CUMULE du groupe n'est
jamais mis en cache cote client ailleurs - cout accepte (rare : 0 la plupart
du temps, 1 le plus souvent). Garde anti-race (navigation rapide entre 2
exercices pendant le chargement) : le resultat n'est applique que si
`getChallenge().slug` correspond encore au slug demande au moment ou la
promesse se resout.

**Mise a jour optimiste a chaque serie loguee** (`addSetInner()`, juste apres
`registerGroupChallengeContributionsIfNeeded()`) : incremente directement
`activeExerciseGroupChallenges[].currentTotal` de `amount` (plafonne a
`targetTotal` si fixe, jamais si Mode infini) - evite une nouvelle lecture
Firestore a CHAQUE tap +5/+10, deja le hot-path le plus frequent de
l'application. Approximation assumee (les contributions d'AUTRES membres en
parallele ne sont pas reflitees en temps reel ici) : resynchronisee avec la
vraie valeur serveur a la prochaine ouverture de cette fiche
(`pickChallenge()` relance toujours `loadActiveExerciseGroupChallenges()`).

**Rendu** : reutilise `.bar-track`/`.bar-fill` (memes classes que la barre de
progression personnelle) pour la coherence visuelle, avec un libelle dedie
(`.group-challenge-linked-progress`/`.group-challenge-linked-label`) - le
Mode infini (`targetTotal:0`) affiche le total brut sans barre/pourcentage,
meme convention que la carte hero du defi de groupe elle-meme.

CACHE_NAME -> v72. Aucun changement de regles Firestore, aucun nouvel index
(la lecture participants reutilise exactement la meme requete que
`loadGroupDetail()`). Meme limite de verification que les chantiers
precedents : valide par tests+lint (client ET Cloud Functions), **pas
visuellement dans un vrai navigateur**.

## Passe "effet waouh" (animations/polish) — demande explicite de l'utilisateur

**Demande** : rendre l'appli "plus animee, plus stylee, moins page web, plus
interactive" - liste de 8 idees proposees (quelques "petites victoires" +
plusieurs "gros chantiers"), toutes approuvees et livrees en un seul lot.

**Fondation : View Transitions API (`document.startViewTransition()`), voir
`applyContent()`** - resout un probleme architectural jamais contourne
jusqu'ici : `render()` remplace TOUJOURS tout le `innerHTML` de `#app`
(aucune vraie transition CSS entre 2 etats d'un meme noeud n'est possible,
documente a de nombreux endroits ailleurs dans ce fichier). La View
Transitions API capture un instantane AVANT/APRES le changement de DOM et
anime automatiquement entre les deux, MEME si les noeuds sont entierement
recrees. `applyContent(app, html, animate, afterRender)` : si `animate` est
vrai ET `document.startViewTransition` existe ET `prefers-reduced-motion`
n'est pas demande, utilise la View Transition ; sinon **repli total et
identique au comportement precedent** (fade CSS manuel 140ms) - zero
regression possible sur les navigateurs non-supportes (Safari < 18, repli
tres frequent sur mobile). CSS : `::view-transition-old(root)`/
`::view-transition-new(root)` personnalisees (leger glissement + zoom,
220ms) plutot que le simple fondu par defaut du navigateur.

**Bonus "gratuit" de la View Transitions API : elements qui MORPHENT d'une
position/forme a l'autre** via `view-transition-name` CSS identique
avant/apres, sans AUCUN code JS de positionnement manuel :
- **Indicateur d'onglet actif qui glisse** (`renderTabBar()`) : un seul
  `<span class="tab-active-indicator">` existe a la fois (uniquement sur
  l'onglet ACTIF, jamais 0 ni plusieurs), `view-transition-name: tab-indicator`
  - la View Transitions API le fait glisser automatiquement d'un onglet a
  l'autre. Repli gracieux total si non supportee (apparait directement a sa
  position finale, jamais invisible/casse).
- **FAB "+"/loupe qui morphe en formulaire** (`renderGroupsScreen()`,
  `toggleCreatingGroupOpen()`/`toggleJoiningGroupOpen()` appellent desormais
  `render(true)` au lieu de `render()`) : le bouton ferme et le panneau
  ouvert (`.group-fab-form`) partagent le meme `view-transition-name`
  (`group-create-fab`/`group-join-fab`), TOUJOURS l'un OU l'autre present,
  jamais les deux (sinon 2 elements avec le meme nom = la transition de ce
  nom echoue silencieusement) - exactement l'animation du bouton de
  composition de Gmail, sans FLIP animation JS manuelle.

**Retour tactile generalise** : regle CSS globale (`button:active`,
`.clickable:active` → `scale(0.96)`) plutot que dupliquee par composant -
les regles `:active` plus specifiques deja existantes (`.tab-btn:active`)
restent prioritaires par specificite CSS, celle-ci comble seulement les
elements qui n'en avaient encore aucune. Le retour haptique
(`navigator.vibrate`) etait deja largement present (listener `click` global
existant, `document.addEventListener('click', ...)`) - non etendu davantage.

**Lisere neon renforce** sur `.active-card` (fiche d'exercice - l'ecran le
plus frequente de l'appli, n'avait jusqu'ici AUCUNE teinte de marque en
dehors du mode Hardcore) et `.group-challenge-hero` (glow existant
intensifie, `0.08` → `0.14` d'opacite).

**Tilt 3D au toucher sur les cartes hero** (`.tilt-card` -
`.group-challenge-hero`, `.athlete-card`) : `initTiltCards()`, delegation
d'evenements `touchmove`/`touchend`/`touchcancel` sur `document` (comme
`initPullToRefresh()`, meme fichier) - survit nativement a tous les
re-renders (contrairement a un listener attache par carte, qu'il faudrait
re-attacher a CHAQUE render() qui recree tout le DOM). Aucune transition CSS
pendant le glisser (suivi instantane du doigt) ; une classe `.tilt-resetting`
n'est ajoutee que ponctuellement au relachement, pour un retour a plat en
douceur. Jamais actif si `prefers-reduced-motion` (effet purement decoratif).

**Chiffres qui defilent** (`animateCountUp(elId, key, targetValue)`) : anime
un nombre affiche de sa valeur precedente vers sa cible (500ms, ease-out
cubique) au lieu de sauter instantanement. `key` (distinct de `elId`)
identifie le compteur d'un point de vue METIER (ex: `'exercise:' + id`) -
ne rejoue jamais si la valeur n'a pas change depuis le dernier appel, evite
une animation "pour rien" sur un re-rendu sans changement reel. Ecrit
directement dans le DOM via `requestAnimationFrame`, hors du cycle de
`render()` : si un nouveau `render()` remplace le noeud entre-temps,
l'animation s'arrete silencieusement au frame suivant (`document.getElementById(elId)
!== el`). **Piege corrige en l'implementant** : `Date.now()` utilise pour
`start` ET a chaque frame (JAMAIS le timestamp fourni par
`requestAnimationFrame`, base sur une horloge `performance.now()`
DIFFERENTE - les melanger produirait un delta absurde). Applique pour
l'instant au seul chiffre de progression de la fiche d'exercice
(`#exerciseProgressCurrent`) - le plus frequemment vu de toute l'appli.

**Mini confettis localises** a l'atteinte de l'objectif du JOUR (pas
seulement les grands moments deja epiques - objectif de groupe, trophee) :
reutilise TEL QUEL le composant `renderConfettiBurst()` existant (deja
respectueux de `prefers-reduced-motion`), enveloppe dans
`.exercise-mini-confetti` (particules plus petites, positionnement
localise). Drapeau `justCompletedDailyObjective` pose par `addSetInner()`
(`willComplete`), consomme UNE SEULE FOIS par le rendu suivant de la fiche
d'exercice (jamais rejoue sur un re-rendu ulterieur du meme etat "termine" -
ex: revenir sur cette fiche plus tard dans la journee).

CACHE_NAME -> v73. Aucun changement de regles Firestore/Cloud Functions.
**Limite de verification explicite** : le harnais de test (mock DOM,
`document.addEventListener`/`requestAnimationFrame` no-op) ne peut verifier
que la logique structurelle (gating, classes CSS, `view-transition-name`
jamais duplique) - jamais le rendu visuel reel (glissement, morph, tilt,
defilement des chiffres) ni le support navigateur effectif de la View
Transitions API, a confirmer par l'utilisateur sur un vrai appareil.

## Passe "effet waouh" 2 — de vrais composants d'interface premium

**Demande explicite de l'utilisateur** : aller plus loin que la 1ere passe
(animations/transitions) - 6 chantiers approuves pour "moins ressembler a une
page web basique, plus a une appli premium". La mascotte animee (7e idee)
est volontairement EXCLUE de ce lot - l'utilisateur veut d'abord choisir un
design ensemble avant toute implementation (voir plus bas).

**1. Bottom sheets a glisser (drag-to-dismiss reel)** - les 3 panneaux
(`.level-roadmap-overlay`/`.level-roadmap-sheet`, parcours de niveau/fiche
ami/info groupe) etaient jusqu'ici une simple page PLEIN ECRAN (fondu
d'entree, fermeture par un bouton "✕"). Refonte complete en VRAIES feuilles
a glisser : le fond devient un backdrop semi-transparent (`display:flex;
align-items:flex-end`), la feuille elle-meme un panneau `border-radius:22px
22px 0 0` avec poignee de glissement (`.sheet-drag-handle`) qui slide depuis
le bas (`@keyframes sheet-slide-up`). **`attachSheetBehavior(overlayEl,
closeFn)`** (fonction PARTAGEE, appelee par les 3 `open*()`) : (a) tap sur le
backdrop (pas la feuille) ferme le panneau, comme tout bottom sheet natif ;
(b) glissement tactile suit le doigt en temps reel, ferme si tire au-dela de
120px (avec animation de sortie avant `closeFn()`), sinon rebondit a plat ;
(c) le glisser-pour-fermer ne s'engage que si la feuille est deja scrollee
tout en haut (`sheet.scrollTop <= 0`) - sinon un glissement continue de faire
defiler une liste longue normalement. `openFriendProfile()` (seul cas
async, repeint le noeud `.level-roadmap-sheet` 2 fois - chargement puis
donnees) appelle `attachSheetBehavior()` une 2e fois apres le repaint final,
le noeud precedent (et ses ecouteurs) ayant ete detruit par `innerHTML`.

**2. Anneau de progression SVG** (`renderExerciseProgressRingSVG()`) - a la
place de l'ancienne barre horizontale, pour l'objectif du jour des exercices
en REPETITIONS uniquement (`c.unit !== 'sec'`). Meme technique deja
eprouvee que le double-anneau du chronometre (`renderDoubleTimerRingSVG()` -
voir plus haut, `stroke-dasharray`/`stroke-dashoffset`), constantes/rayon
dedies et independants. **Les exercices en secondes gardent la barre** -
volontairement PAS un 2e anneau, ils ont deja leur propre riche double-
anneau via le chronometre plus bas sur le meme ecran (redondance evitee).

**3. Sparkline 7 jours** (`renderExerciseSparkline()`/`loadExerciseSparkline()`)
- mini-graphique en courbe (SVG `<polyline>`) a cote du total a vie
(`Σ 1200 a vie`), tendance des 7 derniers jours sur CET exercice precis.
**Reutilise le meme cache que le Journal** (`historyDayCache`, memes cles
`dateKey`) : si le Journal a deja ete ouvert cette session, aucune nouvelle
lecture Firestore ; sinon ne lit QUE les 7 jours necessaires (pas les 28 du
Journal complet), reste econome en quota. Mis en cache PAR EXERCICE
(`exerciseSparklineCache`) pour la session, jamais relu une 2e fois pour le
meme exercice. Mise a jour OPTIMISTE du dernier point (aujourd'hui) a
chaque serie loguee (`addSetInner()`), comme pour la progression du defi de
groupe lie. **Piege rencontre en l'implementant (2e fois cette session)** :
`todayKey` peut avoir ete fige a une date fictive par un test precedent -
meme piege deja documente pour `loadHistoryEntries()`, corrige de la meme
facon (`todayKey = dateKey(new Date())` explicite en tete de test) + reset
de `historyDayCache` (un test anterieur peut avoir cache une entree
etrangere sous la MEME cle relative "il y a N jours").

**4. Glisser pour reveler (swipe-to-reveal)** sur la liste "Mes amis"
(`renderFriendActionRow()`, `clickable=true` uniquement - jamais pour la
recherche/l'invitation a un groupe, ou l'action reste toujours visible telle
quelle) : le bouton "retirer" (🗑️), avant toujours visible, est desormais
CACHE par defaut derriere un glissement vers la gauche (meme geste que
Gmail/WhatsApp) - `.swipeable-row` (wrapper, `overflow:hidden`) /
`.swipeable-row-actions` (panneau cache, `position:absolute`) /
`.swipeable-row-content` (la ligne elle-meme, translate au glissement).
**`initSwipeableRows()`** (delegation sur `document`, comme
`initTiltCards()`) distingue un TAP (mouvement < 8px) d'un VRAI glissement -
seul un vrai glissement neutralise le clic qui suit (evite d'ouvrir la fiche
ami juste apres avoir glisse pour reveler l'action). **Repli desktop/non-
tactile** : `:hover` revele aussi le panneau (aucune fonctionnalite perdue
pour un pointeur non-tactile).

**5. Parallaxe legere** (`initParallax()`, classe `.parallax-img`) sur
l'image de demonstration de l'exercice (`.exercise-hero-apng`) - suit le
defilement a 15% de la vitesse reelle (`window.scrollY * 0.15`), plafonnee
a +/-15px (jamais un decalage qui ferait deborder l'image de sa carte).
Un seul ecouteur `scroll` pose UNE FOIS au demarrage, cherche l'element
cible a CHAQUE evenement (peut etre un noeud different apres un re-render).
Impact volontairement modeste : l'appli a peu de grands ecrans qui
defilent (mise en page compacte mobile), effet du a rester discret par
construction plutot qu'un choix de reglage.

**6. Ecrans squelettes ("shimmer")** a la place d'un simple texte
"Chargement..." - fiche d'un ami (`renderFriendProfileSheet()`, etat
`loading`) et classement communautaire (`renderCommunityScreen()`,
`communityLeaderboardLoading`). **Reutilise TEL QUEL** le keyframe
`picto-shimmer` deja existant pour le chargement des images (`.exercise-picto`)
- nouvelles classes generiques `.skeleton-block`/`.skeleton-text`/
`.skeleton-bar`/`.skeleton-row` (memes couleurs/meme animation, juste des
formes differentes), reutilisables pour un futur ecran squelette sans
nouveau CSS.

**Bonus non planifie, ajoute en cours de route : chime de reussite optionnel**
(`playSuccessChime()`/`toggleSoundEffects()`) - synthese Web Audio pure (2
notes ascendantes, aucun fichier audio a charger/mettre en cache),
**DESACTIVE par defaut** (contrairement au coach vocal deja activable par
defaut) - a double tranchant, certains detestent le son. Nouveau reglage
Parametres (meme famille que le coach vocal), joue un apercu immediat a
l'activation. Champ moderne (`appData` consolide uniquement,
`d.soundEffectsEnabled ?? false`) : contrairement a `voiceCoachEnabled`, pas
de champ legacy separe a migrer (jamais existe avant la consolidation).
Declenche au meme moment que les mini confettis (`willComplete` dans
`addSetInner()`).

**Mascotte animee (7e idee) : NON IMPLEMENTEE, en attente d'un choix de
design avec l'utilisateur** - propositions concretes a faire dans une
prochaine conversation avant tout code.

CACHE_NAME -> v74. Aucun changement de regles Firestore/Cloud Functions.
Meme limite de verification explicite que la 1ere passe "effet waouh" : le
harnais de test ne peut verifier que la logique structurelle (classes CSS,
gating, seuils numeriques via des objets synthetiques pour
`attachSheetBehavior()`) - jamais le rendu visuel reel (glissement de
feuille, tilt, anneau, sparkline, parallaxe) sur un vrai appareil.

## Mascotte "Kilo" (halterophile humanise) — specifications detaillees de l'utilisateur

**Demande explicite, cahier des charges precis fourni par l'utilisateur** (nom
universel FR/EN/ES, style visuel, 5 etats, points d'integration exacts) -
implementee dans la foulee de la 2e passe "effet waouh" ci-dessus.

**Composant SVG reutilisable `renderKilo(state, options)`** - construit a
partir de FORMES SIMPLES (cercles, rectangle arrondi, `clip-path` pour le
bandeau) plutot que des chemins bezier dessines a la main : fiabilite/
maintenabilite avant tout, meme esprit que les pictogrammes d'exercices
(`exercise-pictograms.js`) mais avec une palette PROPRE a Kilo
(`KILO_NEON` cyan + `KILO_BAND` bandeau orange), volontairement distincte du
vert de l'appli - identite de mascotte, pas un simple pictogramme de plus.
`KILO_STATES` (objet de config par etat : sourcils, bouche, angle des 2 bras,
decor supplementaire) pilote un seul corps de fonction plutot que 5 SVG
entierement dupliques. 5 etats : `idle` (flottement doux), `success`
(bras leves "flex", lunettes de soleil, etincelles `KILO_SPARK_PRESETS` -
positions FIXES, jamais `Math.random()`, meme principe que
`CONFETTI_PRESETS`), `warning` (bras affaisses, goutte de sueur, animation de
"tassement"), `beer` (bras leve tenant une choppe, clin d'oeil), `lost`
(couleur ternie `KILO_DULL`, fissures, statique - aucune animation en boucle,
contrairement aux 4 autres etats). `kiloTap(el)` : micro-interaction au clic
(rebond CSS + vibration), rejouable meme si l'animation precedente vient de se
terminer (`void el.offsetWidth` force un reflow entre le retrait et l'ajout de
la classe, sinon le navigateur fusionne les 2 changements et l'animation ne
rejoue pas).

**Integration `buildPopupInnerHtml()`** : nouveau champ `next.kiloState` -
quand present, remplace l'icone emoji habituelle (`next.icon`) par
`renderKilo(next.kiloState, {size:84, clickable:true})` dans `.app-popup-icon`.
Reutilise le moteur de popup EXISTANT (`enqueuePopup()`) sans le modifier
autrement - Kilo n'est qu'un nouveau type de contenu pour `.app-popup-icon`,
pas un nouveau mecanisme de popup.

**4 points d'integration, tous scopes deliberement pour ne jamais entrer en
concurrence avec les moments DEJA epiques (trophees, nouveau titre, victoire
de groupe - `epic:true`, deja confettis/traitement distinctif)** :
- **Accueil** (`computeKiloHomeState(activeIds, stateChallenges, hour)`, PURE -
  l'heure est un parametre, jamais `new Date()` dedans, pour rester testable
  de facon deterministe) : `idle` en journee, `warning` a partir de 19h SI au
  moins un defi actif du jour n'est pas encore valide (`entry.done`). Aucun
  defi actif -> toujours `idle` (rien a reprocher). Positionne dans `.header`
  (deja `justify-content:space-between` - Kilo se retrouve naturellement
  centre entre la date et la pastille de serie, `align-self:center` scope a
  `.kilo-home-slot` seul plutot que de toucher `.header` elle-meme, partagee
  par 3 autres ecrans).
- **Popup de validation d'un defi** (`success`) et **popup de Level Up SIMPLE
  UNIQUEMENT** (`success`) - le nouveau titre (`variant:'title', epic:true`,
  couronne) et le Mode Hardcore (`epic:true`, flamme) gardent leur propre
  traitement deja distinctif, pas de Kilo dessus (eviterait de diluer
  l'"epique").
- **Bilan/reglement d'un defi de groupe** (`beer`, `group_challenge_settled`
  SANS `targetReached`) - la victoire collective (`targetReached:true`,
  celebration epique deja en place) garde aussi son propre traitement, pas de
  Kilo.
- **Serie perdue SANS bouclier disponible** (`lost`) - **bug reel decouvert en
  implementant cette fonctionnalite** : `evaluateStreakOnLoad()` remettait
  deja `streakCount` a 0 dans ce cas (voir Phase "bouclier" plus haut), mais
  **n'affichait absolument RIEN** - contrairement au cas "bouclier active"
  (popup dediee juste a cote dans le meme `if/else`), une serie perdue passait
  totalement inapercue jusqu'a ce que l'utilisateur remarque le chiffre a 0
  par lui-meme. Corrige en ajoutant la branche manquante (`streakLost`),
  Kilo comble ce trou.

**Decouverte et correction en cours de route : `playSuccessSound()` existait
DEJA et jouait de facon INCONDITIONNELLE.** La demande initiale de
l'utilisateur ("son de reussite optionnel, desactive par defaut") a d'abord
ete implementee comme une fonction entierement NOUVELLE (`playSuccessChime()`)
sous l'hypothese qu'aucun son n'existait encore. En cablant le point
d'integration dans `addSetInner()`, decouverte qu'une fonction `playSuccessSound()`
(meme technique Web Audio, 3 notes au lieu de 2) etait DEJA appelee de facon
INCONDITIONNELLE a 3 endroits (completion de defi, Mode Hardcore, victoire
Boss Battle) - sans AUCUN moyen de la desactiver jusqu'ici. **Corrige en
supprimant le doublon** : `playSuccessChime()` retiree, `soundEffectsEnabled`
(reglage Parametres, `saveAppField`) gate desormais directement
`playSuccessSound()` (un seul `if (!soundEffectsEnabled) return;` en tete de
fonction, jamais duplique par site d'appel). **Defaut choisi en consequence :
`true` (ACTIVE), pas `false` comme demande initialement** - defaulter a
`false` aurait coupe SILENCIEUSEMENT un son deja entendu par tous les
utilisateurs existants des la mise a jour, sans qu'ils aient rien demande ;
la vraie nouveaute utile ici est de pouvoir le desactiver, pas de le couper
d'office. **Lecon** : avant d'ajouter un mecanisme visiblement absent d'apres
une recherche initiale (ici un grep imprecis sur "AudioContext" qui n'a pas
matche `window.AudioContext || window.webkitAudioContext`), verifier a
nouveau au moment de cabler le point d'integration reel plutot que de faire
confiance a la recherche initiale seule - c'est exactement le point de
cablage qui a revele la fonction existante.

CACHE_NAME -> v75. Aucun changement de regles Firestore/Cloud Functions.
Meme limite de verification que le reste des chantiers "effet waouh" : valide
par tests+lint (structure SVG par etat, gating `computeKiloHomeState()`,
presence/absence de `kilo-success`/`kilo-beer` dans les bons popups) - jamais
le rendu visuel reel (expressions faciales, animations) sur un vrai appareil.

## Refonte visuelle de Kilo (2e ronde) — nouveau cahier des charges, reference validee, 6e etat

**L'utilisateur n'a pas aime le premier rendu.** Un cahier des charges tres
precis (anatomie "au millimetre" sur un canevas 200x200, palette
`--kilo-cyan`/`--kilo-gold`/`--kilo-pink`/etc., 6e etat `level_up`, style
"React/TypeScript") a suivi, accompagne d'une image de reference generee par
une autre IA. **Aucune previsualisation visuelle n'existe dans cet
environnement** (pas de navigateur) - plutot que d'implementer directement
dans l'app une 3e fois de suite a l'aveugle, la refonte a ete construite et
iteree dans un **artifact HTML autonome** (composant JS + CSS copies-colles,
zero dependance) que l'utilisateur a pu voir et valider AVANT integration
ici. Ce detour a permis de reperer par capture d'ecran que la version
"au millimetre" (bras = un seul rectangle tourne par angle CSS autour d'un
pivot) etait visuellement rigide compare a l'image de reference (bras =
courbes de Bezier dessinees a la main, differentes par etat) - la version
finalement portee ici **abandonne le parametrage par angle unique** au
profit de traces litteralement repris de la reference, un par etat
(`KILO_STATE_SVG`, plus de `KILO_STATES`/`KILO_NEON`/`KILO_BAND`/`KILO_DULL`
partages : chaque etat porte ses propres couleurs en dur, exactement comme
la reference les fait volontairement varier d'un etat a l'autre - ex. la
sueur en `#38bdf8`, pas une teinte de la palette officielle).

**Hierarchie SVG reelle** (demande explicite, apres un retour "trop rigide,
pas assez de vie") : visage/bras/accessoires vivent tous **dans**
`<g class="kilo-body">`, jamais comme des elements freres du SVG racine -
un seul groupe (la racine, via la classe `kilo-<etat>`) porte l'animation
d'ensemble (`kilo-idle-bounce`, `kilo-panic-shiver`), donc aucun risque que
le visage ou un bras se desynchronise du reste pendant le mouvement.

**Glow en 2 `drop-shadow` empiles** (halo serre tres sature + halo large
plus diffus) plutot qu'un flou unique, pour un rendu "tube neon" plus
agressif - toujours en CSS, jamais en filtre SVG `<feDropShadow>` par
instance (evite de dupliquer un bloc `<defs>` a chaque affichage de Kilo,
qui peut apparaitre plusieurs fois simultanement a l'ecran).

**"Clin d'oeil a droite" = l'oeil a droite pour qui regarde l'ecran**,
tranche explicitement par l'utilisateur au-dessus de la coordonnee brute de
l'image de reference (qui plagait le clin d'oeil a gauche-ecran) - a
retenir comme principe general : le langage naturel de l'utilisateur prime
toujours sur une coordonnee litterale quand les deux se contredisent.

**3 etats gagnent une boucle continue** (2e retour, "garde exactement le
design mais ajoute de l'animation") - **aucun trace modifie**, uniquement
de nouvelles classes/keyframes appliquees a des groupes existants ou
nouvellement introduits pour cibler juste la bonne partie :
- `lost` : le corps entier respire lentement (`kilo-lost-breathe`, 3.2s, tres
  leger affaissement) et le petit trait en pointilles derive en fondu
  (`kilo-lost-mark-drift`) - lecture "sommeil/chagrin discret" demandee
  explicitement, sans ajouter un seul element visuel.
- `level_up` : `kilo-trophy-hoist` (entree unique, la coupe vole jusqu'a sa
  place) est relaye par `kilo-trophy-pump`, un groupe **enfant** en boucle
  infinie - **2 animations ne peuvent pas composer un seul `transform` sur
  le meme element** (la 2e ecrase la 1ere), d'ou l'imbrication plutot qu'un
  simple ajout de classe. Bras (`kilo-arms-raise`) et halo dore
  (`kilo-aura-pulse`) suivent le meme rythme, legerement decale
  (`animation-delay`), pour que tout semble porte par le meme geste de joie.
- `beer` : le toast (`kilo-toast-cheers`) va beaucoup plus haut (jusqu'a
  -60deg, hauteur d'epaule, contre -25deg avant) et marque un vrai temps
  d'arret en haut plutot qu'un simple va-et-vient - lit comme un "sante !"
  adresse a l'utilisateur. La choppe (groupe enfant `kilo-mug-clink`) tinte
  au sommet du geste.

**6e etat `level_up` cable dans la popup epique de nouveau titre**
(`enqueueLevelPopups()`, branche `variant:'title', epic:true`) - jusqu'ici
seule popup a n'avoir JAMAIS montre Kilo (couronne emoji `👑` reservee, pour
ne pas diluer son caractere "epique"). Avec un etat dedie couronne+trophee+
halo dore, cette reserve n'a plus lieu d'etre : `kiloState:'level_up'`
remplace l'icone couronne. Le level up SIMPLE (meme palier de titre) garde
`kiloState:'success'`, inchange.

CACHE_NAME -> v76. Aucun changement de regles Firestore/Cloud Functions.
Meme limite de verification qu'avant : tests+lint valident la structure
(classes par etat, presence des groupes d'animation, gating `level_up` sur
la bonne popup) - jamais le rendu visuel/anime reel, verifie uniquement via
l'aller-retour artifact <-> utilisateur avant integration, pas dans ce
harnais.

## Kilo comme guide de l'onboarding complet

Demande explicite : Kilo doit accompagner TOUTE la phase d'initiation (pas
seulement les popups/l'accueil deja cables), "comme si c'est elle qui te
guidait" - du questionnaire de profil (age/sexe/mensurations/niveau, y
compris l'ecran ou l'utilisateur donne son poids) jusqu'au mini-tour guide
qui presente les onglets.

**Principe retenu : Kilo REMPLACE les icones generiques du "coach virtuel"
existant plutot que de s'y ajouter en plus.** Le concept "coach virtuel IA"
etait deja present (badge 🧠 "Coach Virtuel IA" sur l'ecran age uniquement,
badge ⚡ sur l'ecran de bienvenue, ✅ sur l'ecran de confirmation) - Kilo EST
ce coach, donc ces emojis generiques deviennent litteralement Kilo plutot
que de coexister avec lui separement :
- Ecran de bienvenue + ecran de confirmation (`renderOnboardingTransitionScreen()`,
  phase `confirm`) : nouvelle classe `.onboarding-kilo-hero` remplace
  `.pf-welcome-badge` (⚡ puis ✅) - `renderKilo('idle', {size:110})` sur la
  bienvenue, `renderKilo('success', {size:110})` sur la confirmation (l'etat
  success est deja le vocabulaire etabli ailleurs dans l'app pour "moment
  valide").
- Ecran de chargement (phase `loading`, calcul des objectifs) : meme
  `.onboarding-kilo-hero` en idle, au-dessus du spinner existant (inchange).
- **Les 4 etapes du questionnaire** (age/sexe/mensurations-poids/niveau) :
  le badge `.coach-badge` ("Coach Virtuel IA"), qui n'existait QUE sur
  l'ecran age avant ce chantier, s'affiche desormais identiquement sur les 4
  - `renderKilo('idle', {size:28})` y remplace le 🧠. Calcule UNE seule fois
  (`coachBadgeHtml`) et reutilise sur les 4 branches plutot que duplique.
  Les emojis specifiques a chaque question (🎂/🚻/📏/💪) restent inchanges
  (`.pf-emoji`) - ils portent une info utile (quelle question), Kilo n'est
  pas cense les remplacer, juste etre presente en plus sur chaque etape.
- **Mini-tour guide** (`renderGuidedTourOverlay()`, presentation des
  onglets) : restructuration de `.tour-bubble-title` en `.tour-bubble-head`
  (flex row) avec un nouvel avatar `.tour-bubble-avatar`
  (`renderKilo('idle', {size:44, clickable:true})`) a gauche du titre/texte
  - lecture "bulle de chat", Kilo presente chaque carte plutot que
  simplement l'emoji de titre existant (conserve, `step.emoji`).

CACHE_NAME -> v77. Aucun changement de regles Firestore/Cloud Functions, ni
aux textes de traduction (`t(...)`) existants - uniquement de nouveaux
emplacements pour `renderKilo()`, deja teste (structure/classes) pour
chacun des ecrans listes ci-dessus.

## Renommage "Kilo" -> "Kilito" (nom PUBLIC uniquement, pas les identifiants de code)

Demande explicite : un nom plus mignon et comprehensible dans toutes les
langues comme designant un poids/haltere de musculation. Plusieurs pistes
proposees (Hilito, Kilou, Halterito, Tonko, Bulko, Buffo...) avant que
l'utilisateur ne retienne **Kilito** (kilo + diminutif "-ito", reconnu tres
largement grace a l'espagnol/italien/portugais - garde le lien direct avec
le poids, contrairement a "Hilito" qui n'evoque rien de lie a la
musculation - "hilo" = fil en espagnol).

**Choix delibere de perimetre : seul ce qu'un utilisateur voit/entend
change, pas les identifiants internes.** `renderKilo()`, `kiloState`,
`KILO_STATE_SVG`, les classes CSS `.kilo-*`, `kiloTap()`,
`computeKiloHomeState()` etc. restent inchanges - un renommage complet de
tous ces symboles a travers `index.html`/`styles.css`/`tests/app.test.js`
(des dizaines d'occurrences, correspondances de chaines exactes dans les
tests) aurait ete un gros diff a risque pour un changement purement
cosmetique, sans aucun benefice utilisateur - le nom de code interne
divergeant du nom public est une pratique courante et sans consequence.
Seuls 4 emplacements reellement vus/entendus par l'utilisateur ont change :
- `aria-label="Kilito, humeur ${state}"` dans `renderKilo()` (accessibilite).
- Les 3 traductions du sous-titre `popups.streakLost.subtitle`
  (fr/en/es) qui nomment la mascotte dans le texte ("Kilo a eu un coup de
  mou..." -> "Kilito a eu un coup de mou...").

CACHE_NAME -> v78. Aucune regle Firestore/Cloud Functions touchee.

## Retours utilisateur apres tests reels en conditions (9 commits precedents deployes)

Grosse serie de corrections/ajustements apres un vrai passage utilisateur sur les
9 commits precedemment deployes - 2 captures d'ecran + une liste numerotee (voir
historique de conversation) servant de reference aux items "#N" ci-dessous.

**Bugs de donnees/rafraichissement (Firebase) :**
- **Suppression de compte (RGPD)** : `deleteMyAccount()` ne supprimait que le kv
  store + `leaderboard/{uid}` de l'utilisateur - jamais son doc membre dans les
  groupes rejoints (`groups/{id}/members/{uid}`) ni ses relations d'amitie
  (`friendships/{pairId}`), qui restaient visibles cote AUTRES utilisateurs
  (profil "fantome"). Corrige en lisant `users/{uid}/myGroups` (deja la propre
  sous-collection de l'utilisateur - jamais un scan de `groups/**`) puis
  `friendships` par `uidA`/`uidB` (meme requete bornee que `refreshFriendsData()`),
  et en supprimant tout ca par lots (`db.batch()`) - cout de lecture reste
  strictement proportionnel au nombre de groupes/amis de CET utilisateur.
  **Bug de mock decouvert en testant cette correction** : les documents renvoyes
  par une requete (`.where().get()`, `.collection().get()`) n'avaient jamais de
  propriete `.ref` dans le mock Firestore de test (contrairement au vrai SDK) -
  `deleteMyAccount()` tournait donc en prod (`doc.ref` y fonctionne normalement)
  mais n'avait jamais pu etre testee de bout en bout, exactement comme le
  signalait deja un commentaire existant. Corrige dans le mock (`makeQuery().get()`),
  ce qui a aussi revele un 2e trou : `.get()` sur la sous-collection `kv` n'existait
  pas du tout (mock `kv` = un singleton partage, voir son commentaire dedie) -
  ajoute un repli qui renvoie toujours vide plutot que de modeliser un vrai
  document supprimable (vider le singleton partage aurait silencieusement casse
  tous les tests sequentiels suivants qui en dependent).
- **Donnees perimees apres notification** : taper sur une notification (nouveau
  defi de groupe, attaque Boulet) qui ramenait l'app au premier plan alors que
  l'ecran de detail groupe (ou la fiche d'exercice) etait deja affiche montrait
  des donnees figees - `loadGroupDetail()`/`loadActiveExerciseGroupChallenges()`
  sont de simples lectures ponctuelles (`.get()`), jamais des listeners temps
  reel, et rien ne les redeclenchait au retour au premier plan (seule une
  navigation manuelle - quitter puis revenir - forcait un fetch frais). Corrige
  par un nouvel ecouteur `visibilitychange` qui recharge automatiquement l'ecran
  concerne (si toujours affiche) des que l'app redevient visible.

**UI :** cartes de groupe collees entre elles (`.group-card-list` n'avait jamais
eu de regle CSS du tout) - `display:flex; flex-direction:column; gap:12px`.

**Items numerotes (voir liste de reference fournie par l'utilisateur) :**
- **#5** : le compteur/pourcentage global de la carte hero d'un defi de groupe
  sommait le `totalAmount` BRUT de chaque participant au lieu de la valeur NETTE
  (`computeGroupParticipantDisplayAmount()`, deja utilisee par le classement juste
  en dessous depuis un correctif precedent) - desynchronisait visuellement le haut
  de la carte du classement qui la suit. Meme formule partout desormais.
- **#7** : bouton renomme (`doExerciseBtn`) - FR "Faire des {{exercice}}" (choix
  explicite de l'utilisateur ; fonctionne parfaitement pour les noms d'exercice
  pluriels, largement majoritaires dans le catalogue - quelques singuliers comme
  "Planche"/"Chaise" restent une imperfection mineure acceptee), EN "Do
  {{exercice}}", ES "Hacer {{exercice}}" (aucun souci d'article dans ces 2
  langues). **Bug du clic reel** : `startGroupChallengeExercise()` appelait
  `pickChallenge()` sans jamais faire basculer `activeTab` sur `'today'` - le
  dispatcheur principal `render()` teste `activeTab` AVANT `currentChallengeId`,
  donc rester sur `activeTab==='groups'` faisait simplement ré-afficher l'ecran
  Groupes (currentChallengeId totalement ignore), ce qui ressemblait a un simple
  rafraichissement de la page actuelle.
- **#11** : barre verte glissante en haut de l'onglet actif (`.tab-active-indicator`,
  `view-transition-name`) retiree entierement - remplacee par un fond "pilule"
  discret sur `.tab-btn.active` (meme teinte que `.coach-badge`), en plus du halo
  deja existant sur l'icone active.
- **#13** : retour tactile (vibration) manquant sur plusieurs boutons (sous-onglets
  Defi/Ardoise/Palmares d'un groupe, entre autres) - `navigator.vibrate()` n'a
  toujours ete ajoute qu'au cas par cas (~20 emplacements). Plutot que d'auditer
  bouton par bouton, UN SEUL ecouteur `click` delegue au niveau du `document`
  (phase de CAPTURE, pas bubbling) couvre desormais tout `button`/`.clickable` de
  l'app - meme philosophie que le retour visuel `:active` deja generalise. La
  capture (avant le `onclick` propre de l'element) garantit qu'une vibration plus
  riche posee manuellement a un endroit precis (ex: badge debloque) se declenche
  APRES ce signal court et le remplace naturellement (la Vibration API annule
  toujours l'appel precedent) - jamais de double-retour perceptible.
- **#18** : glisser une bottom sheet vers le bas pour la fermer declenchait EN
  MEME TEMPS le pull-to-refresh de la page en arriere-plan - le listener
  `initPullToRefresh()` est pose au niveau du `document` et ne verifiait jamais
  si une feuille etait ouverte par-dessus. Les 3 feuilles (info groupe, profil
  ami, palier de niveau) partagent deja la meme classe `.level-roadmap-overlay`
  (voir `attachSheetBehavior()`) - un seul `document.querySelector(...)` dans le
  garde-fou existant suffit a couvrir les 3 (et toute future feuille qui
  reutiliserait la meme fonction partagee).
- **#19 (annulation)** : l'anneau de progression SVG pour les exercices en
  repetitions (`renderExerciseProgressRingSVG()`, ~130 lignes + CSS dediee,
  ajoute lors de la 2e passe "effet waouh") retire ENTIEREMENT - "occupe
  beaucoup trop d'espace vertical". Retour a la meme barre horizontale +
  pourcentage que les exercices en secondes, plus aucune distinction d'unite
  pour ce bloc.
- **#24** : le son de reussite (accord fixe de 3 notes, percu comme un simple
  "bip") remplace par un cri de felicitations dynamique type "Wouehhh !" -
  balayage de frequence montant (220Hz -> 660Hz, oscillateur en dents de scie
  plutot que sinus pour un timbre plus riche) + vibrato + retombee douce en fin
  de son, a l'image des sons de victoire des applications ludiques/sportives.
  Web Audio API pur, aucun asset audio a heberger.
- **#26/#27-30** : Kilito etait trop petit sur l'accueil (44px -> 72px) et pas
  centre horizontalement dans les popups (84px -> 118px + `.app-popup-icon.kilo-icon`
  devient un conteneur flex centre). **Cause du defaut de centrage** : `.kilo-svg`
  est `display:block`, qui ignore le `text-align` de son parent (contrairement a
  l'icone emoji, simple texte, deja centree par le `text-align` du popup) - un
  bug reel, pas juste une histoire de taille.
- **#38** : nouvel ecran d'onboarding de presentation de Kilito, entre la
  bienvenue et la 1ere question (age) - Kilito tres grand et anime (etat `idle`,
  deja vivant : flottement doux + halo neon), son nom affiche en tres grand avec
  une lueur neon (`.kilo-intro-name`), message humanisant fourni par
  l'utilisateur ("Salut ! Moi c'est Kilito et je vais t'accompagner..."), traduit
  en EN/ES dans le meme ton. **Choix d'implementation** : nouvelle etape `0.5`
  (volontairement NON entiere) dans `profileStep`/`profileNext()`/`profilePrev()`
  plutot que de renumeroter les etapes existantes 1/2/3/4 (age/sexe/mensurations/
  niveau) - ces numeros sont references par leur valeur exacte a des dizaines
  d'endroits (tests, formule des points de progression `renderProfileProgressDots()`).
  Une etape "entre les deux" ne touche a AUCUN d'entre eux, zero risque de
  regression sur l'existant.

CACHE_NAME -> v79. Aucun changement de regles Firestore/Cloud Functions (seule
la logique client evolue). Meme limite de verification que d'habitude pour tout
ce qui touche au rendu visuel reel (tailles/centrage de Kilito, son synthetise,
disparition de la barre glissante) - valide par tests structurels + lint,
jamais par un rendu reel sur appareil dans cet environnement.

## Son de reussite : fichier audio reel (`assets/sounds/success.mp3`) a la place de la synthese Web Audio

Demande explicite de l'utilisateur, avec le fichier MP3 deja fourni (place par
ses soins dans `assets/sounds/success.mp3`) : remplacer la synthese
`playSuccessSound()` (oscillateurs Web Audio, plusieurs iterations au fil de
cette session) par un vrai enregistrement, pour un rendu plus humain que
n'importe quel son genere.

`playSuccessSound()` reduite a l'essentiel : instancie un `new window.Audio(...)`
a CHAQUE appel (jamais une instance reutilisee) et appelle `.play()` avec un
`.catch()` discret - une PWA peut voir l'autoplay bloque par le navigateur tant
qu'aucune interaction utilisateur n'a encore eu lieu dans la page, ne doit
jamais remonter en erreur non geree pour autant. Une NOUVELLE instance a chaque
fois (plutot qu'un seul `<audio>` reutilise avec `.currentTime = 0`) evite toute
logique de reset manuel en cas de declenchements rapproches (completion normale
puis Hardcore dans la foulee, par exemple) - chaque instance rejoue toujours
depuis le debut independamment des autres. Toujours gardee par
`soundEffectsEnabled` (reglage Parametres, inchange) - aucun des 3 points
d'appel existants (completion normale, Hardcore, victoire Boss Battle) n'a
besoin d'etre modifie, seul le contenu de la fonction change.

`window.Audio` (prefixe explicite, pas juste `Audio`) - meme convention que
`window.AudioContext || window.webkitAudioContext` deja utilisee ailleurs dans
le fichier, necessaire pour que le mock de test (`vm.createContext`, ou les
identifiants globaux resolvent contre l'objet sandbox lui-meme, pas contre un
`window` imbrique) puisse intercepter l'appel proprement.

Fichier precache dans le service worker (`ASSETS`) comme les icones/manifest -
disponible hors ligne des le tout premier lancement, pas seulement apres une
1ere lecture reseau qui l'aurait mis en cache "a la volee".

CACHE_NAME -> v80. Aucun changement de regles Firestore/Cloud Functions.

## Pseudo non libere a la suppression + onboarding qui saute le pseudo + retrait du switch push doublon

Trois corrections liees, signalees ensemble par l'utilisateur apres un vrai
test "supprimer mon compte puis le recreer immediatement".

**1. Pseudo non libere a la suppression du compte.** `deleteMyAccount()`
supprimait deja le kv store, `leaderboard/{uid}`, le roster de groupes et les
amities (voir la section precedente) - mais jamais `usernames/{pseudo}`
(reservation create-only, un seul document par pseudo, voir
`firestore.rules`). Un pseudo repris juste apres une suppression restait donc
"deja pris" par le compte pourtant supprime. Corrige en supprimant ce document
au meme endroit, avec la meme regle deja utilisee pour le renommage
(`finishUsernameSetup()`) : chacun ne peut supprimer que SON PROPRE document
(`uid == request.auth.uid`).

**2. Onboarding qui saute silencieusement le choix du pseudo.** Bug plus
subtil, cause racine reelle trouvee en lisant le code plutot que supposee :
la variable `username` n'etait **jamais reinitialisee a la deconnexion**
(`auth.onAuthStateChanged`, branche `user == null` - ce bloc reinitialise deja
`usernameSetupMode`/`usernameDraft`/etc. mais oubliait `username` lui-meme).
Dans la MEME session/onglet (deconnexion puis reconnexion immediate sur un
AUTRE compte - exactement le scenario "supprimer puis recreer" sans recharger
la page), la valeur du pseudo de l'ancien compte restait donc en memoire. Pour
un compte tout neuf, `loadAppData()` ne corrige pas non plus le tir : son bloc
`if (doc && doc.exists) { ... username = d.username ?? null; ... }` est
**entierement saute** quand le document consolide n'existe pas encore (compte
jamais vu) - rien d'autre ne remet `username` a `null` dans ce cas.
Consequence : `finishProfileOnboarding()` (juste apres l'ecran "niveau") teste
`if (!username)` pour forcer l'ecran de choix du pseudo - avec la valeur
perimee toujours "vraie", ce test echouait silencieusement et l'onboarding
enchainait directement sur l'ecran de confirmation, sans jamais demander de
pseudo. Seul un **redemarrage complet** de l'app repartait de zero
(`let username = null;` au chargement du module) et faisait alors
correctement apparaitre le verrou `usernameSetupMode = 'gate'` de `startApp()`
- exactement le symptome signale ("n'apparait qu'au relancement"). Corrige en
ajoutant `username = null;` au meme endroit que les autres reinitialisations
de deconnexion, la ou ca aurait toujours du etre.

**3. Retrait du switch "Notifications push" de Parametres.** Demande
explicite : ce switch manuel faisait doublon avec la popup systeme native de
permission et creait de la confusion (2 sources de verite potentiellement
incoherentes). Retire entierement - `renderPushNotificationsSettingsRow()`,
`togglePushNotifications()`, `disablePushNotifications()`,
`isPushNotificationsEnabledOnThisDevice()` et la constante
`FCM_TOKEN_STORAGE_KEY` (plus aucun lecteur une fois ces fonctions retirees)
supprimes entierement plutot que laisses morts, ainsi que les 4 cles de
traduction `settings.pushNotifications.*` (fr/en/es). **Ce qui reste** :
`enablePushNotifications()` (toujours appelee, mais UNIQUEMENT depuis
`maybePromptPushNotificationsOnStartup()`) et toute la logique
`shouldAutoPromptPushNotifications()`/`shouldRefreshPushToken()` qui decide,
au demarrage, de (re)demander la permission native ou de rafraichir
silencieusement un token perime - c'est desormais la SEULE source de verite,
`Notification.permission`, jamais un etat local en plus.

CACHE_NAME -> v81. Aucun changement de regles Firestore/Cloud Functions. La
correction #2 (reinitialisation a la deconnexion) n'est testable qu'a la
source (verification de presence/ordre dans le texte du fichier) : le mock
`auth()` de test declare explicitement ne jamais declencher son callback
`onAuthStateChanged` ("pilote manuellement depuis le test") - meme limite deja
rencontree pour les autres ecouteurs `document`/`window.addEventListener`.


## Total du groupe plafonne a 0 (malus Boulet non compense) + Ardoise integree/cumulee

**1. Le total collectif du groupe ne doit jamais devenir negatif.** Le
classement individuel (`computeGroupParticipantDisplayAmount()` cote client,
`rankForSettlement()` cote Cloud Function) affiche a raison une valeur nette
NEGATIVE pour la victime d'un malus Boulet non compense (ex: -20 avant d'avoir
fait une seule repetition) - c'est le comportement voulu, ca montre qu'elle
est "en dette". Mais le TOTAL COLLECTIF du groupe (carte hero, seuil de
reglement, plafond de credit d'une contribution) reprenait bêtement la somme
de ces valeurs nettes, pouvant lui aussi devenir negatif (-20, soit -40% de la
cible) - absurde pour un objectif partage. Nouvelle fonction pure
`computeGroupTotalProgress(participants)` (dupliquee cote client et cote
Cloud Function, comme `computeGroupParticipantDisplayAmount()`/
`rankForSettlement()` avant elle - aucun import possible entre index.html et
functions/index.js) : plafonne CHAQUE contribution individuelle nette a 0
AVANT de sommer. Un malus neutralise donc juste la contribution de cette
personne (jamais un total de groupe negatif), qui ne recommence a grimper que
lorsque son propre malus est compense par ses propres repetitions (net
redevenu positif) - exactement le comportement demande ("des que Bob fait sa
21eme pompe").

**Trouve en 3 emplacements distincts qui doivent rester coherents entre eux**
(la vraie raison d'avoir factorise une fonction partagee plutot que de
corriger un seul endroit) :
- Client : `renderGroupDetailScreen()` (carte hero) ET `loadActiveExerciseGroupChallenges()`
  (mini-barre de progression liee, sur la fiche d'exercice) - ces 2 affichaient
  auparavant des totaux CALCULES DIFFEREMMENT pour le MEME defi (l'un net du
  handicap, l'autre totalAmount brut) : desormais unifies sur la meme fonction.
- Cloud Function : `settleChallengeIfNeeded()` (`totalProgress`, decide si la
  cible est atteinte) ET `logGroupChallengeContribution()` (`currentProgress`,
  plafond exact de ce qu'une contribution peut encore crediter avant la
  cible - `computeCreditedAmount()`). Sans cet alignement, le total affiche a
  l'ecran et le seuil de reglement REEL cote serveur auraient pu diverger
  silencieusement (l'un montrant "80%, pas encore atteint" pendant que l'autre
  regle deja le defi a 100%, ou l'inverse empechant a tort de nouvelles
  contributions alors que la cible affichee n'est pas encore atteinte).

**2. Ardoise : le nom du gage integre dans la phrase, plus une ligne isolee
en dessous.** "{{from}} doit un gage à {{to}}" + une ligne separee
`rank-bar-hint` en dessous (deja regroupee/pluralisee via
`groupLedgerEntriesForDisplay()`/`tn()`, ex: "🍺 2 bières") devient
"{{from}} doit 2 bières à {{to}}" en une seule phrase (nouvelle cle
`ledgerLineWithStake`). Le regroupement/cumul EXISTAIT deja (rien a changer
cote logique) - seul le RENDU change : `beerLabel` perd son emoji prefixe
(un emoji en plein milieu de phrase casserait la lecture), `renderLedgerRow()`
compose desormais une seule phrase integrale au lieu d'un titre generique +
sous-ligne separee. Nouvelle cle `stakeFallback` ("un gage"/"a stake"/"una
apuesta") : repli tres rare pour un gage personnalise historique cree avant
que le champ vide soit refuse a la validation.

CACHE_NAME -> v82. **Changement touchant `functions/**` (2 fonctions) -
deploiement `deploy-functions.yml` confirme explicitement avec l'utilisateur
avant tout push**, conformement a la politique d'autonomie du projet (voir
memoire dediee) qui exclut ce dossier de la zone de confiance automatique.


## Trophee "cumul a vie" annonce immediatement (decouple de la completion du jour)

**Signalement initial de l'utilisateur** ("mes repetitions loguees hors
validation du defi du jour sont perdues") **s'est revele inexact a la
verification du code** - `entry.sets` (repetitions brutes), `stats[id].lifetimeTotal`/
`bestDay` et `registerGroupChallengeContributionsIfNeeded()` (credit des defis
de groupe) etaient deja mis a jour de facon INCONDITIONNELLE dans
`addSetInner()`, avant tout test de `willComplete` - rien n'etait reellement
perdu. Le VRAI et seul ecart trouve : `checkNewBadges()` (detection/deblocage
de trophee) n'etait appelee que dans les blocs `if (willComplete)` (completion
normale + Hardcore) - donc un trophee base sur un CUMUL A VIE deja franchi
(`pushups_100/500/1000/5000/10000`, `core_15min/1h/6h/24h` dans `BADGE_DEFS`,
tous sur `sumLifetime(...)`) restait "gele", non annonce, jusqu'a la prochaine
completion d'un objectif personnel du jour QUELCONQUE - parfois des jours plus
tard, ou jamais si l'utilisateur ne fait que contribuer a des defis de groupe
sans jamais completer son propre objectif quotidien.

**Analyse presentee a l'utilisateur avant tout code** (demande explicite,
"NE CODE RIEN POUR L'INSTANT... decris-moi d'abord precisement la logique"),
avec 2 questions de jugement : (a) annoncer le trophee des le franchissement
du seuil meme si la serie qui le declenche depasse largement ce seuil (ex: +30
pompes alors qu'il n'en manquait que 20), ou attendre une frontiere plus
"propre" ; (b) pour un exercice chronometre, s'assurer que la verification
n'interrompt jamais le chrono en cours. Reponse utilisateur : (a) immediat, la
popup doit s'afficher des le tap qui fait franchir le seuil, meme en cas de
depassement ; (b) confirme que l'architecture existante le garantit deja pour
les chronos, a verifier plutot qu'a construire.

**Verifie par lecture directe du code (pas suppose)** : `tickTimer()` (boucle
`setInterval` 250ms) n'appelle JAMAIS `addSet()`/`addSetInner()` directement -
il appelle uniquement `stopTimer(elapsed)` si la cible est atteinte
automatiquement. `stopTimer()` (appelee soit par ce cas auto, soit par le clic
manuel pause dans `toggleTimer()`) appelle `addSet()` **exactement une fois**
par invocation. `addSetInner()` est donc deja le seul et unique point de
passage, appele une fois par tap (reps) ou une fois par arret de chrono
(timer) - jamais en plein tick. Placer la verification de trophee a
l'interieur de cette fonction satisfait donc les deux exigences (immediat
pour les reps, jamais d'interruption du chrono) sans aucun code specifique par
type d'exercice.

**Correctif** : nouvel appel INCONDITIONNEL a `checkNewBadges()` dans
`addSetInner()`, juste apres la mise a jour de `stats[id].lifetimeTotal` (donc
avant le test `willComplete`), avec son propre octroi d'XP
(`awardXp(trophyXp)`) et sa propre mise en file de popups
(`enqueueTrophyPopups()`/`enqueueLevelPopups()`) - independant des 2 appels
`checkNewBadges()` deja existants dans les blocs `willComplete`/Hardcore, qui
restent seuls responsables des trophees bases sur `badges.totalCompletions`/
`computeStreak()`/`badges.totalHardcore` (legitimement lies a la completion du
defi du jour, pas un bug). `checkNewBadges()` etant deja idempotente (ignore
tout badge present dans `badges.unlocked`), aucun risque de popup ou d'XP en
double entre cet appel precoce et les 2 appels existants plus bas dans la
meme fonction.

Nouveau test (`tests/app.test.js`, juste apres le test de la popup epique de
trophee) : `stats[pompes.id].lifetimeTotal = 75`, `addSet(30)` (serie tres en
dessous de l'objectif personnel du jour) -> verifie que `entry.done` reste
`false` (pas de completion du jour) alors que le trophee "100 pompes
cumulees" se debloque et s'affiche immediatement (`badges.unlocked` +
`currentPopupHtml`).

CACHE_NAME -> v83. Aucun changement de regles Firestore/Cloud Functions -
modification 100% cote client (`index.html`), aucune touche a `functions/**`.


## 4 retouches de detail (mascotte, halo d onglet, secousse au clic, separation Classement)

**1. Marges de Kilito sur l accueil (bug reel, pas une preference).**
`renderKilo(kiloHomeState, {size: 72})` (agrandi lors d une session precedente,
non documentee ici) gonflait toute la ligne `.header` (Date/Streak) bien
au-dela de son gabarit d origine. Cause reelle, verifiee en lisant le CSS
(pas supposee) : `.header` utilise `align-items: baseline` ; meme avec
`align-self: center` pose sur `.kilo-home-slot` (deja en place, precisement
pour ne pas casser l alignement baseline de `.date`/`.streak`), un flex item
conserve sa "hypothetical cross size" pour le calcul de la hauteur de LIGNE -
un SVG de 72px continuait donc de forcer toute la ligne a ~72px de haut,
meme non aligne sur la baseline. Corrige sans reduire Kilito lui-meme :
`.kilo-home-slot` a desormais une hauteur fixe compacte (36px, `overflow:
visible`) et son SVG interne recoit une marge verticale negative (-18px de
chaque cote) pour deborder visuellement au-dessus/en dessous de ce calage
sans jamais agrandir la ligne flex qui le contient - Kilito garde exactement
la meme taille visuelle, mais son "poids layout" retombe a 36px.

**2. Halo diffus sur l onglet actif (retouche esthetique).** L aplat "pilule"
(`background: rgba(57,233,122,0.12)` + `border-radius: 12px` plein) derriere
l onglet actif lisait comme un rectangle aux bords trop nets. Remplace par un
`::before` en `radial-gradient(ellipse at center, ...)` qui s estompe
jusqu a `rgba(57,233,122,0) 78%` + `filter: blur(6px)` - aucune frontiere
nette, un vrai halo. `.tab-btn` recoit `z-index: 0` (cree un contexte
d empilement LOCAL a chaque bouton) pour que le `::before` en `z-index: -1`
reste confine derriere l icone/le libelle de CET onglet uniquement, sans
jamais deborder visuellement sur les onglets voisins ni passer sous le fond
de `.tab-bar` (fixed, deja son propre contexte d empilement).

**3. Secousse visuelle au clic sur les onglets du bas (bug reel).** Le retour
tactile GENERALISE (`button:not(:disabled):active { transform: scale(0.96);
}`, tout en haut de `styles.css`, ajoute lors d une session precedente pour
un "effet waouh" sur TOUT element interactif) s appliquait aussi aux onglets,
ressenti comme une secousse d ecran genante. **Piege de specificite CSS
rencontre en le corrigeant** : un simple `.tab-btn:active { transform: none;
}` (specificite 0,0,2,0) est en realite moins specifique que la regle
generale `button:not(:disabled):active` (0,0,2,1 - le `:not()` compte la
specificite de son argument `:disabled`, PLUS le type `button` lui-meme) et
aurait donc perdu ce bras de fer silencieusement, sans aucune erreur visible
- le clic aurait continue de secouer l ecran malgre l override apparent.
Corrige avec un selecteur volontairement plus specifique,
`.tab-bar button.tab-btn:active` (0,0,3,1), qui domine sans ambiguite. Le
fond `.bg-card` au clic reste seul retour visuel ; le retour haptique
(`navigator.vibrate`, deja en place ailleurs) n est pas concerne par ce
correctif, purement visuel.

**4. Separation visuelle du Classement (ecran Communaute).** Les boutons de
filtre du classement (Serie/Hebdo/Legendes) s enchainaient sans transition
juste sous le fil d activite (amis), illisibles comme une section a part
entiere. Un `.section-label` (meme composant deja utilise pour "Temple de la
renommee"/"Fil d activite" juste au-dessus dans le meme ecran - convention
existante reutilisee, pas un nouveau composant) avec la nouvelle cle
`community.leaderboardSectionLabel` ("Classement communautaire"/"Community
leaderboard"/"Clasificacion comunitaria") est insere juste avant
`.leaderboard-tabs` dans `renderCommunityScreen()`.

CACHE_NAME -> v84 (styles.css + les 3 fichiers `locale-*.js`, tous
cache-first avec remplissage cote service worker - voir la regle "RECIDIVE
deja vecue" plus haut, qui s applique aussi aux fichiers de traduction).
Aucun changement de regles Firestore/Cloud Functions - modification 100%
cote client, aucune touche a `functions/**`.


## Fiabilisation des demandes d amis ("Demandes en attente")

**Contexte : la fonctionnalite existait deja presque entierement.** Avant de
coder quoi que ce soit, verification du code existant (`renderFriendsScreen()`,
`refreshFriendsData()`) a confirme qu'une section "Demandes recues" (liste,
masquee si vide, bouton Accepter/Refuser) etait deja en place, alimentee par
une VRAIE requete Firestore (`friendRequests.where('toUid','==',uid)`), pas
par un mecanisme lie aux notifications. Le retour utilisateur ("si la
notification push echoue ou est manquee, aucun moyen de retrouver
l invitation") a donc oriente vers un vrai bug de FRAICHEUR plutot que vers
une fonctionnalite manquante :

**Bug reel trouve : `incomingFriendRequests` n etait jamais rafraichi a la
(re)ouverture de l ecran Amis.** `refreshFriendsData()` (la seule fonction qui
relit `friendRequests` depuis Firestore) n etait appelee qu au demarrage de
l app et apres une action ami (accepter/refuser/retirer) - jamais depuis
`openFriendsScreen()`. Une demande recue pendant que l app etait deja ouverte
restait donc invisible dans l ecran Amis tant que : (a) la popup in-app de
`processUnreadNotifications()` (type `friend_request`, propose "Accepter
maintenant"/"Plus tard") n avait pas ete traitee ET acceptee sur-le-champ - un
tap sur "Plus tard" abandonnait purement et simplement la demande visuellement
(aucun refresh ni ecriture locale), ou (b) un redemarrage complet de l app.
Corrige en ajoutant un appel `refreshFriendsData()` (volontairement NON
attendu - `render(true)` synchrone garde l ouverture instantanee, le
rafraichissement Firestore met a jour l affichage des qu il revient, via le
`render()` deja integre a `refreshFriendsData()`) dans `openFriendsScreen()` -
la liste est desormais TOUJOURS fiable a l ouverture, independamment de toute
notification recue, manquee ou refusee.

**Amelioration demandee : afficher le pseudo, pas le nom Google formate.**
`incomingFriendRequests` utilisait `fetchPublicProfile(fromUid)` (nom Google
anonymise via `formatDisplayName()`, ex: "Jean D.") - aucun index public
`uid -> pseudo` n existe ailleurs dans l app (seul `usernames/{pseudo} ->
uid`, dans l autre sens ; la recherche d amis fonctionne d ailleurs
exclusivement par pseudo exact, jamais par nom). Plutot que d ajouter une
lecture supplementaire ou un nouvel index, le pseudo de l expediteur est
desormais denormalise DIRECTEMENT sur le document `friendRequests` au moment
de l envoi (`sendFriendRequest()` ecrit `fromUsername: username`), repris tel
quel par `refreshFriendsData()` puis affiche `'@' + fromUsername` (convention
deja utilisee ailleurs dans l app, voir `settings.account.label`/recherche
d amis) dans `renderFriendsScreen()`. **Repli gracieux obligatoire** : les
demandes ecrites AVANT ce correctif n ont pas ce champ - `fromUsername ||
null` a la lecture, `r.fromUsername ? '@'+r.fromUsername : r.displayName` a
l affichage, retombe silencieusement sur le nom formate existant (jamais de
`undefined` affiche).

**Titre de section aligne sur la demande exacte de l utilisateur** :
`friends.incomingLabel` renomme de "Demandes reçues" a "Demandes en attente"
(FR) / "Incoming requests" a "Pending requests" (EN) / "Solicitudes
recibidas" a "Solicitudes pendientes" (ES).

Aucune regle Firestore a modifier : `friendRequests.create` autorise deja
n importe quel champ tant que `fromUid == request.auth.uid` (pas de liste
de champs stricte), et la requete `where('toUid','==',uid)` (deja utilisee
avant ce correctif) reste inchangee.

CACHE_NAME -> v85 (les 3 fichiers `locale-*.js`, texte de section modifie).
Aucun changement de regles Firestore/Cloud Functions - modification 100%
cote client, aucune touche a `functions/**`.


## 3 correctifs cibles : score Boulet instable, invitations de groupe centralisees, son de victoire de groupe

### 1. Score de groupe instable apres un malus Boulet (bug reel, pas une preference)

**Symptome signale** : apres avoir recu le malus Boulet (-20), un premier clic
`+10` n etait pas comptabilise/mis a jour a l ecran, mais un clic suivant
`+5` "fonctionnait". **Root cause reelle, trouvee par lecture du code (pas
supposee)** : la mini-barre de progression du defi de groupe affichee sous
l objectif personnel (`activeExerciseGroupChallenges`, fiche d exercice)
utilisait une mise a jour "optimiste" naive dans `addSetInner()` -
`currentTotal + amount`, ajoutant AVEUGLEMENT le montant brut tape. Or
`computeGroupTotalProgress()` (deja en place, correctif precedent) plafonne
le NET de CHAQUE participant (`totalAmount - handicap`) a 0 AVANT de sommer -
une victime du Boulet encore SOUS son handicap qui loggue des repetitions ne
fait donc PAS avancer le total du groupe au meme rythme que le nombre brut
tape (rien tant que son net reste negatif, puis seulement l exces une fois le
handicap compense). Additionner naivement le montant brut etait donc
**mathematiquement faux**, et desynchronisait l affichage de facon instable
(parfois "corrige" par une lecture perimee arrivant plus tard et ecrasant la
valeur) - exactement le symptome decrit.

**Correctif** : `addSetInner()` ne calcule plus rien localement - elle
resynchronise TOUJOURS via une relecture Firestore fraiche et autoritative
(`loadActiveExerciseGroupChallenges()`, reutilisee telle quelle - meme
fonction/meme formule que la carte hero de l ecran Groupes, aucun calcul
duplique). **Protection contre une 2e source d instabilite, decouverte en
creusant** : `loadActiveExerciseGroupChallenges()` est aussi appelee en
"fire-and-forget" depuis `pickChallenge()` a l ouverture de la fiche
d exercice - un utilisateur qui tape une serie tres vite apres ouverture
declenchait 2 lectures Firestore concurrentes (l ouverture ET la
resynchronisation post-serie), sans aucune garantie que la plus RECEMMENT
EMISE resolve en dernier. Corrige par un jeton de sequence
(`activeExerciseGroupChallengesSeq`, incremente a chaque appel) : toute
reponse dont le jeton n est plus le plus recent emis est ignoree - la
derniere lecture EMISE gagne toujours, jamais celle qui RESOUT en dernier
par hasard.

**Compromis assume** (explicitement voulu par l utilisateur : "sans aucune
perte de donnees... 100% robuste" plutot que la reactivite a tout prix) :
chaque serie loguee sur un exercice lie a un defi de groupe declenche
desormais un aller-retour Firestore supplementaire (en plus de l appel deja
existant a la Cloud Function `logGroupChallengeContribution`, deja awaited
avant ce point) avant le prochain `render()` - un leger delai au lieu d une
estimation locale potentiellement fausse. N affecte QUE les series liees a
un defi de groupe actif (garde explicite avant l appel), jamais les series
"normales".

### 2. Invitations de groupe centralisees dans l ecran Amis

**Contexte, decouvert en explorant le code (different des demandes d amis)** :
contrairement a `friendRequests` (vraie collection persistante, requete
`where('toUid','==',uid)` deja fiable), une invitation de groupe
(`inviteFriendToGroup()`) n existait QUE sous forme d un document
`users/{uid}/notifications/{id}` (`type:'group_invite'`) - ephemere par
construction : `processUnreadNotifications()` marque CHAQUE notification
`read:true` des son premier affichage, accepte ou non, et rien d autre n en
gardait trace. Une invitation refusee via "Plus tard" tombait donc dans un
vrai trou noir, sans AUCUN moyen de la retrouver.

**Decision d implementation (aucune nouvelle collection, aucune regle
Firestore a modifier)** : plutot que de creer une collection dediee (a la
`friendRequests`), le document `notifications` lui-meme reste la source de
verite - son EXISTENCE (pas son champ `read`) signale desormais une
invitation "en attente". `match /users/{userId}/{document=**} { allow read,
write: if auth.uid == userId; }` (regle generale deja en place, verifiee
avant tout code) donne DEJA au destinataire un acces complet en
lecture/ecriture/suppression sur sa propre sous-collection `notifications` -
aucune regle a ajouter pour pouvoir la supprimer a l acceptation/au refus.

- `refreshPendingGroupInvites()` : requete `notifications.where('type','==',
  'group_invite')` (filtre simple, aucun index composite necessaire),
  peuple `incomingGroupInvites`. Appelee depuis `openFriendsScreen()`, EXACTEMENT
  comme `refreshFriendsData()` (meme correctif de fiabilite que les demandes
  d amis, meme session) - la liste est donc TOUJOURS a jour a l ouverture de
  l ecran, independamment de toute notification recue/manquee/refusee.
- `acceptGroupInviteFromList(notifId, groupId)` / `declineGroupInviteFromList(notifId)` :
  le premier delegue integralement a `joinGroupById()` (deja existant) puis
  supprime la notification ; le second supprime seulement.
- **`processUnreadNotifications()` (branche `group_invite`) mise a jour** :
  sur acceptation depuis la popup in-app elle-meme, la notification est
  desormais AUSSI supprimee - sans ce correctif, une invitation deja acceptee
  depuis la popup continuait d apparaitre "en attente" dans la nouvelle
  liste centralisee (son EXISTENCE seule faisant foi). Sur "Plus tard", RIEN
  n est supprime - c est exactement ce qui la laisse visible dans la liste
  centralisee pour un traitement ulterieur.
- UI (`renderFriendsScreen()`) : reutilise le composant `renderFriendActionRow()`
  tel quel (meme pattern que les demandes d amis), masquee si
  `incomingGroupInvites` est vide. Chaque ligne affiche EXPLICITEMENT le nom
  du groupe en tete (nouvelle cle `friends.groupInviteRow`,
  `'{{group}} — invite(e) par {{name}}'`) et un bouton `groups.joinBtn`
  ("Rejoindre", cle deja existante, reutilisee pour rester coherent avec le
  reste de l app) + `friends.declineBtn` ("Refuser", deja existante).

### 3. Son de victoire silencieux sur un defi de groupe reussi

**Bug reel signale** : la popup de celebration epique (`targetReached`,
`processUnreadNotifications()`) s affichait en silence, contrairement a la
completion personnelle/Hardcore qui appelle deja `playSuccessSound()` a cote
de son propre `enqueuePopup()`. Un simple appel manquant - ajoute juste avant
l `enqueuePopup()` de cette branche precise, respecte deja le reglage
`soundEffectsEnabled` (Parametres) sans aucun changement necessaire a
`playSuccessSound()` elle-meme.

CACHE_NAME -> v86 (nouvelles cles `friends.groupInvitesLabel`/
`friends.groupInviteRow` dans les 3 fichiers `locale-*.js`, cache-first avec
remplissage cote service worker). Aucun changement de regles Firestore/
Cloud Functions - modification 100% cote client (`index.html` +
`locale-*.js`), aucune touche a `functions/**`.


## Garde-fou anti-spam humoristique (mascotte Kilito, "anti-triche" ludique)

**But explicitement dissuasif/comique, PAS un vrai systeme anti-triche** :
rien n est envoye a un serveur, rien n est stocke, rien ne bloque
definitivement l utilisateur - juste un signal client qui casse un
enchainement de taps compulsifs sur les boutons +5/+10/.../+30 (fiche
d exercice), avec une popup Kilito ironique.

**Detection (`maybeInterceptSpammyTaps(amount)`, appelee tout en tete de
`addSet()`, avant meme `beginAppDataBatch()`)** : fenetre glissante en
memoire (`recentQuickAddTaps`, `[{amount, at}]`, jamais persistee) sur
`SPAM_GUARD_WINDOW_MS` (6000ms). Des que la somme des montants dans la
fenetre atteint `SPAM_GUARD_THRESHOLD_REPS` (90 - calibre sur le scenario
type retenu : 3 taps consecutifs sur le plus gros bouton +30 en moins de 6s),
la fenetre est immediatement reinitialisee (evite de reproposer la popup en
boucle sur le tap suivant) et la popup se declenche. **Uniquement sur les
defis a repetitions** (`c.unit === 'reps'`) : un chrono represente du temps
REELLEMENT ecoule (`stopTimer()`), pas une suite de taps repetes -
impossible/absurde a "spammer" de la meme facon.

**Interception AVANT Firebase** : `addSet()` fait
`if (!(await maybeInterceptSpammyTaps(amount))) return;` en tout premier -
si la popup renvoie "annule", aucune ecriture Firestore n a lieu pour CE tap
precis (les taps precedents, deja legitimement ajoutes avant que le seuil
soit franchi, restent intacts - rien n est retire retroactivement).

**Popup** : `confirmModal()` etendue d un parametre optionnel `kiloState`
(retro-compatible, `null` par defaut) qui, comme `enqueuePopup()`, remplace
l icone emoji par la mascotte Kilo dans l etat demande - ici `'warning'`
(tete suspicieuse, deja existante). Texte dynamise avec le nombre EXACT de
repetitions cumulees dans la fenetre, le nom de l exercice concerne
(`escapeHtml(challengeDisplayName(c))` - **echappement necessaire** : un
defi personnalise a un nom LIBRE tape par l utilisateur, contrairement aux
defis de la bibliotheque toujours traduits, et `confirmModal()` n echappe
jamais son `subtitle` lui-meme) et le nombre de secondes ecoulees. 2 boutons,
volontairement inverses par rapport a la semantique naturelle "confirmer/
annuler" de `confirmModal()` (documente en commentaire pour ne pas piloter a
tort dans le mauvais sens a une prochaine modification) :
- **"Oups, mon doigt a glissé"** (bouton PRINCIPAL, style plein/`confirmLabel`)
  -> annule ce tap precis.
- **"Je suis vraiment une machine"** (bouton secondaire discret/`cancelLabel`)
  -> valide quand meme les points (appli basee sur la confiance).

Retour tactile (`navigator.vibrate([30, 40, 30])`, motif distinct du simple
tap ~8-10ms utilise ailleurs) au declenchement, en plus du blocage visuel
plein ecran deja garanti par l habillage `.app-popup-overlay` existant
(`position:fixed; inset:0`, reutilise tel quel).

**Piege de test rencontre et corrige** : le harnais de test enchaine de tres
nombreux `addSet()` sur le meme exercice, bien plus vite qu un humain
(souvent >90 repetitions cumulees en quelques millisecondes reelles) - sans
garde, `confirmModal()` aurait cree une popup jamais cliquee dans des
DIZAINES de tests existants qui n en ont jamais entendu parler, bloquant
indefiniment sur une `Promise` jamais resolue (toute la suite figee).
Neutralise par defaut pour l ensemble du fichier (`maybeInterceptSpammyTaps
= async () => true;`, juste apres le chargement de `appCode`, reference
d origine conservee dans `__realMaybeInterceptSpammyTaps`), restaure
ponctuellement UNIQUEMENT dans le test dedie a cette fonctionnalite (qui
clique reellement les 2 boutons via `currentConfirmModalEl.querySelector(...)`,
meme pattern que les autres tests bases sur `confirmModal()`).

CACHE_NAME -> v87. Aucun changement de regles Firestore/Cloud Functions -
modification 100% cote client, aucune touche a `functions/**`.


## Kilo, coach temps reel sur la fiche d'exercice (chantier gamification, Phase 1)

Premiere etape d'un chantier plus large (moteur d'humeur global, bulles de
dialogue sur l'accueil, cosmetiques debloquables - voir le plan
`generic-riding-gizmo.md` pour les Phases 2/3, feuille de route non
construite pour l'instant). Cette Phase 1 place Kilo comme "coach temps reel"
sur la fiche d'exercice, a droite du bloc titre/stats.

**Layout** : `.active-name`/`.weight-row`/`.arm-mode-sentence`/`.stats-row`
(inchanges) sont desormais enveloppes dans `.active-header-text`, frere de
`.active-header-kilo` (Kilo + sa bulle) au sein d'un nouveau
`.active-header-row` (`display:flex`). Aucune largeur fixe sur
`.active-header-kilo` : elle s'ajuste au plus large de ses 2 enfants (le SVG
72px ou la bulle, jusqu'a `max-width:160px`) - `.active-header-text`
(`flex:1`) se retracte d'autant, ce qui equilibre naturellement l'espace
sans calcul manuel. **Meme piege deja rencontre et corrige sur
`.kilo-home-slot`** (accueil) : un item flex garde sa taille intrinseque pour
le calcul de la hauteur de ligne meme avec `align-self:center` -
`.kilo-exercise-slot` reprend le meme correctif (hauteur fixe 40px,
`overflow:visible`, marge negative `-16px 0` sur `.kilo-svg`) pour ne jamais
gonfler la ligne du titre.

**Bulle sous Kilo, pas a cote** (decision assumee, documentee dans le plan) :
ce projet n'a **aucun** breakpoint `@media` existant, et sur mobile
`.active-header-text` en `flex:1` ne laisse pas assez de place a gauche de
Kilo pour une bulle sans la cramer - `.kilo-exercise-bubble` s'affiche donc
toujours EN DESSOUS de `.kilo-exercise-slot` (pointe triangulaire vers le
haut, `::before`/`::after`), plutot que d'introduire une bascule
gauche/bas conditionnelle sans aucun precedent dans le reste du code.

**Logique (index.html)** :
- `computeKiloExerciseProgressBucket(total, target, done)` (fonction PURE) :
  4 paliers - `notStarted` (0), `started` (<50%), `almostThere` (>=50%),
  `done` (objectif atteint OU `done` deja vrai, meme si `total < target`
  apres une reduction manuelle de l'objectif).
- `computeKiloExerciseMood(total, target, done)` : `'success'` si palier
  `done`, sinon `'idle'` - **aucun nouvel etat SVG dans cette Phase 1**, les
  etats existants suffisent (le flex/lunettes de `'success'` sert deja de
  "motive/flash").
- `pickKiloExerciseLine(key, params)` : resout une cle i18n vers une replique
  **deja interpolee**, en piochant au hasard si la cle resout vers un
  TABLEAU de variantes (voir `locale-*.js`, namespace `kilo.exercise.*`) -
  `t()` lui-meme n'interpole que si la valeur resolue est directement une
  chaine, l'interpolation `{{}}` est donc refaite ici a la main une fois la
  variante choisie (`interpolate()`, deja existante).
- **Bulle d'ouverture** : `pickChallenge()` calcule et fige
  `exerciseKiloBubbleText` UNE SEULE FOIS a l'ouverture d'un exercice (jamais
  recalcule dans `render()` lui-meme, pour ne jamais faire clignoter/
  re-randomiser la replique sur un re-rendu sans rapport pendant que la
  fiche reste affichee).
- **Flash au tap** : `addSetInner()` pose `exerciseKiloFlashUntil = Date.now()
  + 1600` et une nouvelle punchline (`kilo.exercise.tapPunchline`,
  interpolee avec `{{amount}}`) a CHAQUE serie loguee, independamment de
  `willComplete` (une serie qui n'acheve pas encore l'objectif merite quand
  meme une reaction immediate). `render()` affiche `'success'` tant que
  `Date.now() < exerciseKiloFlashUntil`, sinon retombe sur
  `computeKiloExerciseMood(...)`. Un `setTimeout(() => render(), 1650)` force
  un rendu a l'expiration du flash, meme si l'utilisateur ne retape pas
  entre-temps (sinon Kilo resterait affiche "success" indefiniment jusqu'au
  prochain tap).

**i18n** : nouveau namespace `kilo.exercise.*` (fr/en/es) - chaque cle
resout vers un TABLEAU de variantes (jamais une simple chaine, meme avec
seulement 1-2 variantes pour l'instant) : `opening.{notStarted,started,
almostThere,done}` (interpolees avec `{{current}}`/`{{target}}`) et
`tapPunchline` (interpolee avec `{{amount}}`). Repliques a la 1ere personne,
ton coach/parfois taquin, comme demande.

CACHE_NAME -> v88 (nouvelles cles `locale-*.js`). Aucun changement de regles
Firestore/Cloud Functions - modification 100% cote client, aucune touche a
`functions/**`.


## Kilo, moteur d'humeur global + bulle d'accueil + tap interactif (chantier gamification, Phase 2)

Suite de la Phase 1 (coach sur la fiche d'exercice). Voir le plan
`generic-riding-gizmo.md` pour le contexte complet ; la Phase 3 (cosmetiques)
reste feuille de route, non construite ici.

**2 nouveaux etats SVG** (`KILO_STATE_SVG`, dessines a la main dans le meme
style Bezier que les 6 existants - decision explicite de l'utilisateur,
plutot que de reutiliser des etats existants) :
- `hype` ("Full Muscu/Eclairs") : reprend la pose bras flechis/lunettes de
  `success` en base (biceps encore plus bombes), 3 eclairs qui crepitent en
  boucle autour de Kilo (`.kilo-lightning`, meme principe de decalage
  d'animation que `.kilo-spark`).
- `teasing` ("Taquin/Decu") : bras croises devant le torse, sourcil leve,
  sourire en coin, pied qui tape le sol (`.kilo-foot-tap`). **Volontairement
  distinct de `lost`** (deja utilise pour la perte de serie, triste/grise) :
  `teasing` reste dans les couleurs cyan habituelles de Kilo, juste
  passif-agressif/moqueur - pas triste.

**`computeKiloMood(opts)`** (index.html) remplace entierement l'ancien
`computeKiloHomeState(activeIds, stateChallenges, hour)` (supprime, ses
tests dedies transformes en equivalents `computeKiloMood`) - reste **pure**
(toutes les donnees temporelles/derivees sont des parametres d'un objet
options, jamais lues en interne). **Ordre de priorite documente
explicitement dans le code**, une seule humeur a la fois :
1. `teasing` - inactif depuis >= 2 jours (`daysSinceLastActivity`, via le
   nouveau helper `computeDaysSinceLastActivity(lastCompletedDate, todayKey)`
   qui extrait un calcul deja fait en interne par `evaluateStreakOnLoad()`
   mais jamais expose auparavant). Le signal le plus fort : tout le reste
   passe au second plan.
2. `hype` - une serie "enorme" vient d'etre loguee (`justLoggedHugeSet`, au
   moins la moitie de l'objectif du jour en UNE fois, voir `addSetInner()`
   qui pose `kiloHomeHugeSetUntil` pour une fenetre de **5 minutes** -
   volontairement bien plus longue que le flash de 1.6s de la fiche
   d'exercice en Phase 1, pour que l'effet reste visible en revenant sur
   l'accueil) OU la serie franchit un palier de 7 jours
   (`streakCount % 7 === 0`).
3. `warning` - tard (**>= 18h**, valeur du cahier des charges, distincte du
   seuil 19h de l'ancienne fonction) ET loin du but, cote **personnel**
   (moins de la moitie des defis actifs du jour sont valides - **changement
   de comportement assume** : l'ancienne fonction stressait des qu'un SEUL
   defi actif n'etait pas fait, meme avec plusieurs autres deja valides ;
   desormais un ratio, pour ne pas stresser inutilement quelqu'un qui a deja
   fait l'essentiel) OU cote **groupe** (un defi de groupe actif a moins de
   24h de son echeance et moins de 70% de la cible collective atteinte -
   nouvelle donnee, voir plus bas).
4. Repli : `idle` (comportement par defaut conserve - ne renvoie jamais
   `success`, comme l'ancienne fonction).

**Lacune de donnees comblee** : `refreshMyGroupsAndActiveChallenges()`
enrichit desormais chaque entree de `myActiveGroupChallenges` avec `endDate`
(deja present sur le MEME doc deja lu, aucun cout supplementaire) et
`currentTotal` (nouvelle lecture des participants par defi actif, meme
formule `computeGroupTotalProgress()` que `loadActiveExerciseGroupChallenges()`
- jamais de calcul duplique). Cout equivalent a une lecture deja faite pour
la fiche d'exercice, juste generalise a TOUS les defis actifs au demarrage.

**Bulle d'accueil** : `kiloHomeBubbleText`/`kiloHomeBubbleMood` - meme
principe que la Phase 1 (texte DEJA RESOLU, jamais recalcule a chaque
`render()` qui recalcule l'humeur elle-meme en continu) mais recalculee
**quand l'humeur change** plutot qu'a l'ouverture d'un ecran (il n'y a pas
d'evenement "ouverture" equivalent a `pickChallenge()` sur l'accueil,
affiche en continu). Dictionnaire `kilo.home.*` (nouveau namespace,
fr/en/es) indexe par humeur (`idle`/`warning`/`hype`/`teasing`), chacune un
TABLEAU de variantes.

**Tap interactif ("effet Tamagotchi")** : `kiloHomeTap()` (nouvelle
fonction, PAS une simple extension de `kiloTap()` - voir plus bas pourquoi)
declenche a la fois le rebond visuel ET une phrase d'encouragement aleatoire
(`kilo.home.tapEncouragement`, pool separe des repliques d'humeur). **Piege
rencontre et evite en amont** : `kiloTap()` (Phase 1 et anterieure)
manipule le DOM DIRECTEMENT (`classList.add('kilo-tapped')`) - fonctionne
pour un SVG isole dans une popup (jamais re-rendu entre-temps), mais
l'accueil re-rend TOUT `#app` a chaque `render()` (necessaire ici pour
afficher la nouvelle phrase d'encouragement) : un `classList.add()`
imperatif serait immediatement efface par ce meme `render()` avant meme
d'avoir eu le temps de s'afficher a l'ecran. `kiloHomeTap()` pilote donc le
rebond via un horodatage consulte PAR `render()` lui-meme
(`kiloHomeTapBounceUntil`, classe CSS `.tapped` sur `.kilo-home-slot`,
memes keyframes `kilo-tap-bounce` que `.kilo-tapped`) - exactement le meme
principe que `exerciseKiloFlashUntil` en Phase 1.

**Bulle sans pointe triangulaire precise** (a la difference de la fiche
d'exercice) : `.header` (accueil) est `justify-content:space-between` avec
3 enfants (date/Kilo/pastille de serie) - la position horizontale exacte de
Kilo n'est pas assez fiable a cibler avec un triangle CSS pointant
precisement vers lui. `.kilo-home-bubble` est donc une carte pleine largeur
centree sous le bandeau, sans pointe - meme habillage visuel
(`background`/`border`/`border-radius`) que `.kilo-exercise-bubble` pour
rester coherent, mais sans son `::before`/`::after`.

**Fonction partagee renommee** : `pickKiloExerciseLine()` (Phase 1) devient
`pickKiloLine()` - son implementation etait deja 100% generique (resolution
i18n + pioche aleatoire + interpolation), seul le nom laissait a tort penser
qu'elle etait specifique a la fiche d'exercice. Utilisee maintenant par les
2 ecrans (`kilo.exercise.*` ET `kilo.home.*`).

CACHE_NAME -> v89 (nouveau namespace `kilo.home.*` dans les 3 fichiers
`locale-*.js`). Aucun changement de regles Firestore/Cloud Functions -
modification 100% cote client, aucune touche a `functions/**`.


## Cosmetiques de Kilo : 3 accessoires debloquables (chantier gamification, Phase 3)

Derniere phase du chantier Kilo (voir `generic-riding-gizmo.md`). Livre les 3
accessoires concrets demandes (pas seulement l'architecture vide).

**`renderKilo(state, {size, clickable, accessories: [...]})`** etendu :
`accessories` est un tableau d'ids (`KILO_ACCESSORY_SVG`), chacun rendu dans
son propre `<g class="kilo-accessory kilo-accessory-{id}">`, **frere** de
`.kilo-body` (jamais dedans) - suit donc naturellement l'animation
d'ENSEMBLE posee sur la racine `<svg>` (rebond idle, tremblement hype,
balancement teasing...), sans jamais etre perturbe par les animations
internes propres a un membre precis (bras qui trinque, eclairs...) qui
restent scopees a leurs sous-groupes DANS `.kilo-body`. **Ordre de peinture
selon `behindBody`** : la cape (`behindBody:true`) est peinte AVANT
`.kilo-body` (donc visuellement DERRIERE Kilo) ; la medaille/ceinture
(`behindBody:false`) sont peintes APRES (DEVANT). Coordonnees **fixes**,
calees sur la position du torse des etats les plus courants -
**limite assumee et documentee dans le code** : un leger decalage de
quelques px est possible sur les etats au torse deplace (warning, level_up),
non verifiable par le harnais de test (mock DOM), a confirmer visuellement.

**3 accessoires, dessines en formes SVG simples (pas de gradient, contrairement
aux etats qui utilisent `{{GRAD}}`)** :
- **Medaille** (ruban rouge+bleu, cercle or) - debloquee a `streak_7`.
- **Ceinture de champion** (bande marron + plaque or) - debloquee a `hardcore_50`.
- **Cape** (grande forme rouge/or derriere le dos) - debloquee sur un trophee
  majeur (`streak_100` OU `comp_250` OU `pushups_10000`, le premier atteint).

**`ACCESSORY_DEFS`/`checkNewAccessories()`** : meme pattern que
`BADGE_DEFS`/`checkNewBadges()` (idempotent, ne retourne que les
NOUVEAUX debloques par cet appel) - branche **directement sur
`badges.unlocked`**, jamais de seuil duplique (source de verite unique).
`unlockedAccessories` (nouveau champ du document consolide `appData`, simple
tableau d'ids comme `badges.unlocked` - pas de fonction `loadX()` dediee,
c'est un champ NOUVEAU sans ancienne cle separee a migrer) persiste via
`saveUnlockedAccessories()`.

**Cablage** : `checkNewAccessories()` + `enqueueAccessoryPopups()` (nouvelle
fonction, meme pattern que `enqueueTrophyPopups()`) appeles aux 3 MEMES
points que `checkNewBadges()` dans `addSetInner()` (badges cumulatifs tot,
completion normale, completion Hardcore) - un accessoire peut donc se
debloquer independamment de la completion du defi du jour, exactement comme
les trophees "cumul a vie" (voir la section dediee plus haut dans ce
fichier). La popup d'annonce fait deja **porter l'accessoire a Kilo**
(`kiloAccessories` sur l'objet popup, transmis a `renderKilo()` via
`buildPopupInnerHtml()`) plutot que de se contenter d'un texte.

**Equipement v1 volontairement simple** (`computeEquippedAccessory(unlocked)`,
fonction pure) : Kilo porte toujours l'accessoire debloque le **plus
prestigieux** (ordre fixe medaille < ceinture < cape, `ACCESSORY_PRESTIGE_ORDER`),
jamais plusieurs a la fois - pas de garde-robe/ecran de selection dans cette
version (idee de suite notee dans le plan). **Portee volontairement limitee
a l'accueil** pour cette 1ere version : c'est le seul `renderKilo()` qui
reçoit `accessories` pour l'equipement "normal" (par opposition a
`kiloAccessories` sur une popup d'annonce, un usage different) - le
mecanisme est generique et peut etre reutilise sur d'autres ecrans (fiche
d'exercice...) plus tard sans changement, simplement pas fait ici pour
garder cette phase ciblee.

CACHE_NAME -> v90 (nouveau namespace `kilo.accessories.*` dans les 3
fichiers `locale-*.js`). Aucun changement de regles Firestore/Cloud
Functions - modification 100% cote client, aucune touche a `functions/**`.

---

**Les 3 phases du chantier "Kilo, mascotte-partenaire emotionnel" sont
desormais livrees** (coach sur la fiche d'exercice, moteur d'humeur global +
bulle d'accueil + tap interactif, cosmetiques debloquables). Voir
`generic-riding-gizmo.md` pour le detail complet et les idees bonus notees
hors scope (reglage "faire taire Kilo", micro-fidgets d'inactivite, ecran
"garde-robe", repliques differenciees par type d'exploit).

## Idees bonus Kilo, lot 1/7 (#1 reglage "Faire taire Kilo" + #2 micro-fidget d'inactivite)

Premier lot d'une serie de 12 idees bonus explicitement approuvees par
l'utilisateur (numerotees dans une conversation dediee, hors de ce fichier)
en plus des 3 phases deja livrees ci-dessus.

**#1 - `kiloMuted`/`toggleKiloMuted()`** : meme structure exacte que
`soundEffectsEnabled`/`toggleSoundEffects()` (nouveau champ simple du
document consolide `appData`, pas de cle legacy a migrer). Coupe
UNIQUEMENT les 2 bulles de dialogue (`kilo-home-bubble`/
`kilo-exercise-bubble`) - Kilo reste entierement VISIBLE (SVG, animations,
humeur, accessoires) et ses popups fonctionnelles (trophee, level up,
completion...) continuent de s'afficher normalement. Un seul garde-fou par
site de rendu de bulle (`!kiloMuted && ...Text ? ...`), plutot que de gater
chaque point d'ecriture de bulle un par un (2 sites : accueil + fiche
d'exercice).

**#2 - micro-fidget d'inactivite (`kiloHomeFidgetUntil`/
`maybeTriggerKiloIdleFidget()`)** : "effet vivant"/Tamagotchi meme sans
interaction. Meme principe horodatage->classe CSS deja etabli pour le
rebond au tap (`kiloHomeTapBounceUntil`) - jamais de manipulation DOM
directe, puisque `render()` remplace tout `#app` a chaque appel. Un
**unique** `setInterval` global (15s, enregistre une seule fois au
chargement du script - jamais demarre/arrete par ecran, contrairement a
`timerIntervalId`) avec 1 chance sur 3 de declencher un fidget a chaque
tick (moyenne ~45s, dans la fourchette 30-60s demandee, sans cadence
parfaitement reguliere - une vraie regularite romprait l'effet "vivant").
Gate explicite : accueil idle uniquement (`activeTab==='today'`,
`!currentChallengeId`), jamais si une popup est deja affichee (`popupOpen`
- ne doit jamais distraire en pleine lecture), jamais si
`prefers-reduced-motion` (purement decoratif, CSS neutraliserait de toute
facon l'animation, autant ne pas forcer un `render()` pour rien). Animation
CSS volontairement generique (`kilo-fidget-wiggle`, simple rotation/scale
sur `.kilo-svg`) plutot que specifique a un etat - fonctionne a l'identique
quelle que soit l'humeur affichee, sans dupliquer un trace par etat.
**Fonctionne meme si `kiloMuted`** : coupe seulement les bulles, pas les
animations - Kilo reste vivant visuellement.

**Piege de test rencontre et corrige** : le setInterval est enregistre via
un wrapper (`() => maybeTriggerKiloIdleFidget()`), jamais une reference
directe a la fonction - une reference directe aurait capture la version
d'origine pour toujours des le chargement du script, avant meme que le
harnais de test ait pu la neutraliser (meme convention deja etablie pour
`maybeInterceptSpammyTaps`, necessaire ici aussi : un run de suite qui
depasserait 15s declencherait sinon des `render()` aleatoires en plein
milieu de tests sans rapport, etat DOM/popup imprevisible).

CACHE_NAME -> v91 (`styles.css` modifie - nouvelle animation
`kilo-fidget-wiggle`, nouvelles regles `locale-*.js` `settings.kiloMuted.*`).
Aucun changement de regles Firestore/Cloud Functions - modification 100%
cote client, aucune touche a `functions/**`.

## Idees bonus Kilo, lot 2/7 (#4 punchlines par type d'exploit + #6 punchlines nommant le jour de la semaine)

**#4 - `SQUAT_FAMILY_IDS`/`computeKiloExerciseFamily(id)`** : troisieme
famille d'exercices (`[14, 15, 1010, 1016]` - Squats, Fentes, Squat goblet,
Fentes bulgares), a cote des 2 familles deja existantes pour les trophees
cumulatifs (`PUSHUP_FAMILY_IDS`/`CORE_TIME_FAMILY_IDS`) - source de verite
unique reutilisee, aucun seuil duplique. Volontairement scopee aux VRAIS
mouvements de squat (exclut Chaise/id16 - isometrique, plus proche du
gainage -, Mollets/id17 et Pont fessier/id1019 - patrons de mouvement
differents). `computeKiloExerciseFamily(id)` (fonction PURE) renvoie
`'pushups'`/`'core'`/`'squats'`/`null`. A CHAQUE tap (`addSetInner()`), si
l'exercice appartient a une famille connue, la punchline vient desormais
d'un pool DEDIE (`kilo.exercise.tapPunchlineFamily.<famille>`) plutot que
du pool generique existant (`kilo.exercise.tapPunchline`, conserve tel
quel comme repli pour tout exercice hors de ces 3 familles).

**#6 - `kilo.exercise.dayPunchline`** : a l'ouverture d'un exercice
(`pickChallenge()`), remplace OCCASIONNELLEMENT (40% de chance, pas a
chaque fois - eviterait la lassitude) la replique de palier habituelle par
une phrase qui nomme EXPLICITEMENT le jour de la semaine ET l'exercice en
cours (ex. fourni par l'utilisateur : "C'est dimanche mais pas de repos
pour les abdos"). **Decision de conception cle** : un seul pool de
variantes parametrees par `{{day}}`/`{{exercise}}`, plutot qu'un pool par
jour x famille x palier (explosion combinatoire x7 jours x3 familles x4
paliers x3 langues) - fonctionne pour N'IMPORTE QUEL exercice/jour sans
rien dupliquer. `{{exercise}}` vient de `challengeDisplayName(c)` (deja
traduit). **Casse du jour adaptee par langue** : `t('dates.daysFull')` est
capitalise (reutilise ailleurs pour des libelles de date autonomes, ex.
`formatDateLabel()`) - le FR/ES ecrivent conventionnellement les jours en
minuscule en milieu de phrase (comme l'exemple fourni), contrairement a
l'EN qui capitalise toujours ses noms de jours ; `currentLocale === 'en'`
bascule entre les deux, jamais un `.toLowerCase()` inconditionnel.

**Piege de test evite** : la probabilite de 40% de l'idee #6 aurait rendu
le test existant de la bulle d'ouverture (base sur les paliers de
progression) non deterministe - `Math.random()` est temporairement forcee
au-dessus du seuil (`0.9`) pendant ce test precis, restauree juste apres,
meme pattern que les autres tests bases sur une pioche aleatoire dans ce
fichier.

CACHE_NAME -> v92 (contenu des `locale-*.js` modifie - nouvelles cles
`kilo.exercise.tapPunchlineFamily.*`/`kilo.exercise.dayPunchline`). Aucun
changement de regles Firestore/Cloud Functions - modification 100% cote
client, aucune touche a `functions/**`.

## Idees bonus Kilo, lot 3/7 (#7 comparaisons delirantes du cumul a vie + #8 easter egg au tap repete)

**#7 - `kilo.exercise.statComparison`** : partage desormais un SEUL tirage
aleatoire avec l'idee #6 (`kiloOpeningRoll`, `pickChallenge()`) plutot que
2 tirages independants - probabilites simples et additives : **15%**
comparaison delirante du cumul a vie, **25%** jour de la semaine (idee #6,
bande suivante), **60%** replique de palier standard (par defaut). Ne se
declenche QUE si un cumul existe deja (`stats[c.id]?.lifetimeTotal > 0`) -
rien d'absurde a comparer sur un exercice jamais fait. `{{lifetime}}` est
deja formate avec separateurs de milliers (`toLocaleString(LOCALE_TO_INTL[...])`,
meme convention que l'affichage existant `exercise.lifetimeTotal` - AUCUNE
unite dans le texte, meme partie pris que l'existant).

**#8 - `recentKiloHomeTaps`/`KILO_EASTER_EGG_WINDOW_MS`/`KILO_EASTER_EGG_TAP_THRESHOLD`** :
easter egg au tap repete sur Kilo (accueil) - **meme fenetre glissante en
memoire** que le garde-fou anti-spam (`maybeInterceptSpammyTaps()`,
`recentQuickAddTaps`/`SPAM_GUARD_WINDOW_MS`), jamais persistee. 5 taps en
moins de 3s declenchent une reaction dediee (`kilo.home.tapEasterEgg`,
vibration a motif distinct `[30,40,30,40,30]`) a la place de l'encouragement
habituel (`kilo.home.tapEncouragement`) - la fenetre se **reinitialise
immediatement** des le seuil atteint, pour ne pas redeclencher a CHAQUE tap
suivant (meme piege deja evite pour le garde-fou anti-spam).

CACHE_NAME -> v93 (contenu des `locale-*.js` modifie - nouvelles cles
`kilo.exercise.statComparison`/`kilo.home.tapEasterEgg`). Aucun changement
de regles Firestore/Cloud Functions - modification 100% cote client,
aucune touche a `functions/**`.

## Idees bonus Kilo, lot 4/7 (#9 reaction sur un gros coup d'ami + #10 reaction aux kudos recus)

**Mecanisme partage : `kiloPendingSocialReaction`** (`{key, params} | null`) -
emplacement UNIQUE pour une reaction sociale ponctuelle, consomme (et remis a
`null`) par le PROCHAIN `render()` de l'accueil. Dans `render()`, juste apres
le calcul de l'humeur "normale" (`kiloHomeMood`/`kiloHomeBubbleMood`),
2 nouvelles variables locales `kiloHomeMoodDisplay`/`kiloHomeBubbleTextDisplay`
(defaut = les valeurs normales) sont ecrasees SI une reaction est en attente
(texte de la reaction + humeur forcee `'hype'`) - **jamais** `kiloHomeMood`/
`kiloHomeBubbleMood` eux-memes, qui restent le cache de l'humeur "reelle" :
sans cette separation, le prochain VRAI changement d'humeur ne serait plus
detecte correctement par le garde `kiloHomeMood !== kiloHomeBubbleMood`. Ce
sont ces 2 variables `*Display` (pas les valeurs normales) qui alimentent
desormais `renderKilo(...)` et la bulle - meme principe que
`justCompletedDailyObjective` (consomme une fois, jamais rejoue).

**#10 - kudos recu** : `processUnreadNotifications()`, branche `'kudo'` -
en plus du popup deja existant (inchange), pose desormais aussi
`kiloPendingSocialReaction = { key: 'kilo.home.kudoReceived', params: { name:
data.fromName } }`. Aucune nouvelle donnee necessaire (`data.fromName` deja
present a l'ecriture de la notification).

**#9 - gros coup d'un ami** : `computeFriendBigMoveReaction(seenIds, entries,
myUid)` (fonction PURE, extraite du callback `onSnapshot` de
`startActivityFeedListener()` pour rester testable independamment du
mecanisme temps reel lui-meme) - renvoie le descripteur de reaction de la
1ere entree NOUVELLE (absente de `seenIds`, jamais `myUid`) trouvee, ou
`null`. **`seenIds` (nouveau `communityActivityFeedSeenIds`, un `Set`
d'ids) doit valoir `null` pour ne JAMAIS reagir** - c'est le garde-fou
"1er snapshot" : reinitialise a chaque (re)abonnement
(`startActivityFeedListener()`, nouvel ami ajoute/retire), sans lui la
toute premiere lecture (activite d'amis potentiellement vieille de
plusieurs jours) declencherait a tort une reaction sur du contenu deja
ancien des la 1ere ouverture de l'onglet Communaute. Nomme l'exercice via
le meme repli deja etabli pour le rendu du fil (`exerciseSlug` traduit si
present, sinon `challengeName` litteral).

**Limite deja documentee, acceptee** (voir Phase 2/section "Fil d'activite
global") : le listener `activityFeed` est suspendu hors de l'onglet
Communaute (optimisation quota deja en place) - la reaction #9 ne peut donc
se declencher que si l'utilisateur se trouve deja sur cet onglet au moment
ou l'ami termine son defi, pas un scope etendu pour ce chantier.

**Piege de test rencontre et corrige en cours de route** : le mock
Firestore generique de ce depot a un `onSnapshot()` de REQUETE (pas de
document individuel) qui ne fait qu'un seul `.get().then(cb)` - il ne se
redeclenche JAMAIS sur une ecriture posterieure a l'abonnement
(contrairement au mock `onSnapshot()` d'un document individuel, deja
temps-reel). Extraire la logique de detection dans
`computeFriendBigMoveReaction()` (fonction pure, appelable directement avec
des `Set`/tableaux fabriques a la main) a permis de la tester sans
dependre de cette limite du mock - **a retenir pour tout futur test
touchant un `onSnapshot()` de requete (`where`/`orderBy`/`limit`) : ne pas
supposer qu'une 2e ecriture re-declenche le callback, extraire la logique
metier en fonction pure si elle a besoin d'etre testee independamment.**

CACHE_NAME -> v94 (contenu des `locale-*.js` modifie - nouvelles cles
`kilo.home.kudoReceived`/`kilo.home.friendBigMove`). Aucun changement de
regles Firestore/Cloud Functions - modification 100% cote client, aucune
touche a `functions/**`.

## Idees bonus Kilo, lot 5/7 (#13 accessoires saisonniers + #18 rappel d'anniversaire de compte)

**#13 - `computeSeasonalAccessory(date, accountCreatedAt)`** : 3 nouveaux
accessoires (`santa_hat`/`summer_sunglasses`/`birthday_hat`, ajoutes a
`KILO_ACCESSORY_SVG` - formes simples/couleurs en dur, meme style que
medal/belt/cape) **deliberement HORS de `ACCESSORY_DEFS`/`unlockedAccessories`** :
pas un deblocage permanent a ceremonie (popup) une seule fois dans la vie du
compte, juste un signe des temps porte automatiquement pendant la periode
concernee - recalcule a CHAQUE affichage, jamais persiste. Fonction PURE
(dates en parametres, jamais `new Date()` en interne). Priorite documentee (un
seul accessoire saisonnier a la fois) : anniversaire de compte (evenement
personnel, le plus rare) > Noel (20-31 decembre) > ete (juin-aout). **Purement
additif a l'accessoire PERMANENT deja equipe** (`[kiloHomeEquipped,
kiloHomeSeasonal].filter(Boolean)`, `render()`) - jamais un remplacement : les
2 occupent des zones visuelles differentes (tete pour les 3 nouveaux vs
torse/dos pour medal/belt/cape), peuvent donc se superposer sans collision.

**#18 - `computeAccountAnniversaryYears(date, accountCreatedAt)`** +
`maybeQueueAccountAnniversaryReaction()` : reutilise TEL QUEL le mecanisme
`kiloPendingSocialReaction` deja etabli pour les idees #9/#10 (voir lot 4/7) -
si aujourd'hui est le jour anniversaire du compte (meme mois/jour qu'
`currentUser.metadata.creationTime`, JAMAIS le jour de creation lui-meme -
annee differente exigee), met en file `{key:'kilo.home.accountAnniversary',
params:{yearsLabel}}`. **Implementation 100% client-side** (pas de 2e Cloud
Function) : `currentUser.metadata.creationTime` (champ standard Firebase
Auth) est deja disponible sans aucune lecture Firestore supplementaire -
evite d'etendre `functions/**` pour un simple rappel. Appelee UNE FOIS par
demarrage (`continueStartApp()`, juste avant le `render()` final) - **aucune
garde "deja affiche aujourd'hui" persistee** (simplification volontaire
assumee) : un simple message dans une bulle d'accueil, pas un popup
bloquant, sans consequence reelle si l'utilisateur rouvre l'appli plusieurs
fois le jour J.

**`{{yearsLabel}}` deja pluralise AVANT interpolation** (`tn('kilo.home.accountAnniversaryYears',
years, {n: years})`, ex. "1 an"/"3 ans") : `pickKiloLine()` n'interpole que
des chaines DEJA resolues (`t()`, jamais `tn()`) - aucun support natif de
pluralisation `{one,other}` a l'interieur d'une variante de punchline
existant deja, donc la pluralisation est faite en amont, une seule fois,
plutot que d'etendre `pickKiloLine()` pour ce seul besoin.

**`currentUser?.metadata?.creationTime`** (optional chaining) - les objets
utilisateur factices du harnais de test (`{uid, displayName, email,
photoURL}`, partout dans `tests/app.test.js`) n'ont jamais de champ
`metadata` : deja verifie implicitement par l'ensemble de la suite existante
(des dizaines de rendus de l'accueil sans jamais planter), et explicitement
par un test dedie de `maybeQueueAccountAnniversaryReaction()`.

**Piege de test evite (deja documente ailleurs pour `computeKiloMood()`/
`today.getHours()`)** : `today` (la date reelle du jour, lue dans `render()`)
n'est pas mockable depuis le harnais de test - les tests de
`computeSeasonalAccessory()`/`computeAccountAnniversaryYears()` restent donc
scopes aux fonctions PURES elles-memes (dates fixes en parametres,
deterministe), jamais a travers un vrai `render()` de l'accueil. Le test de
`maybeQueueAccountAnniversaryReaction()`, lui, CONSTRUIT sa date de creation
de compte **en relatif a `new Date()` au moment du test** (ex. "il y a
exactement 3 ans, jour pour jour") plutot qu'une date calendaire fixe -
reste deterministe quel que soit le jour reel d'execution du test, sans
avoir besoin de mocker `Date`.

CACHE_NAME -> v95 (contenu des `locale-*.js` modifie - nouvelles cles
`kilo.home.accountAnniversary`/`kilo.home.accountAnniversaryYears`). Aucun
changement de regles Firestore/Cloud Functions - modification 100% cote
client, aucune touche a `functions/**`.

## Idees bonus Kilo, lot 6/7 (#16 petite intro au premier lancement du jour)

**`lastKiloIntroDate`** (nouveau champ simple du document consolide
`appData`, meme structure de branchement exacte que `kiloMuted` au lot 1/7 -
`let` au niveau module, branche `loadAppData()` "doc existe", payload de la
migration-write) : cle du jour (`todayKey`, format "AAAA-MM-JJ") du dernier
affichage de l'intro - **PERSISTEE, pas juste en memoire**, pour ne se
declencher qu'UNE SEULE FOIS par jour CALENDAIRE meme si l'appli est
fermee/rouverte plusieurs fois le meme jour (meme principe deja etabli que
`lastShieldResetWeek`, compare a une cle de periode courante a chaque
verification).

**`maybeShowKiloDailyIntro()`** (appelee dans `continueStartApp()`, juste
avant `maybeQueueAccountAnniversaryReaction()` - voir lot 5/7) : au tout
premier appel du jour, pose `kiloHomeIntroUntil` (horodatage, meme principe
deja etabli que `kiloHomeTapBounceUntil`/`kiloHomeFidgetUntil` - classe CSS
`.intro` pilotee par `render()`, jamais de manipulation DOM directe) ET
reutilise TEL QUEL `kiloPendingSocialReaction` (mecanisme deja etabli aux
idees #9/#10/#18) pour une replique de bienvenue dediee
(`kilo.home.dailyGreeting`). `.kilo-home-slot.intro .kilo-svg` :
`kilo-intro-pop` (0.7s, `scale(0)->1.08->1` avec `cubic-bezier` de rebond) -
Kilo "apparait" plutot que d'etre statique des le premier rendu.

**Priorite documentee avec #18 (meme emplacement unique)** : appelee AVANT
`maybeQueueAccountAnniversaryReaction()` dans `continueStartApp()` - si les 2
se declenchent le meme jour (rare mais possible : anniversaire de compte ET
1er lancement du jour), l'anniversaire (plus rare/personnel) doit gagner en
etant pose EN DERNIER, jamais l'inverse. Un seul `kiloPendingSocialReaction`
visible a la fois de toute facon, aucune perte reelle pour celui qui "perd".

CACHE_NAME -> v96 (`styles.css` modifie - nouvelle animation
`kilo-intro-pop`, nouvelle cle `locale-*.js` `kilo.home.dailyGreeting`).
Aucun changement de regles Firestore/Cloud Functions - modification 100%
cote client, aucune touche a `functions/**`.

## Idees bonus Kilo, lot 7/7 (#17 rappel du soir si rien fait) - dernier lot, chantier complet

**Seule idee bonus des 12 approuvees a toucher `functions/**`** - explicitement
exclue des Phases push initiales ("Phase A", voir plus haut dans ce fichier :
"rappel quotidien 'defi pas encore fait' - a rediscuter separement si voulu")
puis redemandee explicitement dans ce chantier de suite.

**`exports.sendDailyReminderPush`** (nouvelle Scheduled Function,
`functions/index.js`, `onSchedule('0 19 * * *')` - 1x/jour, 19h UTC) reutilise
integralement l'infrastructure push DEJA en place (voir "Notifications push OS
- Phase A" plus haut) : ecrire un simple document
`users/{uid}/notifications/{id}` suffit, `sendPushOnNotificationCreate`
(trigger deja existant) se charge automatiquement de l'envoi - **aucun
nouveau code d'envoi**, uniquement la logique "qui notifier et quoi ecrire".

**Bornee a la population pertinente** (meme raisonnement deja applique a
`aggregateLeaderboard`/`closeExpiredGroupChallenges`) : seeded via
`collectionGroup('pushTokens')` (uids ayant deja active le push), jamais un
balayage de tous les comptes. Pour chaque uid candidat, une lecture de
`users/{uid}/kv/appData` verifie `dailyActivity[todayKey]` - **fonction PURE
extraite pour la partie decision**, `computeUidsNeedingDailyReminder(uids,
appDataByUid, todayKey)` (`functions/index.js`, testee sans Firestore dans
`functions/test/dailyReminder.test.js`) : un uid SANS document `appData` du
tout (compte tout juste cree) est traite comme "rien fait" -> candidat au
rappel, pas un cas d'erreur.

**Simplification assumee et documentee** (meme famille que la tolerance deja
acceptee sur `mondayOfWeekUTC()`/`aggregateLeaderboard`) : une seule heure UTC
fixe, pas adaptee au fuseau horaire de chaque utilisateur (aucune donnee de
fuseau horaire par utilisateur n'est suivie aujourd'hui) - `todayKey` (UTC,
reutilise `dateKeyUTC()` deja existante) peut differer de la cle LOCALE
ecrite cote client dans `dailyActivity` de quelques dizaines de minutes a 1-2h
maximum pour la base d'utilisateurs actuelle (France/Espagne, UTC+1/+2) -
marge negligeable, acceptable pour un simple rappel non critique.

**Nouveau type de notification `daily_reminder`** ajoute a `PUSH_MESSAGES`
(fr/en/es, `functions/index.js`) ET a `KNOWN_NOTIFICATION_TYPES`
(`functions/test/notifications.test.js`, regression deja en place depuis le
bug reel "kudo oublie" - voir plus haut) - **sans `d.fromName`** (notification
"systeme", aucun expediteur humain, message generique). Cote client,
`processUnreadNotifications()` gagne une branche `'daily_reminder'`
(`kiloState:'warning'`) - rattrapage in-app UNIQUEMENT si l'appli se trouve
deja ouverte au moment ou la notification arrive (le vrai canal vise reste le
push OS, recu meme appli fermee).

CACHE_NAME -> v97 (nouvelles cles `locale-*.js`
`popups.notifications.dailyReminder*`). **Changement touchant `functions/**`
(1 nouvelle Scheduled Function + PUSH_MESSAGES) - deploiement
`deploy-functions.yml` a confirmer explicitement avec l'utilisateur avant tout
push**, conformement a la politique d'autonomie du projet (voir memoire
dediee) qui exclut ce dossier de la zone de confiance automatique.

---

**Chantier "12 idees bonus Kilo" complet (7/7 lots livres)** : reglage
"Faire taire Kilo" (#1), micro-fidget d'inactivite (#2), punchlines
differenciees par type d'exploit (#4), punchlines nommant le jour de la
semaine (#6), comparaisons delirantes du cumul a vie (#7), easter egg au tap
repete (#8), reaction sur un gros coup d'ami (#9), reaction aux kudos recus
(#10), accessoires saisonniers (#13), petite intro au premier lancement du
jour (#16), rappel du soir si rien fait (#17), rappel d'anniversaire de
compte (#18). Voir chaque lot ci-dessus pour le detail technique complet.

## Passe UX "optimisations visuelles, textuelles et logiques" - contenu Kilo + corrections CSS/animations

**Demande explicite de l'utilisateur**, 3 volets appliques directement (pas de
plan intermediaire, corrections directes et robustes).

**1. Contenu/dialogues de Kilo** :
- **Stock de punchlines multiplie** (2-4x selon les pools) sur les 3 langues,
  tous les pools `kilo.exercise.*`/`kilo.home.*` deja etablis
  (`opening.{notStarted,started,almostThere,done}`, `tapPunchline`,
  `tapPunchlineFamily.{pushups,core,squats}`, `dayPunchline`,
  `statComparison`, `home.{idle,warning,hype,teasing,tapEncouragement,
  tapEasterEgg,kudoReceived,friendBigMove,accountAnniversary,dailyGreeting}`)
  - tons volontairement varies (taquin/drole/amical/coach "no pain no gain")
  au lieu d'un seul registre repete. Aucun changement de mecanisme (toujours
  `pickKiloLine()`, tableaux de variantes) - uniquement plus de contenu.
- **Nouveau pool `kilo.exercise.hardcoreInvite`** (fr/en/es, 10 variantes,
  tons direct/motivant/humoristique) : `addSetInner()` bascule desormais sur
  ce pool AU LIEU de `tapPunchline`/`tapPunchlineFamily` au moment PRECIS ou
  `willComplete` est vrai (l'objectif normal du jour vient d'etre atteint par
  CE tap precis, deja calcule plus haut dans la fonction) - felicite ET
  invite explicitement au Mode Hardcore. Un tap SUIVANT (une fois
  `entry.done` deja vrai) retombe naturellement sur le pool normal, puisque
  `willComplete` redevient faux des que `entry.done` est deja vrai - aucune
  garde supplementaire necessaire, le comportement existant de `willComplete`
  suffit deja.

**2. Interface graphique (UI)** :
- **Bulle d'accueil restylee** : nouveau conteneur `.kilo-home-wrap` (flex
  colonne, `align-self:center`, deplace depuis `.kilo-home-slot`) enveloppe
  desormais Kilo ET sa bulle ensemble - avant ce correctif, la bulle etait un
  FRERE du `.header` en pleine largeur, sans lien visuel avec Kilo (au milieu
  d'une ligne a 3 elements en `justify-content:space-between`, sa position
  horizontale exacte n'etait pas assez fiable pour y ancrer un triangle).
  `.kilo-home-bubble` reprend desormais EXACTEMENT le meme habillage que
  `.kilo-exercise-bubble` (petite carte ~220px, pointe triangulaire
  `::before`/`::after` pointant vers Kilo) - **plus une "carte pleine
  largeur"**. **`min-height: 58px` FIXE** (pas juste un padding) : le texte
  varie en longueur (1-3 lignes selon la replique piochee) SANS jamais faire
  varier la hauteur reelle de la bulle - c'est ce qui regle "l'effet cascade"
  au clic sur Kilo (les cartes de defis en dessous ne bougent plus jamais,
  contrairement a l'ancien format pleine largeur dont la hauteur suivait
  fidelement la longueur du texte).
- **Ligne de demarcation retiree, scopee a l'accueil uniquement** : nouvelle
  classe `.header.today-header { border-bottom: none; }` - `.header` seule
  (partagee par Communaute/Groupes/Profil) reste inchangee, aucune regression
  sur ces 3 autres ecrans.
- **GIF de demonstration reduit d'environ 10%** : `.exercise-hero-apng
  max-height` `220px -> 198px`.
- **Marges nulles pour les defis chronometres** : nouvelle classe
  `.active-card.timed-hero` (posee cote client si `c.unit === 'sec'`) -
  `padding-top:0` sur la carte + `margin-bottom:0` sur le GIF lui-meme. Les
  defis en repetitions gardent leurs marges actuelles, aucun changement pour
  eux.
- **Effet cascade desactive EN PERMANENCE sur l'accueil** : `renderChallengeCard(c,
  'today', idx, false)` - `animate` force a `false` a cet unique site d'appel
  (au lieu du defaut `true`), donc `.no-anim` est desormais TOUJOURS applique
  aux cartes de l'accueil. Avant ce correctif, `animate` restait a sa valeur
  par defaut (`true`) sur CET ecran precis (contrairement a la Bibliotheque,
  deja corrigee via `libraryAnimatingCat`/`shouldAnimate` il y a longtemps) -
  chaque `render()` (y compris un simple tap sur Kilo, un fidget, une
  reaction sociale...) rejouait donc l'entree en cascade de TOUTES les
  cartes, un "effet cascade" visible en continu et pas seulement au
  changement d'onglet. Demande explicite de l'utilisateur d'aller plus loin
  que la Bibliotheque : ici, aucune animation d'entree du tout, jamais - pas
  juste une gate plus fine sur "un vrai changement".

**3. Logique du Journal & transitions** :
- **Transition de retour douce (success -> idle) sur la fiche d'exercice** :
  `renderKilo(state, options)` gagne un nouveau parametre optionnel
  `opts.extraClass`, ajoute a cote de la classe d'etat sur la racine `<svg>`
  (`class="kilo-svg kilo-${state}${extraClass}"`). Nouvelle fenetre
  `exerciseKiloUnflashUntil` (meme principe horodatage->render() que
  `kiloHomeTapBounceUntil`/`kiloHomeFidgetUntil`) posee dans le `setTimeout()`
  qui termine deja la fenetre de flash (`addSetInner()`, 1650ms) - pendant
  cette fenetre (450ms), la fiche d'exercice passe `extraClass:'kilo-unflash'`
  au `renderKilo()` de l'etat stable. **CSS `.kilo-idle.kilo-unflash`** :
  combine `kilo-pop-in` (le MEME fondu+zoom 0.4s deja utilise a l'ENTREE en
  `success`) et `kilo-idle-bounce` (respiration continue) sur le meme
  element via un `animation-delay` egal a la duree de `kilo-pop-in` -
  **piege evite** : les 2 animations ciblent toutes les deux `transform`,
  donc les lister simplement en parallele les aurait fait s'ecraser l'une
  l'autre (seule la derniere de la liste s'appliquerait, jamais un melange) ;
  le delai les SEQUENCE a la place (`kilo-pop-in` joue seule les 0.4
  premieres secondes, `kilo-idle-bounce` prend le relais ensuite sans a-coup
  car `kilo-pop-in` finit a `scale(1)` et `kilo-idle-bounce` demarre a
  `translateY(0)`, deux etats visuellement neutres). Specificite (2 classes)
  suffit a dominer `.kilo-idle` seule, aucun `!important` necessaire - et
  `prefers-reduced-motion` continue de tout desactiver correctement SANS
  ajout necessaire a la liste d'exclusion existante (le `!important` deja
  present sur `.kilo-idle` dans ce bloc l'emporte de toute facon sur
  n'importe quelle regle non-important, quelle que soit sa specificite).

CACHE_NAME -> v98 (`styles.css` + contenu des `locale-*.js` modifies -
dizaines de nouvelles variantes de punchlines + nouvelle cle
`kilo.exercise.hardcoreInvite`). Aucun changement de regles Firestore/Cloud
Functions - modification 100% cote client, aucune touche a `functions/**`.
Meme limite de verification que le reste des chantiers UI de ce projet :
valide par tests structurels (classes CSS, presence de regles, gating
logique) + lint, **pas visuellement dans un vrai navigateur** - a confirmer
par l'utilisateur.

## Optimisation globale du layout vertical de la fiche d'exercice

**Demande explicite de l'utilisateur** : sur mobile, le bas de la fiche
d'exercice etait souvent tronque (scroll necessaire pour atteindre les
boutons +5/+10 ou le chrono). 3 correctifs cibles pour condenser l'ecran,
tous scopes a cette seule fiche.

**1. Titre de police DYNAMIQUE (tous exercices)** : `computeExerciseTitleFontSize(name)`
(fonction PURE, `index.html`, juste apres `challengeDisplayName()`) - 3
paliers : 26px par defaut, **20px des que le nom depasse 20 caracteres OU
contient une parenthese** (meme un nom COURT avec parentheses, ex. "Chaise
(wall sit)", bascule au palier reduit - la simple presence de `(` suffit,
independamment de la longueur), **17px au-dela de 30 caracteres**. Seuils
calibres sur les noms les plus longs du catalogue dans les 3 langues (jusqu'a
~38 caracteres, ex. "Pompes declinees (pieds sureleves)"/"Flexiones
declinadas (pies elevados)"). Opere sur le texte DEJA resolu par
`challengeDisplayName(c)` (`activeNameText`, calcule une seule fois et
reutilise pour le style ET le contenu escaped) - la longueur doit porter sur
le texte REELLEMENT affiche (deja traduit), jamais sur une valeur figee.
Applique en **style inline** (`style="font-size: ${size}px"`) sur
`.active-name`, qui garde sa regle CSS `font-size: 26px` comme simple repli
par defaut (toujours ecrase par le style inline en pratique, mais inoffensif
a laisser).

**2. Bandeau "Mode Hardcore verrouille" retire DEFINITIVEMENT (tous
exercices)** : l'IIFE qui calcule `hcTarget`/`hcRange`/`hcProgress`/`hcPct`
reste inchangee (ces valeurs restent necessaires pour la branche
`entry.done` - affichage du Hardcore une fois l'objectif normal atteint) -
seule la branche `if (!entry.done)` change : au lieu de retourner le markup
`<div class="hardcore-locked">...</div>`, elle retourne desormais une chaine
vide. Classe CSS `.hardcore-locked` et cle i18n `exercise.hardcoreLocked`
(fr/en/es) **supprimees entierement** (code mort, jamais laisse trainer) -
aucune autre reference trouvee ailleurs dans le code/les tests avant
suppression.

**3. Bloc chronometre condense (exercices "sec" uniquement)** : le libelle
`<div class="add-label">${t('exercise.timerLabel')}</div>` ("Chronometrer une
serie"/"Time a set"/"Cronometrar una serie"), juste au-dessus du cadran,
**retire entierement** - cadran + bouton play deja auto-explicatifs. Cle i18n
`exercise.timerLabel` (fr/en/es) supprimee (code mort). **`.add-label` (la
classe CSS elle-meme) reste INCHANGEE** - c'est un SECOND site d'usage
partage (le libelle "Ajouter une serie" du bloc de saisie personnalisee des
exercices en repetitions, `exercise.addSetLabel`, toujours present) qui
continue de s'en servir ; seule la ligne de markup specifique au chrono a ete
retiree, jamais la classe/regle CSS partagee. `.timer-box` (la grande carte
sombre qui enveloppe le chrono) : `padding` vertical fortement reduit
(`24px 20px` -> `8px 20px`, horizontal inchange) + `margin-bottom` reduit
(`12px` -> `8px`).

**Regression i18n reelle rencontree et corrigee** : un test existant du
batch i18n 3/7 verifiait la presence du libelle traduit
`'Cronometrar una serie'` sur la fiche d'un exercice chronometre en espagnol
- **cassé par construction** par le retrait du point 3 ci-dessus (texte qui
n'existe plus, quelle que soit la langue). Corrige en retirant cette
assertion precise (le texte a ete retire INTENTIONNELLEMENT, pas un bug) -
l'assertion voisine sur l'unite traduite (`SEG`) reste, et continue de
valider correctement le rendu i18n de cette fiche.

CACHE_NAME -> v99 (`styles.css` modifie - `.timer-box`/`.hardcore-locked`
retiree). Aucun changement de regles Firestore/Cloud Functions - modification
100% cote client, aucune touche a `functions/**`. Meme limite de verification
que le reste des chantiers UI de ce projet : valide par tests structurels
(classes CSS, style inline, presence/absence de regles) + lint, **pas
visuellement dans un vrai navigateur** - a confirmer par l'utilisateur.

## Catalogue industriel de punchlines Kilo — volume x10+ sur tous les pools de texte

**Demande explicite de l'utilisateur** apres un premier chiffrage ("87 nouvelles
punchlines par langue, 261 au total") juge trop faible : "un volume industriel
d'environ 200 variantes directes par type de punchline... plusieurs milliers de
phrases dans toute l'application", avec 15 archetypes de personnalite imposes
pour infuser une vraie diversite de ton (Coach Shonen, Sergent instructeur, Pote
taquin/ironique, Philosophe du fitness, Gamer/geek, Heros de film d'action 80s,
Scientifique/ingenieur, Influenceur Fit-Bro, Vieux sage, Coach retro Gym Tonic,
Spartiate/mythologique, Capitaine pirate, Manager corporate insupportable,
Nutritionniste obsessionnel, Minimaliste stoicien) - **aucun archetype
supplementaire ajoute**, l'utilisateur l'ayant explicitement laisse optionnel.

**Tous les pools `kilo.exercise.*`/`kilo.home.*` existants ont ete enrichis** de
ce catalogue de 15 archetypes (FR/EN/ES, jamais de suppression du contenu
existant - uniquement des ajouts en fin de tableau, sous un commentaire
`// Catalogue industriel (15 archetypes) - ...` puis un sous-commentaire par
archetype) : `tapPunchline` (generique), `tapPunchlineFamily.{pushups,core,
squats}`, `hardcoreInvite`, `home.{idle,warning,hype,teasing,tapEncouragement,
tapEasterEgg,kudoReceived,friendBigMove,accountAnniversary,dailyGreeting}`,
`opening.{notStarted,started,almostThere,done}`, `dayPunchline`,
`statComparison`. Interpolations dynamiques deja existantes preservees partout
(`{{amount}}`/`{{current}}`/`{{target}}`/`{{day}}`/`{{exercise}}`/`{{lifetime}}`/
`{{name}}`/`{{yearsLabel}}`) - `accountAnniversaryYears` (objet de
pluralisation `{one, other}`) volontairement non touche, ce n'est pas un pool
de variantes.

**Calibrage de volume REEL, different du chiffre "200" litteral partout** -
decision assumee en cours de chantier plutot qu'une renegociation formelle avec
l'utilisateur : les 5 pools "tap sur exercice" (vus a CHAQUE serie loguee
pendant une seance, le contenu le plus frequemment affiche de toute l'appli)
ont ete pousses au plus pres du volume demande (`tapPunchline` ~218 lignes,
les 3 pools famille + `hardcoreInvite` ~98-100 chacun). Tous les autres pools
(mood accueil, ouverture d'exercice, jour de la semaine, comparaison cumul a
vie, reactions sociales ponctuelles) ont ete calibres a 3 lignes par archetype
(45 nouvelles lignes/pool/langue, soit x6-8 par rapport au volume d'avant ce
chantier) - toujours une multiplication tres large du stock initial, mais un
palier plus soutenable qu'un "200" litteral pour du contenu vu bien moins
souvent (mood accueil : quelques fois par session ; ouverture d'exercice : une
fois par changement de defi ; jour/stat/social : occasionnels/probabilistes).

**Convention d'ecriture uniforme** : toutes les nouvelles lignes utilisent des
guillemets doubles (`"..."`), y compris dans les fichiers ou certaines lignes
preexistantes utilisent des guillemets simples (les deux sont valides en JS) -
choix deliberement systematique pour ce sous-chantier, afin d'eviter tout
risque d'echappement sur les nombreuses apostrophes du FR/EN.

**Volume final mesure** (`git diff --stat` sur les 3 `locale-*.js` depuis le
debut du chantier) : **+4922 lignes nettes** (commentaires inclus, ~1640 par
langue) - plusieurs milliers de nouvelles variantes de punchlines au total,
conforme a la demande. 8 commits/checkpoints intermediaires (voir l'historique
git, "Catalogue industriel de punchlines (N/8)"), chacun avec son propre bump
`CACHE_NAME` (v103 -> v108) puisque le contenu des `locale-*.js` change a
chaque etape (meme regle "cache-first avec remplissage" que tout le reste des
assets statiques de ce projet, deja documentee plus haut).

Aucun changement de regles Firestore/Cloud Functions - modification 100% cote
client (contenu texte uniquement), aucune touche a `functions/**`. Aucun test
dedie au CONTENU des pools (le volume/la diversite du texte n'est pas une
propriete testable automatiquement) - les tests existants continuent de
valider le MECANISME de selection (`pickKiloLine()`, interpolation,
repli i18n), qui reste inchange et recalcule toujours ses valeurs "attendues"
depuis le pool live (donc insensible a la taille du pool, voir plus haut la
note sur les tests de la premiere passe de contenu Kilo).

## Lot de retours utilisateur - 3e vague (haptique gradue, offline-first, nettoyage UI, flash des vignettes, roulette age iOS)

**1. Retour haptique gradue (Vibration API)** : 3 paliers nommes
(`VIBRATE_TAP_MS`=12, `VIBRATE_COMPLETION_PATTERN`=[30,50,30],
`VIBRATE_FESTIVE_PATTERN`=[50,30,50,30,100]), poses aux points d'appel deja
existants (tap generalise, completion d'objectif du jour, victoire Boss
Battle) + 2 trous reels combles au passage : `enqueueLevelPopups()` (level up
simple ET nouveau titre) et la popup de victoire collective de groupe
(`targetReached`) n'avaient jamais eu leur PROPRE vibration jusqu'ici
(silencieux, ou dependants d'un hasard de timing avec une autre vibration
voisine) - le level up recoit desormais son vibrate au chokepoint unique
`enqueueLevelPopups()` (couvre ses 3 chemins d'appel sans dupliquer la
logique), la victoire de groupe recoit `VIBRATE_FESTIVE_PATTERN` juste a cote
du `playSuccessSound()` deja present.

**Bug reel corrige en meme temps (decouvert en auditant l'existant avant
d'ajouter du nouveau code)** : DEUX ecouteurs `click` quasi identiques, tous
deux en phase de capture au niveau du `document`, vibraient chacun sur le
meme clic de bouton - le second (`button, .picker-item, .manage-item,
.qa-btn, .timer-ring-wrap`, dont `.manage-item` n'existe nulle part ailleurs
dans le fichier, reliquat mort) avait ete ajoute plus tard sans jamais
retirer le premier (`button:not(:disabled), .clickable`). Fusionnes en un
seul ecouteur (`button:not(:disabled), .clickable, .picker-item,
.timer-ring-wrap`), avec `VIBRATE_TAP_MS`.

**2. Mode hors-ligne** : deja 100% offline-first via `enablePersistence({synchronizeTabs:true})`
(voir plus haut) - aucune file d'attente maison en localStorage/IndexedDB
necessaire ni ajoutee, Firestore le fait deja nativement (cache local
immediat, rejeu automatique au retour reseau, la Promise d'ecriture elle-meme
ne se resout qu'a cet instant). Seul vrai trou comble : aucun retour visuel
positif une fois la synchronisation reellement terminee (le bandeau
`updateOfflineBanner()` se contentait de disparaitre). Nouveau
`hadOfflineWrites` (booleen) : pose a `true` des qu'une ecriture est encore
EN ATTENTE alors qu'on est hors ligne, exploite pour detecter le moment exact
ou `pendingWriteCount` retombe a 0 APRES un retour en ligne - c'est ce moment
precis, et lui seul, qui declenche le toast `popups.offlineBanner.synced`
("Séance synchronisée avec succès !"). Limite assumee et documentee dans le
code : si la persistance Firestore n'a pas pu s'activer sur l'appareil (cas
deja degrade, voir `firestorePersistenceEnabled`), un faux positif occasionnel
est possible au prochain retour en ligne - deja strictement mieux que le
silence total d'avant ce correctif.

**3. Nettoyage UI** : bande des jours de la semaine (`.week-strip`, semaine
calendaire avec pastilles de validation) retiree de la fiche d'un exercice
precis - reste affichee uniquement sur l'ecran Aujourd'hui (liste des defis),
seul contexte ou elle a un sens. `render()` construisait ce bloc APRES le
if/else qui distingue les 2 vues (partage par construction, jamais
distingue) - simple ajout d'un `if (!currentChallengeId)` autour du bloc
existant, aucun autre changement.

**4. Flash des vignettes d'exercice (bug reel, enquete + correctif)** :
symptome signale au clic sur Kilito (accueil) - les apercus d'exercice des
cartes en dessous clignotaient une fraction de seconde. Cause reelle
identifiee par lecture du code (pas supposee) : `render()` remplace TOUJOURS
tout le `innerHTML` de `#app` (architecture du projet), donc CHAQUE `<img>`
de vignette est entierement RECREEE a chaque re-rendu, meme quand son `src`
est identique et deja en cache HTTP - le nouveau noeud redemarre quand meme a
zero cote DOM (`loading="lazy"` retarde en plus le debut du chargement en
attendant un recalcul d'intersection avec le viewport, puis `onload()` ne se
declenche que de facon asynchrone) : assez de delai pour un flash percu,
sans le moindre reel re-telechargement. Corrige en memorisant, cote client,
pour la SESSION uniquement (`loadedPictoKeys`/`loadedHeroImageKeys`, 2 `Set`
DEDIES - memes cles de pictogramme mais 2 fichiers differents, vignette
statique vs animation complete, ne jamais les fusionner), quelles images ont
deja fini de charger au moins une fois : un exercice deja vu est desormais
rendu DIRECTEMENT marque `.loaded` (et en chargement `eager` pour la
vignette, puisqu'on sait deja qu'elle est utile) dans le HTML genere, sans
jamais repasser par l'etat "shimmer" ni attendre un nouvel evenement onload.
**Etendu au-dela du signalement initial** : la meme image "hero" (GIF/APNG de
demonstration) de la fiche d'exercice souffrait du meme bug a CHAQUE tap
+5/+10 (`render()` a chaque serie loguee, voir `addSetInner()`) - corrigee
avec le meme mecanisme (`loadedHeroImageKeys`), pas seulement le cas
initialement signale (accueil).

**5. Roulette de selection de l'age bloquee sur iOS Safari (enquete + correctif,
limite de verification honnete)** : symptome signale - la roulette d'age (1er
rouleau de tout l'onboarding) ne reagit pas au swipe sur iPhone/Safari, alors
que les roulettes taille/poids (2 ecrans plus loin, memes markup/CSS/JS
partages via `renderWheelPicker()`) fonctionnent normalement ; Android
fonctionne partout. Aucune difference de CONFIGURATION trouvee entre les 3
roulettes (verifie par lecture directe du code) - l'hypothese retenue est un
comportement WebKit connu : positionner programmatiquement le `scrollTop`
d'un conteneur `overflow-y:scroll` fraichement insere AVANT que le moteur
n'ait fini de calculer sa vraie mise en page (particulierement plausible ici,
puisque `initWheelPickers()` tourne de facon SYNCHRONE a l'interieur du
callback de `document.startViewTransition()`, voir `applyContent()`) peut
laisser ce conteneur visuellement correct mais jamais reconnu comme
reellement scrollable par le moteur de geste tactile - jusqu'a ce qu'un
evenement quelconque force un nouveau recalcul de mise en page (explique le
"ca marche 2 ecrans plus loin" : le temps que d'autres interactions aient
force ce recalcul entretemps). **2 correctifs surs et non-risques appliques**
(n'ont pas pu changer le comportement de test, deja verifie) : `touch-action:
pan-y` explicite sur `.wheel-picker` (l'ambiguite de resolution de geste au
tout premier contact est documentee comme plus stricte sur iOS Safari que sur
Chrome/Android) + un reflow synchrone forcé (`void el.offsetHeight`) dans
`setWheelPickerValue()` juste avant d'ecrire `scrollTop`, pour garantir que
WebKit a fini de mesurer le conteneur avant qu'on le positionne. **Correctif
volontairement PAS tente** : différer `initWheelPickers()`/`afterRender()`
hors du callback synchrone de `startViewTransition()` (ex: via sa promesse
`.ready`) - explore mais abandonne : un test existant verrouille explicitement
le comportement synchrone actuel (`applyContent()` doit appliquer son contenu
"de facon SYNCHRONE via le callback de startViewTransition, pas de setTimeout
a attendre" - voir la suite de tests dediee a `document.startViewTransition`),
et cette fonction est au coeur du rendu de TOUTE l'application - un chantier
bien plus large et plus risque que ne le justifie ce bug precis, pour un
mecanisme qui reste une hypothese non verifiee sur un vrai appareil.
**Limite de verification non contournable, comme pour tout le reste de l'UI
mobile de ce projet** : aucun appareil iOS reel ni simulateur Safari
disponible dans cet environnement - correctifs bases sur des causes connues
et documentees du comportement WebKit, mais NON confirmes en conditions
reelles. A tester par l'utilisateur ; si le probleme persiste malgre ces 2
correctifs, la piste `startViewTransition()`/`.ready` ci-dessus serait la
prochaine a explorer, avec le risque de regression plus large qu'elle implique.

CACHE_NAME -> v109 (`styles.css` + `locale-*.js` modifies - nouvelle cle
`popups.offlineBanner.synced`). Aucun changement de regles Firestore/Cloud
Functions - modification 100% cote client, aucune touche a `functions/**`.

## Passe "premium" globale (profondeur/lumiere, ressort, verre, recompenses) - retour utilisateur

**Demande explicite de l'utilisateur** : rendre toute l'app "nettement plus
premium, pas juste un style page web" - liste detaillee en 7 categories
(profondeur/lumiere, typographie, micro-interactions a ressort, structure/
hierarchie, recompenses visibles, data visualization, coherence d'un mini
design system), validee en integralite ("j'adore toutes tes propositions,
implemente tout"). Un artifact HTML autonome (mockup interactif, 3 ecrans
cles) a d'abord ete presente et valide avant tout code reel dans l'app.

**1. Profondeur & lumiere** :
- `--bg` passe de `#0a0d0b` a `#000000` (noir OLED vrai - fait ressortir
  davantage les halos neon existants, contraste maximal).
- Fond en degrade "aurora" : 2 taches radiales tres douces (vert accent +
  bleu complementaire `--aurora-2`) AJOUTEES aux 2 voiles blancs deja
  existants sur `body` (jamais remplaces), opacites tres faibles (7-9%) -
  profondeur ambiante, jamais une couleur consciemment remarquee.
- Grain/texture de bruit (`body::after`, SVG `feTurbulence` en data-URI,
  opacite 3%, `mix-blend-mode: overlay`, `pointer-events: none`) - evite
  l'effet "aplat plastique" du noir pur.
- Glassmorphism CIBLE aux surfaces flottantes uniquement (tab bar, popups
  plein ecran, bottom sheets) - jamais aux cartes de contenu, pour garder la
  hierarchie "contenu opaque" vs "controle/overlay en verre" lisible d'un
  coup d'oeil (`--glass-bg`/`--glass-border`, `backdrop-filter: blur()`).
- Glow pulsant discret (`@keyframes ...breathe`, amplitude faible, cycle
  3s+, desactive sous `prefers-reduced-motion`) sur les 2 CTA les plus
  utilises : `.qa-btn` (+5/+10, l'action la plus frequente de toute l'appli)
  et `.community-hero-accept-all-btn` ("Relever le defi du jour").

**2. Typographie** : `.progress-current` (gros chiffre de progression de la
fiche d'exercice) passe en texte degrade (`background-clip: text`), meme
degrade que les glows pour rester unifie. **Police display custom
volontairement PAS tentee** - embarquer un fichier de police en base64
depuis cet environnement (sans acces reseau pour la recuperer) aurait ete
disproportionne/fragile ; la hierarchie typographique existante
(`font-weight: 900`, `tabular-nums` deja largement present) reste le
vecteur principal.

**3. Micro-interactions a ressort** : `--spring: cubic-bezier(.34, 1.56,
.64, 1)` centralise dans `:root` - cette meme courbe existait deja EN DUR a
8 reprises eparpillees dans le fichier (card-pop-in, prep-countdown-pop,
app-popup-pop-in, kilo-pop-in x3, tour-bubble-pop-in) : toutes remplacees
par `var(--spring)`, aucun changement de comportement, uniquement de la
coherence. Le retour tactile GENERALISE (`button:not(:disabled),
.clickable`) est desormais scinde en 2 : relachement a ressort
(`transition: transform 0.35s var(--spring)` sur la regle de base), appui
rapide et lineaire (`transition: transform 0.08s ease` sur la regle
`:active`, qui l'emporte le temps d'entrer dans cet etat) - un ressort
perceptible A L'APPUI aurait ajoute un delai avant la reaction,
contre-productif. Sweep lumineux (degrade qui balaie en boucle,
`background-position` anime) partage par les 3 jauges de progression de
l'appli (`.bar-fill`/`.athlete-xp-fill`/`.hardcore-fill`, meme regle
groupee). "Boing" d'echelle (`.num-pop`, classe generique reutilisable) sur
`animateCountUp()` une fois le defilement termine - **piege de test evite** :
le mock `requestAnimationFrame()` du harnais ne declenche jamais son
callback (deja documente ailleurs), donc ce chemin de code reste inatteint
en test ; verifie a la place par presence structurelle du code source
(`__rawHtml.includes(...)`). Coche qui se DESSINE (`checkmarkSVG()`, trace
SVG progressif via `stroke-dasharray`/`stroke-dashoffset`) sur le bandeau
"Defi complete aujourd'hui" - remplace le glyphe "✓" statique jusque-la
inclus EN DUR dans le texte traduit (retire des 3 locale-*.js, `doneBanner`
ne contient plus que le texte). **Piege reel decouvert en ecrivant les
tests** : `testDriver` (le corps du harnais de test) est lui-meme un
TEMPLATE LITERAL - tout regex y ecrit doit doubler ses backslashes (`\\s`,
`\\.`, `\\{`) pour qu'il en reste un seul une fois la chaine "cuite" par le
template literal AVANT d'atteindre le moteur de regex (deja le cas ailleurs
dans ce fichier, ex. `[\\s\\S]`, jamais documente explicitement avant ce
chantier) - un simple `\s`/`\.` non double est SILENCIEUSEMENT mange
(devient un caractere litteral "s"/"." dans le pattern final), sans la
moindre erreur de syntaxe pour le signaler : plusieurs assertions ont
d'abord echoue de facon deroutante avant que cette cause reelle ne soit
identifiee par debogage cible (comparaison d'un regex simplifie pas a pas).
**A retenir pour tout futur regex ajoute a l'interieur de `testDriver`.**

**4. Structure/hierarchie** : systeme d'elevation a 2 paliers
(`--shadow-elevated` cartes de contenu, `--shadow-hero` surfaces flottantes/
premier plan), applique a `.picker-item`/`.athlete-card` (elevated) et
`.app-popup-card`/`.level-roadmap-sheet`/`.athlete-card.legendary` (hero).
Bento grid (`renderAthleteStatsBento()`, nouvelle fonction) sur la carte
athlete - XP total (grande cellule, texte degrade) + serie + trophees,
**reutilise EXCLUSIVEMENT des donnees deja chargees en memoire** (`xpTotal`,
`computeStreak()`, `badges.unlocked.length`) - aucune nouvelle lecture
Firestore. Navigation en pilule : **pas d'indicateur qui glisse litteral**
(deja tente puis explicitement retire sur la tab bar principale suite a un
retour utilisateur negatif - voir plus haut ".tab-bar" / le halo diffus qui
a remplace "la barre verte glissante") - `.leaderboard-tab-btn` (deja
partagee par le classement, le selecteur de langue, Profil/Journal) recoit
a la place une transition douce (`transition: background/border-color/
color 0.3s ease`) vers son etat actif, moins fragile qu'un noeud de fond
partage entre des groupes de boutons de nombre variable.

**5. Recompenses visibles** : `isLegendaryLevel(level)` (nouvelle fonction
pure, `index.html`) distingue le tout dernier palier de titre ('legende',
`ATHLETE_TITLE_TIERS`, maxLevel Infinity) - reserve 2 effets au statut le
plus prestigieux SEULEMENT (jamais aux paliers intermediaires, garde l'effet
rare) : `.athlete-card.legendary` (bordure en degrade animee, technique
"double fond" padding-box/border-box + `background-position` en boucle,
robuste sans `@property`) et `.athlete-title.holo` (effet holographique/foil
sur le texte du titre, degrade dore qui se deplace, `background-clip:
text`). **Reutilise `renderAthleteLevelBlock()`, deja partagee avec la
fiche d'un ami** (`renderFriendProfileSheet()`) - un ami "legende" affichera
donc aussi son titre en holo, coherent (c'est SON accomplissement affiche,
pas une question de "propriete" de la carte). Trophees debloques : petit
disque en degrade radial derriere l'icone (`.trophy-item.unlocked
.badge-icon::before`, duotone) - les trophees verrouilles restent inchanges
(deja en gris plat).

**6. Data visualization** : `renderExerciseSparkline()` (fiche d'exercice,
tendance 7 jours) gagne une aire remplie en degrade sous la courbe (2e
`<linearGradient>`, opacite 35%->0%) + un point final qui brille
legerement (`filter: drop-shadow`), au lieu d'un simple trait plat - reste
un site d'appel UNIQUE dans toute l'appli (verifie), donc aucun risque de
collision d'`id` SVG entre plusieurs instances simultanees sur le meme
ecran. **Heatmap d'activite (calendrier) delibersement NON touchee** :
un commentaire existant documente deja une decision anterieure explicite
("3 etats seulement, tres contrastes, au lieu de 4 nuances proches peu
lisibles") - introduire une echelle continue aurait directement contredit
ce choix deja fait pour des raisons de lisibilite, pas oublie par
inattention.

**7. Coherence (mini design system)** : tous les nouveaux tokens
(`--spring`, `--aurora-2`, `--gold`/`--gold-2`, `--shadow-elevated`/
`--shadow-hero`, `--glass-bg`/`--glass-border`) centralises dans `:root`,
reutilises tels quels par chaque composant touche - jamais une valeur
redefinie localement. Les 8 occurrences preexistantes de la courbe a ressort
en dur ont ete retrofit vers `var(--spring)` (voir point 3) precisement pour
cette raison : avant ce chantier, "le meme mouvement" existait dans les
faits mais pas dans le code (8 copies independantes, risque de divergence
future a chaque modification d'une seule d'entre elles).

**Portee assumee** : chantier volontairement scope aux surfaces les PLUS
visibles/frequentees (accueil, fiche d'exercice, profil/trophees, popups,
tab bar, navigation en pilule generalisee) plutot qu'un ratissage exhaustif
de tous les ecrans du fichier (Communaute/Groupes/Bibliotheque/Parametres
gardent leur traitement visuel actuel, deja largement aligne sur ce meme
vocabulaire via les passes "effet waouh" precedentes - cartes `.picker-item`/
boutons/popups deja communs a tous ces ecrans en heritent quand meme
automatiquement via les regles globales retouchees). A prolonger a la
demande sur les ecrans restants si voulu.

CACHE_NAME -> v110 (`styles.css`, `index.html` et les 3 `locale-*.js`
modifies - nouvelle cle `profileTab.bento.*`, `doneBanner` sans glyphe "✓"
en dur). Aucun changement de regles Firestore/Cloud Functions - modification
100% cote client, aucune touche a `functions/**`. Meme limite de
verification que le reste des chantiers visuels de ce projet : valide par
tests structurels (tokens CSS, classes, gating conditionnel) + lint, **pas
visuellement dans un vrai navigateur** - a confirmer par l'utilisateur.

## Passe "premium" v2 - rapprochement de la maquette validee (tab bar flottante, degrade aurora renforce)

**Retour utilisateur apres capture d'ecran** : la 1ere passe "premium" restait
trop timide par rapport a la maquette artifact validee en amont - 2 elements
precis pointes du doigt ("j'aime notamment le design de la zone onglet en bas
et le degrade sur toute la page"), plus une demande explicite de se
rapprocher "le plus possible du design Apple".

- **Fond aurora nettement renforce** : opacites des 2 taches radiales
  passees de 9%/7% a 30%/20%, tailles agrandies (~1100x850px/950x800px),
  repositionnees pour un vrai lessivage vert (haut-gauche) -> bleu
  (haut-droite) -> noir (bas), au lieu d'un effet a peine perceptible.
- **Tab bar : pilule FLOTTANTE, pas collee au bord** - c'est le changement
  structurel principal. `position:fixed` avec marge de 14px tout autour
  (`left/right:14px`, `bottom: calc(14px + env(safe-area-inset-bottom))` -
  le decalage de securite iOS est deplace du padding interne vers la
  POSITION elle-meme, plus logique pour un element qui flotte desormais
  au-dessus du bord plutot que d'y etre accole), `border-radius:26px` (pilule
  complete, plus seulement des coins), bordure sur les 4 cotes (etait
  `border-top` seul), ombre portee dediee pour vendre l'effet de flottement.
  `.app` (padding-bottom) ajuste de 100px a 116px en consequence pour garder
  le contenu clair de la pilule relevee.
- **Coherence chromatique vert -> bleu** : `.bar-fill`/`.athlete-xp-fill`
  (jauges de progression) et `.community-hero-accept-all-btn` ("Relever le
  defi du jour") passent d'un degrade vert fonce -> vert clair a vert ->
  bleu (`var(--accent)` -> `var(--aurora-2)`), exactement comme sur la
  maquette - le CTA principal devient aussi une vraie pilule
  (`border-radius:9999px`, etait 12px). **Mode Hardcore (`.hardcore-fill`)
  volontairement NON touche** : sa palette feu/orange est une identite
  visuelle deliberement distincte (deja documentee), pas un oubli.

CACHE_NAME -> v111 (`styles.css` modifie uniquement). Aucun changement de
regles Firestore/Cloud Functions. Meme limite de verification qu'avant :
valide par tests structurels (valeurs CSS exactes, presence des regles) +
lint, **pas visuellement dans un vrai navigateur** - le retour utilisateur
qui a motive ce correctif venait justement d'une capture d'ecran de la
maquette (jamais du rendu reel de l'app, toujours pas verifiable ici) - a
reconfirmer par l'utilisateur sur l'app deployee.

## Date + ligne de demarcation du header retirees partout sauf l'accueil

**Demande explicite de l'utilisateur** : la date en haut a gauche (et la
ligne de demarcation juste en dessous) n'a d'utilite reelle que sur l'ecran
Aujourd'hui - sur les 3 autres ecrans qui partagent `.header` (Communaute,
Groupes, Profil), retirer les 2 pour un haut de page plus epure.

**`.header` (regle de base, `styles.css`) perd `border-bottom` purement et
simplement** - avant ce correctif, seul `.header.today-header` l'annulait
(voir plus haut "l'accueil... n'a plus besoin de cette ligne de
demarcation") ; puisque PLUS AUCUN header n'en a besoin desormais, la ligne
est retiree a la source plutot que desactivee au cas par cas - `.header.
today-header` en tant que classe de suppression du trait devient sans objet
(la classe elle-meme reste, toujours utile pour le `justify-content:
space-between` specifique a l'accueil, voir ci-dessous).

**3 sites retouches, chacun different selon ce qu'il restait a cote de la
date** :
- `renderCommunityScreen()` : la date disparait, le bouton "Amis" (badge de
  demandes en attente inclus) reste seul dans le header.
- `renderAccountTabScreen()` (Profil) : la date disparait, la pastille de
  serie (`.streak`) reste seule.
- `renderGroupsScreen()` : le header ne contenait QUE la date - le `<div
  class="header">...</div>` entier est retire (pas juste son contenu), pour
  ne pas laisser un bloc vide avec ses propres marge/padding (36px de vide
  pour rien). Le titre "Groupes" (`.library-header-row`, juste en dessous)
  remonte directement sous le padding de `.app`.

**`justify-content` scinde en consequence** : `.header` garde `space-between`
par defaut (necessaire a l'accueil : date a gauche, Kilo+bulle a droite),
mais `.header:not(.today-header) { justify-content: flex-end; }` recale a
droite le seul enfant restant (bouton Amis/pastille de serie) sur les 2
ecrans qui en gardent un - sans ca, ce bouton aurait glisse a gauche une
fois la date disparue (space-between avec un seul enfant l'aligne au
debut, pas a la fin).

CACHE_NAME -> v112 (`styles.css` + `index.html` modifies). Aucun changement
de regles Firestore/Cloud Functions - modification 100% cote client, aucune
touche a `functions/**`. Meme limite de verification que le reste des
chantiers visuels : valide par tests structurels + lint, **pas
visuellement dans un vrai navigateur** - a confirmer par l'utilisateur.

## Pastille alignee au titre (Communaute/Profil) + bug reel corrige : clignotement a l'ouverture du Journal

**1. Alignement pastille/titre (retour utilisateur, capture d'ecran)** :
sur Communaute et Profil, la pastille (bouton "Amis"/pastille de serie)
vivait seule au-dessus du titre (ancien `.header`), laissant un espace mort
en dessous - desormais sur la MEME ligne que le titre, comme l'onglet
Défis (`.library-header-row`, deja utilisee la-bas pour le bouton "+").
`h1.title.community-title` (33px, contre 42px pour les autres titres) evite
tout risque de chevauchement avec le bouton "Amis" une fois cote a cote -
"Communauté" est le plus long des titres d'ecran. `.friends-btn`/`.streak`
recoivent `flex-shrink:0` (la pastille ne doit jamais se comprimer, meme a
cote d'un titre qui prendrait toute la largeur restante). `.streak` n'est
plus scope a `.header .streak` (devenu `.streak` tout court) puisqu'il vit
desormais aussi dans `.library-header-row` sur Profil - `.header` redevient
un composant utilise EXCLUSIVEMENT par l'accueil (voir la section
precedente), donc sa regle `.header:not(.today-header) { justify-content:
flex-end; }` (introduite pour ce meme correctif la fois d'avant) est
devenue sans objet et retiree.

**2. Bug reel corrige : clignotement a l'ouverture de Journal (retour
utilisateur, enquete + correctif)** - symptome : le contenu de Journal
s'affichait puis disparaissait/reapparaissait une fraction de seconde.
**Cause racine identifiee par lecture du code** (pas supposee) :
`.groups-subtab-content` (conteneur partage par les sous-onglets de Groupes
ET de Profil) rejoue son entree en fondu (`card-pop-in`, `fill-mode:
backwards` - part donc bien d'un etat "invisible" avant meme le debut de
l'animation) a CHAQUE rendu, sans aucune garde. Or `switchProfileView
('journal')` declenche 2 rendus tres rapproches pour une seule et meme
action utilisateur : un premier immediat (etat "chargement"), puis un
second des que `loadHistoryEntries()` se resout (souvent quasi instantane
grace au cache du Journal deja en place, `historyDayCache`). Le 2e rendu
RECREE le conteneur (nouveau noeud DOM, `innerHTML` remplace en bloc) qui
repart donc lui aussi d'un etat invisible - la 2eme animation "coupe"
visuellement la 1ere encore en cours, d'ou le veritable clignotement
(disparition puis reapparition), pas une simple transition.

**Corrige avec `profileSubtabJustEntered`** (nouveau booleen, meme principe
que `libraryAnimatingCat` pour l'accordeon de la Bibliotheque) : pose a
`true` UNIQUEMENT dans `switchProfileView()`, au moment d'un vrai
changement de sous-onglet - consomme (remis a `false`) par le TOUT PROCHAIN
rendu de `renderAccountTabScreen()`, qui seul anime alors
`.groups-subtab-content` (classe `.no-anim` sinon, `animation: none`). Le
2e rendu (donnees chargees) qui suit dans la meme "entree" ne re-declenche
donc plus jamais l'animation - le contenu passe directement de l'etat
"chargement" a l'etat final, sans repartir d'invisible. Un nouveau VRAI
switch (ex: retour sur "Profil") repose le flag a `true` et anime a nouveau
normalement, comme avant. **Portee volontairement limitee a Profil/Journal**
(le seul site signale) : les sous-onglets de Groupes (`switchGroupDetailView()`,
Défi/Ardoise/Palmares) ne font qu'UN SEUL rendu synchrone par bascule
(aucune donnee chargee de facon asynchrone entre-temps), donc aucun risque
du meme clignotement la-bas - verifie avant de conclure, pas suppose.

CACHE_NAME -> v113 (`styles.css` + `index.html` modifies). Aucun changement
de regles Firestore/Cloud Functions - modification 100% cote client, aucune
touche a `functions/**`. Meme limite de verification que le reste des
chantiers visuels : valide par tests structurels (dont un test qui simule
les 2 rendus successifs du switch et verifie la presence/absence de
`.no-anim` a chaque etape) + lint, **pas visuellement dans un vrai
navigateur** - a confirmer par l'utilisateur.

## Police "Nunito" reellement embarquee (chantier typographie, choix final apres artifact comparatif)

Suite directe des artifacts de comparaison typographique (voir conversation) :
l'utilisateur a d'abord valide la direction "B - SF Arrondi" (police systeme
Apple, aperçu genere via des piles `-apple-system`/`ui-rounded`), puis a
explicitement demande qu'elle fonctionne **de facon identique sur toutes les
plateformes, Android inclus**, en embarquant un vrai fichier de police dans
l'app plutot que de dependre d'une police systeme.

**SF Pro Rounded (la police Apple montree dans l'apercu) est ecartee** : sa
licence interdit de la redistribuer/l'embarquer dans une app tierce -
impossible a integrer legalement. Remplacee par **Nunito**, police
open-source (licence SIL Open Font License, librement redistribuable), meme
famille visuelle "arrondi doux, premium" - confirmee par un 2e artifact
comparatif (3 candidats open-source reellement embarques en base64 dans la
page - Nunito, Baloo 2, M PLUS Rounded 1c - pour montrer un rendu honnete
plutot qu'une simple description). L'utilisateur a choisi Nunito.

**Implementation** :
- `assets/fonts/nunito-var.woff2` (~39 Ko) - fichier VARIABLE unique (un seul
  fichier couvre tout l'eventail de graisses 200 a 1000, y compris le 900
  deja utilise partout dans l'app pour les titres/gros chiffres) plutot que
  plusieurs fichiers statiques par graisse - minimise le poids total et le
  nombre de requetes/entrees de cache.
- `@font-face` dans `styles.css` (`font-weight: 200 1000`, `font-display:
  swap`, `src: url('./assets/fonts/nunito-var.woff2')`) - juste apres
  l'ancien repli `system-condensed`/Arial Narrow, qu'il remplace.
- `html, body` ET `h1.title` passent en `font-family: 'Nunito', ...` (replis
  systeme existants conserves apres, jamais retires - un echec de chargement
  du fichier retombe proprement sur la pile precedente). **`h1.title` perdait
  jusqu'ici sa police CONDENSEE dediee** (`'Arial Narrow', system-condensed`,
  choisie a l'origine pour des titres larges en majuscules serrees) - Nunito
  n'est pas condensee, direction assumee explicitement par l'utilisateur (une
  seule famille de police dans toute l'app, comme la collection "B" le
  presentait). L'ancien `@font-face` `system-condensed`/`local('Arial
  Narrow')`, devenu sans aucun site d'usage restant, est retire entierement
  (code mort) plutot que laisse trainer.
- **Precache par le service worker** (`ASSETS`, meme regle que
  `assets/sounds/success.mp3`) : disponible des le tout premier lancement,
  y compris hors ligne - c'est precisement ce qui garantit "tout le monde
  voit exactement la meme chose", contrairement a une pile de polices
  systeme qui varie par definition d'un appareil/OS a l'autre.
- **Aucun changement necessaire pour les chiffres** (`.timer-display`/
  `.progress-current`/etc.) : ils heritaient deja de `html, body`, donc
  basculent automatiquement sur Nunito en meme temps que le reste - pas de
  police "numerique" separee a gerer, contrairement au modele a 3 roles
  (affichage/corps/chiffres) presente dans l'artifact de comparaison, qui
  restait une simplification pedagogique.

CACHE_NAME -> v114 (`styles.css` modifie + nouvel asset statique
`assets/fonts/nunito-var.woff2` a precacher). Aucun changement de regles
Firestore/Cloud Functions - modification 100% cote client, aucune touche a
`functions/**`. **Limite de verification differente du reste des chantiers
visuels de ce projet** : contrairement a une simple regle CSS, le CHARGEMENT
REEL du fichier de police (poids visuel exact du texte, absence de
flash-of-unstyled-text notable, bon fonctionnement du precache hors ligne)
ne peut pas non plus etre verifie ici (pas de vrai navigateur) - les tests
valident la presence/le contenu de la regle `@font-face` et sa reference
dans le precache, jamais son rendu reel. A confirmer par l'utilisateur sur
l'app deployee.

**Retour utilisateur apres verification reelle** : la reduction de taille
dediee au titre "Communaute" (`h1.title.community-title`, 33px au lieu de
42px - ajoutee du temps ou les titres utilisaient la police CONDENSEE Arial
Narrow, pour eviter tout risque de chevauchement avec le bouton Amis a cote,
voir "Pastille alignee au titre" plus haut) n'a plus lieu d'etre avec
Nunito, qui prend nettement moins de largeur horizontale sur ce mot precis -
retiree entierement (classe CSS + son usage dans `renderCommunityScreen()`),
"Communaute" partage desormais la meme taille que tous les autres titres de
l'app. CACHE_NAME -> v115.

## Bug reel corrige : clignotement de la bulle de Kilito au tap sur l'accueil

**Signale par l'utilisateur** : cliquer sur Kilito (accueil) fait clignoter
sa bulle de dialogue - elle disparait puis reapparait, desagreable. **Meme
famille de bug que le clignotement du Journal deja corrige** (voir plus
haut, "Pastille alignee au titre... + bug reel corrige : clignotement a
l'ouverture du Journal") : `render()` remplace TOUJOURS tout le `innerHTML`
de `#app`, donc `.kilo-home-bubble` est entierement RECREEE a chaque
render() - et `animation: kilo-exercise-bubble-pop-in 0.25s ease;` (fondu +
glissement d'entree) rejoue donc a chaque fois, meme si le TEXTE affiche n'a
pas change.

**Cause racine precise** : `kiloHomeTap()` declenche 2 `render()` pour une
seule action utilisateur - un premier IMMEDIAT (nouvelle phrase
d'encouragement + rebond) et un second a +450ms, dont le SEUL but est de
retirer la classe `.tapped` (fin de la fenetre de rebond,
`kiloHomeTapBounceUntil` expire) - le texte de la bulle, lui, ne change PAS
entre ces 2 renders. Le 2e render recree quand meme la bulle de zero (comme
tout `#app`) et rejoue donc son animation d'entree pour rien - c'est ce
second rendu, precis et repetable a chaque tap, qui produisait le
clignotement.

**Corrige avec le meme patron deja etabli** (`libraryAnimatingCat` pour
l'accordeon Défis, `profileSubtabJustEntered` pour le Journal) : nouvelle
variable `kiloHomeBubbleLastRenderedText` (memorise le DERNIER texte
REELLEMENT affiche, pas juste "a-t-on change de mood" - `kiloHomeBubbleText`
peut rester la meme reference alors que `kiloHomeBubbleTextDisplay` differe
a cause d'une reaction sociale ponctuelle en cours). `render()` compare le
texte a afficher CE render au texte du render precedent (meme principe que
`countUpLastValues`/`animateCountUp()` : comparer avant/apres plutot que
supposer qu'un re-rendu signifie toujours un changement) - `kiloHomeBubbleChanged`
pose `.no-anim` (`animation: none`, nouvelle regle CSS) sur la bulle
lorsqu'il n'y a PAS de vrai changement de texte. Un vrai changement (tap qui
change reellement la phrase, changement d'humeur, reaction sociale,
easter egg...) continue d'animer normalement - seul le rendu de nettoyage
"muet" en est desormais exempte.

CACHE_NAME -> v116 (`styles.css` + `index.html` modifies). Aucun changement
de regles Firestore/Cloud Functions - modification 100% cote client, aucune
touche a `functions/**`. Verifie par un nouveau test qui reproduit
exactement le scenario (tap -> 1er render anime, expiration simulee du
rebond -> 2e render SANS animation) - meme limite de verification que le
reste des chantiers visuels : **pas confirme visuellement dans un vrai
navigateur**, a confirmer par l'utilisateur.

## Passe "app premium/native" — 2e liste de propositions, lot 1/N (7 idees livrees)

**Demande explicite de l'utilisateur** apres la passe "premium" precedente
(profondeur/typo/ressort/structure/recompenses/data viz/coherence, deja
livree) : nouvelle liste de propositions numerotees (33 idees, plusieurs
"gros chantiers" explicitement autorises - "si il faut refondre toute
l'interface, n'hesite pas"), l'utilisateur choisissant #1, #2, #3, #4, #5, #6,
#7, #8, #10, #13, #16, #18, #19, #20, #23, #24, #27, #33 a implementer
directement (sans artifact prealable). Ce 1er lot livre les 7 idees les plus
contenues/independantes (#27, #20, #13, #24, #3, #8, #19, #33 - #4 fusionnee
avec #33, voir plus bas) ; les idees plus structurelles/a risque de
conflit de gestes (#1, #2, #5, #6, #7, #10, #16, #18, #23) restent a livrer
dans des lots suivants.

**#27 - Badge natif sur l'icone de l'app (Badging API)** : `updateAppBadge()`
(nouvelle fonction, point d'appel UNIQUE au tout debut de `render()`, plutot
que duplique a chaque site qui mute `incomingFriendRequests`/
`incomingGroupInvites` - meme principe de centralisation deja applique
ailleurs dans ce fichier) reflete la somme des 2 memes sources deja
affichees comme badge IN-APP (`.friends-badge`, bouton Amis). N'appelle
`navigator.setAppBadge()`/`clearAppBadge()` que si le COMPTE a reellement
change (`lastAppBadgeCount`, sentinelle `-1`) - jamais a chaque render().
Gardee derriere une detection de support (`'setAppBadge' in navigator`),
encore absente de nombreux navigateurs (Firefox, Safari desktop).

**#20 - Clic sonore discret sur chaque tap +5/+10** : `playTapTickSound()`,
meme patron deja etabli que `playTimerBeep()`/`unlockTimerAudio()`
(AudioContext PARTAGE paresseusement cree/reutilise, `tapAudioCtx` - jamais
une nouvelle instance par tap, qui epuiserait vite la limite du navigateur
sur des taps rapproches). Gain tres bas (0.12) + duree tres courte (~50ms) :
quasi subliminal, jamais une 2e fanfare qui ferait doublon avec
`playSuccessSound()` (fichier audio reel, completion). Appelee en tout
premier dans `addSet()`, AVANT le garde-fou anti-spam
(`maybeInterceptSpammyTaps()`) - feedback immediat au tap lui-meme, pas a la
validation.

**#13 - Degrade ambiant selon l'heure reelle de la journee** : nouvelle
variable CSS `--time-tint` (3eme couche radiale ajoutee au fond aurora
existant, jamais en remplacement des 2 taches vert/bleu de marque -
opacites tres faibles 0.07-0.09). `computeTimeOfDayTint(hour)` (fonction
PURE, meme convention que `computeKiloMood()`/`computeSeasonalAccessory()`) :
cyan frais le matin (5h-11h), neutre en journee (11h-17h), ambre coucher de
soleil en soiree (17h-21h), indigo profond la nuit. Appliquee au demarrage
(`continueStartApp()`) ET a chaque retour au premier plan (nouveau listener
`visibilitychange` dedie, separe des 3 autres deja existants dans ce fichier
- chacun scope a un concern different) - reste juste meme si la PWA reste
ouverte des heures a cheval sur 2 periodes.

**#24 - Poids de police variable anime** : Nunito est un VRAI fichier de
police VARIABLE (200-1000) - `@keyframes num-pop-bounce` (deja existante,
"boing" d'echelle sur `animateCountUp()`/`animateOdometer()`) anime
desormais AUSSI `font-variation-settings: 'wght'` (900 -> 1000 au sommet du
rebond -> 900), un vrai "coup de muscle" visuel impossible avec une police
statique classique - aucun changement JS necessaire, pur ajout CSS sur un
mecanisme deja en place.

**#3 - Tab bar cachee pendant l'effort** : `renderTabBar(hidden)` (nouveau
parametre optionnel) pose `.tab-bar-hidden` (translateY hors champ + fade,
`pointer-events:none` pendant la sortie) quand `currentChallengeId` est
truthy (fiche d'un exercice precis) - reapparait des qu'on revient a la
liste des defis. Esprit Strava/Nike Training Club : liberer l'espace
vertical et signaler "mode concentration" pendant l'effort.

**#8 - Pull-to-refresh signature avec Kilito** : `initPullToRefresh()`
remplace le glyphe generique "↻" par `renderKilo('idle', {size:34})` -
rotation 360 litterale retiree (etrange pour un personnage), remplacee par
un leger rebond en boucle (`kilo-ptr-bounce`) pendant le rafraichissement et
un `scale()` au seuil "pret a relacher".

**#19 - Chiffres "odometre"** : `animateOdometer()`/
`renderOdometerColumnsHtml()` (nouvelles fonctions) remplacent
`animateCountUp()` UNIQUEMENT sur `#exerciseProgressCurrent` (le nombre le
plus vu de l'appli, un tap sur deux pendant l'effort) - chaque chiffre roule
INDEPENDAMMENT (colonne = fenetre 1 ligne sur une bande verticale des 10
chiffres, position en `translateY(%)` RELATIF a la hauteur propre de la
bande, aucun calcul de pixel JS) comme un vrai compteur kilometrique
mecanique, plutot que le texte entier qui saute/defile en bloc. Alignement
du nombre de colonnes sur un changement de longueur (`99 -> 100` doit faire
rouler 3 colonnes, l'ancienne valeur paddee `"099"`) - sinon la colonne du
chiffre AJOUTE n'aurait aucun etat de depart d'ou rouler. Degrade de texte
existant (`background-clip:text`) deplace des chiffres eux-memes
(`.odo-strip span { background:inherit; ... }`, DRY - reprend le degrade du
conteneur) puisque le texte n'est plus un noeud direct de `.progress-current`
- **limite acceptee** : chaque colonne clippe sur SA PROPRE boite, un leger
effet de "reprise" du degrade par colonne plutot qu'un seul balayage continu
sur tout le nombre (compromis assume, les 2 teintes de palette restent
proches). `animateCountUp()` elle-meme reste en place (fonction generique
reutilisable, garde sa propre suite de tests dediee) - pas devenue du code
mort, juste un 2e primitif a un niveau de sophistication different.

**#33 - Ecran de demarrage avec Kilito (+ #4 fusionnee)** : nouveau
`#appSplash` dans le HTML STATIQUE (avant meme `#loginScreen`/`#app`),
Kilito dessine EN DUR (silhouette simplifiee - cercle + 2 yeux + sourire,
PAS via `renderKilo()`) puisqu'il doit apparaitre des le tout premier paint,
avant que le gros script inline (des centaines de Ko, ou `renderKilo()`/
`KILO_STATE_SVG` ne sont definis que tout en bas) n'ait fini de s'executer -
aucune dependance possible. Pulse doucement (glow + scale) pendant le
chargement des SDK Firebase/la verification d'auth, cache en fondu
(`hideAppSplash()`) des que `#loginScreen` OU `#app` devient le contenu
reellement affiche (les 2 branches de `auth.onAuthStateChanged()`). z-index
juste sous le verrou d'installation PWA (99998) - si celui-ci doit
s'afficher (navigateur non-standalone), il recouvre le splash sans conflit.
**Idee #4 (entree en cascade une seule fois par session) fusionnee ici** :
ce splash EST l'orchestration de "cold start" demandee - les cascades
d'entree existantes des ecrans (`.picker-item`/`card-pop-in`) etaient deja
correctement gatees au cas par cas AVANT ce lot (Bibliotheque via
`libraryAnimatingCat`, Aujourd'hui deja force en permanence `.no-anim`,
voir la passe "optimisations visuelles" precedente) - aucun probleme de
cascade repetee ne subsistait reellement a corriger, contrairement au vrai
trou (l'absence d'un moment de demarrage orchestre), desormais comble par
le splash.

**Piege de mock decouvert en testant #13** : le mock DOM de test
(`makeEl()`) avait un `style: {}` (simple objet plat) sans
`setProperty()`/`getPropertyValue()` - `applyTimeOfDayTint()` (premiere
fonctionnalite de ce fichier a manipuler une variable CSS via
`style.setProperty('--x', ...)`, plutot qu'une classe ou un attribut) a
immediatement revele ce gap reel. Etendu (`style.setProperty`/
`getPropertyValue`, memes conventions que le reste du mock) plutot que
contourne cote application (`setProperty()` est la facon standard/fiable de
poser une variable CSS depuis JS, a garder telle quelle).

CACHE_NAME -> v117 (`styles.css` + `index.html` modifies, aucun nouvel
asset statique ce lot). Aucun changement de regles Firestore/Cloud
Functions - modification 100% cote client, aucune touche a `functions/**`.
Meme limite de verification que le reste des chantiers visuels de ce
projet : valide par tests structurels/comportementaux (dont le nouveau gap
de mock ci-dessus, corrige) + lint, **pas confirme visuellement dans un
vrai navigateur** - a confirmer par l'utilisateur. Suite (idees #1, #2, #5,
#6, #7, #10, #16, #18, #23) a livrer dans un/des lot(s) suivant(s).
