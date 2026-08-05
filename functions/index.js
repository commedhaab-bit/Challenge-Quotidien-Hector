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

// Pure (aucun acces Firestore) : classement utilise pour le REGLEMENT financier
// uniquement (computeSettlementPairs) - distinct du classement BRUT (`ranked`, par
// totalAmount reel) qui sert lui a la progression partagee, au Clutch Win et aux
// rollups Hall of Fame. Applique les 2 jokers qui modifient le reglement (Phase 4) :
// - L'Immunite Swiss : le participant est totalement RETIRE de ce classement (ni
//   dette ni recompense), mais garde ses vraies statistiques ailleurs (Hall of Fame).
// - Le Boulet : handicap soustrait du totalAmount du CIBLE (jamais son vrai
//   totalAmount, qui reste intact pour les stats) - un handicap de 20 sur quelqu'un
//   a 80 le classe comme s'il n'avait que 60 pour le reglement uniquement.
// Le Doublon (x2 pendant 2h) n'a PAS sa place ici : il agit plus tot, directement
// sur le totalAmount reel au moment de la contribution (voir applyDoublonMultiplier
// / logGroupChallengeContribution) - une fois credite, ce montant double est un
// totalAmount comme un autre.
function rankForSettlement(ranked) {
  return ranked
    .filter((p) => !p.immune)
    .map((p) => ({ ...p, effectiveAmount: Math.max(0, (p.totalAmount || 0) - (p.handicap || 0)) }))
    .sort((a, b) => b.effectiveAmount - a.effectiveAmount);
}

// Reglement d'UN defi - partage entre le balayage planifie (filet de securite,
// ci-dessous) ET le declenchement instantane (logGroupChallengeContribution, plus
// bas) : lit l'etat FRAIS du defi, ne fait RIEN si shouldSettleChallenge() ne
// l'exige pas encore, sinon calcule le reglement et ecrit ledger + rollups Hall of
// Fame + notifications dans une seule transaction. Re-verifie le statut SOUS
// transaction (freshChallenge) : protege contre un double reglement si cette
// fonction est appelee 2 fois presque en meme temps (le sweep planifie ET une
// contribution qui atteint la cible au meme moment, ou 2 contributions
// quasi-simultanees).
async function settleChallengeIfNeeded(db, challengeRef) {
  const challengeSnap = await challengeRef.get();
  if (!challengeSnap.exists || challengeSnap.data().status !== 'active') return;
  const challenge = challengeSnap.data();
  const groupRef = challengeRef.parent.parent; // groups/{groupId}/challenges/{id} -> groups/{groupId}
  const now = Date.now();

  const participantsSnap = await challengeRef.collection('participants').get();
  const ranked = participantsSnap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0));
  const totalProgress = ranked.reduce((sum, p) => sum + (p.totalAmount || 0), 0);
  if (!shouldSettleChallenge(totalProgress, challenge.targetTotal, challenge.endDate, now)) return;

  // Jokers (Phase 4) : le classement REGLEMENT (immunite retiree, handicap Boulet
  // applique) peut differer du classement BRUT `ranked` ci-dessus - voir
  // rankForSettlement(). Le reste (Clutch Win, rollups, winnerName) continue
  // d'utiliser `ranked` (les vraies performances), inchange.
  const pairs = computeSettlementPairs(rankForSettlement(ranked), challenge.stakeMode);

  // Bornee par la duree/taille du defi (pas un balayage global) : sert uniquement a
  // detecter un Clutch Win, voir detectClutchWin().
  const contributionsSnap = await challengeRef.collection('contributions').get();
  const contributionEvents = contributionsSnap.docs.map((d) => d.data());
  // challenge.createdAt (timestamp numerique) sert de "debut" pour la fenetre de
  // detection clutch, PAS challenge.startDate (simple chaine "AAAA-MM-JJ" saisie a
  // la creation, cosmetique/affichage) - createdAt correspond au moment reel ou le
  // defi devient actif et peut recevoir des contributions.
  const clutchWinnerUid = detectClutchWin(ranked, contributionEvents, challenge.createdAt, challenge.endDate);
  // 1er contributeur (par volume) : embarque dans la notification pour un popup de
  // felicitations immediat cote client, sans lecture supplementaire.
  const winnerName = (ranked[0] && ranked[0].displayName) || '';

  await db.runTransaction(async (tx) => {
    const freshChallenge = await tx.get(challengeRef);
    if (!freshChallenge.exists || freshChallenge.data().status !== 'active') return;

    for (const pair of pairs) {
      const entryId = `${challengeRef.id}_${pair.fromUid}_${pair.toUid}`;
      tx.set(groupRef.collection('ledger').doc(entryId), {
        challengeId: challengeRef.id,
        fromUid: pair.fromUid,
        toUid: pair.toUid,
        stakeDescription: challenge.stakeDescription || '',
        createdAt: now,
        honoredAt: null,
        honoredBy: null,
      });
    }
    tx.set(challengeRef, { status: 'settled', settledAt: now }, { merge: true });

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
        challengeId: challengeRef.id,
        challengeName: challenge.name || '',
        winnerName,
        read: false,
        createdAt: now,
      });
    }
  });
}

