const test = require('node:test');
const assert = require('node:assert/strict');

// Smoke test Phase 0 : confirme juste que le module se charge sans exception et
// exporte bien la fonction attendue avant d'ecrire la moindre logique metier.
// Les vraies fonctions (aggregateLeaderboard, closeExpiredGroupChallenges,
// applyGroupJoker, aggregateGroupContribution) auront leurs propres tests,
// idealement via firebase-functions-test + l'emulateur Firestore, aux phases suivantes.
test('le module functions/index.js expose helloWorld', () => {
  const functions = require('../index.js');
  assert.equal(typeof functions.helloWorld, 'function', 'onCall() doit renvoyer une CloudFunction (callable) exportee');
});
