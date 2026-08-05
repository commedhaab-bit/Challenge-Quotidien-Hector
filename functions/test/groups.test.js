const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const {
  computeSettlementPairs, detectClutchWin, shouldSettleChallenge, computeCreditedAmount,
  rankForSettlement, applyDoublonMultiplier, computeRaidSettlementPairs,
} = __testables;

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

// --- computeCreditedAmount() ---
// Bug reel signale en prod : un objectif de 100 avec 60 deja loggues par un membre,
// puis 60 loggues par un 2e membre, affichait "120/100" indefiniment (chaque membre
// incrementait directement son propre doc, sans jamais voir le total des autres).
// Desormais le serveur plafonne exactement au restant.

test('computeCreditedAmount() : sous la cible -> credite le montant complet', () => {
  assert.equal(computeCreditedAmount(60, 0, 100), 60);
});

test('computeCreditedAmount() : depasserait la cible -> ne credite que le restant exact (60 puis 40, jamais 120/100)', () => {
  assert.equal(computeCreditedAmount(60, 60, 100), 40);
});

test('computeCreditedAmount() : cible deja atteinte -> plus rien a crediter', () => {
  assert.equal(computeCreditedAmount(10, 100, 100), 0);
  assert.equal(computeCreditedAmount(10, 150, 100), 0);
});

test('computeCreditedAmount() : pile la cible -> credite exactement le restant', () => {
  assert.equal(computeCreditedAmount(40, 60, 100), 40);
});

test('computeCreditedAmount() : targetTotal absent/0 -> jamais de plafond', () => {
  assert.equal(computeCreditedAmount(500, 0, 0), 500);
  assert.equal(computeCreditedAmount(500, 1000, undefined), 500);
});

// --- Phase 4 : Jokers tactiques ---

test('rankForSettlement() : sans joker, meme ordre que le classement brut (par totalAmount)', () => {
  const ranked = [{ uid: 'a', totalAmount: 100 }, { uid: 'b', totalAmount: 50 }];
  assert.deepEqual(rankForSettlement(ranked).map((p) => p.uid), ['a', 'b']);
});

test('rankForSettlement() : Immunite Swiss retire totalement le participant du classement de reglement', () => {
  const ranked = [{ uid: 'a', totalAmount: 100 }, { uid: 'b', totalAmount: 50, immune: true }];
  const result = rankForSettlement(ranked);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, 'a');
});

test('rankForSettlement() : Le Boulet (handicap) peut faire chuter la cible sous un adversaire moins performant', () => {
  const ranked = [{ uid: 'a', totalAmount: 80, handicap: 30 }, { uid: 'b', totalAmount: 60 }];
  // a a reellement fait plus (80 > 60), mais son handicap de 30 le fait tomber a un
  // effectiveAmount de 50, sous les 60 de b -> b doit desormais etre classe 1er.
  const result = rankForSettlement(ranked);
  assert.deepEqual(result.map((p) => p.uid), ['b', 'a']);
});

test('rankForSettlement() : le handicap ne fait jamais descendre l effectiveAmount sous 0', () => {
  const ranked = [{ uid: 'a', totalAmount: 10, handicap: 999 }];
  assert.equal(rankForSettlement(ranked)[0].effectiveAmount, 0);
});

test('rankForSettlement() : le totalAmount BRUT (stats Hall of Fame) n est jamais modifie par le handicap', () => {
  const ranked = [{ uid: 'a', totalAmount: 80, handicap: 30 }];
  assert.equal(rankForSettlement(ranked)[0].totalAmount, 80, 'le vrai totalAmount doit rester intact, seul effectiveAmount change');
});

test('applyDoublonMultiplier() : fenetre active (doublonActiveUntil dans le futur) -> montant double', () => {
  assert.equal(applyDoublonMultiplier(10, Date.now() + 60000, Date.now()), 20);
});

test('applyDoublonMultiplier() : fenetre expiree ou absente -> montant inchange', () => {
  assert.equal(applyDoublonMultiplier(10, Date.now() - 1000, Date.now()), 10);
  assert.equal(applyDoublonMultiplier(10, undefined, Date.now()), 10);
  assert.equal(applyDoublonMultiplier(10, null, Date.now()), 10);
});

// --- Phase 5 : Raids Express ---
// Pari BINAIRE createur-vs-groupe, enjeu FIXE et INVERSE (pas de classement N-way
// comme computeSettlementPairs) : succes -> le createur offre a tout le monde ;
// echec -> le groupe doit au createur.

test('computeRaidSettlementPairs() : succes -> le createur doit une entree a CHACUN des autres', () => {
  const pairs = computeRaidSettlementPairs('createur', ['createur', 'a', 'b'], true);
  assert.deepEqual(pairs, [
    { fromUid: 'createur', toUid: 'a' },
    { fromUid: 'createur', toUid: 'b' },
  ]);
});

test('computeRaidSettlementPairs() : echec -> CHACUN des autres doit une entree au createur', () => {
  const pairs = computeRaidSettlementPairs('createur', ['createur', 'a', 'b'], false);
  assert.deepEqual(pairs, [
    { fromUid: 'a', toUid: 'createur' },
    { fromUid: 'b', toUid: 'createur' },
  ]);
});

test('computeRaidSettlementPairs() : le createur seul (aucun autre participant) -> aucune entree', () => {
  assert.deepEqual(computeRaidSettlementPairs('createur', ['createur'], true), []);
  assert.deepEqual(computeRaidSettlementPairs('createur', ['createur'], false), []);
});

test('computeRaidSettlementPairs() : le createur n apparait jamais comme "autre" (jamais d entree createur->createur)', () => {
  const pairs = computeRaidSettlementPairs('createur', ['createur', 'a'], true);
  assert.ok(!pairs.some((p) => p.fromUid === 'createur' && p.toUid === 'createur'));
  assert.equal(pairs.length, 1);
});
