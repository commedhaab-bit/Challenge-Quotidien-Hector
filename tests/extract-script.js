const fs = require('fs');
const path = require('path');
// Par defaut, cible index.html a la racine du repo et ecrit a cote (voir CI :
// node tests/extract-script.js && node -c /tmp/... est aussi possible en passant
// des arguments explicites).
const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const outPath = process.argv[3] || path.join(__dirname, '..', '.extracted-script.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const longest = scripts.reduce((a, b) => (a.length > b.length ? a : b), '');
// exercise-data.js / exercise-pictograms.js sont chargés en <script src="..."> classiques
// (voir index.html <head>) : leur contenu n'apparait donc jamais dans un bloc <script>
// inline, il faut le lire depuis les fichiers voisins et le concatener AVANT le script
// principal, exactement comme un navigateur les charge (ordre synchrone, meme portee).
const dir = path.dirname(htmlPath);
let externalClassicScripts = '';
for (const name of ['exercise-pictograms.js', 'exercise-data.js']) {
  const p = path.join(dir, name);
  if (fs.existsSync(p)) externalClassicScripts += fs.readFileSync(p, 'utf8') + '\n';
}
const combined = externalClassicScripts + longest;
fs.writeFileSync(outPath, combined);
console.log('script blocks found:', scripts.length, 'longest length:', longest.length, 'combined length:', combined.length);
