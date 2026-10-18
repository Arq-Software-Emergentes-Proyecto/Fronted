<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { setPasswordForCurrentUser } from '@/iam/infrastructure/firebaseAuth.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import {
  SubscriptionPlanId,
  isPaidSubscriptionPlan,
  maxResidentsForSubscriptionPlan,
} from '@/billing/domain/subscriptionPlans.js'
import { subscriptionApi } from '@/billing/infrastructure/subscriptionApi.js'
import {
  clearPendingCheckout,
  MpPendingKeys,
  readPendingCheckout,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { serviceProvidersApi } from '@/incidents/infrastructure/serviceProvidersApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'
import { formatDayMonth, normalizeAdmissionPayRange, normalizeSettings } from '@/finances/domain/billingCycle.js'
import {
  applySubscriptionSnapshot,
  refreshSubscriptionFromApi,
} from '@/billing/infrastructure/subscriptionPlanStorage.js'
import SubscriptionPlansSection from '@/billing/presentation/components/SubscriptionPlansSection.vue'
import BuildingForm from '@/profiles/presentation/components/BuildingForm.vue'
import { buildingsApi } from '@/profiles/infrastructure/buildingsApi.js'

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

/** Resident: add (or change) an email + password credential next to Google sign-in (US014). */
const residentPassword = ref('')
const residentPasswordConfirm = ref('')
const residentPasswordSaving = ref(false)
const residentPasswordNotice = ref('')
const residentPasswordError = ref('')

async function onSaveResidentPassword() {
  if (residentPasswordSaving.value) return
  residentPasswordNotice.value = ''
  residentPasswordError.value = ''
  if (String(residentPassword.value).length < 6) {
    residentPasswordError.value = t('auth.passwordTooShort')
    return
  }
  if (residentPassword.value !== residentPasswordConfirm.value) {
    residentPasswordError.value = t('auth.passwordMismatch')
    return
  }
  residentPasswordSaving.value = true
  try {
    if (!OPEN_WIREFRAME_ACCESS) {
      await setPasswordForCurrentUser(residentPassword.value)
    }
    residentPassword.value = ''
    residentPasswordConfirm.value = ''
    residentPasswordNotice.value = t('app.settingsResidentPasswordSaved')
  } catch (error) {
    if (error?.code === 'REAUTH_REQUIRED') {
      residentPasswordError.value = t('app.settingsResidentPasswordReauth')
    } else if (error?.code === 'PASSWORD_TOO_SHORT') {
      residentPasswordError.value = t('auth.passwordTooShort')
    } else if (error?.code === 'EMAIL_ALREADY_EXISTS') {
      residentPasswordError.value = t('auth.emailAlreadyExists')
    } else if (error?.code === 'TOO_MANY_REQUESTS') {
      residentPasswordError.value = t('auth.tooManyRequests')
    } else {
      residentPasswordError.value = t('app.settingsResidentPasswordError')
    }
  } finally {
    residentPasswordSaving.value = false
  }
}

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
/** Full subscription snapshot (status, trial, billable departments) for the plans section. */
const subscription = ref(null)
/** US015: plan suggested after registering the building (?suggestedPlan=…). */
const suggestedPlanId = computed(() => {
  const raw = route.query.suggestedPlan
  return typeof raw === 'string' && raw.length ? raw : null
})
const residentsCount = ref(0)
const residentLimit = ref(maxResidentsForSubscriptionPlan(SubscriptionPlanId.FREE))
const planSaveNotice = ref('')
const planError = ref('')
const planLoading = ref(false)
const planCheckoutPlanId = ref(null)
const activeTab = ref(
  ['profile', 'plans', 'finance', 'admission', 'providers'].includes(String(route.query.tab ?? ''))
    ? String(route.query.tab)
    : 'profile',
)

watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === 'string' && settingsTabs.value.some((item) => item.id === tab)) activeTab.value = tab
  },
)

/** RF015: building (condominium) of the admin; existing admins without one get the form here. */
const buildings = ref([])
const buildingLoading = ref(false)
const buildingLoadError = ref(false)
const isEditingBuilding = ref(false)
const buildingNotice = ref('')
const primaryBuilding = computed(() => buildings.value[0] ?? null)

async function loadBuildings() {
  if (!isAdmin.value) return
  buildingLoading.value = true
  buildingLoadError.value = false
  try {
    buildings.value = await buildingsApi.mine()
  } catch {
    buildingLoadError.value = true
  } finally {
    buildingLoading.value = false
  }
}

