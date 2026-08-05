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

// =============================================================================
// Phase 2 : Groupes & Defis Collectifs - fondations (closeExpiredGroupChallenges)
// =============================================================================
// Reglement automatique des defis de groupe a echeance, cote serveur - remplace la
// resolution paresseuse cote client envisagee dans la version 100% Spark du plan :
// desormais un seul passage planifie regle TOUS les defis expires, deterministe,
// sans dependre qu'un membre ouvre l'app.

// Pure (aucun acces Firestore) : classe les participants (deja RANGES par
// totalAmount decroissant, rang 0 = 1er) en paires gagnant/perdant selon le mode
// d'enjeu du defi. Un seul algorithme couvre le mode 50/50 pair ET impair (voir
// commentaire ci-dessous) - testable directement avec de simples tableaux JS.
function computeSettlementPairs(rankedParticipants, mode) {
  const n = rankedParticipants.length;
  if (mode === 'friendly' || n < 2) return [];

  if (mode === 'lastPaysAll') {
    const last = rankedParticipants[n - 1];
    return rankedParticipants.slice(0, n - 1).map((other) => ({ fromUid: last.uid, toUid: other.uid }));
  }
  if (mode === 'winnerTakesAll') {
    const winner = rankedParticipants[0];
    return rankedParticipants.slice(1).map((other) => ({ fromUid: other.uid, toUid: winner.uid }));
  }

  // Mode 50/50 (par defaut) : un seul algorithme pour pair ET impair - le i-eme
  // (depuis le haut, index 0) est appaire au (n-1-i)-eme (depuis le bas). Pour n
  // PAIR, la boucle couvre tout le monde (ex: n=6 -> paires (0,5)(1,4)(2,3)). Pour n
  // IMPAIR, floor(n/2) s'arrete AVANT l'element du milieu (ex: n=5 -> paires
  // (0,4)(1,3), index 2 jamais touche = Zone Neutre, ni dette ni recompense).
  const entries = [];
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const winner = rankedParticipants[i];
    const loser = rankedParticipants[n - 1 - i];
    entries.push({ fromUid: loser.uid, toUid: winner.uid });
  }
  return entries;
}

// Fraction finale de la duree d'un defi consideree comme "derniere minute" pour la
// detection d'un "Clutch Win" (voir Phase 3, Hall of Fame).
const CLUTCH_WINDOW_FRACTION = 0.25;

// Pure (aucun acces Firestore) : le 1er (rankedParticipants[0]) est-il un "Clutch
// Player" pour ce defi ? Definition retenue : un VRAI comeback, pas juste "actif en
// fin de defi" - si on retire tout ce que le 1er a contribue pendant la derniere
// fenetre (les derniers 25% de la duree du defi), le 2e serait-il passe devant (ou
// egal) ? Si oui, c'est bien la fin de defi qui a fait gagner le 1er. Retourne l'uid
// du gagnant "clutch", ou null (pas de comeback, ou moins de 2 participants).
function detectClutchWin(rankedParticipants, contributionEvents, startDate, endDate) {
  if (!rankedParticipants || rankedParticipants.length < 2) return null;
  const winner = rankedParticipants[0];
  const runnerUp = rankedParticipants[1];
  const finalWindowStart = endDate - (endDate - startDate) * CLUTCH_WINDOW_FRACTION;
  const winnerLateAmount = (contributionEvents || [])
    .filter((e) => e.uid === winner.uid && e.at >= finalWindowStart)
    .reduce((sum, e) => sum + (e.amount || 0), 0);
  const winnerEarlyTotal = (winner.totalAmount || 0) - winnerLateAmount;
  return winnerEarlyTotal <= (runnerUp.totalAmount || 0) ? winner.uid : null;
}

// Pure (aucun acces Firestore) : un defi doit-il etre regle des ce passage ? Soit
// l'objectif chiffre est deja atteint (peu importe l'echeance - un groupe qui finit
// "125/100" en avance ne doit pas attendre la date de fin pour voir son Ardoise/
// Palmares se mettre a jour), soit l'echeance est depassee (filet de securite : le
// defi se cloture quand meme si personne n'a atteint la cible a temps).
function shouldSettleChallenge(totalProgress, targetTotal, endDate, now) {
  const targetReached = (targetTotal || 0) > 0 && totalProgress >= targetTotal;
  const deadlinePassed = (endDate || 0) <= now;
  return targetReached || deadlinePassed;
}

