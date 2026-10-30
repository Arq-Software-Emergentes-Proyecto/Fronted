<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
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
import { RouterLink, useRouter } from 'vue-router'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

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

const showForm = ref(false)
const form = ref({ name: '', address: '', departmentCount: '' })
const formErrors = ref({})
const formError = ref('')
const saving = ref(false)

const isAccountOwner = computed(() => !isBoard.value && rows.value.some((r) => r.role === 'owner'))
const onPortfolio = computed(() => workspace.value.planId === SubscriptionPlanId.PORTAFOLIO)
const ownedRows = computed(() => rows.value.filter((r) => r.role === 'owner'))
const totals = computed(() => {
  const list = rows.value
  return {
    buildings: list.length,
    departments: list.reduce((sum, r) => sum + (Number(r.departmentCount) || 0), 0),
    residents: list.reduce((sum, r) => sum + (Number(r.residents) || 0), 0),
    openIncidents: list.reduce((sum, r) => sum + (Number(r.openIncidents) || 0), 0),
  }
})
const ownedDepartments = computed(() => ownedRows.value.reduce((sum, r) => sum + (Number(r.departmentCount) || 0), 0))
const portfolioMonthly = computed(() =>
  Math.max(PORTAFOLIO_MINIMUM_PEN, PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN * ownedDepartments.value),
)

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

function isActive(row) {
  return String(row.ownerAdminId) === String(session.activeBuildingId)
}