async function onBuildingSaved(building) {
  isEditingBuilding.value = false
  buildingNotice.value = t('buildings.saved')
  await loadBuildings()
  await loadSubscription()
  if (building?.suggestedPlanId && !subscription.value?.isPaid) {
    router.replace({ name: AppRouteNames.APP_SETTINGS, query: { tab: 'plans', suggestedPlan: building.suggestedPlanId } })
  }
}

const trialBanner = computed(() => {
  const sub = subscription.value
  if (!sub) return null
  if (sub.trialExpired) return { tone: 'error', text: t('billing.trialExpiredBanner') }
  if (sub.status === 'SUSPENDED' || sub.status === 'CANCELLED') return { tone: 'error', text: t('billing.inactiveBanner') }
  if (sub.requiresPlanSelection && sub.isPaid) return { tone: 'warn', text: t('billing.renewBanner') }
  if (sub.status === 'PAYMENT_FAILED') return { tone: 'warn', text: t('billing.paymentFailedBanner') }
  if (sub.status === 'TRIAL' && sub.trialDaysLeft != null) {
    return {
      tone: sub.trialDaysLeft <= 7 ? 'warn' : 'info',
      text: t('billing.trialBanner', { days: sub.trialDaysLeft }),
    }
  }
  return null
})

const settingsTabs = computed(() => [
  { id: 'profile', label: t('app.settingsTabProfile'), icon: 'pi pi-user' },
  { id: 'plans', label: t('app.settingsTabPlans'), icon: 'pi pi-id-card' },
  { id: 'finance', label: t('app.settingsTabFinance'), icon: 'pi pi-wallet' },
  { id: 'admission', label: t('app.settingsTabAdmission'), icon: 'pi pi-calendar' },
  { id: 'providers', label: t('app.settingsTabProviders'), icon: 'pi pi-wrench' },
])

const serviceProviders = ref([])
const providersLoading = ref(false)
const providersSaving = ref(false)
const providersError = ref('')
const providersNotice = ref('')
const deletingProviderId = ref('')
const providerDraft = ref({
  name: '',
  phone: '',
  specialty: '',
})

function resetProviderDraft() {
  providerDraft.value = { name: '', phone: '', specialty: '' }
}

async function loadServiceProviders() {
  if (!isAdmin.value) return
  providersLoading.value = true
  providersError.value = ''
  try {
    const list = await serviceProvidersApi.list()
    serviceProviders.value = list
      .slice()
      .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }))
  } catch {
    providersError.value = t('app.settingsProvidersLoadError')
  } finally {
    providersLoading.value = false
  }
}

async function addServiceProvider() {
  const name = String(providerDraft.value.name ?? '').trim()
  if (!name || providersSaving.value) return
  providersSaving.value = true
  providersError.value = ''
  providersNotice.value = ''
  try {
    await serviceProvidersApi.add({
      name,
      phone: providerDraft.value.phone,
      specialty: providerDraft.value.specialty,
    })
    resetProviderDraft()
    providersNotice.value = t('app.settingsProvidersSaved')
    await loadServiceProviders()
  } catch {
    providersError.value = t('app.settingsProvidersSaveError')
  } finally {
    providersSaving.value = false
  }
}

