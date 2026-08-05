const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
// Region europe-west1 (Belgique) : plus proche de la base d'utilisateurs actuelle
// (France/Espagne) que la region par defaut us-central1 - a ajuster si besoin.
setGlobalOptions({ region: 'europe-west1' });

// Phase 0 : valide la chaine complete outillage -> CI -> deploiement Blaze avant
// d'ecrire la moindre logique metier (aggregateLeaderboard, closeExpiredGroupChallenges,
// applyGroupJoker, aggregateGroupContribution - voir le plan). Ne fait rien d'autre
// que confirmer que les Cloud Functions sont bien deployees et joignables.
exports.helloWorld = onCall((request) => {
  return { message: 'Cloud Functions Phase 0 : chaine de deploiement operationnelle.' };
});
