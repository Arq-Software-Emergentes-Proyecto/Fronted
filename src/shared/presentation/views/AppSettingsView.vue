<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import {
  SubscriptionPlanId,
  isPaidSubscriptionPlan,
  maxResidentsForSubscriptionPlan,
} from '@/shared/domain/subscriptionPlans.js'
import { subscriptionApi } from '@/shared/infrastructure/subscriptionApi.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'
import { formatDayMonth, normalizeAdmissionPayRange, normalizeSettings } from '@/finances/domain/billingCycle.js'
import {
  applySubscriptionSnapshot,
  refreshSubscriptionFromApi,
} from '@/shared/infrastructure/subscriptionPlanStorage.js'

const route = useRoute()
const router = useRouter()

const { t, locale } = useI18n()
const { state, isAdmin, isResident } = useSession()
const financesStore = useFinancesStore()

const sessionProfile = computed(() => state.profile ?? {})
const serverProfile = ref(null)
const isLoading = ref(false)
const loadError = ref(false)

const display = computed(() => ({
  ...sessionProfile.value,
  ...(serverProfile.value ?? {}),
}))

async function loadServerProfile() {
  const id = sessionProfile.value?.id
  if (!id) {
    serverProfile.value = null
    return
  }
  isLoading.value = true
  loadError.value = false
  try {
    const full = await authApi.getProfileById(id)
    serverProfile.value = full
    if (!full) loadError.value = true
  } catch {
    loadError.value = true
    serverProfile.value = null
  } finally {
    isLoading.value = false
  }
}

const selectedPlanId = ref(SubscriptionPlanId.FREE)
const residentsCount = ref(0)
const residentLimit = ref(maxResidentsForSubscriptionPlan(SubscriptionPlanId.FREE))
const planSaveNotice = ref('')
const planError = ref('')
const planLoading = ref(false)
const planCheckoutPlanId = ref(null)

const lateFeePerDay = ref(0)
const lateFeeError = ref('')
const lateFeeNotice = ref('')
const isSavingLateFee = ref(false)
const lateFeeLoading = ref(false)
const admissionPayFromDay = ref(1)
const admissionPayToDay = ref(7)
const admissionRangePreview = computed(() =>
  normalizeAdmissionPayRange({
    admissionPayFromDay: admissionPayFromDay.value,
    admissionPayToDay: admissionPayToDay.value,
  }),
)
const admissionRuleError = ref('')
const admissionRuleNotice = ref('')
const isSavingAdmissionRules = ref(false)
const admissionResidentSearch = ref('')
const billingResidentId = ref('')
const billingResidentError = ref('')

function residentSearchText(resident) {
  const name = String(resident?.name ?? '')
  const floor = String(resident?.floor ?? '')
  const code = String(resident?.code ?? '')
  return [name, floor, code, `piso ${floor}`, `depto ${code}`, `dept ${code}`, `${floor}-${code}`]
    .join(' ')
    .toLowerCase()
}

const admissionResidents = computed(() => {
  const query = admissionResidentSearch.value.trim().toLowerCase()
  const residents = financesStore.state.residents || []
  if (!query) return residents
  return residents.filter((resident) => residentSearchText(resident).includes(query))
})

const activeResidentLimit = computed(() => residentLimit.value)

function syncFromSubscription(sub) {
  if (!sub) return
  selectedPlanId.value = sub.planId
  residentsCount.value = sub.residentsCount
  residentLimit.value = sub.residentLimit
  applySubscriptionSnapshot(sub)
}

async function loadSubscription() {
  if (!isAdmin.value) return
  planLoading.value = true
  planError.value = ''
  try {
    const sub = await refreshSubscriptionFromApi()
    if (sub) syncFromSubscription(sub)
  } catch (error) {
    planError.value = t('app.settingsPlanLoadError')
  } finally {
    planLoading.value = false
  }
}

