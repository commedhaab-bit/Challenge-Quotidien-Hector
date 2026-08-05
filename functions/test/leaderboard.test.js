const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const { computeLeaderboardCaches, leaderboardFieldForView, mondayOfWeekUTC, dateKeyUTC } = __testables;

// Ces tests couvrent uniquement la logique PURE (aucun acces Firestore reel) :
// aggregateLeaderboard/getMyRank eux-memes ne sont verifies qu'en production apres
// deploiement (pas d'emulateur Firestore branche pour l'instant, voir CLAUDE.md).

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

test('computeLeaderboardCaches() trie chaque vue par son propre champ, decroissant, et plafonne a 100', () => {
  const docs = [
    { uid: 'a', displayName: 'Alice', streakCount: 10, xpTotal: 500, xpWeekly: 50, xpWeekStart: '2026-01-05' },
    { uid: 'b', displayName: 'Bob', streakCount: 8, xpTotal: 300, xpWeekly: 90, xpWeekStart: '2026-01-05' },
    { uid: 'c', displayName: 'Chloe', streakCount: 5, xpTotal: 150, xpWeekly: 20, xpWeekStart: '2026-01-05' },
  ];
  const caches = computeLeaderboardCaches(docs, '2026-01-05');
  assert.deepEqual(caches.streaks.entries.map((e) => e.uid), ['a', 'b', 'c'], 'streaks doit trier par streakCount decroissant');
  assert.deepEqual(caches.alltime.entries.map((e) => e.uid), ['a', 'b', 'c'], 'alltime doit trier par xpTotal decroissant');
  assert.deepEqual(caches.weekly.entries.map((e) => e.uid), ['b', 'a', 'c'], 'weekly doit trier par xpWeekly decroissant');
  assert.equal(caches.alltime.entries[0].value, 500, 'la valeur exposee doit correspondre au champ de la vue (xpTotal pour alltime)');
  assert.equal(caches.streaks.totalCount, 3);

  const many = Array.from({ length: 150 }, (_, i) => ({ uid: 'u' + i, displayName: 'U' + i, streakCount: 0, xpTotal: i, xpWeekly: 0, xpWeekStart: '2026-01-05' }));
  const cachesMany = computeLeaderboardCaches(many, '2026-01-05');
  assert.equal(cachesMany.alltime.entries.length, 100, 'chaque vue doit etre plafonnee a 100 entrees, meme avec plus de monde');
  assert.equal(cachesMany.alltime.totalCount, 150, 'totalCount doit refleter le nombre REEL de participants, pas la taille plafonnee du tableau entries');
});

test('computeLeaderboardCaches() : la vue weekly ne compte que les xpWeekStart == semaine courante', () => {
  const docs = [
    { uid: 'a', displayName: 'Alice', streakCount: 1, xpTotal: 1, xpWeekly: 40, xpWeekStart: '2026-01-05' },
    { uid: 'b', displayName: 'Bob (semaine precedente)', streakCount: 1, xpTotal: 1, xpWeekly: 999, xpWeekStart: '2025-12-29' },
  ];
  const caches = computeLeaderboardCaches(docs, '2026-01-05');
  assert.deepEqual(caches.weekly.entries.map((e) => e.uid), ['a'], 'un xpWeekly d une semaine precedente jamais rafraichi ne doit pas apparaitre dans la vue hebdomadaire courante');
  assert.equal(caches.weekly.totalCount, 1);
  // Les vues streaks/alltime, elles, ne filtrent jamais par semaine.
  assert.deepEqual(caches.alltime.entries.map((e) => e.uid).sort(), ['a', 'b'], 'les vues non-hebdomadaires ne doivent jamais filtrer par xpWeekStart');
});
