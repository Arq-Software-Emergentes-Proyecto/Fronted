/**
 * Ubiquitous language: route names of the application.
 * Keep names in sync with `presentation/router` route definitions.
 */
export const AppRouteNames = /** @type {const} */ ({
  LOGIN: 'login',
  REGISTER: 'register',
  RESIDENT_LOGIN: 'resident-login',
  GUEST_INVITE: 'guest-invite',
  MEMBER_INVITE: 'member-invite',
  APP_DASHBOARD: 'app-dashboard',
  APP_ADVANCED_MANAGEMENT: 'app-advanced-management',
  APP_IMPORT: 'app-import',
  APP_FINANCE: 'app-finance',
  APP_GENERATION: 'app-generation',
  APP_INCIDENTS: 'app-incidents',
  APP_INFORMATION: 'app-information',
  APP_PROJECTS: 'app-projects',
  APP_COLLECTIONS_MANAGEMENT_EXPENSES: 'app-collections-management-expenses',
  APP_TEAM: 'app-team',
  APP_RESIDENT_HELP: 'app-resident-help',
  APP_SETTINGS: 'app-settings',
  APP_BOARD: 'app-board',
  APP_ACCESS: 'app-access',
  APP_BUILDINGS: 'app-buildings',
  APP_RESIDENT_DASHBOARD: 'app-resident-dashboard',
  APP_RESIDENT_FINANCE: 'app-resident-finance',
  APP_RESIDENT_SERVICES: 'app-resident-services',
  APP_RESIDENT_GENERATION: 'app-resident-generation',
  APP_RESIDENT_INCIDENTS: 'app-resident-incidents',
  APP_RESIDENT_SUPPORT: 'app-resident-support',
})

/** @typedef {typeof AppRouteNames[keyof typeof AppRouteNames]} AppRouteName */

export const AppPaths = /** @type {const} */ ({
  LOGIN: '/login',
  REGISTER: '/register',
  RESIDENT_LOGIN: '/login/residente',
  GUEST_INVITE: '/invite/:token',
  MEMBER_INVITE: '/equipo/invitacion/:token',
  APP: '/app',
  APP_ADVANCED_MANAGEMENT: '/app/advanced-management',
  APP_IMPORT: '/app/import',
  APP_FINANCE: '/app/finance',
  APP_GENERATION: '/app/generation',
  APP_INCIDENTS: '/app/incidents',
  APP_INFORMATION: '/app/information',
  APP_PROJECTS: '/app/projects',
  APP_COLLECTIONS_MANAGEMENT_EXPENSES:
    '/app/collections-management-expenses',
  APP_TEAM: '/app/team',
  APP_RESIDENT_HELP: '/app/resident-help',
  APP_SETTINGS: '/app/settings',
  APP_BOARD: '/app/board',
  APP_ACCESS: '/app/access',
  APP_BUILDINGS: '/app/buildings',
  APP_RESIDENT_DASHBOARD: '/app/resident/dashboard',
  APP_RESIDENT_FINANCE: '/app/resident/finance',
  APP_RESIDENT_SERVICES: '/app/resident/services',
  APP_RESIDENT_GENERATION: '/app/resident/generation',
  APP_RESIDENT_INCIDENTS: '/app/resident/incidents',
  APP_RESIDENT_SUPPORT: '/app/resident/support',
})