// Scheduled Function (15 min) : FILET DE SECURITE uniquement - le reglement lui-meme
// est desormais surtout declenche INSTANTANEMENT par logGroupChallengeContribution
// des qu'une contribution atteint la cible (voir plus bas). Ce balayage ne reste
// necessaire que pour les defis dont l'ECHEANCE se depasse SANS que personne
// n'atteigne la cible (aucune ecriture pour reagir dans ce cas). Cherche, TOUS
// GROUPES CONFONDUS (collectionGroup), TOUS les defis encore actifs (un seul filtre
// d'egalite, servi par le prefixe de l'index composite existant status+endDate -
// aucun nouvel index requis) et delegue a settleChallengeIfNeeded() pour chacun.
exports.closeExpiredGroupChallenges = onSchedule('every 15 minutes', async () => {
  const db = admin.firestore();
  const activeSnap = await db.collectionGroup('challenges').where('status', '==', 'active').get();
  for (const challengeDoc of activeSnap.docs) {
    await settleChallengeIfNeeded(db, challengeDoc.ref);
  }
});

// Pure (aucun acces Firestore) : combien credite-t-on reellement pour CETTE
// contribution, une fois plafonnee exactement au restant pour atteindre la cible ?
// (ex: cible 100, deja 60 accumules, quelqu'un loggue 60 de plus -> seuls 40 sont
// credites, jamais 120/100). Sans cible chiffree (ne devrait pas arriver via le
// formulaire, mais defensif), aucun plafond.
function computeCreditedAmount(amount, currentProgress, targetTotal) {
  if (!(targetTotal > 0)) return amount;
  const remaining = Math.max(0, targetTotal - currentProgress);
  return Math.min(amount, remaining);
}

// Pure (aucun acces Firestore) : joker "Le Doublon" (Phase 4) - double le montant
// BRUT d'une contribution tant que la fenetre de 2h est active, AVANT tout
// plafonnage (computeCreditedAmount) - le doublement porte donc aussi bien sur ce
// que le participant peut faire progresser la cible partagee que sur son propre
// classement de reglement.
function applyDoublonMultiplier(amount, doublonActiveUntil, now) {
  return (doublonActiveUntil || 0) > now ? amount * 2 : amount;
}

// =============================================================================
// Correctif : plafond exact des contributions a un defi de groupe + reglement
// instantane des que la cible est atteinte (fini le "jusqu'a 15 min d'attente")
// =============================================================================
// AVANT : le client incrementait directement participants/{uid}.totalAmount (simple
// ecriture Firestore, fonctionne hors-ligne) - mais 2 membres logant chacun leur
// propre serie sans jamais se voir pouvaient faire depasser la cible (ex: 60+60 sur
// un objectif de 100, affiche "120/100" indefiniment). Desormais, TOUTE contribution
// a un defi de groupe passe par cette Callable (Admin SDK, transaction) : elle
// resomme les participants existants (borne par la taille du groupe, <=20 - jamais
// un champ separe a maintenir en parallele, donc toujours coherent avec la verite),
// plafonne exactement via computeCreditedAmount(), puis declenche
// settleChallengeIfNeeded() immediatement si la cible est atteinte. Compromis assume
// et valide explicitement : cette action necessite desormais une connexion reseau
// (contrairement au reste de l'app, 100% hors-ligne) - voir CLAUDE.md. Le doc
// participant lui-meme doit deja exister (ensureMyParticipantDoc, cote client, tou-
// jours une simple creation directe autorisee par les regles) avant cet appel.
exports.logGroupChallengeContribution = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const { groupId, challengeId, amount } = request.data || {};
  if (!groupId || !challengeId || !(amount > 0)) {
    throw new HttpsError('invalid-argument', 'groupId, challengeId et amount (> 0) sont requis.');
  }

  const db = admin.firestore();
  const challengeRef = db.collection('groups').doc(groupId).collection('challenges').doc(challengeId);
  const participantRef = challengeRef.collection('participants').doc(uid);

  const outcome = await db.runTransaction(async (tx) => {
    const challengeSnap = await tx.get(challengeRef);
    if (!challengeSnap.exists || challengeSnap.data().status !== 'active') {
      return { credited: 0, reachedTarget: false };
    }
    const challenge = challengeSnap.data();
    const participantsSnap = await tx.get(challengeRef.collection('participants'));
    const currentProgress = participantsSnap.docs.reduce((sum, d) => sum + (d.data().totalAmount || 0), 0);
    const myDoc = participantsSnap.docs.find((d) => d.id === uid);
    // Joker "Le Doublon" (Phase 4) : double le montant BRUT avant tout plafonnage,
    // tant que la fenetre de 2h (doublonActiveUntil) est active.
    const doubledAmount = applyDoublonMultiplier(amount, myDoc && myDoc.data().doublonActiveUntil, Date.now());
    const credited = computeCreditedAmount(doubledAmount, currentProgress, challenge.targetTotal);
    if (credited <= 0) {
      return { credited: 0, reachedTarget: (challenge.targetTotal || 0) > 0 && currentProgress >= challenge.targetTotal };
    }

    const prevAmount = myDoc ? (myDoc.data().totalAmount || 0) : 0;
    tx.set(participantRef, { totalAmount: prevAmount + credited }, { merge: true });
    tx.set(challengeRef.collection('contributions').doc(), { uid, amount: credited, at: Date.now() });

    return { credited, reachedTarget: (challenge.targetTotal || 0) > 0 && (currentProgress + credited) >= challenge.targetTotal };
  });

  if (outcome.reachedTarget) {
    await settleChallengeIfNeeded(db, challengeRef);
  }
  return outcome;
});