async function handleSubscriptionReturnFromRoute() {
  const status = route.query.subscription
  const plan = route.query.plan
  if (!status || !plan || !isAdmin.value) return

  if (status === 'failure') {
    planError.value = t('app.settingsPlanPaymentFailed')
    router.replace({ name: AppRouteNames.APP_SETTINGS })
    return
  }

  if (status === 'pending') {
    planSaveNotice.value = t('app.settingsPlanPaymentPending')
    router.replace({ name: AppRouteNames.APP_SETTINGS })
    return
  }

  if (status !== 'success') return

  planCheckoutPlanId.value = String(plan)
  try {
    const paymentRaw = route.query.payment_id ?? route.query.collection_id
    const paymentId = paymentRaw != null && String(paymentRaw).length ? Number(paymentRaw) : null
    const result = await subscriptionApi.confirm({
      planId: String(plan),
      paymentId: Number.isFinite(paymentId) ? paymentId : null,
    })
    if (result.subscription) syncFromSubscription(result.subscription)
    planSaveNotice.value = t('app.settingsPlanSaved')
  } catch {
    planError.value = t('app.settingsPlanConfirmError')
  } finally {
    planCheckoutPlanId.value = null
    router.replace({ name: AppRouteNames.APP_SETTINGS })
  }
}

async function loadLateFee() {
  if (!isAdmin.value) return
  lateFeeLoading.value = true
  lateFeeError.value = ''
  try {
    await financesStore.loadData()
    const settings = normalizeSettings(financesStore.state.settings)
    lateFeePerDay.value = Number(settings.lateFeePerDay) || 0
    const range = normalizeAdmissionPayRange(settings)
    admissionPayFromDay.value = range.admissionPayFromDay
    admissionPayToDay.value = range.admissionPayToDay
  } catch {
    lateFeeError.value = t('app.settingsLateFeeLoadError')
    admissionRuleError.value = t('app.settingsAdmissionLoadError')
  } finally {
    lateFeeLoading.value = false
  }
}

async function onSaveLateFee() {
  const amount = Number(lateFeePerDay.value)
  if (!Number.isFinite(amount) || amount < 0) {
    lateFeeError.value = t('financeAdmin.lateFeeRequired')
    lateFeeNotice.value = ''
    return
  }

  isSavingLateFee.value = true
  lateFeeError.value = ''
  lateFeeNotice.value = ''
  try {
    const current = normalizeSettings(financesStore.state.settings || {})
    await financesStore.updateSettings({
      ...current,
      lateFeePerDay: amount,
    })
    lateFeeNotice.value = t('financeAdmin.lateFeeSaved')
  } catch (error) {
    lateFeeError.value = error?.message || t('app.settingsLateFeeSaveError')
  } finally {
    isSavingLateFee.value = false
  }
}

async function onSaveAdmissionRules() {
  const range = normalizeAdmissionPayRange({
    admissionPayFromDay: admissionPayFromDay.value,
    admissionPayToDay: admissionPayToDay.value,
  })
  if (
    !Number.isFinite(Number(admissionPayFromDay.value)) ||
    !Number.isFinite(Number(admissionPayToDay.value))
  ) {
    admissionRuleError.value = t('financeAdmin.admissionRangeInvalid')
    admissionRuleNotice.value = ''
    return
  }

  isSavingAdmissionRules.value = true
  admissionRuleError.value = ''
  admissionRuleNotice.value = ''
  try {
    const current = normalizeSettings(financesStore.state.settings || {})
    await financesStore.updateSettings({
      ...current,
      admissionPayFromDay: range.admissionPayFromDay,
      admissionPayToDay: range.admissionPayToDay,
    })
    admissionPayFromDay.value = range.admissionPayFromDay
    admissionPayToDay.value = range.admissionPayToDay
    admissionRuleNotice.value = t('financeAdmin.admissionRulesSaved')
  } catch (error) {
    admissionRuleError.value = error?.message || t('app.settingsAdmissionSaveError')
  } finally {
    isSavingAdmissionRules.value = false
  }
}

