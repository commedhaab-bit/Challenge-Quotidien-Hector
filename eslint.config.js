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
  URLSearchParams: 'readonly',
};

module.exports = [
  {
    // Contrairement a un .eslintignore, les fichiers hors des `files` d'un bloc ne
    // sont PAS silencieusement ignores : ESLint tente quand meme de les parser (et
    // peut lever ses propres erreurs de parsing dessus). `.extracted-script.js` est
    // un artefact TEMPORAIRE genere par tests/extract-script.js (verification node -c) :
    // s'il traine sur le disque au moment du lint (ex: etape CI precedente non
    // nettoyee), il ne doit jamais etre analyse par ESLint.
    ignores: ['node_modules/**', '.extracted-script.js'],
  },
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
      // args: 'none' : le harnais definit beaucoup de stubs/mocks DOM/Firebase dont
      // la signature doit correspondre a l'API reelle (ex: getContext(tag), fetch
      // (cb), confirm(msg)) sans que le corps du mock ait besoin du parametre —
      // un "jamais utilise" attendu et sans interet ici. Les variables locales
      // (hors arguments) restent, elles, signalees normalement.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
    },
  },
];