function open(row) {
  if (isActive(row)) {
    router.push({ name: row.role === 'board_member' ? AppRouteNames.APP_BOARD : AppRouteNames.APP_DASHBOARD })
    return
  }
  const name = row.role === 'board_member' ? AppRouteNames.APP_BOARD : AppRouteNames.APP_DASHBOARD
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
    form.value = { name: '', address: '', departmentCount: '' }
    showForm.value = false
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
  <div class="app-view portfolio">
    <header class="pf-head">
      <div>
        <h1 class="pf-title">{{ t('portfolio.title') }}</h1>
        <p class="pf-lead">{{ t('portfolio.lead') }}</p>
      </div>
      <button
        v-if="isAccountOwner && workspace.canAddBuildings"
        type="button"
        class="pf-primary"
        :aria-expanded="showForm ? 'true' : 'false'"
        aria-controls="pf-add-form"
        @click="showForm = !showForm"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        <span>{{ t('portfolio.add') }}</span>
      </button>
    </header>

    <LoadErrorRetry v-if="!isLoading && loadFailed" :loading="isLoading" @retry="load" />

    <section class="pf-totals" :aria-label="t('portfolio.totalsLabel')">
      <div class="pf-total"><strong>{{ totals.buildings }}</strong><span>{{ t('portfolio.totalBuildings') }}</span></div>
      <div class="pf-total"><strong>{{ totals.departments }}</strong><span>{{ t('portfolio.totalDepartments') }}</span></div>
      <div class="pf-total"><strong>{{ totals.residents }}</strong><span>{{ t('portfolio.totalResidents') }}</span></div>
      <div class="pf-total"><strong>{{ totals.openIncidents }}</strong><span>{{ t('portfolio.totalIncidents') }}</span></div>
    </section>

    <form
      v-if="showForm"
      id="pf-add-form"
      class="pf-card pf-form"
      novalidate
      :aria-label="t('portfolio.addTitle')"
      @submit.prevent="onAdd"
    >
      <h2 class="pf-card__title">{{ t('portfolio.addTitle') }}</h2>
      <p class="pf-card__hint">{{ t('portfolio.addHint') }}</p>
      <div class="pf-form__grid">
        <div class="pf-field">
          <label for="pf-name">{{ t('portfolio.name') }}</label>
          <input id="pf-name" v-model="form.name" class="pf-input" type="text" :aria-invalid="formErrors.name ? 'true' : 'false'" />
          <small v-if="formErrors.name" class="pf-error">{{ formErrors.name }}</small>
        </div>
        <div class="pf-field">
          <label for="pf-address">{{ t('portfolio.address') }}</label>
          <input id="pf-address" v-model="form.address" class="pf-input" type="text" :aria-invalid="formErrors.address ? 'true' : 'false'" />
          <small v-if="formErrors.address" class="pf-error">{{ formErrors.address }}</small>
        </div>
        <div class="pf-field">
          <label for="pf-departments">{{ t('portfolio.departments') }}</label>
          <input
            id="pf-departments"
            v-model="form.departmentCount"
            class="pf-input"
            type="number"
            min="1"
            max="5000"
            inputmode="numeric"
            :aria-invalid="formErrors.departmentCount ? 'true' : 'false'"
          />
          <small v-if="formErrors.departmentCount" class="pf-error">{{ formErrors.departmentCount }}</small>
        </div>
      </div>
      <p v-if="formError" class="pf-error" role="alert">{{ formError }}</p>
      <div class="pf-form__actions">
        <button type="submit" class="pf-primary" :disabled="saving">
          {{ saving ? t('portfolio.saving') : t('portfolio.save') }}
        </button>
        <button type="button" class="pf-secondary" @click="showForm = false">{{ t('portfolio.cancel') }}</button>
      </div>
    </form>

    <ul class="pf-grid" role="list">
      <li v-for="row in rows" :key="row.ownerAdminId" class="pf-card pf-building" :class="{ 'is-active': isActive(row) }">
        <div class="pf-building__top">
          <span class="pf-building__icon" aria-hidden="true"><i class="pi pi-building" /></span>
          <div class="pf-building__name">
            <h2>{{ row.name }}</h2>
            <p>{{ row.address || t('portfolio.noAddress') }}</p>
          </div>
        </div>
        <dl class="pf-stats">
          <div><dt>{{ t('portfolio.statDepartments') }}</dt><dd>{{ row.departmentCount }}</dd></div>
          <div><dt>{{ t('portfolio.statResidents') }}</dt><dd>{{ row.residents }}</dd></div>
          <div>
            <dt>{{ t('portfolio.statIncidents') }}</dt>
            <dd :class="{ 'is-alert': row.openIncidents > 0 }">{{ row.openIncidents }}</dd>
          </div>
        </dl>
        <div class="pf-building__foot">
          <span class="pf-chip" :class="`pf-chip--${row.role}`">{{ roleLabel(row.role) }}</span>
          <span v-if="row.isPortfolioBuilding" class="pf-chip pf-chip--soft">{{ t('portfolio.portfolioChip') }}</span>
          <button type="button" class="pf-open" @click="open(row)">
            <span>{{ isActive(row) ? t('portfolio.current') : t('portfolio.open') }}</span>
            <i class="pi pi-arrow-right" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>

    <section v-if="isAccountOwner && onPortfolio" class="pf-card pf-plan" aria-labelledby="pf-plan-title">
      <div>
        <h2 id="pf-plan-title" class="pf-card__title">{{ t('portfolio.planActiveTitle') }}</h2>
        <p class="pf-card__hint">
          {{ t('portfolio.planActiveHint', { departments: ownedDepartments, price: pen(PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN), minimum: pen(PORTAFOLIO_MINIMUM_PEN) }) }}
        </p>
      </div>
      <p class="pf-plan__price">
        <strong>{{ pen(portfolioMonthly) }}</strong>
        <span>{{ t('portfolio.perMonth') }}</span>
      </p>
    </section>

    <section v-else-if="isAccountOwner" class="pf-card pf-upsell" aria-labelledby="pf-upsell-title">
      <div class="pf-upsell__text">
        <p class="pf-upsell__eyebrow">{{ t('portfolio.upsellEyebrow') }}</p>
        <h2 id="pf-upsell-title" class="pf-card__title">{{ t('portfolio.upsellTitle') }}</h2>
        <p class="pf-card__hint">{{ t('portfolio.upsellLead') }}</p>
        <ul class="pf-upsell__list">
          <li v-for="key in ['oneAccount', 'separateData', 'switcher', 'team', 'ai', 'support']" :key="key">
            <i class="pi pi-check" aria-hidden="true" />
            <span>{{ t(`portfolio.upsellPoints.${key}`) }}</span>
          </li>
        </ul>
      </div>
      <div class="pf-upsell__price">
        <strong>{{ pen(PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN) }}</strong>
        <span>{{ t('portfolio.perDepartment') }}</span>
        <small>{{ t('portfolio.minimum', { minimum: pen(PORTAFOLIO_MINIMUM_PEN) }) }}</small>
        <RouterLink
          class="pf-primary"
          :to="{ name: AppRouteNames.APP_SETTINGS, query: { tab: 'plans', suggestedPlan: SubscriptionPlanId.PORTAFOLIO } }"
        >
          {{ t('portfolio.upsellCta') }}
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.5rem 1.5rem 2.5rem;
  max-width: 80rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.pf-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.pf-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.pf-lead {
  margin: 0.35rem 0 0;
  max-width: 46rem;
  font-size: 0.9rem;
  color: #475569;
}

.pf-totals {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}

.pf-total {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: #eef2fb;
}

.pf-total strong {
  font-size: 1.35rem;
  font-weight: 700;
  color: #1e3a8a;
}

.pf-total span {
  font-size: 0.76rem;
  color: #475569;
}

.pf-card {
  padding: 1.15rem 1.2rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.pf-card__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  color: #0f172a;
}

.pf-card__hint {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: #64748b;
}

.pf-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.9rem;
}