// Scheduled Function (15 min) : cherche, TOUS GROUPES CONFONDUS (collectionGroup),
// TOUS les defis encore actifs (un seul filtre d'egalite, servi par le prefixe de
// l'index composite existant status+endDate - aucun nouvel index requis). Pour
// chacun : classe les participants, verifie via shouldSettleChallenge() si l'objectif
// est deja atteint OU l'echeance depassee, et seulement si oui calcule le reglement,
// ecrit les entrees ledger (ID deterministe, create-only - protege contre une
// re-execution de la fonction elle-meme, "at-least-once" par nature pour les
// Scheduled Functions), marque le defi 'settled', et (Phase 3) met a jour les
// compteurs Hall of Fame de chaque participant.
exports.closeExpiredGroupChallenges = onSchedule('every 15 minutes', async () => {
  const db = admin.firestore();
  const now = Date.now();
  const activeSnap = await db.collectionGroup('challenges')
    .where('status', '==', 'active')
    .get();

  for (const challengeDoc of activeSnap.docs) {
    const challenge = challengeDoc.data();
    const groupRef = challengeDoc.ref.parent.parent; // groups/{groupId}/challenges/{id} -> groups/{groupId}
    const participantsSnap = await challengeDoc.ref.collection('participants').get();
    const ranked = participantsSnap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0));
    const totalProgress = ranked.reduce((sum, p) => sum + (p.totalAmount || 0), 0);
    if (!shouldSettleChallenge(totalProgress, challenge.targetTotal, challenge.endDate, now)) continue;

    const pairs = computeSettlementPairs(ranked, challenge.stakeMode);

    // Bornee par la duree/taille du defi (pas un balayage global) : sert uniquement
    // a detecter un Clutch Win, voir detectClutchWin().
    const contributionsSnap = await challengeDoc.ref.collection('contributions').get();
    const contributionEvents = contributionsSnap.docs.map((d) => d.data());
    // challenge.createdAt (timestamp numerique) sert de "debut" pour la fenetre de
    // detection clutch, PAS challenge.startDate (simple chaine "AAAA-MM-JJ" saisie a
    // la creation, cosmetique/affichage) - createdAt correspond au moment reel ou le
    // defi devient actif et peut recevoir des contributions.
    const clutchWinnerUid = detectClutchWin(ranked, contributionEvents, challenge.createdAt, challenge.endDate);

    await db.runTransaction(async (tx) => {
      // Re-verifie sous transaction : evite un double reglement si 2 executions de
      // la fonction planifiee se chevauchent (retry "at-least-once").
      const freshChallenge = await tx.get(challengeDoc.ref);
      if (!freshChallenge.exists || freshChallenge.data().status !== 'active') return;

      for (const pair of pairs) {
        const entryId = `${challengeDoc.id}_${pair.fromUid}_${pair.toUid}`;
        const entryRef = groupRef.collection('ledger').doc(entryId);
        tx.set(entryRef, {
          challengeId: challengeDoc.id,
          fromUid: pair.fromUid,
          toUid: pair.toUid,
          stakeDescription: challenge.stakeDescription || '',
          createdAt: now,
          honoredAt: null,
          honoredBy: null,
        });
      }
      tx.set(challengeDoc.ref, { status: 'settled', settledAt: now }, { merge: true });

      // Hall of Fame (Phase 3) : rollups cumulatifs sur le doc membre, lus par le
      // CLIENT (computeGroupHallOfFameTitles(), zero lecture supplementaire - deja
      // charges avec le roster). debtsOwed incremente uniquement pour le(s) fromUid
      // des paires ci-dessus (pas de double-compte : un membre peut apparaitre dans
      // plusieurs paires seulement en mode 50/50 avec des egalites, tres rare).
      for (const pair of pairs) {
        tx.set(groupRef.collection('members').doc(pair.fromUid), { debtsOwed: admin.firestore.FieldValue.increment(1) }, { merge: true });
      }
      for (const participant of ranked) {
        tx.set(groupRef.collection('members').doc(participant.uid), {
          totalVolume: admin.firestore.FieldValue.increment(participant.totalAmount || 0),
          challengesParticipated: admin.firestore.FieldValue.increment(1),
        }, { merge: true });
      }
      if (clutchWinnerUid) {
        tx.set(groupRef.collection('members').doc(clutchWinnerUid), { clutchWins: admin.firestore.FieldValue.increment(1) }, { merge: true });
      }

      // Notification "Bilan disponible" a chaque participant (canal in-app existant,
      // toujours pas de push OS - voir CLAUDE.md).
      for (const participant of ranked) {
        const notifRef = db.collection('users').doc(participant.uid).collection('notifications').doc();
        tx.set(notifRef, {
          type: 'group_challenge_settled',
          fromUid: 'system',
          groupId: groupRef.id,
          challengeId: challengeDoc.id,
          challengeName: challenge.name || '',
          read: false,
          createdAt: now,
        });
      }
    });
  }
});

// Exposees uniquement pour les tests unitaires (logique pure, sans Firestore) -
// voir functions/test/leaderboard.test.js et functions/test/groups.test.js.
module.exports.__testables = {
  computeLeaderboardCaches,
  leaderboardFieldForView,
  mondayOfWeekUTC,
  dateKeyUTC,
  computeSettlementPairs,
  detectClutchWin,
  shouldSettleChallenge,
};
