<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import Dialog from 'primevue/dialog'
import { membersApi } from '@/iam/infrastructure/membersApi.js'
import { loadAccessibleBuildings, switchBuilding } from '@/iam/application/buildingWorkspace.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import {
  PORTAFOLIO_MINIMUM_PEN,
  PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN,
  SubscriptionPlanId,
} from '@/billing/domain/subscriptionPlans.js'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import '@/shared/presentation/assets/bf-workspace.css'

/**
 * Mis edificios (consola Portafolio). La plataforma se divide por edificios: cada uno es un condominio
 * con sus propios residentes, cuotas, reservas, incidencias y documentos. Con el plan Portafolio una
 * misma cuenta administra varios y paga una sola suscripción (S/ 4 por departamento, mínimo S/ 600).
 */
const { t, locale } = useI18n()
const router = useRouter()
const { state: session, isBoard } = useSession()

const isLoading = ref(true)
const loadFailed = ref(false)
const rows = ref([])
const workspace = ref({ canAddBuildings: false, planId: null, accountKind: null })
const search = ref('')

const addOpen = ref(false)
const form = ref({ name: '', address: '', departmentCount: '' })
const formErrors = ref({})
const formError = ref('')
const saving = ref(false)

const isAccountOwner = computed(() => !isBoard.value && rows.value.some((r) => r.role === 'owner'))
const onPortfolio = computed(() => workspace.value.planId === SubscriptionPlanId.PORTAFOLIO)
const plansRoute = { name: AppRouteNames.APP_SETTINGS, query: { tab: 'plans', suggestedPlan: SubscriptionPlanId.PORTAFOLIO } }

const totals = computed(() => {
  const sum = (field) => rows.value.reduce((acc, r) => acc + (Number(r[field]) || 0), 0)
  return {
    buildings: rows.value.length,
    departments: sum('departmentCount'),
    residents: sum('residents'),
    openIncidents: sum('openIncidents'),
  }
})
const ownedDepartments = computed(() =>
  rows.value.filter((r) => r.role === 'owner').reduce((acc, r) => acc + (Number(r.departmentCount) || 0), 0),
)
const portfolioMonthly = computed(() =>
  Math.max(PORTAFOLIO_MINIMUM_PEN, PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN * ownedDepartments.value),
)

/** Con pocos edificios el buscador sobra. */
const showSearch = computed(() => rows.value.length > 3)
const visibleRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q ? rows.value.filter((r) => `${r.name ?? ''} ${r.address ?? ''}`.toLowerCase().includes(q)) : rows.value
  // El edificio abierto va primero.
  return [...list].sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
})

const kpiPills = computed(() => [
  { key: 'buildings', tone: 'blue', icon: 'pi-building', label: t('portfolio.totalBuildings'), value: totals.value.buildings },
  {
    key: 'departments',
    tone: 'green',
    icon: 'pi-th-large',
    label: t('portfolio.totalDepartments'),
    short: t('portfolio.statDepartments'),
    value: totals.value.departments,
  },
  { key: 'residents', tone: 'amber', icon: 'pi-users', label: t('portfolio.totalResidents'), value: totals.value.residents },
  {
    key: 'incidents',
    tone: totals.value.openIncidents ? 'orange' : 'green',
    icon: 'pi-flag',
    label: t('portfolio.totalIncidents'),
    short: t('portfolio.statIncidents'),
    value: totals.value.openIncidents,
    alert: totals.value.openIncidents > 0,
  },
])

function pen(value) {
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    style: 'currency',
    currency: 'PEN',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0)
}

function roleLabel(role) {
  if (role === 'owner') return t('portfolio.roleOwner')
  if (role === 'admin') return t('portfolio.roleAdmin')
  return t('portfolio.roleBoard')
}

function roleTone(role) {
  if (role === 'owner') return 'ws-pill--blue'
  if (role === 'admin') return 'ws-pill--green'
  return 'ws-pill--amber'
}

function isActive(row) {
  return String(row.ownerAdminId) === String(session.activeBuildingId)
}

