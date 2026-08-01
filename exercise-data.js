// Catalogue d'exercices + utilitaires associés — extrait de index.html pour un
// fichier principal moins volumineux. Chargé en <script> CLASSIQUE (PAS de
// type=module, PAS de defer/async) avant le script principal : ces éléments
// doivent être des globaux disponibles avant que le reste de l'appli ne s'exécute.
// Voir la remarque "ATTENTION : NE PAS mettre defer" dans index.html — le même
// risque de chargement s'applique ici : garder ce script synchrone.

const CHALLENGE_LIBRARY = [
  // ==== Haut du corps (bmiImpact élevé : mouvements qui portent tout le poids du corps) ====
  { id: 1,  cat: 'Haut du corps', name: 'Pompes', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 1.0 },
  { id: 3,  cat: 'Haut du corps', name: 'Dips', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 1.0 },
  { id: 1001, cat: 'Haut du corps', name: 'Pompes diamant', target: 80,  unit: 'reps', hardcoreTarget: 160, isDefault: false, bmiImpact: 1.0 },
  { id: 1002, cat: 'Haut du corps', name: 'Pompes déclinées (pieds surélevés)', target: 80, unit: 'reps', hardcoreTarget: 160, isDefault: false, bmiImpact: 1.0 },
  { id: 1003, cat: 'Haut du corps', name: 'Pike push-ups (épaules)', target: 50, unit: 'reps', hardcoreTarget: 100, isDefault: false, bmiImpact: 0.9 },
  { id: 1004, cat: 'Haut du corps', name: 'Superman (extension dos)', target: 60, unit: 'reps', hardcoreTarget: 120, isDefault: false, bmiImpact: 0.4 },
  { id: 1020, cat: 'Haut du corps', name: 'Tirage élastique', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: false, bmiImpact: 0.2 },

  // ==== Haltères (bmiImpact ~nul : le poids déplacé est celui de l'haltère, pas du corps) ====
  { id: 5,  cat: 'Haltères', name: 'Triceps', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 0, standardWeightKg: 8, armMode: 'perArm' },
  { id: 6,  cat: 'Haltères', name: 'Biceps', target: 150, unit: 'reps', hardcoreTarget: 300, isDefault: true, bmiImpact: 0, standardWeightKg: 8, armMode: 'perArm' },
  { id: 7,  cat: 'Haltères', name: 'Élévations latérales', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 0, standardWeightKg: 5, armMode: 'total' },
  { id: 8,  cat: 'Haltères', name: 'Presse cubaine', target: 150, unit: 'reps', hardcoreTarget: 300, isDefault: true, bmiImpact: 0, standardWeightKg: 8, armMode: 'total' },
  { id: 1005, cat: 'Haltères', name: 'Tirage haltères', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: false, bmiImpact: 0, standardWeightKg: 10, armMode: 'perArm' },
  { id: 1006, cat: 'Haltères', name: 'Développé épaules haltères', target: 80, unit: 'reps', hardcoreTarget: 160, isDefault: false, bmiImpact: 0, standardWeightKg: 8, armMode: 'total' },
  { id: 1008, cat: 'Haltères', name: 'Extensions triceps nuque', target: 80, unit: 'reps', hardcoreTarget: 160, isDefault: false, bmiImpact: 0, standardWeightKg: 6, armMode: 'total' },
  { id: 1010, cat: 'Haltères', name: 'Squat goblet', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: false, bmiImpact: 0.15, standardWeightKg: 12, armMode: 'total' },

  // ==== Gainage / Core (bmiImpact modéré : la planche/hollow tiennent le poids du corps, les crunchs moins) ====
  { id: 9,  cat: 'Gainage / Core', name: 'Planche cumulée', target: 300, unit: 'sec', hardcoreTarget: 600, isDefault: true, bmiImpact: 0.7 },
  { id: 10, cat: 'Gainage / Core', name: 'Crunchs', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 0.3 },
  { id: 11, cat: 'Gainage / Core', name: 'Gainage latéral (2 côtés)', target: 300, unit: 'sec', hardcoreTarget: 600, isDefault: true, bmiImpact: 0.7 },
  { id: 13, cat: 'Gainage / Core', name: 'Leg raises', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 0.4 },
  { id: 1012, cat: 'Gainage / Core', name: 'Hollow hold cumulé', target: 180, unit: 'sec', hardcoreTarget: 360, isDefault: false, bmiImpact: 0.5 },
  { id: 1013, cat: 'Gainage / Core', name: 'V-ups', target: 60, unit: 'reps', hardcoreTarget: 120, isDefault: false, bmiImpact: 0.4 },
  { id: 1014, cat: 'Gainage / Core', name: 'Bicycle crunches', target: 150, unit: 'reps', hardcoreTarget: 300, isDefault: false, bmiImpact: 0.3 },
  { id: 1015, cat: 'Gainage / Core', name: 'Dead bug', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: false, bmiImpact: 0.2 },

  // ==== Bas du corps (bmiImpact modéré : les jambes sont naturellement conçues pour porter le poids du corps) ====
  { id: 14, cat: 'Bas du corps', name: 'Squats', target: 200, unit: 'reps', hardcoreTarget: 400, isDefault: true, bmiImpact: 0.5 },
  { id: 15, cat: 'Bas du corps', name: 'Fentes (2 jambes)', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: true, bmiImpact: 0.5 },
  { id: 16, cat: 'Bas du corps', name: 'Chaise (wall sit) cumulée', target: 180, unit: 'sec', hardcoreTarget: 360, isDefault: true, bmiImpact: 0.6 },
  { id: 17, cat: 'Bas du corps', name: 'Mollets (calf raises)', target: 150, unit: 'reps', hardcoreTarget: 300, isDefault: true, bmiImpact: 0.4 },
  { id: 1016, cat: 'Bas du corps', name: 'Fentes bulgares', target: 100, unit: 'reps', hardcoreTarget: 200, isDefault: false, bmiImpact: 0.55 },
  { id: 1019, cat: 'Bas du corps', name: 'Pont fessier (glute bridge)', target: 150, unit: 'reps', hardcoreTarget: 300, isDefault: false, bmiImpact: 0.3 },
];

