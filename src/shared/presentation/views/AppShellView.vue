<script setup>
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Toast from 'primevue/toast'
import { useToast } from 'primevue/usetoast'
import SkipLink from '../components/SkipLink.vue'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import {
  markIncidentsSeen,
  onIncidentRealtime,
  startIncidentRealtime,
  stopIncidentRealtime,
  useIncidentRealtime,
} from '@/incidents/application/incidentRealtimeStore.js'
import { stopSupportHub } from '@/residentCare/infrastructure/supportRealtime.js'
import { IncidentRealtimeEvent } from '@/incidents/domain/model/incidentConstants.js'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { isResident, clearSession } = useSession()
const toast = useToast()
const { state: incidentRealtime } = useIncidentRealtime()

const adminNavPrimary = computed(() => [
  {
    key: 'dashboard',
    label: t('app.dashboard'),
    icon: 'pi pi-th-large',
    routeName: AppRouteNames.APP_DASHBOARD,
  },
  {
    key: 'advancedManagement',
    label: t('app.advancedManagement'),
    icon: 'pi pi-sitemap',
    routeName: AppRouteNames.APP_ADVANCED_MANAGEMENT,
  },
  {
    key: 'import',
    label: t('app.import'),
    icon: 'pi pi-upload',
    routeName: AppRouteNames.APP_IMPORT,
  },
  {
    key: 'finance',
    label: t('app.finance'),
    icon: 'pi pi-wallet',
    routeName: AppRouteNames.APP_FINANCE,
  },
  {
    key: 'generation',
    label: t('app.generation'),
    icon: 'pi pi-cog',
    routeName: AppRouteNames.APP_GENERATION,
  },
  {
    key: 'incidents',
    label: t('app.incidents'),
    icon: 'pi pi-flag',
    routeName: AppRouteNames.APP_INCIDENTS,
    badge: incidentRealtime.unseenCount > 0 ? incidentRealtime.unseenCount : null,
    badgeLabel: t('incidentFlow.newBadgeLabel', { count: incidentRealtime.unseenCount }),
  },
  {
    key: 'information',
    label: t('app.information'),
    icon: 'pi pi-book',
    routeName: AppRouteNames.APP_INFORMATION,
  },
  {
    key: 'residentHelp',
    label: t('app.residentHelp'),
    icon: 'pi pi-comments',
    routeName: AppRouteNames.APP_RESIDENT_HELP,
  },
])

const adminNavAdministrative = computed(() => [
  {
    key: 'collectionsManagementExpenses',
    label: t('app.collectionsManagementExpenses'),
    icon: 'pi pi-chart-line',
    routeName: AppRouteNames.APP_COLLECTIONS_MANAGEMENT_EXPENSES,
  },
])

const residentNavItems = computed(() => [
  {
    key: 'residentDashboard',
    label: t('resident.navDashboard'),
    icon: 'pi pi-th-large',
    routeName: AppRouteNames.APP_RESIDENT_DASHBOARD,
  },
  {
    key: 'residentFinance',
    label: t('resident.navFinance'),
    icon: 'pi pi-wallet',
    routeName: AppRouteNames.APP_RESIDENT_FINANCE,
  },
  {
    key: 'residentServices',
    label: t('resident.navServices'),
    icon: 'pi pi-bolt',
    routeName: AppRouteNames.APP_RESIDENT_SERVICES,
  },
  {
    key: 'residentGeneration',
    label: t('resident.navGeneration'),
    icon: 'pi pi-calendar',
    routeName: AppRouteNames.APP_RESIDENT_GENERATION,
  },
  {
    key: 'residentIncidents',
    label: t('resident.navIncidents'),
    icon: 'pi pi-flag',
    routeName: AppRouteNames.APP_RESIDENT_INCIDENTS,
  },
  {
    key: 'residentSupport',
    label: t('resident.navSupport'),
    icon: 'pi pi-question-circle',
    routeName: AppRouteNames.APP_RESIDENT_SUPPORT,
  },
])

const lockChatPageScroll = computed(
  () =>
    route.name === AppRouteNames.APP_RESIDENT_SUPPORT ||
    route.name === AppRouteNames.APP_RESIDENT_HELP,
)

