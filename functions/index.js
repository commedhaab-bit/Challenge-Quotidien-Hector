const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
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

// =============================================================================
// Phase 1 : classement precalcule cote serveur (aggregateLeaderboard + getMyRank)
// =============================================================================
// Remplace l'ancien mecanisme 100% client (Top 50 par .limit() + 2 requetes
// ciblees "voisins" pour approx. le rang) : desormais UNE SEULE lecture complete
// de la collection leaderboard, partagee par TOUT LE MONDE (executee une fois par
// cycle planifie), au lieu d'une lecture par visite d'onglet cote client.

const LEADERBOARD_VIEWS = { streaks: 'streakCount', weekly: 'xpWeekly', alltime: 'xpTotal' };
const LEADERBOARD_TOP_N = 100;

function leaderboardFieldForView(view) {
  return LEADERBOARD_VIEWS[view] || 'xpTotal';
}

// Equivalents server-side de dateKey()/mondayOfWeek() (index.html), qui operent eux
// en heure LOCALE du navigateur - ici en UTC (deterministe, independant de la region
// d'execution de la fonction). Un ecart de quelques dizaines de minutes est possible
// tres exactement au moment du changement de semaine (dimanche 23h/minuit UTC selon
// la saison, vs minuit heure de Paris) : accepte, s'auto-corrige au prochain passage
// de aggregateLeaderboard (15 min) - meme tolerance que le reste du cache TTL cote
// client. Utilise UNIQUEMENT par aggregateLeaderboard (pas de client a interroger) ;
// getMyRank recoit au contraire le weekStart directement du client (voir plus bas),
// pour rester coherent avec la valeur que CE client a lui-meme ecrite dans xpWeekStart.
function dateKeyUTC(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function mondayOfWeekUTC(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=dim..6=sam
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return dateKeyUTC(date);
}

// Pure (aucun acces Firestore) : calcule les 3 payloads de cache a partir d'un
// tableau simple de documents leaderboard deja lus - testable directement avec de
// simples tableaux JS, sans emulateur Firestore. `docs` : [{ uid, displayName,
// photoURL, streakCount, xpTotal, xpWeekly, xpWeekStart }, ...].
function computeLeaderboardCaches(docs, weekStart) {
  const caches = {};
  for (const [view, field] of Object.entries(LEADERBOARD_VIEWS)) {
    const pool = view === 'weekly' ? docs.filter((d) => d.xpWeekStart === weekStart) : docs;
    const sorted = [...pool].sort((a, b) => (b[field] || 0) - (a[field] || 0)).slice(0, LEADERBOARD_TOP_N);
    caches[view] = {
      entries: sorted.map((d) => ({
        uid: d.uid,
        displayName: d.displayName || '',
        photoURL: d.photoURL || '',
        value: d[field] || 0,
        kudosTotal: d.kudosTotal || 0,
      })),
      totalCount: pool.length,
    };
  }
  return caches;
}

// Scheduled Function (15 min) : LA SEULE fonction a lire l'integralite de la
// collection leaderboard. N'ECRIT JAMAIS sur les documents individuels
// leaderboard/{uid} (ecrire un rang sur chaque utilisateur a chaque passage aurait
// fait exploser le quota gratuit d'ecritures des quelques centaines d'utilisateurs,
// voir CLAUDE.md) : seulement 3 documents leaderboardCache/{view} par execution,
// quelle que soit la taille de la communaute.
exports.aggregateLeaderboard = onSchedule('every 15 minutes', async () => {
  const db = admin.firestore();
  const snap = await db.collection('leaderboard').get();
  const docs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const weekStart = mondayOfWeekUTC(new Date());
  const caches = computeLeaderboardCaches(docs, weekStart);

  const batch = db.batch();
  for (const [view, payload] of Object.entries(caches)) {
    batch.set(db.collection('leaderboardCache').doc(view), { ...payload, updatedAt: Date.now() });
  }
  await batch.commit();
});

// Callable : rang exact pour un utilisateur HORS du Top 100 mis en cache - calcule
// A LA DEMANDE seulement (jamais un balayage proactif de toute la communaute).
// `weekStart` est fourni par le CLIENT (deja calcule en heure locale, coherent avec
// la valeur qu'il a lui-meme ecrite dans xpWeekStart) plutot que recalcule ici, pour
// eviter tout ecart de fuseau horaire avec un calcul purement serveur (UTC).
exports.getMyRank = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const view = request.data && request.data.view;
  const weekStart = request.data && request.data.weekStart;
  if (!Object.prototype.hasOwnProperty.call(LEADERBOARD_VIEWS, view)) {
    throw new HttpsError('invalid-argument', 'Vue de classement inconnue.');
  }
  const field = leaderboardFieldForView(view);
  const db = admin.firestore();
  const myDoc = await db.collection('leaderboard').doc(request.auth.uid).get();
  if (!myDoc.exists) return { rank: null, value: 0 };
  const myValue = myDoc.data()[field] || 0;

  let query = db.collection('leaderboard');
  if (view === 'weekly') query = query.where('xpWeekStart', '==', weekStart);
  query = query.where(field, '>', myValue);
  const countSnap = await query.count().get();
  return { rank: countSnap.data().count + 1, value: myValue };
});

// Exposees uniquement pour les tests unitaires (logique pure, sans Firestore) -
// voir functions/test/leaderboard.test.js.
module.exports.__testables = {
  computeLeaderboardCaches,
  leaderboardFieldForView,
  mondayOfWeekUTC,
  dateKeyUTC,
};