function open(row) {
  const name = row.role === 'board_member' ? AppRouteNames.APP_BOARD : AppRouteNames.APP_DASHBOARD
  if (isActive(row)) {
    router.push({ name })
    return
  }
  switchBuilding(row.ownerAdminId, { reloadTo: router.resolve({ name }).href })
}

async function load() {
  isLoading.value = true
  loadFailed.value = false
  try {
    const [summary, mine] = await Promise.all([membersApi.portfolioSummary(), loadAccessibleBuildings()])
    rows.value = summary
    if (mine) workspace.value = mine
  } catch {
    loadFailed.value = true
  } finally {
    isLoading.value = false
  }
}

function openAdd() {
  form.value = { name: '', address: '', departmentCount: '' }
  formErrors.value = {}
  formError.value = ''
  addOpen.value = true
}

function closeAdd() {
  if (!saving.value) addOpen.value = false
}

/** Cuotas por defecto del edificio nuevo (como al registrar la cuenta), en su propio condominio. */
async function seedBuildingDefaults(ownerAdminId) {
  try {
    await apiClient.post(
      '/financeSettings',
      {
        ownerAdminId,
        baseMonthlyExpense: 150,
        lateFeeRate: 0,
        lateFeePerDay: 0,
        admissionPayFromDay: 1,
        admissionPayToDay: 7,
        monthlyCharges: [],
      },
      { headers: { 'X-Building-Id': ownerAdminId } },
    )
  } catch {
    // Se configuran después en Finanzas.
  }
}