async function removeServiceProvider(id) {
  if (deletingProviderId.value) return
  deletingProviderId.value = String(id)
  providersError.value = ''
  try {
    await serviceProvidersApi.remove(id)
    await loadServiceProviders()
  } catch {
    providersError.value = t('app.settingsProvidersDeleteError')
  } finally {
    deletingProviderId.value = ''
  }
}

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
  subscription.value = sub
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
  if (!isAdmin.value) return

  const pending = readPendingCheckout(MpPendingKeys.subscription)
  const status = String(
    route.query.status ?? route.query.collection_status ?? route.query.subscription ?? '',
  ).toLowerCase()
  const plan = route.query.plan || pending?.planId
  const paymentRaw = route.query.payment_id ?? route.query.collection_id
  const hasReturn = Boolean(status || paymentRaw || route.query.subscription)
  if (!hasReturn) return
  activeTab.value = 'plans'

  const clearReturn = () => {
    clearPendingCheckout(MpPendingKeys.subscription)
    router.replace({ name: AppRouteNames.APP_SETTINGS })
  }

  if (status === 'failure' || status === 'rejected' || status === 'cancelled') {
    planError.value = t('app.settingsPlanPaymentFailed')
    clearReturn()
    return
  }

  if (status === 'pending' || status === 'in_process' || status === 'in_mediation') {
    planSaveNotice.value = t('app.settingsPlanPaymentPending')
    clearReturn()
    return
  }

  if (status && status !== 'success' && status !== 'approved') return
  if (!plan) return

  planCheckoutPlanId.value = String(plan)
  try {
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
    clearReturn()
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
  await loadBuildings()
  await loadLateFee()
  await handleSubscriptionReturnFromRoute()
  await loadServiceProviders()
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
    if (checkout.initPoint) {
      window.location.assign(checkout.initPoint)
      return
    }
    planError.value = t('app.settingsPlanCheckoutError')
  } catch (error) {
    planError.value =
      error?.code === 'PLAN_DOWNGRADE_RESIDENTS_EXCEEDED'
        ? t('billing.planTooSmall', {
            count: error.payload?.residentsCount ?? residentsCount.value,
            max: error.payload?.residentLimit ?? '',
          })
        : error?.payload?.message || error?.message || t('app.settingsPlanCheckoutError')
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

watch(buildingNotice, (msg) => {
  if (!msg) return
  window.setTimeout(() => {
    buildingNotice.value = ''
  }, 4000)
})

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
  <div class="app-view app-view--ai">
    <nav
      v-if="isAdmin"
      class="settings-tabs"
      :aria-label="t('app.pageSettings')"
    >
      <button
        v-for="tab in settingsTabs"
        :key="tab.id"
        type="button"
        class="settings-tabs__item"
        :class="{ 'is-active': activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <i :class="tab.icon" aria-hidden="true" />
        {{ tab.label }}
      </button>
    </nav>

    <div class="ai-shell">
      <div class="settings-body">
    <p v-if="isLoading" class="app-view__status">{{ t('app.settingsLoadingProfile') }}</p>
    <p v-else-if="loadError" class="app-view__status app-view__status--warn">
      {{ t('app.settingsProfileLoadError') }}
    </p>

    <section
      v-if="isAdmin && activeTab === 'profile'"
      class="settings-card"
      aria-labelledby="settings-admin-heading"
    >
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

    <p
      v-if="isAdmin && activeTab !== 'plans' && trialBanner && trialBanner.tone === 'error'"
      class="billing-banner billing-banner--error"
      role="alert"
    >
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      {{ trialBanner.text }}
      <button type="button" class="billing-banner__action" @click="activeTab = 'plans'">
        {{ t('billing.choosePlanCta') }}
      </button>
    </p>

    <section
      v-if="isAdmin && activeTab === 'profile'"
      class="settings-card"
      aria-labelledby="settings-building-heading"
    >
      <h2 id="settings-building-heading" class="settings-card__title">
        <i class="pi pi-building" aria-hidden="true" />
        {{ t('buildings.cardTitle') }}
      </h2>
      <p v-if="buildingLoading" class="settings-card__status">{{ t('buildings.loading') }}</p>
      <p v-else-if="buildingLoadError" class="settings-card__error" role="alert">
        {{ t('buildings.loadError') }}
        <button type="button" class="billing-banner__action" @click="loadBuildings">{{ t('billing.plans.retry') }}</button>
      </p>
      <template v-else-if="primaryBuilding && !isEditingBuilding">
        <ul class="settings-card__list" role="list">
          <li><strong>{{ t('buildings.form.name') }}:</strong> {{ primaryBuilding.name }}</li>
          <li><strong>{{ t('buildings.form.address') }}:</strong> {{ primaryBuilding.address }}</li>
          <li><strong>{{ t('buildings.form.departmentCount') }}:</strong> {{ primaryBuilding.departmentCount }}</li>
        </ul>
        <p v-if="buildings.length > 1" class="settings-card__hint">
          {{ t('buildings.moreBuildings', { count: buildings.length - 1 }) }}
        </p>
        <p v-if="buildingNotice" class="settings-card__notice" role="status">{{ buildingNotice }}</p>
        <button type="button" class="settings-card__save" @click="isEditingBuilding = true">
          {{ t('buildings.edit') }}
        </button>
      </template>
      <template v-else>
        <p v-if="!primaryBuilding" class="settings-card__hint">{{ t('buildings.missingHint') }}</p>
        <BuildingForm
          :building="primaryBuilding"
          :submit-label="primaryBuilding ? t('buildings.saveChanges') : t('buildings.form.submit')"
          :show-skip="Boolean(primaryBuilding)"
          @saved="onBuildingSaved"
          @skip="isEditingBuilding = false"
        />
      </template>
    </section>

    <section
      v-if="isAdmin && activeTab === 'finance'"
      class="settings-card"
      aria-labelledby="settings-late-fee-heading"
    >
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

    <section
      v-if="isAdmin && activeTab === 'admission'"
      class="settings-card settings-card--admission"
      aria-labelledby="settings-admission-rules-heading"
    >
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

    <section
      v-if="isAdmin && activeTab === 'providers'"
      class="settings-card settings-card--admission"
      aria-labelledby="settings-providers-heading"
    >
      <h2 id="settings-providers-heading" class="settings-card__title">
        {{ t('app.settingsProvidersTitle') }}
      </h2>
      <p class="settings-card__hint">{{ t('app.settingsProvidersHint') }}</p>
      <p v-if="providersLoading" class="settings-card__status">
        {{ t('app.settingsProvidersLoading') }}
      </p>
      <div class="settings-provider-fields">
        <label class="settings-card__field" for="settingsProviderName">
          <span>{{ t('app.settingsProvidersName') }}</span>
          <input
            id="settingsProviderName"
            v-model="providerDraft.name"
            type="text"
            class="settings-card__input"
            :placeholder="t('app.settingsProvidersNamePlaceholder')"
            :disabled="providersSaving"
            maxlength="80"
            @keydown.enter.prevent="addServiceProvider"
          />
        </label>
        <label class="settings-card__field" for="settingsProviderPhone">
          <span>{{ t('app.settingsProvidersPhone') }}</span>
          <input
            id="settingsProviderPhone"
            v-model="providerDraft.phone"
            type="tel"
            class="settings-card__input"
            :placeholder="t('app.settingsProvidersPhonePlaceholder')"
            :disabled="providersSaving"
            maxlength="30"
            @keydown.enter.prevent="addServiceProvider"
          />
        </label>
        <label class="settings-card__field" for="settingsProviderSpecialty">
          <span>{{ t('app.settingsProvidersSpecialty') }}</span>
          <input
            id="settingsProviderSpecialty"
            v-model="providerDraft.specialty"
            type="text"
            class="settings-card__input"
            :placeholder="t('app.settingsProvidersSpecialtyPlaceholder')"
            :disabled="providersSaving"
            maxlength="60"
            @keydown.enter.prevent="addServiceProvider"
          />
        </label>
      </div>
      <p v-if="providersNotice" class="settings-card__notice" role="status">
        {{ providersNotice }}
      </p>
      <p v-if="providersError" class="settings-card__error" role="alert">
        {{ providersError }}
      </p>
      <button
        type="button"
        class="settings-card__save"
        :disabled="providersSaving || providersLoading || !String(providerDraft.name || '').trim()"
        @click="addServiceProvider"
      >
        {{ t('app.settingsProvidersAdd') }}
      </button>

      <ul class="admission-resident-list" role="list">
        <li v-if="!providersLoading && !serviceProviders.length" class="admission-resident-list__empty">
          {{ t('app.settingsProvidersEmpty') }}
        </li>
        <li v-for="provider in serviceProviders" :key="provider.id" class="admission-resident">
          <div class="admission-resident__info">
            <strong>{{ provider.name }}</strong>
            <span>
              <template v-if="provider.specialty">{{ provider.specialty }}</template>
              <template v-if="provider.specialty && provider.phone"> · </template>
              <template v-if="provider.phone">{{ provider.phone }}</template>
            </span>
          </div>
          <button
            type="button"
            class="admission-resident__btn"
            :disabled="Boolean(deletingProviderId) || providersSaving"
            @click="removeServiceProvider(provider.id)"
          >
            {{ t('app.settingsProvidersDelete') }}
          </button>
        </li>
      </ul>
    </section>

    <!-- Subscriptions — solo visible para admin -->
    <section
      v-if="isAdmin && activeTab === 'plans'"
      class="plans-section"
      aria-labelledby="settings-plans-heading"
    >
      <h2 id="settings-plans-heading" class="plans-section__title">
        {{ t('app.settingsPlansTitle') }}
      </h2>
      <p class="plans-section__subtitle">{{ t('billing.plans.subtitle') }}</p>
      <p
        v-if="trialBanner"
        class="billing-banner"
        :class="`billing-banner--${trialBanner.tone}`"
        :role="trialBanner.tone === 'error' ? 'alert' : 'status'"
      >
        <i class="pi" :class="trialBanner.tone === 'info' ? 'pi-clock' : 'pi-exclamation-triangle'" aria-hidden="true" />
        {{ trialBanner.text }}
      </p>
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

      <SubscriptionPlansSection
        :current-plan-id="selectedPlanId"
        :subscription="subscription"
        :busy-plan-id="planCheckoutPlanId"
        :disabled="planLoading"
        :suggested-plan-id="suggestedPlanId"
        @select="selectPlan"
      />
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

    <section
      v-if="isResident"
      class="settings-card"
      aria-labelledby="settings-resident-password-heading"
    >
      <h2 id="settings-resident-password-heading" class="settings-card__title">
        {{ t('app.settingsResidentPasswordTitle') }}
      </h2>
      <p class="settings-card__hint">{{ t('app.settingsResidentPasswordHint') }}</p>
      <form class="settings-resident-password" @submit.prevent="onSaveResidentPassword">
        <input
          type="email"
          name="username"
          autocomplete="username"
          class="visually-hidden"
          :value="display.email || ''"
          readonly
          tabindex="-1"
          aria-hidden="true"
        />
        <label class="settings-card__field" for="settingsResidentPassword">
          <span>{{ t('auth.passwordPlaceholder') }}</span>
          <input
            id="settingsResidentPassword"
            v-model="residentPassword"
            type="password"
            autocomplete="new-password"
            minlength="6"
            class="settings-card__input"
            :disabled="residentPasswordSaving"
          />
        </label>
        <label class="settings-card__field" for="settingsResidentPasswordConfirm">
          <span>{{ t('auth.passwordConfirmPlaceholder') }}</span>
          <input
            id="settingsResidentPasswordConfirm"
            v-model="residentPasswordConfirm"
            type="password"
            autocomplete="new-password"
            minlength="6"
            class="settings-card__input"
            :disabled="residentPasswordSaving"
          />
        </label>
        <p v-if="residentPasswordNotice" class="settings-card__notice" role="status">
          {{ residentPasswordNotice }}
        </p>
        <p v-if="residentPasswordError" class="settings-card__error" role="alert">
          {{ residentPasswordError }}
        </p>
        <button type="submit" class="settings-card__save" :disabled="residentPasswordSaving">
          {{ t('app.settingsResidentPasswordSave') }}
        </button>
      </form>
    </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.app-view--ai {
  max-width: 88rem;
  padding-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.settings-tabs {
  align-self: center;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.15rem;
  max-width: 100%;
  padding: 0.3rem;
  overflow-x: auto;
  border-radius: 999px;
  background: #eef0f3;
}

.settings-tabs__item {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
  padding: 0.55rem 1.05rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #4b5563;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: -0.015em;
  cursor: pointer;
  white-space: nowrap;
}

.settings-tabs__item i {
  font-size: 0.9rem;
}

.settings-tabs__item:hover:not(.is-active) {
  color: #1d1d1f;
}

.settings-tabs__item.is-active {
  background: #fff;
  color: #1d1d1f;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.settings-tabs__item:focus-visible {
  outline: 2px solid var(--apple-blue, #1e3a8a);
  outline-offset: 2px;
}

.ai-shell {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 8.5rem);
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.settings-body {
  padding: 1.25rem 1.5rem 1.75rem;
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

.settings-provider-fields {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
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

.settings-resident-password .visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
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
  margin-top: 0;
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

/* ── Billing: trial / subscription banner (plan cards live in SubscriptionPlansSection) ── */
.billing-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0 0 0.85rem;
  padding: 0.7rem 0.9rem;
  border-radius: 12px;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.4;
}

.billing-banner--info {
  background: rgba(10, 132, 255, 0.08);
  color: #0060c0;
}

.billing-banner--warn {
  background: #fff8e6;
  color: #8a5300;
}

.billing-banner--error {
  background: #fff4f2;
  color: #b42318;
  border: 1px solid rgba(180, 35, 24, 0.2);
}

.billing-banner__action {
  margin-left: auto;
  padding: 0.35rem 0.8rem;
  border-radius: 980px;
  border: none;
  background: #0a84ff;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}
</style>
