// @ts-check
// Diccionario español. Script clásico (NO type="module", NO defer) cargado justo
// después de exercise-data.js — ver el comentario correspondiente en el <head> de
// index.html.
const LOCALE_ES = {
  common: {
    cancel: 'Cancelar',
    confirm: 'Confirmar',
    close: 'Cerrar',
    back: 'Atrás',
  },
  nav: {
    today: 'Hoy',
    library: 'Retos',
    history: 'Diario',
    community: 'Comunidad',
    account: 'Perfil',
  },
  settings: {
    screenTitle: 'Ajustes',
    username: {
      label: 'Usuario: @{{username}}',
      desc: 'Tu identificador público — lo usan tus amigos para encontrarte.',
      editAria: 'Editar usuario',
    },
    voiceCoach: {
      label: 'Coach de voz',
      desc: 'Anuncia en voz alta la cuenta atrás de preparación y el fin del reto.',
    },
    leaderboardOptOut: {
      label: 'Clasificación comunitaria',
      desc: 'Muestra tu nombre, tu racha y tu XP en la clasificación compartida con otros usuarios.',
    },
    language: {
      label: 'Idioma',
      desc: 'Cambia el idioma de la aplicación en este dispositivo.',
    },
    dataManagement: {
      sectionLabel: 'Mis datos',
      exportBtn: '📤 Exportar mis datos',
      importBtn: '📥 Importar datos',
    },
    troubleshooting: {
      sectionLabel: 'Solución de problemas',
      persistenceLabel: 'Persistencia local sin conexión: {{status}}',
      persistenceActive: '✅ Activa',
      persistenceUnavailable: '⚠️ No disponible en este dispositivo (los guardados recientes pueden perderse si la app se cierra justo después)',
      persistenceChecking: '… comprobando',
      forceUpdateBtn: '🔄 Forzar actualización de la app',
      forceUpdateModal: {
        title: '¿Forzar la actualización?',
        subtitle: 'Da de baja el service worker y borra la caché de la app, luego recarga. Úsalo si la app parece atascada en una versión antigua a pesar de una recarga normal.',
        confirmLabel: 'Forzar actualización',
      },
    },
    account: {
      sectionLabel: 'Cuenta',
      signOutBtn: '🚪 Cerrar sesión',
      deleteAccountBtn: '🗑️ Eliminar mi cuenta y mis datos',
    },
  },
  today: {
    title: 'Reto del día',
    emptyState: {
      title: 'Ningún reto seleccionado para hoy',
      text: 'Ve a la pestaña Retos para elegir tus retos de hoy.',
      btn: '🎯 Elegir un reto',
    },
    hero: {
      badge: '🌍 Reto comunitario del día',
      timer: '⏳ Quedan {{n}}h',
      proof: {
        one: '🔥 {{n}} miembro ha aceptado este reto hoy',
        other: '🔥 {{n}} miembros han aceptado este reto hoy',
      },
      acceptAllBtn: 'Aceptar el reto comunitario del día',
      chooseBtn: 'Elegir mi propio reto',
    },
    suggestion: {
      one: 'No has hecho <strong>{{category}}</strong> desde hace {{n}} día',
      other: 'No has hecho <strong>{{category}}</strong> desde hace {{n}} días',
    },
    trophies: {
      allUnlockedLabel: 'Trofeos',
      allUnlockedText: '¡Todos los trofeos desbloqueados — enhorabuena, leyenda! 🏆',
      nextLabel: 'Próximos trofeos a tu alcance',
    },
  },
  exercise: {
    recordPrefix: '🏆 Récord: {{value}}{{unit}}',
    lifetimeTotal: 'Σ {{value}} de por vida',
    editWeightAria: 'Editar peso',
    editTargetAria: 'Editar objetivo',
    normalObjectiveRecap: '✓ Objetivo normal: {{target}} — completado',
    hardcoreLocked: '🔒 Modo Hardcore se desbloquea a {{target}} {{unit}} — objetivo {{hcTarget}} {{unit}}',
    hardcoreTag: '🔥 Modo Hardcore',
    hardcoreBanner: '🔥 ¡MODO HARDCORE completado!',
    timerLabel: 'Cronometrar una serie',
    addSetLabel: 'Añadir una serie',
    customPlaceholder: 'Número personalizado',
    addBtn: 'Añadir',
    undoBtn: 'Deshacer la última serie ({{n}})',
    doneBanner: '✓ Reto completado hoy',
    demoAlt: 'Demostración: {{name}}',
    armModeSentence: 'Cada brazo debe hacer {{target}} {{unit}}.',
    editWeightPrompt: 'Peso de la mancuerna para "{{name}}" (kg):',
    editTargetPromptSec: 'Objetivo de hoy (segundos):',
    editTargetPromptReps: 'Objetivo de hoy (repeticiones):',
    unitSecLabel: 'SEG',
    unitSecLabelLower: 'seg',
    unitRepsLabel: 'reps',
  },
  card: {
    hardcoreDone: '🔥 Hardcore completado',
    doneToday: '✓ Completado hoy',
    inProgress: '● En curso — {{current}}/{{target}}',
    activate: '+ Activar',
    active: '✓ Activo',
    communityRibbonTitle: 'Reto comunitario del día — {{n}} completado(s) hoy',
  },
};