const appNavPrimaryItems = computed(() =>
  isResident.value ? residentNavItems.value : adminNavPrimary.value,
)

const appNavAdministrativeItems = computed(() =>
  isResident.value ? [] : adminNavAdministrative.value,
)

const activeAppNavPrimaryIndex = computed(() =>
  appNavPrimaryItems.value.findIndex((item) => item.routeName === route.name),
)

const isAppNavPrimaryPillVisible = computed(() => activeAppNavPrimaryIndex.value >= 0)

// RF024: aviso en tiempo real de nuevas incidencias al admin (SignalR /hubs/support).
let stopIncidentToasts = () => {}

async function connectIncidentRealtime() {
  if (isResident.value) return
  const ownerId = getActiveDataOwnerId()
  if (!ownerId) return
  await startIncidentRealtime(ownerId, { countUnseen: true })
}

onMounted(() => {
  stopIncidentToasts = onIncidentRealtime((type, payload) => {
    if (type !== IncidentRealtimeEvent.CREATED || isResident.value) return
    if (route.name === AppRouteNames.APP_INCIDENTS) markIncidentsSeen()
    toast.add({
      group: 'incidents',
      severity: 'info',
      summary: t('incidentFlow.newIncidentToast'),
      detail: [payload?.title, payload?.residentName].filter(Boolean).join(' · '),
      life: 6000,
    })
  })
  connectIncidentRealtime()
})

onBeforeUnmount(() => stopIncidentToasts())

watch(
  () => route.name,
  (name) => {
    if (name === AppRouteNames.APP_INCIDENTS) markIncidentsSeen()
  },
  { immediate: true },
)

function onLogout() {
  // Tear realtime down explicitly (clearSession also notifies identity listeners) so the
  // next user in this tab never inherits this user's hub connection / groups / listeners.
  stopIncidentRealtime()
  void stopSupportHub()
  clearSession()
  router.push({ name: AppRouteNames.LOGIN })
}