async function onToggleBillFromNextMonth(resident) {
  if (billingResidentId.value) return
  billingResidentId.value = resident.id
  billingResidentError.value = ''
  const nextValue = !resident.billFromNextMonth
  try {
    const updated = await residentsApi.setBillFromNextMonth(resident.id, nextValue)
    await financesStore.setResidentBillFromNextMonth(updated, nextValue)
  } catch (error) {
    console.error('Could not update billFromNextMonth:', error)
    billingResidentError.value = t('app.billFromNextMonthError')
  } finally {
    billingResidentId.value = ''
  }
}

async function initSettings() {
  await loadServerProfile()
  await loadSubscription()
  await loadLateFee()
  await handleSubscriptionReturnFromRoute()
}

async function selectPlan(planId) {
  if (!isAdmin.value || planLoading.value || planCheckoutPlanId.value) return
  if (selectedPlanId.value === planId && !isPaidSubscriptionPlan(planId)) return

  planError.value = ''
  planSaveNotice.value = ''

  if (planId === SubscriptionPlanId.FREE) {
    planCheckoutPlanId.value = planId
    try {
      const sub = await subscriptionApi.changeToFreePlan()
      syncFromSubscription(sub)
      planSaveNotice.value = t('app.settingsPlanSaved')
    } catch (error) {
      if (error?.code === 'PLAN_DOWNGRADE_RESIDENTS_EXCEEDED') {
        planError.value = error.payload?.message ?? t('app.settingsPlanDowngradeError')
      } else {
        planError.value = t('app.settingsPlanChangeError')
      }
    } finally {
      planCheckoutPlanId.value = null
    }
    return
  }

  planCheckoutPlanId.value = planId
  let checkout = null
  try {
    checkout = await subscriptionApi.checkout(planId)
    if (checkout.demo) {
      const result = await subscriptionApi.confirm({ planId, demo: true })
      if (result.subscription) syncFromSubscription(result.subscription)
      planSaveNotice.value = t('app.settingsPlanSavedDemo')
    } else if (checkout.initPoint) {
      window.location.assign(checkout.initPoint)
      return
    } else {
      planError.value = t('app.settingsPlanCheckoutError')
    }
  } catch (error) {
    planError.value = error?.payload?.message || error?.message || t('app.settingsPlanCheckoutError')
  } finally {
    if (!checkout?.initPoint) planCheckoutPlanId.value = null
  }
}

function isPlanBusy(planId) {
  return planCheckoutPlanId.value === planId || (planLoading.value && planCheckoutPlanId.value === null)
}

onMounted(initSettings)
watch(
  () => sessionProfile.value?.id,
  async () => {
    await loadServerProfile()
    await loadSubscription()
    await loadLateFee()
  },
)

watch(planSaveNotice, (msg) => {
  if (!msg) return
  window.setTimeout(() => {
    planSaveNotice.value = ''
  }, 4000)
})

watch(lateFeeNotice, (msg) => {
  if (!msg) return
  window.setTimeout(() => {
    lateFeeNotice.value = ''
  }, 4000)
})

watch(admissionRuleNotice, (msg) => {
  if (!msg) return
  window.setTimeout(() => {
    admissionRuleNotice.value = ''
  }, 4000)
})
</script>

