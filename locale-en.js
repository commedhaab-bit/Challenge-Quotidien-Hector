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
  today: {
    title: "Today's challenge",
    emptyState: {
      title: 'No challenge selected for today',
      text: 'Head to the Challenges tab to pick your challenges for today!',
      btn: '🎯 Pick a challenge',
    },
    hero: {
      badge: '🌍 Community challenge of the day',
      timer: '⏳ {{n}}h left',
      proof: {
        one: '🔥 {{n}} member has taken on this challenge today',
        other: '🔥 {{n}} members have taken on this challenge today',
      },
      acceptAllBtn: "Take on today's community challenge",
      chooseBtn: 'Pick my own challenge',
    },
    suggestion: {
      one: "You haven't done <strong>{{category}}</strong> in {{n}} day",
      other: "You haven't done <strong>{{category}}</strong> in {{n}} days",
    },
    trophies: {
      allUnlockedLabel: 'Trophies',
      allUnlockedText: 'All trophies unlocked — congrats, legend! 🏆',
      nextLabel: 'Next trophies within reach',
    },
  },
  exercise: {
    recordPrefix: '🏆 Record: {{value}}{{unit}}',
    lifetimeTotal: 'Σ {{value}} lifetime',
    editWeightAria: 'Edit weight',
    editTargetAria: 'Edit target',
    normalObjectiveRecap: '✓ Normal target: {{target}} — done',
    hardcoreLocked: '🔒 Hardcore mode unlocks at {{target}} {{unit}} — target {{hcTarget}} {{unit}}',
    hardcoreTag: '🔥 Hardcore mode',
    hardcoreBanner: '🔥 HARDCORE MODE completed!',
    timerLabel: 'Time a set',
    addSetLabel: 'Add a set',
    customPlaceholder: 'Custom number',
    addBtn: 'Add',
    undoBtn: 'Undo last set ({{n}})',
    doneBanner: '✓ Challenge completed today',
    demoAlt: 'Demo: {{name}}',
    armModeSentence: 'Each arm must do {{target}} {{unit}}.',
    editWeightPrompt: 'Dumbbell weight for "{{name}}" (kg):',
    editTargetPromptSec: "Today's target (seconds):",
    editTargetPromptReps: "Today's target (reps):",
    unitSecLabel: 'SEC',
    unitSecLabelLower: 'sec',
    unitRepsLabel: 'reps',
  },
  card: {
    hardcoreDone: '🔥 Hardcore completed',
    doneToday: '✓ Done today',
    inProgress: '● In progress — {{current}}/{{target}}',
    activate: '+ Activate',
    active: '✓ Active',
    communityRibbonTitle: "Community challenge of the day — {{n}} completed today",
  },
};