function toggleAppLocale() {
  locale.value = locale.value === 'es' ? 'en' : 'es'
}
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--chat': lockChatPageScroll }">
    <SkipLink />
    <Toast v-if="!isResident" group="incidents" position="top-right" />
    <aside class="app-shell__sidebar">
      <header class="app-shell__top">
        <RouterLink 
          class="app-shell__brand" 
          :to="{ name: isResident ? AppRouteNames.APP_RESIDENT_DASHBOARD : AppRouteNames.APP_DASHBOARD }"
        >
          <img
            src="/logo-buildingfex.png"
            :alt="t('brand')"
            class="app-shell__logo"
            width="120"
            height="29"
            decoding="async"
          />
        </RouterLink>

        <button
          type="button"
          class="app-shell__lang-switch-btn"
          role="switch"
          :aria-label="t('app.languageSwitch')"
          :aria-checked="locale === 'en'"
          @click="toggleAppLocale"
        >
          <span class="app-shell__segment-track">
            <span
              class="app-shell__segment-pill"
              :class="{ 'app-shell__segment-pill--right': locale === 'en' }"
              aria-hidden="true"
            />
            <span
              class="app-shell__segment-locale"
              :class="{ 'app-shell__segment-tab--active': locale === 'es' }"
              aria-hidden="true"
            >ES</span>
            <span
              class="app-shell__segment-locale"
              :class="{ 'app-shell__segment-tab--active': locale === 'en' }"
              aria-hidden="true"
            >EN</span>
          </span>
        </button>
      </header>

      <div class="app-shell__divider" role="presentation" />

      <nav class="app-shell__nav" :aria-label="t('app.sidebarNav')">
        <div class="app-shell__nav-cluster">
          <div
            class="app-shell__nav-track"
            :style="{ '--nav-pill-index': activeAppNavPrimaryIndex }"
          >
            <span
              class="app-shell__nav-pill"
              :class="{ 'app-shell__nav-pill--hidden': !isAppNavPrimaryPillVisible }"
              aria-hidden="true"
            />
            <RouterLink
              v-for="item in appNavPrimaryItems"
              :key="item.key"
              class="app-shell__nav-link"
              active-class="app-shell__nav-link--active"
              exact-active-class="app-shell__nav-link--active"
              :to="{ name: item.routeName }"
            >
              <i :class="[item.icon, 'app-shell__nav-link-icon']" aria-hidden="true" />
              <span>{{ item.label }}</span>
              <span
                v-if="item.badge"
                class="app-shell__nav-badge"
                role="status"
                :aria-label="item.badgeLabel"
              >{{ item.badge > 99 ? '99+' : item.badge }}</span>
            </RouterLink>
          </div>

          <template v-if="appNavAdministrativeItems.length">
            <div class="app-shell__nav-split" role="presentation" />
            <p class="app-shell__nav-group-label">{{ t('app.sidebarAdministrative') }}</p>
            <div class="app-shell__nav-track app-shell__nav-track--simple">
              <RouterLink
                v-for="item in appNavAdministrativeItems"
                :key="item.key"
                class="app-shell__nav-link"
                active-class="app-shell__nav-link--active"
                exact-active-class="app-shell__nav-link--active"
                :to="{ name: item.routeName }"
              >
                <i :class="[item.icon, 'app-shell__nav-link-icon']" aria-hidden="true" />
                <span>{{ item.label }}</span>
              </RouterLink>
            </div>
          </template>
        </div>
      </nav>

      <footer class="app-shell__footer">
        <RouterLink
          class="app-shell__chip app-shell__chip--outline app-shell__chip--footer"
          active-class="app-shell__chip--outline-active"
          exact-active-class="app-shell__chip--outline-active"
          :to="{ name: AppRouteNames.APP_SETTINGS }"
        >
          <i class="pi pi-cog app-shell__chip-icon" aria-hidden="true" />
          {{ t('app.settings') }}
        </RouterLink>
        <button type="button" class="app-shell__chip app-shell__chip--danger" @click="onLogout">
          <i class="pi pi-sign-out app-shell__chip-icon" aria-hidden="true" />
          {{ t('app.logout') }}
        </button>
      </footer>
    </aside>
    <main
      id="main-content"
      class="app-shell__main"
      :class="{ 'app-shell__main--chat': lockChatPageScroll }"
      role="main"
      tabindex="-1"
    >
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  --shell-sidebar-width: 13rem;
  --shell-sidebar-bg: #ffffff;
  --shell-border: #e8e8ed;
  --shell-text: #1d1d1f;
  --shell-muted: #6e6e73;
  --shell-nav-active: #f2f2f7;
  --shell-danger-bg: #fdecee;
  --shell-danger-text: #b42318;
  --shell-pill-radius: 980px;

  min-height: 100vh;
  min-height: 100dvh;
  font-family: var(--apple-font, -apple-system, system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
  background: var(--apple-bg-secondary, #f5f5f7);
}

/* Escritorio: sidebar fijo a la vista (ancho/posición estables; el main scrollea solo) */
.app-shell__sidebar {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 300;
  height: 100vh;
  height: 100dvh;
  width: var(--shell-sidebar-width);
  min-width: var(--shell-sidebar-width);
  max-width: var(--shell-sidebar-width);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--shell-sidebar-bg);
  border-right: 1px solid var(--shell-border);
  padding: 1rem 0.55rem 1rem;
  align-items: center;
  text-align: center;
}

.app-shell__main {
  margin-left: var(--shell-sidebar-width);
  min-height: 100vh;
  min-height: 100dvh;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  background: var(--apple-bg, #ffffff);
}

.app-shell--chat {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.app-shell__main--chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  max-height: 100vh;
  max-height: 100dvh;
  overflow: hidden;
}

.app-shell__top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  width: 100%;
}

.app-shell__brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  text-decoration: none;
  color: inherit;
  border-radius: 12px;
  padding: 0.15rem 0.25rem;
  margin: -0.15rem -0.25rem;
}

.app-shell__brand:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.app-shell__logo {
  display: block;
  height: auto;
  max-width: 7.75rem;
  margin-left: auto;
  margin-right: auto;
}