async function onAdd() {
  if (saving.value) return
  formError.value = ''
  const errors = {}
  if (!form.value.name.trim()) errors.name = t('common.fieldRequired')
  if (!form.value.address.trim()) errors.address = t('common.fieldRequired')
  const count = Number(form.value.departmentCount)
  if (!Number.isInteger(count) || count < 1 || count > 5000) errors.departmentCount = t('portfolio.errorDepartments')
  formErrors.value = errors
  if (Object.keys(errors).length) return
  saving.value = true
  try {
    const created = await membersApi.addBuilding({
      name: form.value.name.trim(),
      address: form.value.address.trim(),
      departmentCount: count,
    })
    if (created?.ownerAdminId) await seedBuildingDefaults(created.ownerAdminId)
    addOpen.value = false
    await load()
  } catch (error) {
    const keys = {
      PORTFOLIO_PLAN_REQUIRED: 'portfolio.errorPlan',
      FIRST_BUILDING_REQUIRED: 'portfolio.errorFirstBuilding',
      ACCOUNT_OWNER_REQUIRED: 'portfolio.errorOwner',
      BUILDING_VALIDATION_FAILED: 'portfolio.errorValidation',
    }
    formError.value = t(keys[error?.code] ?? 'portfolio.errorGeneric')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="ws-view pf">
    <header class="ws-head">
      <h1 class="bf-sr-only">{{ t('portfolio.title') }}</h1>
      <KpiPills v-if="!loadFailed" inline :items="kpiPills" :aria-label="t('portfolio.totalsLabel')" :busy="isLoading" />
      <div class="ws-head__actions">
        <button
          type="button"
          class="ws-icon-btn"
          :aria-label="t('access.refresh')"
          :title="t('access.refresh')"
          :disabled="isLoading"
          @click="load"
        >
          <i class="pi" :class="isLoading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
        </button>
        <button
          v-if="isAccountOwner && workspace.canAddBuildings"
          type="button"
          class="ws-btn ws-btn--primary"
          @click="openAdd"
        >
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('portfolio.add') }}
        </button>
        <RouterLink v-else-if="isAccountOwner && !onPortfolio" class="ws-btn ws-btn--primary" :to="plansRoute">
          <i class="pi pi-star" aria-hidden="true" />
          {{ t('portfolio.upsellCta') }}
        </RouterLink>
      </div>
    </header>

    <LoadErrorRetry v-if="loadFailed" :loading="isLoading" @retry="load" />

    <section v-else class="ws-card" :aria-label="t('portfolio.title')">
      <div v-if="showSearch || isAccountOwner" class="ws-toolbar pf-toolbar">
        <label v-if="showSearch" class="ws-search" for="pf-search">
          <i class="pi pi-search" aria-hidden="true" />
          <input
            id="pf-search"
            v-model="search"
            type="search"
            :placeholder="t('portfolio.searchPlaceholder')"
            :aria-label="t('portfolio.searchPlaceholder')"
          />
        </label>
        <div v-if="isAccountOwner" class="pf-plan" :class="{ 'is-active': onPortfolio }">
          <span class="pf-plan__badge"><i class="pi pi-star-fill" aria-hidden="true" />{{ t('portfolio.portfolioChip') }}</span>
          <template v-if="onPortfolio">
            <span class="pf-plan__calc">
              {{ t('portfolio.planCalc', { departments: ownedDepartments, price: pen(PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN) }) }}
            </span>
            <strong class="pf-plan__total">{{ pen(portfolioMonthly) }}<small>/{{ t('portfolio.monthShort') }}</small></strong>
          </template>
          <span v-else class="pf-plan__calc">
            {{ pen(PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN) }} {{ t('portfolio.perDepartmentShort') }} ·
            {{ t('portfolio.minimum', { minimum: pen(PORTAFOLIO_MINIMUM_PEN) }) }}
          </span>
        </div>
      </div>

      <p v-if="isLoading && !rows.length" class="ws-status" role="status">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        {{ t('board.loading') }}
      </p>

      <div v-else-if="!visibleRows.length" class="ws-empty">
        <span class="ws-empty__icon"><i class="pi pi-filter-slash" aria-hidden="true" /></span>
        <span>{{ t('portfolio.emptyFiltered') }}</span>
      </div>

      <div v-else class="ws-table-wrap">
        <table class="ws-table">
          <thead>
            <tr>
              <th scope="col">{{ t('portfolio.colBuilding') }}</th>
              <th scope="col">{{ t('portfolio.colRole') }}</th>
              <th scope="col" class="is-num">{{ t('portfolio.statDepartments') }}</th>
              <th scope="col" class="is-num">{{ t('portfolio.statResidents') }}</th>
              <th scope="col">{{ t('portfolio.statIncidents') }}</th>
              <th scope="col" class="c-actions"><span class="bf-sr-only">{{ t('access.colActions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="row.ownerAdminId" :class="{ 'pf-row--active': isActive(row) }">
              <td class="c-main">
                <div class="ws-who">
                  <span class="ws-avatar ws-avatar--square" :class="{ 'ws-avatar--slate': !isActive(row) }" aria-hidden="true">
                    <i class="pi pi-building" />
                  </span>
                  <div class="ws-who__text">
                    <strong>{{ row.name }}</strong>
                    <small>{{ row.address || t('portfolio.noAddress') }}</small>
                  </div>
                </div>
              </td>
              <td :data-label="t('portfolio.colRole')">
                <span class="ws-pill" :class="roleTone(row.role)">{{ roleLabel(row.role) }}</span>
              </td>
              <td class="is-num pf-num" :data-label="t('portfolio.statDepartments')">{{ row.departmentCount }}</td>
              <td class="is-num pf-num" :data-label="t('portfolio.statResidents')">{{ row.residents }}</td>
              <td :data-label="t('portfolio.statIncidents')">
                <span class="ws-pill" :class="row.openIncidents > 0 ? 'ws-pill--orange' : 'ws-pill--green'">
                  <i class="pi" :class="row.openIncidents > 0 ? 'pi-flag' : 'pi-check'" aria-hidden="true" />
                  {{ row.openIncidents > 0 ? t('portfolio.openCount', row.openIncidents) : t('portfolio.noOpen') }}
                </span>
              </td>
              <td class="c-actions">
                <div class="ws-row-actions">
                  <button
                    type="button"
                    class="ws-chip"
                    :class="{ 'is-current': isActive(row) }"
                    :aria-label="isActive(row) ? t('portfolio.current') : t('portfolio.openFor', { name: row.name })"
                    @click="open(row)"
                  >
                    <i class="pi" :class="isActive(row) ? 'pi-check' : 'pi-arrow-right'" aria-hidden="true" />
                    {{ isActive(row) ? t('portfolio.current') : t('portfolio.open') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Dialog
      :visible="addOpen"
      modal
      dismissable-mask
      :header="t('portfolio.addTitle')"
      class="ws-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!saving"
      :close-on-escape="!saving"
      @update:visible="(visible) => !visible && closeAdd()"
    >
      <form class="ws-form" novalidate @submit.prevent="onAdd">
        <div class="ws-field">
          <label for="pf-name">{{ t('portfolio.name') }}</label>
          <input
            id="pf-name"
            v-model="form.name"
            type="text"
            :aria-invalid="formErrors.name ? 'true' : 'false'"
            @input="formErrors.name = ''"
          />
          <small v-if="formErrors.name" class="ws-field__error">{{ formErrors.name }}</small>
        </div>
        <div class="ws-field">
          <label for="pf-address">{{ t('portfolio.address') }}</label>
          <input
            id="pf-address"
            v-model="form.address"
            type="text"
            :aria-invalid="formErrors.address ? 'true' : 'false'"
            @input="formErrors.address = ''"
          />
          <small v-if="formErrors.address" class="ws-field__error">{{ formErrors.address }}</small>
        </div>
        <div class="ws-field">
          <label for="pf-departments">{{ t('portfolio.departments') }}</label>
          <input
            id="pf-departments"
            v-model="form.departmentCount"
            type="number"
            min="1"
            max="5000"
            inputmode="numeric"
            :aria-invalid="formErrors.departmentCount ? 'true' : 'false'"
            @input="formErrors.departmentCount = ''"
          />
          <small v-if="formErrors.departmentCount" class="ws-field__error">{{ formErrors.departmentCount }}</small>
        </div>
        <p v-if="formError" class="ws-form__error" role="alert">{{ formError }}</p>
        <ConfirmActions
          :cancel-label="t('portfolio.cancel')"
          :confirm-label="saving ? t('portfolio.saving') : t('portfolio.save')"
          confirm-type="submit"
          :loading="saving"
          :cancel-disabled="saving"
          :stagger="false"
          @cancel="closeAdd"
        />
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.pf-toolbar {
  justify-content: flex-end;
}

.pf-toolbar:has(.ws-search) {
  justify-content: space-between;
}

.pf-num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.ws-table tbody tr.pf-row--active td {
  background: #f5f8ff;
}

.ws-table tbody tr.pf-row--active td:first-child {
  box-shadow: inset 3px 0 0 #1e3a8a;
}

.pf-plan {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 2.4rem;
  padding: 0 0.95rem 0 0.4rem;
  border-radius: 999px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.08);
  font-size: 0.8rem;
  color: #475569;
  white-space: nowrap;
}

.pf-plan.is-active {
  background: #e8eefc;
  border-color: transparent;
  color: #1e3a8a;
}

.pf-plan__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.6rem;
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font-size: 0.74rem;
  font-weight: 700;
}

.pf-plan__badge .pi {
  font-size: 0.62rem;
  color: #d97706;
}

.pf-plan__total {
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.95rem;
  font-weight: 700;
  color: #0f172a;
}

.pf-plan__total small {
  font-size: 0.72rem;
  font-weight: 600;
  color: #475569;
}

@media (max-width: 900px) {
  .ws-table tbody tr.pf-row--active {
    border-color: #1e3a8a;
  }

  .ws-table tbody tr.pf-row--active td,
  .ws-table tbody tr.pf-row--active td:first-child {
    background: transparent;
    box-shadow: none;
  }

  .pf-plan {
    width: 100%;
    flex-wrap: wrap;
    white-space: normal;
    padding: 0.4rem 0.9rem 0.4rem 0.4rem;
    border-radius: 16px;
  }
}
</style>