.pf-building {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.pf-building.is-active {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.1);
}

.pf-building__top {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.pf-building__icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
}

.pf-building__name {
  min-width: 0;
}

.pf-building__name h2 {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 650;
  color: #0f172a;
}

.pf-building__name p {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: #64748b;
}

.pf-stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.pf-stats div {
  padding: 0.5rem 0.6rem;
  border-radius: 10px;
  background: #f8fafc;
}

.pf-stats dt {
  font-size: 0.68rem;
  color: #64748b;
}

.pf-stats dd {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: #0f172a;
}

.pf-stats dd.is-alert {
  color: #c2410c;
}

.pf-building__foot {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-top: auto;
}

.pf-chip {
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 600;
}

.pf-chip--owner {
  background: #e8eefc;
  color: #1e3a8a;
}

.pf-chip--admin {
  background: #e3f4e8;
  color: #15803d;
}

.pf-chip--soft {
  background: #fdf3dc;
  color: #92400e;
}

.pf-open {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.8rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.pf-open:hover {
  background: #eef2ff;
}

.pf-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  padding: 0.45rem 1.1rem;
  border: 0;
  border-radius: 999px;
  background: #1e3a8a;
  color: #fff;
  font: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.pf-primary:hover {
  background: #172554;
}

.pf-primary:disabled {
  opacity: 0.6;
}

.pf-secondary {
  min-height: 2.5rem;
  padding: 0.45rem 1.1rem;
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 999px;
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
}

.pf-open:focus-visible,
.pf-primary:focus-visible,
.pf-secondary:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.pf-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.pf-form__grid {
  display: grid;
  grid-template-columns: 1.2fr 1.5fr 0.8fr;
  gap: 0.75rem;
}

.pf-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.pf-field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #334155;
}

.pf-input {
  min-height: 2.6rem;
  padding: 0.55rem 0.8rem;
  box-sizing: border-box;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 12px;
  font: inherit;
  font-size: 0.9rem;
}

.pf-input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.pf-error {
  margin: 0;
  font-size: 0.76rem;
  color: #b42318;
}

.pf-form__actions {
  display: flex;
  gap: 0.5rem;
}

.pf-plan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  background: #f8fafc;
}

.pf-plan__price {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
}

.pf-plan__price strong {
  font-size: 1.6rem;
  font-weight: 700;
  color: #1e3a8a;
}

.pf-plan__price span {
  font-size: 0.8rem;
  color: #64748b;
}

.pf-upsell {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 1.25rem;
  align-items: center;
}

.pf-upsell__eyebrow {
  margin: 0 0 0.3rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #1e3a8a;
}

.pf-upsell__list {
  list-style: none;
  margin: 0.8rem 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem 1rem;
}

.pf-upsell__list li {
  display: flex;
  gap: 0.45rem;
  font-size: 0.82rem;
  color: #334155;
}

.pf-upsell__list i {
  margin-top: 0.15rem;
  font-size: 0.75rem;
  color: #15803d;
}

.pf-upsell__price {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  padding: 1rem 1.1rem;
  border-radius: 14px;
  background: #eef2fb;
}

.pf-upsell__price strong {
  font-size: 1.8rem;
  font-weight: 700;
  color: #1e3a8a;
}

.pf-upsell__price span {
  font-size: 0.82rem;
  color: #334155;
}

.pf-upsell__price small {
  margin-bottom: 0.6rem;
  font-size: 0.76rem;
  color: #64748b;
}

@media (max-width: 900px) {
  .pf-totals {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pf-form__grid,
  .pf-upsell,
  .pf-upsell__list {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
}
</style>
