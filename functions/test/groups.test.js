const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const { computeSettlementPairs, detectClutchWin, shouldSettleChallenge } = __testables;

// Ces tests couvrent uniquement la logique PURE de reglement (aucun acces
// Firestore reel) - closeExpiredGroupChallenges lui-meme n'est verifie qu'en
// production apres deploiement (pas d'emulateur Firestore branche pour l'instant,
// voir CLAUDE.md).

function ranked(...uids) {
  // Simule des participants deja RANGES par totalAmount decroissant (rang 0 = 1er) -
  // les valeurs elles-memes n'importent pas a computeSettlementPairs, seul l'ORDRE compte.
  return uids.map((uid) => ({ uid, totalAmount: 0 }));
}

test('50/50 pair (N=6) : appairage symetrique i <-> N-1-i, tout le monde couvert', () => {
  const pairs = computeSettlementPairs(ranked('a', 'b', 'c', 'd', 'e', 'f'), '5050');
  assert.deepEqual(pairs, [
    { fromUid: 'f', toUid: 'a' },
    { fromUid: 'e', toUid: 'b' },
    { fromUid: 'd', toUid: 'c' },
  ]);
});

test('50/50 impair (N=5) : les 2 premiers gagnent, les 2 derniers payent, le milieu exact est en Zone Neutre', () => {
  const pairs = computeSettlementPairs(ranked('a', 'b', 'c', 'd', 'e'), '5050');
  assert.deepEqual(pairs, [
    { fromUid: 'e', toUid: 'a' },
    { fromUid: 'd', toUid: 'b' },
  ]);
  assert.ok(!pairs.some((p) => p.fromUid === 'c' || p.toUid === 'c'), 'le participant du milieu (c, rang 3 sur 5) ne doit apparaitre dans aucune entree');
});

test('lastPaysAll : le dernier doit une entree a CHACUN des autres, jamais l inverse', () => {
  const pairs = computeSettlementPairs(ranked('a', 'b', 'c'), 'lastPaysAll');
  assert.deepEqual(pairs, [
    { fromUid: 'c', toUid: 'a' },
    { fromUid: 'c', toUid: 'b' },
  ]);
});

test('winnerTakesAll : chacun des autres doit une entree au 1er, jamais l inverse', () => {
  const pairs = computeSettlementPairs(ranked('a', 'b', 'c'), 'winnerTakesAll');
  assert.deepEqual(pairs, [
    { fromUid: 'b', toUid: 'a' },
    { fromUid: 'c', toUid: 'a' },
  ]);
});

test('friendly : jamais aucune entree, quel que soit le nombre de participants', () => {
  assert.deepEqual(computeSettlementPairs(ranked('a', 'b', 'c', 'd'), 'friendly'), []);
});

test('cas limites : 0 ou 1 participant ne doit jamais produire d entree, quel que soit le mode', () => {
  for (const mode of ['5050', 'lastPaysAll', 'winnerTakesAll', 'friendly']) {
    assert.deepEqual(computeSettlementPairs([], mode), [], `mode ${mode}, 0 participant`);
    assert.deepEqual(computeSettlementPairs(ranked('a'), mode), [], `mode ${mode}, 1 participant`);
  }
});

test('50/50 avec exactement 2 participants : une seule entree, le perdant paye le gagnant', () => {
  assert.deepEqual(computeSettlementPairs(ranked('a', 'b'), '5050'), [{ fromUid: 'b', toUid: 'a' }]);
});

// --- detectClutchWin() (Phase 3, Hall of Fame) ---
// Defi de 1000ms (0 -> 1000), fenetre "derniere minute" = les 25% finaux = [750, 1000].
const START = 0;
const END = 1000;

test('detectClutchWin() : vrai comeback - sans les contributions tardives, le 2e serait passe devant', () => {
  const rankedParticipants = [
    { uid: 'winner', totalAmount: 100 }, // 1er au final
    { uid: 'runnerUp', totalAmount: 90 }, // 2e au final
  ];
  // Le gagnant n avait que 50 avant la derniere fenetre (750-1000) : sans les 50
  // derniers, il aurait ete a 50 < 90 (le 2e) -> vrai comeback.
  const events = [
    { uid: 'winner', amount: 50, at: 500 },
    { uid: 'winner', amount: 50, at: 900 }, // dans la derniere fenetre
    { uid: 'runnerUp', amount: 90, at: 500 },
  ];
  assert.equal(detectClutchWin(rankedParticipants, events, START, END), 'winner');
});

test('detectClutchWin() : pas de comeback - le gagnant etait deja devant avant la derniere fenetre', () => {
  const rankedParticipants = [
    { uid: 'winner', totalAmount: 100 },
    { uid: 'runnerUp', totalAmount: 90 },
  ];
  // Le gagnant avait deja 95 avant la derniere fenetre (95 > 90) : les 5 derniers
  // points ne changent rien au resultat -> pas un comeback, juste une victoire nette.
  const events = [
    { uid: 'winner', amount: 95, at: 100 },
    { uid: 'winner', amount: 5, at: 900 },
    { uid: 'runnerUp', amount: 90, at: 100 },
  ];
  assert.equal(detectClutchWin(rankedParticipants, events, START, END), null);
});

test('detectClutchWin() : moins de 2 participants -> jamais de clutch win', () => {
  assert.equal(detectClutchWin([{ uid: 'solo', totalAmount: 10 }], [], START, END), null);
  assert.equal(detectClutchWin([], [], START, END), null);
});

test('detectClutchWin() : aucune contribution tardive -> pas de comeback a detecter', () => {
  const rankedParticipants = [
    { uid: 'winner', totalAmount: 100 },
    { uid: 'runnerUp', totalAmount: 90 },
  ];
  const events = [
    { uid: 'winner', amount: 100, at: 100 },
    { uid: 'runnerUp', amount: 90, at: 100 },
  ];
  assert.equal(detectClutchWin(rankedParticipants, events, START, END), null);
});

// --- shouldSettleChallenge() ---
// Bug reel signale en prod : un defi de groupe a 125/100 (objectif depasse) restait
// affiche comme actif indefiniment, sans Ardoise ni Palmares, car le reglement
// n'etait alors declenche QUE par l'echeance (endDate). Corrige en ajoutant un 2e
// declencheur : objectif atteint, peu importe l'echeance.

test('shouldSettleChallenge() : objectif atteint avant l echeance -> regler des maintenant', () => {
  assert.equal(shouldSettleChallenge(125, 100, /* endDate */ Date.now() + 999999, /* now */ Date.now()), true);
});

test('shouldSettleChallenge() : objectif tout juste atteint (egalite) -> regler', () => {
  assert.equal(shouldSettleChallenge(100, 100, Date.now() + 999999, Date.now()), true);
});

test('shouldSettleChallenge() : objectif non atteint mais echeance depassee -> regler quand meme (filet de securite)', () => {
  assert.equal(shouldSettleChallenge(40, 100, /* endDate */ 1000, /* now */ 2000), true);
});

test('shouldSettleChallenge() : objectif non atteint et echeance future -> ne pas regler', () => {
  assert.equal(shouldSettleChallenge(40, 100, /* endDate */ 2000, /* now */ 1000), false);
});

test('shouldSettleChallenge() : targetTotal absent/0 -> seule l echeance compte', () => {
  assert.equal(shouldSettleChallenge(0, 0, 1000, 2000), true);
  assert.equal(shouldSettleChallenge(0, 0, 2000, 1000), false);
});
