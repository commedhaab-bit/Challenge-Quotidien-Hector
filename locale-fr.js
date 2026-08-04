// @ts-check
// Dictionnaire français — langue de référence (repli pour toute clé manquante dans
// une autre langue, voir t()/tn() dans index.html). Script CLASSIQUE (PAS type="module",
// PAS defer) chargé juste après exercise-data.js : voir le commentaire correspondant
// dans <head> d'index.html — tout ce qui doit être un global disponible avant le
// script principal doit rester chargé de façon synchrone, dans l'ordre.
const LOCALE_FR = {
  common: {
    cancel: 'Annuler',
    confirm: 'Confirmer',
    close: 'Fermer',
    back: 'Retour',
  },
  nav: {
    today: "Aujourd'hui",
    library: 'Défis',
    history: 'Journal',
    community: 'Commu',
    account: 'Profil',
  },
  settings: {
    screenTitle: 'Paramètres',
    username: {
      label: 'Pseudo : @{{username}}',
      desc: 'Ton identifiant public — utilisé par tes amis pour te retrouver.',
      editAria: 'Modifier le pseudo',
    },
    voiceCoach: {
      label: 'Coach vocal',
      desc: 'Annonce le compte à rebours de préparation et la fin du défi à voix haute.',
    },
    leaderboardOptOut: {
      label: 'Classement communautaire',
      desc: 'Affiche ton nom, ta série et ton XP dans le classement partagé avec les autres utilisateurs.',
    },
    language: {
      label: 'Langue',
      desc: "Change la langue de l'application sur cet appareil.",
    },
    dataManagement: {
      sectionLabel: 'Mes données',
      exportBtn: '📤 Exporter mes données',
      importBtn: '📥 Importer des données',
    },
    troubleshooting: {
      sectionLabel: 'Dépannage',
      persistenceLabel: 'Persistance locale hors ligne : {{status}}',
      persistenceActive: '✅ Active',
      persistenceUnavailable: "⚠️ Indisponible sur cet appareil (les sauvegardes récentes peuvent se perdre si l'appli se ferme juste après)",
      persistenceChecking: '… vérification en cours',
      forceUpdateBtn: "🔄 Forcer la mise à jour de l'appli",
      forceUpdateModal: {
        title: 'Forcer la mise à jour ?',
        subtitle: "Désenregistre le service worker et vide le cache de l'appli, puis recharge. À utiliser si l'appli semble bloquée sur une ancienne version malgré un rechargement classique.",
        confirmLabel: 'Forcer la mise à jour',
      },
    },
    account: {
      sectionLabel: 'Compte',
      signOutBtn: '🚪 Se déconnecter',
      deleteAccountBtn: '🗑️ Supprimer mon compte et mes données',
    },
  },
};
