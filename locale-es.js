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
};