.app-shell__segment {
  width: 100%;
  max-width: 11.25rem;
}

.app-shell__segment-track {
  /* ~50% menos altura que la versión anterior */
  --seg-p: 0.105rem;
  --seg-gap: 0.18rem;

  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--seg-gap);
  padding: var(--seg-p);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
}

.app-shell__segment-pill {
  position: absolute;
  top: var(--seg-p);
  bottom: var(--seg-p);
  left: var(--seg-p);
  z-index: 0;
  width: calc((100% - 2 * var(--seg-p) - var(--seg-gap)) / 2);
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.07);
  pointer-events: none;
  transition: transform 0.42s cubic-bezier(0.34, 1.2, 0.64, 1);
  will-change: transform;
}

.app-shell__segment-pill--right {
  transform: translateX(calc(100% + var(--seg-gap)));
}

.app-shell__segment-tab {
  position: relative;
  z-index: 1;
  margin: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
  padding: 0.14rem 0.22rem;
  min-height: 1.18rem;
  font-size: 0.625rem;
  line-height: 1.2;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--shell-muted);
  background: transparent;
  border: none;
  border-radius: 999px;
  font-family: inherit;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    color 0.28s ease,
    font-weight 0.28s ease;
}

.app-shell__segment-tab:hover {
  color: var(--shell-text);
}

.app-shell__segment-tab:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.app-shell__segment-tab--active {
  color: var(--shell-text);
  font-weight: 700;
}

.app-shell__segment-tab-icon {
  flex-shrink: 0;
  font-size: 0.56rem;
  line-height: 1;
  opacity: 0.88;
}

.app-shell__segment-tab--active .app-shell__segment-tab-icon {
  opacity: 1;
}

.app-shell__segment-tab-text {
  display: block;
  max-width: 100%;
  text-align: center;
  text-wrap: balance;
}

.app-shell__segment-locale {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0.14rem 0.22rem;
  min-height: 1.18rem;
  font-size: 0.625rem;
  line-height: 1.2;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--shell-muted);
  pointer-events: none;
  user-select: none;
  box-sizing: border-box;
}

.app-shell__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.32rem 0.5rem;
  border: none;
  border-radius: var(--shell-pill-radius);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
  box-sizing: border-box;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.app-shell__chip-icon {
  font-size: 0.75rem;
  opacity: 0.85;
}

.app-shell__chip--outline {
  background: #fff;
  color: var(--shell-text);
  border: 1px solid var(--shell-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.app-shell__chip--outline:hover {
  background: #fafafa;
  border-color: #d2d2d7;
}

.app-shell__chip--outline:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.app-shell__chip--outline-active {
  background: var(--shell-nav-active);
  border-color: #d2d2d7;
}

.app-shell__chip--footer {
  width: 100%;
  max-width: 100%;
  justify-content: center;
}

.app-shell__chip--danger {
  width: 100%;
  max-width: 100%;
  justify-content: center;
  background: var(--shell-danger-bg);
  color: var(--shell-danger-text);
  border: 1px solid transparent;
}

.app-shell__chip--danger:hover {
  filter: brightness(0.97);
}

.app-shell__chip--danger:focus-visible {
  outline: 2px solid var(--shell-danger-text);
  outline-offset: 2px;
}

.app-shell__divider {
  height: 1px;
  background: var(--shell-border);
  margin: 1.125rem 0 0.875rem;
  flex-shrink: 0;
  width: 100%;
  max-width: 11.25rem;
}

.app-shell__nav {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  justify-content: center;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.app-shell__nav-cluster {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.app-shell__nav-split {
  height: 1px;
  background: var(--shell-border);
  width: 100%;
  max-width: 11.25rem;
  margin: 0.15rem 0 0;
  flex-shrink: 0;
}

.app-shell__nav-group-label {
  margin: 0;
  align-self: stretch;
  max-width: 11.25rem;
  padding: 0 0.35rem;
  box-sizing: border-box;
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--shell-muted);
  text-align: left;
}

.app-shell__nav-track {
  --nav-p: 0.21rem;
  --nav-gap: 0.21rem;
  --nav-item-height: 2rem;
  display: grid;
  grid-template-columns: 1fr;
  grid-auto-rows: var(--nav-item-height);
  gap: var(--nav-gap);
  padding: var(--nav-p);
  width: 100%;
  max-width: 11.25rem;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.06);
  box-sizing: border-box;
  position: relative;
}

.app-shell__nav-pill {
  position: absolute;
  top: var(--nav-p);
  left: var(--nav-p);
  right: var(--nav-p);
  z-index: 0;
  height: var(--nav-item-height);
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.07);
  pointer-events: none;
  opacity: 1;
  transform: translateY(calc((var(--nav-item-height) + var(--nav-gap)) * var(--nav-pill-index)));
  transition:
    transform 0.42s cubic-bezier(0.34, 1.2, 0.64, 1),
    opacity 0.2s ease;
  will-change: transform;
}

.app-shell__nav-pill--hidden {
  opacity: 0;
}

.app-shell__nav-link {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin: 0;
  width: 100%;
  text-align: center;
  padding: 0.3rem 0.35rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--shell-muted);
  background: transparent;
  text-decoration: none;
  box-sizing: border-box;
  transition:
    color 0.28s ease,
    font-weight 0.28s ease;
}