const QUICK_ADD = { reps: [5, 10, 15, 20, 25, 30], sec: [15, 30, 60, 120] };

function formatSecToReadable(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s} s`;
  if (s === 0) return `${m} min`;
  return `${m} min ${s} s`;
}

// Affichage complet d'une valeur cible selon son unité, ex: "335 SEC (5 min 35 s)" ou "100 reps"
function formatTargetLabel(value, unit) {
  if (unit === 'sec') {
    return `${value} SEC (${formatSecToReadable(value)})`;
  }
  return `${value} reps`;
}

const EXERCISE_ICON_BY_NAME = {
  "Pompes": "pompes",
  "Dips": "dips",
  "Pompes diamant": "pompes_diamant",
  "Pompes déclinées (pieds surélevés)": "pompes_declinees",
  "Pike push-ups (épaules)": "pike",
  "Superman (extension dos)": "superman",
  "Triceps": "triceps",
  "Biceps": "biceps",
  "Élévations latérales": "epaule_raise",
  "Presse cubaine": "cuban_press",
  "Tirage haltères": "rowing",
  "Développé épaules haltères": "developpe_epaules",
  "Extensions triceps nuque": "extension_nuque",
  "Squat goblet": "squat_goblet",
  "Planche cumulée": "planche",
  "Crunchs": "crunchs",
  "Gainage latéral (2 côtés)": "gainage_lateral",
  "Leg raises": "leg_raises",
  "Hollow hold cumulé": "hollow_hold",
  "V-ups": "vups",
  "Bicycle crunches": "bicycle",
  "Dead bug": "dead_bug",
  "Squats": "squats",
  "Fentes (2 jambes)": "fentes",
  "Chaise (wall sit) cumulée": "chaise",
  "Mollets (calf raises)": "mollets",
  "Fentes bulgares": "fentes_bulgares",
  "Pont fessier (glute bridge)": "pont_fessier",
  "Tirage élastique": "tirage_elastique"
};

// Clés de pictogramme sans aucun fichier exercices/{clé}(-static).png sur le disque
// (soit en attente de l'illustration IA de l'utilisateur, soit — pour generic/
// dumbbell_generic — un repli SVG permanent qui n'aura jamais d'image dédiée). Le
// vérifier ici évite une requête réseau vouée à échouer (404 garanti) à chaque
// affichage d'une carte ou d'une fiche défi concernée ; retirer une clé de cette
// liste dès que sa vraie illustration est déposée dans exercices/.
const PICTOGRAM_ASSET_MISSING = new Set([
  'pompes_iso', 'pompes_larges', 'mountain_climbers', 'squats_sumo', 'tirage_elastique',
  'generic', 'dumbbell_generic',
]);

function getExercisePictogramKey(c) {
  // 1) Correspondance exacte par nom (tous les défis de la bibliothèque)
  if (EXERCISE_ICON_BY_NAME[c.name]) return EXERCISE_ICON_BY_NAME[c.name];
  // 2) Repli par mots-clés pour les défis personnalisés créés par l'utilisateur
  const name = (c.name || '').toLowerCase();
  const cat = (c.cat || '').toLowerCase();
  if (cat === 'haltères') return 'dumbbell_generic';
  if (name.includes('pompe') || name.includes('push-up') || name.includes('push up') || name.includes('pike') || name.includes('dip')) return 'pompes';
  if (name.includes('squat') || name.includes('fente') || name.includes('pistol') || name.includes('mollet') || name.includes('pont') || name.includes('bridge') || name.includes('step')) return 'squats';
  if (name.includes('planche') || name.includes('gainage') || name.includes('hollow') || name.includes('wall sit') || name.includes('chaise') || name.includes('superman')) return 'planche';
  if (name.includes('crunch') || name.includes('abdo') || name.includes('v-up') || name.includes('bicycle') || name.includes('leg raise') || name.includes('dead bug') || name.includes('twist') || name.includes('sit-up')) return 'crunchs';
  if (name.includes('course') || name.includes('running') || name.includes('sprint') || name.includes('corde') || name.includes('jumping') || name.includes('burpee') || name.includes('high knee') || name.includes('mountain climber') || name.includes('sauté')) return 'mountain_climbers';
  return 'generic';
}
