const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../index.js');
const { PUSH_MESSAGES } = __testables;

// Regression directe du bug reel signale par l'utilisateur : le type 'kudo'
// avait ete entierement oublie dans PUSH_MESSAGES lors de la mise en place des
// notifications push - sendPushToUser() abandonnait alors SILENCIEUSEMENT
// (aucune erreur, aucun log visible cote client) des qu'un kudos etait donne,
// alors que la notification in-app fonctionnait normalement (systeme distinct).
// Cette liste doit rester en phase avec CHAQUE endroit du code qui ecrit une
// notification (voir index.html: kudo/friend_request/friend_request_accepted/
// group_invite/group_challenge_created/group_member_joined, et plus haut dans
// ce fichier: group_challenge_settled/group_challenge_reminder/boulet_attack).
const KNOWN_NOTIFICATION_TYPES = [
  'kudo',
  'friend_request',
  'friend_request_accepted',
  'group_invite',
  'group_challenge_created',
  'group_member_joined',
  'group_challenge_settled',
  'group_challenge_reminder',
  'boulet_attack',
  'daily_reminder',
];

test('PUSH_MESSAGES.fr couvre TOUS les types de notification reellement ecrits par l app (sinon sendPushToUser() abandonne silencieusement pour ce type)', () => {
  for (const type of KNOWN_NOTIFICATION_TYPES) {
    assert.equal(typeof PUSH_MESSAGES.fr[type], 'function', `PUSH_MESSAGES.fr doit exposer une entree pour le type "${type}"`);
  }
});

test('PUSH_MESSAGES : chaque langue (en/es) couvre EXACTEMENT le meme jeu de types que fr (jamais un repli fr incoherent/silencieux pour une langue precise)', () => {
  const referenceTypes = Object.keys(PUSH_MESSAGES.fr).sort();
  for (const locale of Object.keys(PUSH_MESSAGES)) {
    if (locale === 'fr') continue;
    assert.deepEqual(Object.keys(PUSH_MESSAGES[locale]).sort(), referenceTypes, `PUSH_MESSAGES.${locale} doit couvrir exactement les memes types que fr`);
  }
});

test('PUSH_MESSAGES : chaque constructeur de message renvoie bien {title, body} non-vides, pour un jeu de donnees minimal', () => {
  const sampleData = {
    fromName: 'Alex M.', groupName: 'Les Costauds', challengeName: '100 pompes',
    winnerName: 'Alex M.', targetReached: true, thresholdLabel: '24h', amount: 20,
  };
  for (const locale of Object.keys(PUSH_MESSAGES)) {
    for (const type of Object.keys(PUSH_MESSAGES[locale])) {
      const { title, body } = PUSH_MESSAGES[locale][type](sampleData);
      assert.ok(title && title.length > 0, `${locale}.${type} doit produire un titre non-vide`);
      assert.ok(body && body.length > 0, `${locale}.${type} doit produire un corps non-vide`);
    }
  }
});
