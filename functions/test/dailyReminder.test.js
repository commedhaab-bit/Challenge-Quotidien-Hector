const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const { computeUidsNeedingDailyReminder } = __testables;

// Idee bonus #17 (retour utilisateur, rappel du soir si rien fait) : logique
// PURE de selection des uids a notifier, testee sans Firestore - voir
// sendDailyReminderPush() dans index.js pour l'I/O (collectionGroup('pushTokens') +
// lecture appData par uid + ecriture des notifications elles-memes).

test('computeUidsNeedingDailyReminder() : un uid sans aucune activite aujourd\'hui doit etre notifie', () => {
  const appDataByUid = new Map([
    ['uid1', { dailyActivity: { '2026-01-01': 2 } }], // activite un AUTRE jour seulement
  ]);
  assert.deepEqual(computeUidsNeedingDailyReminder(['uid1'], appDataByUid, '2026-01-02'), ['uid1']);
});

test('computeUidsNeedingDailyReminder() : un uid ayant deja valide au moins 1 defi aujourd\'hui ne doit PAS etre notifie', () => {
  const appDataByUid = new Map([
    ['uid1', { dailyActivity: { '2026-01-02': 1 } }],
  ]);
  assert.deepEqual(computeUidsNeedingDailyReminder(['uid1'], appDataByUid, '2026-01-02'), []);
});

test('computeUidsNeedingDailyReminder() : un uid SANS document appData (compte tout juste cree) doit etre traite comme "rien fait" -> notifie', () => {
  const appDataByUid = new Map(); // aucune entree pour uid1
  assert.deepEqual(computeUidsNeedingDailyReminder(['uid1'], appDataByUid, '2026-01-02'), ['uid1']);
});

test('computeUidsNeedingDailyReminder() : un uid avec un appData mais sans champ dailyActivity du tout doit aussi etre notifie', () => {
  const appDataByUid = new Map([
    ['uid1', { xpTotal: 500 }], // pas de dailyActivity
  ]);
  assert.deepEqual(computeUidsNeedingDailyReminder(['uid1'], appDataByUid, '2026-01-02'), ['uid1']);
});

test('computeUidsNeedingDailyReminder() : filtre correctement un melange d\'uids actifs/inactifs, en preservant l\'ordre d\'entree', () => {
  const appDataByUid = new Map([
    ['actif-1', { dailyActivity: { '2026-01-02': 3 } }],
    ['inactif-1', { dailyActivity: { '2026-01-01': 5 } }],
    ['inactif-2', {}],
  ]);
  assert.deepEqual(
    computeUidsNeedingDailyReminder(['actif-1', 'inactif-1', 'inactif-2'], appDataByUid, '2026-01-02'),
    ['inactif-1', 'inactif-2']
  );
});
