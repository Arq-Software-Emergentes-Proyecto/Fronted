import { createRouter, createWebHistory } from 'vue-router'
import {
  clearSession,
  getAccessToken,
  getSessionRole,
  isAccessTokenValid,
  SessionRoles,
} from '@/iam/application/sessionStore.js'
import {
  ensureOpenAccessSession,
  OPEN_WIREFRAME_ACCESS,
} from '@/iam/application/localPreviewAuth.js'
import { AppPaths, AppRouteNames } from '@/shared/domain/appRoutes.js'
import AuthView from '@/iam/presentation/views/AuthView.vue'
import AppShellView from '@/shared/presentation/views/AppShellView.vue'
import AppDashboardView from '@/shared/presentation/views/AppDashboardView.vue'
import AppAdvancedManagementView from '@/shared/presentation/views/AppAdvancedManagementView.vue'
import AppImportView from '@/shared/presentation/views/AppImportView.vue'
import AppFinanceView from '@/shared/presentation/views/AppFinanceView.vue'
import AppGenerationView from '@/shared/presentation/views/AppGenerationView.vue'
import AppIncidentsView from '@/shared/presentation/views/AppIncidentsView.vue'
import AppInformationView from '@/shared/presentation/views/AppInformationView.vue'
import AppCollectionsManagementExpensesView from '@/shared/presentation/views/AppCollectionsManagementExpensesView.vue'
import AppTeamView from '@/shared/presentation/views/AppTeamView.vue'
import AppAdminResidentHelpView from '@/shared/presentation/views/AppAdminResidentHelpView.vue'
import AppProjectsView from '@/shared/presentation/views/AppProjectsView.vue'
import AppSettingsView from '@/shared/presentation/views/AppSettingsView.vue'
import AppResidentDashboardView from '@/shared/presentation/views/AppResidentDashboardView.vue'
import AppResidentFinanceView from '@/shared/presentation/views/AppResidentFinanceView.vue'
import AppResidentServicesView from '@/shared/presentation/views/AppResidentServicesView.vue'
import AppResidentGenerationView from '@/shared/presentation/views/AppResidentGenerationView.vue'
import AppResidentIncidentsView from '@/shared/presentation/views/AppResidentIncidentsView.vue'
import AppResidentSupportView from '@/shared/presentation/views/AppResidentSupportView.vue'
import GuestInviteView from '@/socialSpaces/presentation/views/GuestInviteView.vue'

/** Routes a resident may open (admin shell URLs are blocked for this role). */
const RESIDENT_APP_ROUTE_NAMES = new Set([
  AppRouteNames.APP_RESIDENT_DASHBOARD,
  AppRouteNames.APP_RESIDENT_FINANCE,
  AppRouteNames.APP_RESIDENT_SERVICES,
  AppRouteNames.APP_RESIDENT_GENERATION,
  AppRouteNames.APP_RESIDENT_INCIDENTS,
  AppRouteNames.APP_RESIDENT_SUPPORT,
  AppRouteNames.APP_SETTINGS,
])

