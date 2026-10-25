import i18n from '@/shared/infrastructure/i18n/index.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'

const DEFAULT_TITLE = 'BuildingFex — Gestión de condominios y edificios'

/** Nombre de cada vista privada (mismas etiquetas del menú). */
const TITLE_KEYS = {
  [AppRouteNames.APP_DASHBOARD]: 'app.dashboard',
  [AppRouteNames.APP_ADVANCED_MANAGEMENT]: 'app.advancedManagement',
  [AppRouteNames.APP_IMPORT]: 'app.import',
  [AppRouteNames.APP_FINANCE]: 'app.finance',
  [AppRouteNames.APP_GENERATION]: 'app.generation',
  [AppRouteNames.APP_INCIDENTS]: 'app.incidents',
  [AppRouteNames.APP_INFORMATION]: 'app.information',
  [AppRouteNames.APP_COLLECTIONS_MANAGEMENT_EXPENSES]: 'app.collectionsManagementExpenses',
  [AppRouteNames.APP_TEAM]: 'app.team',
  [AppRouteNames.APP_RESIDENT_HELP]: 'app.residentHelp',
  [AppRouteNames.APP_SETTINGS]: 'app.settings',
  [AppRouteNames.APP_RESIDENT_DASHBOARD]: 'resident.navDashboard',
  [AppRouteNames.APP_RESIDENT_FINANCE]: 'resident.navFinance',
  [AppRouteNames.APP_RESIDENT_SERVICES]: 'resident.navServices',
  [AppRouteNames.APP_RESIDENT_GENERATION]: 'resident.navGeneration',
  [AppRouteNames.APP_RESIDENT_INCIDENTS]: 'resident.navIncidents',
  [AppRouteNames.APP_RESIDENT_SUPPORT]: 'resident.navSupport',
}

function robotsTag() {
  let tag = document.head.querySelector('meta[name="robots"]')
  if (!tag) {
    tag = document.createElement('meta')
    tag.setAttribute('name', 'robots')
    document.head.appendChild(tag)
  }
  return tag
}

/**
 * Título por vista ("Incidencias · BuildingFex") y noindex en todo lo que exige sesión o es un enlace
 * privado (pases de invitado): los buscadores solo indexan el login público.
 */
export function applyPageMeta(to) {
  if (typeof document === 'undefined') return
  const key = TITLE_KEYS[to.name]
  document.title = key ? `${i18n.global.t(key)} · BuildingFex` : DEFAULT_TITLE
  const isPrivate = to.matched.some((record) => record.meta?.requiresAuth) || to.name === AppRouteNames.GUEST_INVITE
  robotsTag().setAttribute('content', isPrivate ? 'noindex, nofollow' : 'index, follow')
}