<template>
  <div class="app-view">
    <h1 class="app-view__title">{{ t('app.pageSettings') }}</h1>
    <p class="app-view__subtitle">{{ t('app.settingsProfileSubtitle') }}</p>

    <p v-if="isLoading" class="app-view__status">{{ t('app.settingsLoadingProfile') }}</p>
    <p v-else-if="loadError" class="app-view__status app-view__status--warn">
      {{ t('app.settingsProfileLoadError') }}
    </p>

    <section v-if="isAdmin" class="settings-card" aria-labelledby="settings-admin-heading">
      <h2 id="settings-admin-heading" class="settings-card__title">
        {{ t('app.settingsAdminProfileTitle') }}
      </h2>
      <ul class="settings-card__list" role="list">
        <li v-if="display.name">
          <strong>{{ t('auth.fullName') }}:</strong> {{ display.name }}
        </li>
        <li v-if="display.email">
          <strong>{{ t('auth.email') }}:</strong> {{ display.email }}
        </li>
        <li v-if="display.dni">
          <strong>{{ t('app.settingsAdminDniLabel') }}:</strong> {{ display.dni }}
        </li>
        <li v-if="display.address">
          <strong>{{ t('app.settingsAdminAddressLabel') }}:</strong> {{ display.address }}
        </li>
        <li v-if="display.company">
          <strong>{{ t('app.settingsAdminCompanyLabel') }}:</strong> {{ display.company }}
        </li>
        <li v-if="display.ruc">
          <strong>{{ t('app.settingsAdminRucLabel') }}:</strong> {{ display.ruc }}
        </li>
      </ul>
    </section>

    <section v-if="isAdmin" class="settings-card" aria-labelledby="settings-late-fee-heading">
      <h2 id="settings-late-fee-heading" class="settings-card__title">
        {{ t('financeAdmin.lateFeePerDay') }}
      </h2>
      <p class="settings-card__hint">{{ t('financeAdmin.lateFeeHint') }}</p>
      <p v-if="lateFeeLoading" class="settings-card__status">{{ t('financeAdmin.loading') }}</p>
      <label class="settings-card__field" for="settingsLateFeePerDay">
        <span>{{ t('financeAdmin.lateFeePerDay') }}</span>
        <input
          id="settingsLateFeePerDay"
          v-model.number="lateFeePerDay"
          type="number"
          min="0"
          step="0.01"
          class="settings-card__input"
        />
      </label>
      <p v-if="lateFeeNotice" class="settings-card__notice" role="status">{{ lateFeeNotice }}</p>
      <p v-if="lateFeeError" class="settings-card__error" role="alert">{{ lateFeeError }}</p>
      <button
        type="button"
        class="settings-card__save"
        :disabled="isSavingLateFee || lateFeeLoading"
        @click="onSaveLateFee"
      >
        {{ t('financeAdmin.saveLateFee') }}
      </button>
    </section>

    <section v-if="isAdmin" class="settings-card settings-card--admission" aria-labelledby="settings-admission-rules-heading">
      <h2 id="settings-admission-rules-heading" class="settings-card__title">
        {{ t('financeAdmin.admissionRulesTitle') }}
      </h2>
      <p class="settings-card__hint">{{ t('financeAdmin.admissionRulesHint') }}</p>
      <p v-if="lateFeeLoading" class="settings-card__status">{{ t('financeAdmin.loading') }}</p>
      <div class="admission-range">
        <label class="settings-card__field" for="settingsAdmissionPayFromDay">
          <span>{{ t('financeAdmin.admissionRangeFrom') }}</span>
          <input
            id="settingsAdmissionPayFromDay"
            v-model.number="admissionPayFromDay"
            type="number"
            min="1"
            max="31"
            step="1"
            class="settings-card__input"
          />
        </label>
        <label class="settings-card__field" for="settingsAdmissionPayToDay">
          <span>{{ t('financeAdmin.admissionRangeTo') }}</span>
          <input
            id="settingsAdmissionPayToDay"
            v-model.number="admissionPayToDay"
            type="number"
            min="1"
            max="31"
            step="1"
            class="settings-card__input"
          />
        </label>
      </div>
      <p class="settings-card__hint">
        {{
          admissionRangePreview.admissionPayToDay >= 31
            ? t('financeAdmin.admissionRangePreviewAll', {
                from: admissionRangePreview.admissionPayFromDay,
                to: admissionRangePreview.admissionPayToDay,
              })
            : t('financeAdmin.admissionRangePreview', {
                from: admissionRangePreview.admissionPayFromDay,
                to: admissionRangePreview.admissionPayToDay,
                after: admissionRangePreview.admissionPayToDay + 1,
              })
        }}
      </p>
      <p v-if="admissionRuleNotice" class="settings-card__notice" role="status">
        {{ admissionRuleNotice }}
      </p>
      <p v-if="admissionRuleError" class="settings-card__error" role="alert">
        {{ admissionRuleError }}
      </p>
      <button
        type="button"
        class="settings-card__save"
        :disabled="isSavingAdmissionRules || lateFeeLoading"
        @click="onSaveAdmissionRules"
      >
        {{ t('financeAdmin.admissionRulesSave') }}
      </button>

      <h3 class="settings-card__subtitle">{{ t('financeAdmin.admissionResidentsTitle') }}</h3>
      <p class="settings-card__hint">{{ t('financeAdmin.admissionResidentsHint') }}</p>
      <label class="settings-card__field" for="settingsAdmissionResidentSearch">
        <span class="visually-hidden">{{ t('financeAdmin.extraSearch') }}</span>
        <input
          id="settingsAdmissionResidentSearch"
          v-model="admissionResidentSearch"
          type="search"
          class="settings-card__input"
          :placeholder="t('financeAdmin.extraSearchPlaceholder')"
        />
      </label>
      <ul class="admission-resident-list" role="list">
        <li v-if="!financesStore.state.residents.length" class="admission-resident-list__empty">
          {{ t('financeAdmin.admissionResidentsEmpty') }}
        </li>
        <li v-else-if="!admissionResidents.length" class="admission-resident-list__empty">
          {{ t('financeAdmin.admissionResidentsNone') }}
        </li>
        <li v-for="resident in admissionResidents" :key="resident.id" class="admission-resident">
          <div class="admission-resident__info">
            <strong>{{ resident.name }}</strong>
            <span>
              {{ t('app.residentFloorApt', { floor: resident.floor, code: resident.code }) }}
              <template v-if="resident.admissionDate">
                · {{ t('app.residentAdmissionDate', { date: formatDayMonth(resident.admissionDate, locale) }) }}
              </template>
            </span>
          </div>
          <button
            type="button"
            class="admission-resident__btn"
            :class="{ 'is-on': resident.billFromNextMonth }"
            :aria-pressed="resident.billFromNextMonth"
            :disabled="Boolean(billingResidentId) || lateFeeLoading"
            @click="onToggleBillFromNextMonth(resident)"
          >
            {{
              resident.billFromNextMonth
                ? t('app.billFromNextMonthOn')
                : t('app.billFromNextMonthAction')
            }}
          </button>
        </li>
      </ul>
      <p v-if="billingResidentError" class="settings-card__error" role="alert">
        {{ billingResidentError }}
      </p>
    </section>

    <!-- Subscriptions — solo visible para admin -->
    <section v-if="isAdmin" class="plans-section" aria-labelledby="settings-plans-heading">
      <h2 id="settings-plans-heading" class="plans-section__title">
        {{ t('app.settingsPlansTitle') }}
      </h2>
      <p class="plans-section__subtitle">{{ t('app.settingsPlansSubtitle') }}</p>
      <p class="plans-section__usage">
        {{ t('app.settingsPlanUsageLine', { current: residentsCount, max: activeResidentLimit }) }}
      </p>
      <p v-if="planSaveNotice" class="plans-section__notice" role="status">
        {{ planSaveNotice }}
      </p>
      <p v-if="planError" class="plans-section__error" role="alert">
        {{ planError }}
      </p>
      <p v-if="planLoading" class="plans-section__loading">{{ t('app.settingsPlanLoading') }}</p>

      <div class="plans-grid">

        <!-- Free -->
        <div
          class="plan-card plan-card--free"
          :class="{ 'plan-card--selected': selectedPlanId === SubscriptionPlanId.FREE }"
        >
          <div class="plan-card__header">
            <span class="plan-card__name">Free</span>
          </div>
          <div class="plan-card__price">
            <span class="plan-card__amount">S/ 0</span>
            <span class="plan-card__period">/ mes</span>
          </div>
          <p class="plan-card__range">Hasta 9 departamentos</p>
          <p class="plan-card__billing">Empieza sin costo.</p>
          <ul class="plan-card__features">
            <li><i class="pi pi-check" aria-hidden="true"></i> Dashboard y directorio de residentes.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Anuncios y registro de visitas.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Una cuenta de administrador.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Soporte comunitario.</li>
          </ul>
          <button
            type="button"
            class="plan-card__btn plan-card__btn--ghost"
            :disabled="isPlanBusy(SubscriptionPlanId.FREE)"
            @click="selectPlan(SubscriptionPlanId.FREE)"
          >
            {{ t('app.settingsPlanSelectFree') }}
          </button>
        </div>

        <!-- Essential -->
        <div
          class="plan-card"
          :class="{ 'plan-card--selected': selectedPlanId === SubscriptionPlanId.ESSENTIAL }"
        >
          <div class="plan-card__header">
            <span class="plan-card__name">Essential</span>
          </div>
          <div class="plan-card__price">
            <span class="plan-card__amount">S/ 40</span>
            <span class="plan-card__period">/ mes (PEN)</span>
          </div>
          <p class="plan-card__range">10–15 departamentos</p>
          <p class="plan-card__billing">Facturación mensual en soles peruanos (PEN).</p>
          <ul class="plan-card__features">
            <li><i class="pi pi-check" aria-hidden="true"></i> Para edificios pequeños y condominios.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Áreas comunes, cobranzas y anuncios.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Documentos y registro de visitas.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Consola web para administradores.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Soporte por email en días hábiles.</li>
          </ul>
          <button
            type="button"
            class="plan-card__btn plan-card__btn--ghost"
            :disabled="isPlanBusy(SubscriptionPlanId.ESSENTIAL)"
            @click="selectPlan(SubscriptionPlanId.ESSENTIAL)"
          >
            {{ t('app.settingsPlanSelectEssential') }}
          </button>
        </div>

        <!-- Standard — destacado -->
        <div
          class="plan-card plan-card--highlighted"
          :class="{ 'plan-card--selected': selectedPlanId === SubscriptionPlanId.STANDARD }"
        >
          <div class="plan-card__header">
            <span class="plan-card__name">Standard</span>
            <span class="plan-card__badge">Más popular</span>
          </div>
          <div class="plan-card__price">
            <span class="plan-card__amount">S/ 80</span>
            <span class="plan-card__period">/ mes (PEN)</span>
          </div>
          <p class="plan-card__range">16–40 departamentos</p>
          <p class="plan-card__billing">Facturación mensual en PEN. Hasta 40 unidades.</p>
          <ul class="plan-card__features">
            <li><i class="pi pi-check" aria-hidden="true"></i> Para torres medianas y comunidades activas.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Mismas funciones que Essential, mayor capacidad.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Visibilidad de cuotas y morosidad.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Difusión a residentes y comités.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Soporte operativo prioritario.</li>
          </ul>
          <button
            type="button"
            class="plan-card__btn plan-card__btn--primary"
            :disabled="isPlanBusy(SubscriptionPlanId.STANDARD)"
            @click="selectPlan(SubscriptionPlanId.STANDARD)"
          >
            {{ t('app.settingsPlanSelectStandard') }}
          </button>
        </div>

        <!-- Scale -->
        <div
          class="plan-card"
          :class="{ 'plan-card--selected': selectedPlanId === SubscriptionPlanId.SCALE }"
        >
          <div class="plan-card__header">
            <span class="plan-card__name">Scale</span>
          </div>
          <div class="plan-card__price">
            <span class="plan-card__amount">S/ 120</span>
            <span class="plan-card__period">/ mes (PEN)</span>
          </div>
          <p class="plan-card__range">41–80 departamentos</p>
          <p class="plan-card__billing">Facturación mensual en PEN. Nivel para no solapar con 16–40.</p>
          <ul class="plan-card__features">
            <li><i class="pi pi-check" aria-hidden="true"></i> Grandes conjuntos y edificios en altura.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Rendimiento acorde al tamaño del edificio.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Reportes para juntas y comités grandes.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Asistencia en despliegue y onboarding.</li>
            <li><i class="pi pi-check" aria-hidden="true"></i> Canal de soporte con tiempos de respuesta.</li>
          </ul>
          <button
            type="button"
            class="plan-card__btn plan-card__btn--ghost"
            :disabled="isPlanBusy(SubscriptionPlanId.SCALE)"
            @click="selectPlan(SubscriptionPlanId.SCALE)"
          >
            {{ t('app.settingsPlanSelectScale') }}
          </button>
        </div>

      </div>
    </section>

    <section
      v-if="isResident"
      class="settings-card"
      aria-labelledby="settings-resident-heading"
    >
      <h2 id="settings-resident-heading" class="settings-card__title">
        {{ t('app.settingsResidentProfileTitle') }}
      </h2>
      <ul class="settings-card__list" role="list">
        <li v-if="display.name">
          <strong>{{ t('app.residentNameLabel') }}:</strong> {{ display.name }}
        </li>
        <li v-if="display.floor != null && display.floor !== ''">
          <strong>{{ t('app.residentFloorLabel') }}:</strong> {{ display.floor }}
        </li>
        <li v-if="display.code != null && display.code !== ''">
          <strong>{{ t('app.residentCodeLabel') }}:</strong> {{ display.code }}
        </li>
        <li v-if="display.email">
          <strong>{{ t('auth.email') }}:</strong> {{ display.email }}
        </li>
        <li v-if="display.admissionDate">
          <strong>{{ t('app.settingsResidentAdmissionLabel') }}:</strong>
          {{ display.admissionDate }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 3rem;
  max-width: 72rem;
}

