const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();
// Region europe-west1 (Belgique) : plus proche de la base d'utilisateurs actuelle
// (France/Espagne) que la region par defaut us-central1 - a ajuster si besoin.
setGlobalOptions({ region: 'europe-west1' });

// Note deploiement : le premier trigger Firestore (onDocumentCreated, voir
// sendPushOnNotificationCreate plus bas) a necessite 3 bindings IAM
// supplementaires accordes manuellement par le proprietaire du projet - voir
// CLAUDE.md pour le detail exact (roles + comptes de service concernes). Une
// fois ces bindings accordes, le tout premier deploiement peut encore echouer
// une fois de plus avec "Permission denied while using the Eventarc Service
// Agent" (propagation du role, message Firebase explicite : "retry in a few
// minutes") - un simple redeploiement quelques minutes plus tard suffit,
// aucune action supplementaire requise.

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
// Renvoie true si un reglement a reellement eu lieu lors de CET appel (false
// si le defi n'est pas eligible, ou si une transaction concurrente l'a deja
// regle entre-temps) - utilise par closeExpiredGroupChallenges() pour savoir
// si un rappel d'echeance a encore un sens juste apres (voir plus bas).
async function settleChallengeIfNeeded(db, challengeRef) {
  const challengeSnap = await challengeRef.get();
  if (!challengeSnap.exists || challengeSnap.data().status !== 'active') return false;
  const challenge = challengeSnap.data();
  const groupRef = challengeRef.parent.parent; // groups/{groupId}/challenges/{id} -> groups/{groupId}
  const now = Date.now();

  const participantsSnap = await challengeRef.collection('participants').get();
  const ranked = participantsSnap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0));
  const totalProgress = ranked.reduce((sum, p) => sum + (p.totalAmount || 0), 0);
  if (!shouldSettleChallenge(totalProgress, challenge.targetTotal, challenge.endDate, now)) return false;
  // Distingue une VRAIE victoire collective (objectif chiffre atteint) d'un simple
  // reglement par expiration d'echeance sans objectif atteint - embarque dans la
  // notification pour que le client sache quand declencher la celebration plein
  // ecran (confettis + variant epique) plutot que le bilan neutre habituel.
  const targetReached = (challenge.targetTotal || 0) > 0 && totalProgress >= challenge.targetTotal;

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

  let settled = false;
  await db.runTransaction(async (tx) => {
    const freshChallenge = await tx.get(challengeRef);
    if (!freshChallenge.exists || freshChallenge.data().status !== 'active') return;
    settled = true;

    for (const pair of pairs) {
      const entryId = `${challengeRef.id}_${pair.fromUid}_${pair.toUid}`;
      tx.set(groupRef.collection('ledger').doc(entryId), {
        challengeId: challengeRef.id,
        fromUid: pair.fromUid,
        toUid: pair.toUid,
        // stakeType structure le gage (ex: 'beer') plutot que du texte libre, pour
        // que le client puisse regrouper/sommer proprement plusieurs gages
        // identiques dans l'Ardoise (ex: "3 bieres" au lieu de 3 lignes fragmentees
        // par de legeres variations de texte). 'custom' (defaut si absent, defis
        // crees avant ce champ) garde le texte libre historique tel quel.
        stakeType: challenge.stakeType || 'custom',
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

    // Notification "Bilan disponible" a chaque participant - declenche AUSSI un
    // push OS via sendPushOnNotificationCreate (trigger generique sur toute
    // ecriture dans cette sous-collection, voir plus bas).
    for (const participant of ranked) {
      const notifRef = db.collection('users').doc(participant.uid).collection('notifications').doc();
      tx.set(notifRef, {
        type: 'group_challenge_settled',
        fromUid: 'system',
        groupId: groupRef.id,
        challengeId: challengeRef.id,
        challengeName: challenge.name || '',
        winnerName,
        targetReached,
        read: false,
        createdAt: now,
      });
    }
  });
  return settled;
}

// Scheduled Function (15 min) : FILET DE SECURITE uniquement - le reglement lui-meme
// est desormais surtout declenche INSTANTANEMENT par logGroupChallengeContribution
// des qu'une contribution atteint la cible (voir plus bas). Ce balayage ne reste
// necessaire que pour les defis dont l'ECHEANCE se depasse SANS que personne
// n'atteigne la cible (aucune ecriture pour reagir dans ce cas). Cherche, TOUS
// GROUPES CONFONDUS (collectionGroup), TOUS les defis encore actifs (un seul filtre
// d'egalite, servi par le prefixe de l'index composite existant status+endDate -
// aucun nouvel index requis) et delegue a settleChallengeIfNeeded() pour chacun.
// Paliers de rappel avant l'echeance d'un defi de groupe, du plus large au
// plus urgent - un defi qui saute directement sous 3h (ex: cree tres tard)
// doit quand meme recevoir les 2 rappels au meme passage, pas seulement le
// plus urgent.
const REMINDER_THRESHOLDS = [
  { label: '24h', ms: 24 * 3600 * 1000 },
  { label: '3h', ms: 3 * 3600 * 1000 },
];

// Pure (aucun acces Firestore) : quels paliers de rappel viennent d'etre
// franchis et n'ont pas encore ete notifies (remindersSent, tableau ecrit sur
// le doc defi) ? Ne renvoie jamais un palier deja notifie, meme si l'appel se
// repete au passage planifie suivant.
function computeDueReminderThresholds(remainingMs, remindersSent) {
  if (!(remainingMs > 0)) return [];
  const sent = new Set(remindersSent || []);
  return REMINDER_THRESHOLDS.filter((t) => remainingMs <= t.ms && !sent.has(t.label)).map((t) => t.label);
}

// Rappels d'echeance (24h/3h) : reutilise TEL QUEL le doc deja lu par
// activeSnap ci-dessous (aucune lecture/index supplementaire) - un leger
// risque de donnee legerement perimee en cas de contribution concurrente est
// accepte (au pire un rappel ecrit un peu en retard, jamais de doublon grace
// a remindersSent). Notifie TOUS les membres du groupe (pas seulement les
// participants ayant deja contribue) - un rappel doit aussi pouvoir relancer
// quelqu'un qui n'a encore rien logue.
async function maybeRemindChallengeDeadline(db, challengeDoc, now) {
  const challenge = challengeDoc.data();
  const due = computeDueReminderThresholds((challenge.endDate || 0) - now, challenge.remindersSent);
  if (due.length === 0) return;
  const groupRef = challengeDoc.ref.parent.parent;
  const membersSnap = await groupRef.collection('members').get();
  const batch = db.batch();
  for (const memberDoc of membersSnap.docs) {
    for (const label of due) {
      const notifRef = db.collection('users').doc(memberDoc.id).collection('notifications').doc();
      batch.set(notifRef, {
        type: 'group_challenge_reminder',
        fromUid: 'system',
        groupId: groupRef.id,
        challengeId: challengeDoc.id,
        challengeName: challenge.name || '',
        thresholdLabel: label,
        read: false,
        createdAt: now,
      });
    }
  }
  batch.set(challengeDoc.ref, { remindersSent: admin.firestore.FieldValue.arrayUnion(...due) }, { merge: true });
  await batch.commit();
}

exports.closeExpiredGroupChallenges = onSchedule('every 15 minutes', async () => {
  const db = admin.firestore();
  const now = Date.now();
  const activeSnap = await db.collectionGroup('challenges').where('status', '==', 'active').get();
  for (const challengeDoc of activeSnap.docs) {
    const justSettled = await settleChallengeIfNeeded(db, challengeDoc.ref);
    if (justSettled) continue; // vient d'etre regle - un rappel n'a plus de sens
    await maybeRemindChallengeDeadline(db, challengeDoc, now);
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
  // La cible du Boulet est n'importe quel AUTRE MEMBRE DU GROUPE, pas seulement les
  // participants ayant deja ouvert ce defi precis (ensureMyParticipantDoc() ne cree
  // leur doc participant qu'a la premiere ouverture/contribution) - sans ca,
  // impossible de viser quelqu'un qui n'a pas encore interagi avec le defi, alors
  // que c'est justement le cas le plus frequent juste apres la creation. Lu
  // uniquement en repli, si la cible n'a pas encore de doc participant.
  const targetMemberRef = jokerType === 'boulet' ? db.collection('groups').doc(groupId).collection('members').doc(targetUid) : null;

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
    let targetMemberSnap = null;
    if (targetRef && (!targetSnap || !targetSnap.exists)) {
      targetMemberSnap = await tx.get(targetMemberRef);
      if (!targetMemberSnap.exists) {
        throw new HttpsError('not-found', 'Cible introuvable dans ce groupe.');
      }
    }

    if (jokerType === 'doublon') {
      tx.set(participantRef, { jokerUsed: 'doublon', doublonActiveUntil: Date.now() + DOUBLON_DURATION_MS }, { merge: true });
    } else if (jokerType === 'immunite') {
      tx.set(participantRef, { jokerUsed: 'immunite', immune: true }, { merge: true });
    } else if (jokerType === 'boulet') {
      tx.set(participantRef, { jokerUsed: 'boulet', jokerTargetUid: targetUid }, { merge: true });
      if (targetMemberSnap) {
        // Cree le doc participant de la cible a la volee (totalAmount:0), a partir
        // de son profil de membre - le handicap de 20 s'applique des le depart, le
        // classement de reglement la traite comme a effectiveAmount 0 (jamais
        // negatif, voir rankForSettlement()) tant qu'elle n'a pas elle-meme
        // contribue au moins 20.
        const m = targetMemberSnap.data();
        tx.set(targetRef, {
          uid: targetUid, displayName: m.displayName || '', photoURL: m.photoURL || '',
          totalAmount: 0, handicap: BOULET_HANDICAP,
        });
      } else {
        tx.set(targetRef, { handicap: admin.firestore.FieldValue.increment(BOULET_HANDICAP) }, { merge: true });
      }
    }
  });

  return { ok: true };
});

// =============================================================================
// Notifications PUSH (Firebase Cloud Messaging)
// =============================================================================
// Principe central : UN SEUL point d'envoi pour tous les push, quel que soit
// l'endroit qui ecrit la notification (client ou une autre Cloud Function) -
// voir sendPushOnNotificationCreate ci-dessous, qui intercepte TOUTE ecriture
// dans users/{uid}/notifications. Ajouter un futur type de notification
// n'importe donc qu'une entree dans PUSH_MESSAGES, jamais un nouveau point
// d'envoi a cabler manuellement a la main a chaque endroit qui notifie.

// Miroir volontairement simplifie des textes deja utilises cote client dans
// locale-*.js (popups.notifications.*) - pas d'import possible entre un
// script navigateur et ce module Node, a maintenir a la main (voir CLAUDE.md).
const PUSH_MESSAGES = {
  fr: {
    friend_request: (d) => ({ title: 'Nouvelle demande d\'ami', body: `${d.fromName} veut devenir ton ami.` }),
    friend_request_accepted: (d) => ({ title: 'Demande acceptée !', body: `${d.fromName} a accepté ta demande d'ami.` }),
    group_invite: (d) => ({ title: 'Invitation à un groupe', body: `${d.fromName} t'invite à rejoindre "${d.groupName}".` }),
    group_member_joined: (d) => ({ title: 'Nouveau membre', body: `${d.fromName} a rejoint "${d.groupName}".` }),
    group_challenge_created: (d) => ({ title: 'Nouveau défi collectif', body: `${d.fromName} a lancé "${d.challengeName}" dans "${d.groupName}".` }),
    group_challenge_settled: (d) => ({
      title: d.targetReached ? 'Objectif atteint !' : 'Bilan disponible !',
      body: d.targetReached
        ? (d.winnerName ? `Bravo à toute l'équipe, portée par ${d.winnerName} !` : 'Le groupe a relevé le défi ensemble - bravo à toute l\'équipe !')
        : `Le défi "${d.challengeName}" est terminé - découvre le classement.`,
    }),
    group_challenge_reminder: (d) => ({
      title: d.thresholdLabel === '3h' ? 'Dernière ligne droite !' : 'Plus que 24h !',
      body: `Le défi "${d.challengeName}" se termine bientôt - encore le temps de contribuer.`,
    }),
  },
  en: {
    friend_request: (d) => ({ title: 'New friend request', body: `${d.fromName} wants to be your friend.` }),
    friend_request_accepted: (d) => ({ title: 'Request accepted!', body: `${d.fromName} accepted your friend request.` }),
    group_invite: (d) => ({ title: 'Group invitation', body: `${d.fromName} invites you to join "${d.groupName}".` }),
    group_member_joined: (d) => ({ title: 'New member', body: `${d.fromName} joined "${d.groupName}".` }),
    group_challenge_created: (d) => ({ title: 'New collective challenge', body: `${d.fromName} started "${d.challengeName}" in "${d.groupName}".` }),
    group_challenge_settled: (d) => ({
      title: d.targetReached ? 'Target reached!' : 'Report available!',
      body: d.targetReached
        ? (d.winnerName ? `Great job, team - carried by ${d.winnerName}!` : 'The group pulled it off together - great job, team!')
        : `The "${d.challengeName}" challenge is over - check the ranking.`,
    }),
    group_challenge_reminder: (d) => ({
      title: d.thresholdLabel === '3h' ? 'Final stretch!' : '24 hours left!',
      body: `The "${d.challengeName}" challenge ends soon - there's still time to contribute.`,
    }),
  },
  es: {
    friend_request: (d) => ({ title: 'Nueva solicitud de amistad', body: `${d.fromName} quiere ser tu amigo.` }),
    friend_request_accepted: (d) => ({ title: '¡Solicitud aceptada!', body: `${d.fromName} aceptó tu solicitud de amistad.` }),
    group_invite: (d) => ({ title: 'Invitación a un grupo', body: `${d.fromName} te invita a unirte a "${d.groupName}".` }),
    group_member_joined: (d) => ({ title: 'Nuevo miembro', body: `${d.fromName} se unió a "${d.groupName}".` }),
    group_challenge_created: (d) => ({ title: 'Nuevo reto colectivo', body: `${d.fromName} lanzó "${d.challengeName}" en "${d.groupName}".` }),
    group_challenge_settled: (d) => ({
      title: d.targetReached ? '¡Objetivo alcanzado!' : '¡Balance disponible!',
      body: d.targetReached
        ? (d.winnerName ? `¡Enhorabuena al equipo, liderado por ${d.winnerName}!` : 'El grupo lo ha logrado junto - ¡enhorabuena al equipo!')
        : `El reto "${d.challengeName}" ha terminado - descubre la clasificación.`,
    }),
    group_challenge_reminder: (d) => ({
      title: d.thresholdLabel === '3h' ? '¡Recta final!' : '¡Quedan 24 horas!',
      body: `El reto "${d.challengeName}" termina pronto - todavía hay tiempo para contribuir.`,
    }),
  },
};

// Envoie un push a TOUS les appareils d'un utilisateur (users/{uid}/pushTokens,
// un doc par token) pour un type de notification donne, dans sa langue
// preferee (users/{uid}/kv/appData.preferredLanguage, repli 'fr' si absent -
// voir setPreferredLanguage() cote client). Nettoie les tokens invalides
// (appareil desinstalle/permission revoquee) retournes par la reponse FCM -
// evite l'accumulation silencieuse de tokens morts.
async function sendPushToUser(db, uid, type, data) {
  const tokensSnap = await db.collection('users').doc(uid).collection('pushTokens').get();
  if (tokensSnap.empty) return;

  let locale = 'fr';
  const appDataDoc = await db.collection('users').doc(uid).collection('kv').doc('appData').get();
  if (appDataDoc.exists && PUSH_MESSAGES[appDataDoc.data().preferredLanguage]) {
    locale = appDataDoc.data().preferredLanguage;
  }
  const buildMessage = PUSH_MESSAGES[locale][type] || PUSH_MESSAGES.fr[type];
  if (!buildMessage) return; // type de notification sans equivalent push (ne devrait pas arriver)
  const { title, body } = buildMessage(data);

  const tokens = tokensSnap.docs.map((d) => d.id);
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: '/' } },
  });

  const staleCodes = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
  const batch = db.batch();
  let hasStale = false;
  response.responses.forEach((r, i) => {
    if (!r.success && r.error && staleCodes.has(r.error.code)) {
      hasStale = true;
      batch.delete(db.collection('users').doc(uid).collection('pushTokens').doc(tokens[i]));
    }
  });
  if (hasStale) await batch.commit();
}

// Trigger generique : TOUTE notification in-app deja ecrite aujourd'hui (par
// le client ou par une autre Cloud Function - friend_request, group_invite,
// group_challenge_settled, group_challenge_reminder, ...) declenche
// automatiquement l'envoi push correspondant, sans avoir a cabler un appel
// FCM a chaque endroit du code qui ecrit une notification.
exports.sendPushOnNotificationCreate = onDocumentCreated('users/{uid}/notifications/{notifId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  await sendPushToUser(admin.firestore(), event.params.uid, snap.data().type, snap.data());
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
  computeDueReminderThresholds,
};
