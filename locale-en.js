// @ts-check
// English dictionary. Classic script (NOT type="module", NOT defer) loaded right
// after exercise-data.js — see the matching comment in index.html's <head>.
const LOCALE_EN = {
  common: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    back: 'Back',
  },
  nav: {
    today: 'Today',
    library: 'Challenges',
    history: 'Log',
    community: 'Community',
    account: 'Profile',
  },
  settings: {
    screenTitle: 'Settings',
    username: {
      label: 'Username: @{{username}}',
      desc: 'Your public handle — used by your friends to find you.',
      editAria: 'Edit username',
    },
    voiceCoach: {
      label: 'Voice coach',
      desc: 'Announces the prep countdown and challenge completion out loud.',
    },
    leaderboardOptOut: {
      label: 'Community leaderboard',
      desc: 'Shows your name, streak and XP on the leaderboard shared with other users.',
    },
    language: {
      label: 'Language',
      desc: 'Change the app language on this device.',
    },
    dataManagement: {
      sectionLabel: 'My data',
      exportBtn: '📤 Export my data',
      importBtn: '📥 Import data',
    },
    troubleshooting: {
      sectionLabel: 'Troubleshooting',
      persistenceLabel: 'Offline local persistence: {{status}}',
      persistenceActive: '✅ Active',
      persistenceUnavailable: '⚠️ Unavailable on this device (recent saves may be lost if the app closes right after)',
      persistenceChecking: '… checking',
      forceUpdateBtn: '🔄 Force app update',
      forceUpdateModal: {
        title: 'Force update?',
        subtitle: 'Unregisters the service worker and clears the app cache, then reloads. Use this if the app seems stuck on an old version despite a regular reload.',
        confirmLabel: 'Force update',
      },
    },
    account: {
      sectionLabel: 'Account',
      signOutBtn: '🚪 Sign out',
      deleteAccountBtn: '🗑️ Delete my account and data',
    },
  },
};