.app-view__title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--apple-text, #1d1d1f);
}

.app-view__subtitle {
  margin: 0.5rem 0 1.5rem;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.app-view__status {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.app-view__status--warn {
  color: #b42318;
}

/* ── Perfil card ── */
.settings-card {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  padding: 1.2rem 1.25rem;
  max-width: 32rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  margin-bottom: 1.5rem;
}

.settings-card--admission {
  max-width: 40rem;
}

.settings-card__title {
  margin: 0 0 0.65rem;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.settings-card__subtitle {
  margin: 1.25rem 0 0.45rem;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.settings-card__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.875rem;
  color: var(--apple-text, #1d1d1f);
}

.settings-card__hint {
  margin: 0 0 0.85rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.settings-card__status {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.settings-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6e6e73;
}

.settings-card__input {
  height: 2.75rem;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: 0 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 400;
  color: #1d1d1f;
  background: #fff;
  box-sizing: border-box;
}

.settings-card__input:focus {
  outline: none;
  border-color: #0071e3;
}

.settings-card__notice {
  margin: 0.65rem 0 0;
  font-size: 0.8125rem;
  color: #248a3d;
}

.settings-card__error {
  margin: 0.65rem 0 0;
  font-size: 0.8125rem;
  color: #b42318;
}

.settings-card__save {
  margin-top: 0.85rem;
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border: none;
  border-radius: 8px;
  background: #0071e3;
  color: #fff;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.settings-card__save:hover:not(:disabled) {
  background: #0066cc;
}

.settings-card__save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.admission-range {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}

.admission-resident-list {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  max-height: 20rem;
  overflow: auto;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
}

.admission-resident-list__empty {
  padding: 0.85rem 0.9rem;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.admission-resident {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
}

.admission-resident + .admission-resident {
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.admission-resident__info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.admission-resident__info strong {
  font-size: 0.875rem;
  font-weight: 600;
  color: #1d1d1f;
}

.admission-resident__info span {
  font-size: 0.75rem;
  color: #6e6e73;
}

.admission-resident__btn {
  flex-shrink: 0;
  max-width: 11.5rem;
  padding: 0.38rem 0.6rem;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  background: #fff;
  color: #1d1d1f;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
}

.admission-resident__btn:hover:not(:disabled) {
  border-color: #1e3a8a;
  color: #1e3a8a;
  background: #f4f7ff;
}

.admission-resident__btn.is-on {
  border-color: #1e3a8a;
  background: #eef3ff;
  color: #1e3a8a;
}

.admission-resident__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ── Sección de planes ── */
.plans-section {
  margin-top: 2rem;
}

.plans-section__title {
  margin: 0 0 0.25rem;
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--apple-text, #1d1d1f);
}

.plans-section__subtitle {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.plans-section__usage {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.plans-section__notice {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: #248a3d;
}

.plans-section__error {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: #b42318;
}

.plans-section__loading {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
}

/* ── Grid de planes ── */
.plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  align-items: stretch;
}

/* ── Tarjeta de plan ── */
.plan-card {
  display: flex;
  flex-direction: column;
  padding: 1.35rem 1.25rem 1.25rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}

.plan-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}

/* Plan destacado */
.plan-card--highlighted {
  border-color: #0a84ff;
  box-shadow: 0 0 0 1px #0a84ff, 0 4px 16px rgba(10, 132, 255, 0.12);
}

.plan-card--highlighted:hover {
  box-shadow: 0 0 0 1px #0a84ff, 0 8px 24px rgba(10, 132, 255, 0.18);
}

/* Plan free — borde verde */
.plan-card--free {
  border-color: rgba(52, 199, 89, 0.4);
}

.plan-card--selected {
  box-shadow: 0 0 0 2px #0a84ff, 0 4px 16px rgba(10, 132, 255, 0.12);
}

.plan-card--highlighted.plan-card--selected {
  box-shadow: 0 0 0 2px #0a84ff, 0 0 0 1px #0a84ff, 0 8px 24px rgba(10, 132, 255, 0.18);
}

/* ── Header del plan ── */
.plan-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.85rem;
}

.plan-card__name {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.plan-card__badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: 980px;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: #0a84ff;
  color: #fff;
}

/* ── Precio ── */
.plan-card__price {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
  margin-bottom: 0.4rem;
}

.plan-card__amount {
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--apple-text, #1d1d1f);
}

.plan-card--highlighted .plan-card__amount {
  color: #0a84ff;
}

.plan-card__period {
  font-size: 0.8125rem;
  color: var(--apple-text-secondary, #6e6e73);
}

/* ── Rango de apartamentos ── */
.plan-card__range {
  margin: 0 0 0.2rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

/* ── Texto de facturación ── */
.plan-card__billing {
  margin: 0 0 1rem;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
  line-height: 1.4;
}

/* ── Lista de features ── */
.plan-card__features {
  flex: 1;
  list-style: none;
  margin: 0 0 1.25rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--apple-text, #1d1d1f);
  line-height: 1.4;
}

.plan-card__features li {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}

.plan-card__features .pi-check {
  color: #34c759;
  font-size: 0.75rem;
  margin-top: 0.1rem;
  flex-shrink: 0;
}

/* ── Botones ── */
.plan-card__btn {
  width: 100%;
  padding: 0.6rem 1rem;
  border-radius: 980px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background 0.15s ease, opacity 0.15s ease;
  margin-top: auto;
}

.plan-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.plan-card__btn--primary {
  background: #0a84ff;
  color: #fff;
}

.plan-card__btn--primary:hover {
  background: #0071e3;
}

.plan-card__btn--ghost {
  background: rgba(0, 0, 0, 0.05);
  color: var(--apple-text, #1d1d1f);
}

.plan-card__btn--ghost:hover {
  background: rgba(0, 0, 0, 0.09);
}
</style>