// =============================================================================
// Phase 4 : Jokers tactiques (applyGroupJoker)
// =============================================================================
// UN SEUL joker par participant et par defi (ressource rare, choix tactique) :
// - 'doublon'   : double mes propres contributions pendant 2h (voir
//                 applyDoublonMultiplier(), applique par logGroupChallengeContribution).
// - 'boulet'    : handicap de 20 sur un ADVERSAIRE (targetUid, jamais moi-meme) pour
//                 le classement de reglement uniquement (voir rankForSettlement()) -
//                 son vrai totalAmount et ses stats Hall of Fame restent intacts.
// - 'immunite'  : m'exclut moi-meme du reglement financier (ni dette ni recompense),
//                 mes stats Hall of Fame restent comptees normalement.
// Ecrit exclusivement via cette Callable (Admin SDK) : les regles Firestore
// n'autorisent le client qu'a CREER son propre doc participant, jamais a le
// modifier ensuite (voir firestore.rules) - et surtout jamais a ecrire dans le doc
// d'un tiers (necessaire pour 'boulet').
const JOKER_TYPES = ['doublon', 'boulet', 'immunite'];
const BOULET_HANDICAP = 20;
const DOUBLON_DURATION_MS = 2 * 3600 * 1000;

exports.applyGroupJoker = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const { groupId, challengeId, jokerType, targetUid } = request.data || {};
  if (!groupId || !challengeId || !JOKER_TYPES.includes(jokerType)) {
    throw new HttpsError('invalid-argument', 'groupId, challengeId et un jokerType valide sont requis.');
  }
  if (jokerType === 'boulet' && (!targetUid || targetUid === uid)) {
    throw new HttpsError('invalid-argument', 'Le Boulet exige une cible, differente de soi-meme.');
  }

  const db = admin.firestore();
  const challengeRef = db.collection('groups').doc(groupId).collection('challenges').doc(challengeId);
  const participantRef = challengeRef.collection('participants').doc(uid);
  const targetRef = jokerType === 'boulet' ? challengeRef.collection('participants').doc(targetUid) : null;

  await db.runTransaction(async (tx) => {
    const challengeSnap = await tx.get(challengeRef);
    if (!challengeSnap.exists || challengeSnap.data().status !== 'active') {
      throw new HttpsError('failed-precondition', 'Ce defi n est plus actif.');
    }
    const participantSnap = await tx.get(participantRef);
    if (participantSnap.exists && participantSnap.data().jokerUsed) {
      throw new HttpsError('failed-precondition', 'Un seul joker par defi - deja utilise.');
    }
    const targetSnap = targetRef ? await tx.get(targetRef) : null;
    if (targetRef && (!targetSnap || !targetSnap.exists)) {
      throw new HttpsError('not-found', 'Cible introuvable dans ce defi.');
    }

    if (jokerType === 'doublon') {
      tx.set(participantRef, { jokerUsed: 'doublon', doublonActiveUntil: Date.now() + DOUBLON_DURATION_MS }, { merge: true });
    } else if (jokerType === 'immunite') {
      tx.set(participantRef, { jokerUsed: 'immunite', immune: true }, { merge: true });
    } else if (jokerType === 'boulet') {
      tx.set(participantRef, { jokerUsed: 'boulet', jokerTargetUid: targetUid }, { merge: true });
      tx.set(targetRef, { handicap: admin.firestore.FieldValue.increment(BOULET_HANDICAP) }, { merge: true });
    }
  });

  return { ok: true };
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
  computeCreditedAmount,
  rankForSettlement,
  applyDoublonMultiplier,
};