const PUBLIC_ROUTE_NAMES = new Set([
  AppRouteNames.LOGIN,
  AppRouteNames.REGISTER,
  AppRouteNames.RESIDENT_LOGIN,
  AppRouteNames.GUEST_INVITE,
])

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: { name: AppRouteNames.LOGIN } },
    { path: AppPaths.LOGIN, name: AppRouteNames.LOGIN, component: AuthView },
    { path: AppPaths.REGISTER, name: AppRouteNames.REGISTER, component: AuthView },
    { path: AppPaths.RESIDENT_LOGIN, name: AppRouteNames.RESIDENT_LOGIN, component: AuthView },
    {
      path: AppPaths.GUEST_INVITE,
      name: AppRouteNames.GUEST_INVITE,
      component: GuestInviteView,
    },
    {
      path: AppPaths.APP,
      component: AppShellView,
      children: [
        { path: '', name: AppRouteNames.APP_DASHBOARD, component: AppDashboardView },
        {
          path: 'advanced-management',
          name: AppRouteNames.APP_ADVANCED_MANAGEMENT,
          component: AppAdvancedManagementView,
        },
        { path: 'import', name: AppRouteNames.APP_IMPORT, component: AppImportView },
        { path: 'finance', name: AppRouteNames.APP_FINANCE, component: AppFinanceView },
        { path: 'generation', name: AppRouteNames.APP_GENERATION, component: AppGenerationView },
        { path: 'incidents', name: AppRouteNames.APP_INCIDENTS, component: AppIncidentsView },
        { path: 'information', name: AppRouteNames.APP_INFORMATION, component: AppInformationView },
        {
          path: 'collections-management-expenses',
          name: AppRouteNames.APP_COLLECTIONS_MANAGEMENT_EXPENSES,
          component: AppCollectionsManagementExpensesView,
        },
        { path: 'team', name: AppRouteNames.APP_TEAM, component: AppTeamView },
        {
          path: 'resident-help',
          name: AppRouteNames.APP_RESIDENT_HELP,
          component: AppAdminResidentHelpView,
        },
        { path: 'projects', name: AppRouteNames.APP_PROJECTS, component: AppProjectsView },
        { path: 'settings', name: AppRouteNames.APP_SETTINGS, component: AppSettingsView },
        {
          path: 'resident/dashboard',
          name: AppRouteNames.APP_RESIDENT_DASHBOARD,
          component: AppResidentDashboardView,
        },
        {
          path: 'resident/finance',
          name: AppRouteNames.APP_RESIDENT_FINANCE,
          component: AppResidentFinanceView,
        },
        {
          path: 'resident/services',
          name: AppRouteNames.APP_RESIDENT_SERVICES,
          component: AppResidentServicesView,
        },
        {
          path: 'resident/generation',
          name: AppRouteNames.APP_RESIDENT_GENERATION,
          component: AppResidentGenerationView,
        },
        {
          path: 'resident/incidents',
          name: AppRouteNames.APP_RESIDENT_INCIDENTS,
          component: AppResidentIncidentsView,
        },
        {
          path: 'resident/support',
          name: AppRouteNames.APP_RESIDENT_SUPPORT,
          component: AppResidentSupportView,
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: { name: AppRouteNames.LOGIN } },
  ],
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

function wantsResidentSurface(to) {
  return to.path.startsWith('/app/resident')
}

router.beforeEach((to) => {
  // Wireframe mode: keep login/register visible for screenshots; any submit still lets you in.
  // Only auto-provision a demo session when entering /app.
  if (OPEN_WIREFRAME_ACCESS && to.path.startsWith('/app')) {
    const hasValidPreviewSession =
      getSessionRole() &&
      getAccessToken() &&
      isAccessTokenValid()

    if (!hasValidPreviewSession) {
      ensureOpenAccessSession(
        wantsResidentSurface(to)
          ? SessionRoles.RESIDENT
          : SessionRoles.ADMIN,
      )
    } else if (wantsResidentSurface(to)) {
      ensureOpenAccessSession(SessionRoles.RESIDENT)
    } else if (
      getSessionRole() === SessionRoles.RESIDENT &&
      to.name != null &&
      !RESIDENT_APP_ROUTE_NAMES.has(to.name)
    ) {
      ensureOpenAccessSession(SessionRoles.ADMIN)
    }
    return true
  }

  if (PUBLIC_ROUTE_NAMES.has(to.name)) {
    return true
  }
  if (!to.path.startsWith('/app')) {
    return true
  }

  const role = getSessionRole()
  const token = getAccessToken()
  if (!role || !token || !isAccessTokenValid()) {
    if (token && !isAccessTokenValid()) {
      clearSession()
    }
    return {
      name: AppRouteNames.LOGIN,
      query: {
        redirect: to.fullPath,
        ...(token && !isAccessTokenValid() ? { session: 'expired' } : {}),
      },
    }
  }

  if (
    role === SessionRoles.RESIDENT &&
    (to.name == null || !RESIDENT_APP_ROUTE_NAMES.has(to.name))
  ) {
    return { name: AppRouteNames.APP_RESIDENT_DASHBOARD }
  }

  return true
})

export default router
