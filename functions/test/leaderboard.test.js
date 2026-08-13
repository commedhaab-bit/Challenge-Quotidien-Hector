const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const { buildLeaderboardCaches, leaderboardFieldForView, mondayOfWeekUTC, dateKeyUTC } = __testables;

// Ces tests couvrent uniquement la logique PURE (aucun acces Firestore reel) :
// aggregateLeaderboard/getMyRank eux-memes ne sont verifies qu'en production apres
// deploiement (pas d'emulateur Firestore branche pour l'instant, voir CLAUDE.md).
// Depuis l'audit quota (retour utilisateur), aggregateLeaderboard ne recoit plus
// TOUTE la collection pour trier/filtrer/compter en memoire ici - le tri/filtrage/
// plafonnage est desormais fait par 3 requetes Firestore BORNEES (orderBy+limit(100)
// + .where(xpWeekStart) pour la vue hebdo) et 2 agregations .count() separees ;
// buildLeaderboardCaches() ne fait plus que PROJETER des tableaux deja tries/limites
// vers le payload attendu par le client, sans plus jamais dependre de la taille
// totale de `leaderboard`.

test('leaderboardFieldForView() associe chaque vue au bon champ', () => {
  assert.equal(leaderboardFieldForView('streaks'), 'streakCount');
  assert.equal(leaderboardFieldForView('weekly'), 'xpWeekly');
  assert.equal(leaderboardFieldForView('alltime'), 'xpTotal');
});

test('dateKeyUTC()/mondayOfWeekUTC() : meme format YYYY-MM-DD que dateKey() cote client', () => {
  assert.equal(dateKeyUTC(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
  // Lundi 5 janvier 2026 est deja un lundi -> doit rester inchange.
  assert.equal(mondayOfWeekUTC(new Date(Date.UTC(2026, 0, 5, 10))), '2026-01-05');
  // Vendredi 9 janvier 2026 -> lundi de la meme semaine (5 janvier).
  assert.equal(mondayOfWeekUTC(new Date(Date.UTC(2026, 0, 9, 23))), '2026-01-05');
  // Dimanche 11 janvier 2026 -> encore la semaine du 5 janvier (dimanche = fin de semaine, pas debut).
  assert.equal(mondayOfWeekUTC(new Date(Date.UTC(2026, 0, 11, 23))), '2026-01-05');
});

test('buildLeaderboardCaches() projette chaque vue depuis SON PROPRE tableau deja trie, sur le bon champ', () => {
  const streaksDocs = [
    { uid: 'a', displayName: 'Alice', streakCount: 10 },
    { uid: 'b', displayName: 'Bob', streakCount: 8 },
  ];
  const xpDocs = [
    { uid: 'a', displayName: 'Alice', xpTotal: 500 },
    { uid: 'c', displayName: 'Chloe', xpTotal: 150 },
  ];
  const weeklyDocs = [
    { uid: 'b', displayName: 'Bob', xpWeekly: 90 },
    { uid: 'a', displayName: 'Alice', xpWeekly: 50 },
  ];
  const caches = buildLeaderboardCaches({ streaksDocs, xpDocs, weeklyDocs, totalCount: 3, weeklyCount: 2 });
  assert.deepEqual(caches.streaks.entries.map((e) => e.uid), ['a', 'b'], 'streaks doit refleter l ordre DEJA fourni (trie par la requete Firestore, jamais re-trie ici)');
  assert.equal(caches.streaks.entries[0].value, 10, 'streaks doit exposer streakCount comme "value"');
  assert.deepEqual(caches.alltime.entries.map((e) => e.uid), ['a', 'c']);
  assert.equal(caches.alltime.entries[0].value, 500, 'alltime doit exposer xpTotal comme "value"');
  assert.deepEqual(caches.weekly.entries.map((e) => e.uid), ['b', 'a']);
  assert.equal(caches.weekly.entries[0].value, 90, 'weekly doit exposer xpWeekly comme "value"');
});

test('buildLeaderboardCaches() : totalCount/weeklyCount viennent des agregations .count() fournies, jamais de la longueur des tableaux (deja plafonnes a 100)', () => {
  // Simule le cas reel : 150 comptes au total, mais les tableaux *Docs sont deja
  // plafonnes a 100 par le orderBy+limit() de la requete Firestore (voir
  // aggregateLeaderboard) - totalCount doit refleter les 150 REELS, pas 100.
  const streaksDocs = Array.from({ length: 100 }, (_, i) => ({ uid: 'u' + i, streakCount: 100 - i }));
  const caches = buildLeaderboardCaches({ streaksDocs, xpDocs: [], weeklyDocs: [], totalCount: 150, weeklyCount: 42 });
  assert.equal(caches.streaks.entries.length, 100, 'entries garde le plafond de 100 tel que fourni (deja impose par la requete, pas par cette fonction)');
  assert.equal(caches.streaks.totalCount, 150, 'totalCount doit venir de l agregation .count() fournie, pas de entries.length');
  assert.equal(caches.alltime.totalCount, 150, 'alltime et streaks partagent le meme totalCount (population totale, non filtree par semaine)');
  assert.equal(caches.weekly.totalCount, 42, 'weekly doit utiliser weeklyCount (population filtree par xpWeekStart), distinct de totalCount');
});

test('buildLeaderboardCaches() : replis surs sur des champs manquants (displayName/photoURL/kudosTotal absents, value absente -> 0)', () => {
  const caches = buildLeaderboardCaches({
    streaksDocs: [{ uid: 'x' }], // aucun champ optionnel
    xpDocs: [],
    weeklyDocs: [],
    totalCount: 1,
    weeklyCount: 0,
  });
  const entry = caches.streaks.entries[0];
  assert.deepEqual(entry, { uid: 'x', displayName: '', photoURL: '', value: 0, kudosTotal: 0 });
});