.app-shell__nav-link:hover {
  color: var(--shell-text);
}

.app-shell__nav-link:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.app-shell__nav-link--active {
  color: var(--shell-text);
  font-weight: 700;
}

.app-shell__nav-link-icon {
  font-size: 0.85rem;
  color: var(--shell-muted);
  width: 1.1rem;
  text-align: center;
  flex-shrink: 0;
  transition: color 0.28s ease;
}

.app-shell__nav-link--active .app-shell__nav-link-icon {
  color: var(--shell-text);
}

.app-shell__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding-top: 1rem;
  margin-top: auto;
  border-top: 1px solid var(--shell-border);
  width: 100%;
  max-width: 11.25rem;
}

.app-shell__lang-switch-btn {
  display: block;
  width: 100%;
  max-width: 11.25rem;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  line-height: 0;
  border-radius: 999px;
}

.app-shell__lang-switch-btn:focus {
  outline: none;
}

.app-shell__lang-switch-btn:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
  border-radius: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .app-shell__segment-pill,
  .app-shell__nav-pill {
    transition-duration: 0.01ms;
  }

}

@media (max-width: 720px) {
  .app-shell {
    display: flex;
    flex-direction: column;
  }

  .app-shell__sidebar {
    position: relative;
    top: auto;
    left: auto;
    z-index: auto;
    width: 100%;
    min-width: 0;
    max-width: none;
    height: auto;
    min-height: 0;
    flex: 0 0 auto;
    overflow-x: visible;
    overflow-y: visible;
    border-right: none;
    border-bottom: 1px solid var(--shell-border);
  }

  .app-shell__main {
    margin-left: 0;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* Stacked nav + chat: let the page scroll instead of squeezing the conversation into the leftover height. */
  .app-shell--chat {
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: visible;
  }

  .app-shell__main--chat {
    height: auto;
    max-height: none;
    overflow: visible;
  }

  .app-shell__divider,
  .app-shell__nav-cluster,
  .app-shell__nav-track,
  .app-shell__footer {
    max-width: min(16rem, 100%);
  }

  .app-shell__nav-link {
    padding: 0.45rem 0.5rem;
    font-size: 0.8125rem;
  }

  .app-shell__footer {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
  }

  .app-shell__chip--footer,
  .app-shell__chip--danger {
    width: auto;
    flex: 1 1 auto;
    min-width: min(100%, 8rem);
    justify-content: center;
  }

  .app-shell__lang-switch-btn {
    flex: 1 1 100%;
    max-width: 11.25rem;
  }
}
.app-shell__nav-badge {
  position: absolute;
  top: 50%;
  right: 0.45rem;
  transform: translateY(-50%);
  min-width: 1.15rem;
  height: 1.15rem;
  padding: 0 0.35rem;
  border-radius: 980px;
  background: #e5484d;
  color: #fff;
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.15rem;
  text-align: center;
}
</style>
