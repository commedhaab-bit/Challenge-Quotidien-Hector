'use strict';

// Portee volontairement limitee aux fichiers .js reels (catalogue de donnees +
// harnais de test) : le script principal reste inline dans index.html, et le
// linter proprement dit (sans plugin HTML supplementaire, hors scope de ce
// batch) ne peut pas l'analyser. Voir CLAUDE.md.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  history: 'readonly',
  firebase: 'readonly',
};

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  console: 'readonly',
  setImmediate: 'readonly',
};

module.exports = [
  {
    files: ['exercise-data.js', 'exercise-pictograms.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      // Ces fichiers ne font qu'exposer des globaux consommes par le script inline
      // de index.html (scripts classiques, pas de vrais modules — voir CLAUDE.md) :
      // ESLint ne voit pas cet usage puisqu'il n'analyse pas index.html, d'ou ce
      // "jamais utilise" systematique et non pertinent ici.
      'no-unused-vars': 'off',
      'no-undef': 'error',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: { ...browserGlobals, ...nodeGlobals },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
    },
  },
];
