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
  // Profiles (DNI, company, RUC…) only exist for admins; a resident's data comes from the session.
  if (!id || !isAdmin.value) {
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
const ALL_TAB_IDS = ['profile', 'building', 'plans', 'finance', 'admission', 'providers', 'security', 'preferences']
const activeTab = ref(
  ALL_TAB_IDS.includes(String(route.query.tab ?? '')) ? String(route.query.tab) : 'profile',
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

const settingsTabs = computed(() => {
  const profile = { id: 'profile', label: t('app.settingsTabProfile'), icon: 'pi pi-user' }
  const preferences = { id: 'preferences', label: t('app.settingsTabPreferences'), icon: 'pi pi-globe' }
  if (isAdmin.value) {
    return [
      profile,
      { id: 'building', label: t('app.settingsTabBuilding'), icon: 'pi pi-building' },
      { id: 'plans', label: t('app.settingsTabPlanBilling'), icon: 'pi pi-credit-card' },
      { id: 'finance', label: t('app.settingsTabFinance'), icon: 'pi pi-wallet' },
      { id: 'admission', label: t('app.settingsTabAdmission'), icon: 'pi pi-calendar' },
      { id: 'providers', label: t('app.settingsTabProviders'), icon: 'pi pi-wrench' },
      preferences,
    ]
  }
  if (isResident.value) {
    return [profile, { id: 'security', label: t('app.settingsTabSecurity'), icon: 'pi pi-lock' }, preferences]
  }
  return [profile, preferences]
})

/** Section actually shown: a tab id that does not exist for the current role falls back to Perfil. */
const currentTab = computed(() =>
  settingsTabs.value.some((item) => item.id === activeTab.value) ? activeTab.value : 'profile',
)

function selectTab(id) {
  if (activeTab.value === id) return
  activeTab.value = id
  router.replace({ query: { ...route.query, tab: id } }).catch(() => {})
}

/** Vertical (desktop) / horizontal (mobile) tablist: arrows, Home and End move between sections. */
function onTabKeydown(event, index) {
  const list = settingsTabs.value
  let next = null
  if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % list.length
  else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + list.length) % list.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = list.length - 1
  if (next == null) return
  event.preventDefault()
  selectTab(list[next].id)
  document.getElementById(`settings-tab-${list[next].id}`)?.focus()
}

const intlLocale = computed(() => (locale.value === 'en' ? 'en-US' : 'es-PE'))

/** yyyy-mm-dd is read as a local calendar day (no timezone shift); other values go through Date. */
function parseDateValue(value) {
  if (!value) return null
  const raw = String(value)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatLongDate(value) {
  const date = parseDateValue(value)
  if (!date) return ''
  return new Intl.DateTimeFormat(intlLocale.value, { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
}

function formatPen(value) {
  return new Intl.NumberFormat(intlLocale.value, {
    style: 'currency',
    currency: 'PEN',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0)
}

function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return `${first}${last}`.toUpperCase()
}

const accountInitials = computed(() => initialsOf(display.value.name || display.value.email))
const roleLabel = computed(() =>
  isAdmin.value ? t('app.settingsRoleAdmin') : isResident.value ? t('app.settingsRoleResident') : '',
)
const residentUnitLabel = computed(() => {
  const { floor, code } = display.value
  const hasFloor = floor != null && floor !== ''
  const hasCode = code != null && code !== ''
  return hasFloor || hasCode ? t('app.residentFloorApt', { floor: hasFloor ? floor : '—', code: hasCode ? code : '—' }) : ''
})

/** Brand names of the plans (Free, Essential, Standard, Scale, Portafolio). */
const planDisplayName = computed(() => {
  const id = String(subscription.value?.planId ?? selectedPlanId.value ?? SubscriptionPlanId.FREE)
  return id.charAt(0).toUpperCase() + id.slice(1)
})

/** Status pill of the subscription: label + soft tint (blue / green / amber / red). */
const planStatus = computed(() => {
  const sub = subscription.value
  if (!sub) return null
  if (sub.trialExpired) return { tone: 'red', label: t('app.settingsPlanStatusTrialExpired') }
  if (sub.status === 'SUSPENDED') return { tone: 'red', label: t('app.settingsPlanStatusSuspended') }
  if (sub.status === 'CANCELLED') return { tone: 'red', label: t('app.settingsPlanStatusCancelled') }
  if (sub.status === 'PAYMENT_FAILED') return { tone: 'amber', label: t('app.settingsPlanStatusPaymentFailed') }
  if (sub.status === 'TRIAL') {
    if (sub.trialDaysLeft == null) return { tone: 'blue', label: t('app.settingsPlanStatusTrialNoDays') }
    const days = Math.max(0, Number(sub.trialDaysLeft) || 0)
    return { tone: days <= 7 ? 'amber' : 'blue', label: t('app.settingsPlanStatusTrial', { days }, days) }
  }
  const until = formatLongDate(sub.paidUntil)
  return {
    tone: 'green',
    label: until ? t('app.settingsPlanStatusActiveUntil', { date: until }) : t('app.settingsPlanStatusActive'),
    short: t('app.settingsPlanStatusActive'),
  }
})

const planStatusHint = computed(() => {
  const sub = subscription.value
  if (!sub) return ''
  if (sub.status === 'TRIAL' || sub.trialExpired) {
    const ends = formatLongDate(sub.trialEndsAt)
    return ends ? t('app.settingsPlanSummaryTrialEnds', { date: ends }) : t('app.settingsPlanSummaryNoDate')
  }
  const until = formatLongDate(sub.paidUntil)
  return until ? t('app.settingsPlanSummaryPaidUntil', { date: until }) : t('app.settingsPlanSummaryNoDate')
})

const planPriceLabel = computed(() => {
  const price = Number(subscription.value?.monthlyPricePen ?? 0)
  return price > 0 ? t('billing.plans.pricePerMonth', { price: formatPen(price) }) : t('app.settingsPlanSummaryFree')
})

const residentUsagePercent = computed(() => {
  const max = Number(activeResidentLimit.value) || 0
  if (max <= 0) return 0
  return Math.min(100, Math.round((Number(residentsCount.value) / max) * 100))
})

/** Idioma y preferencias: same global locale the sidebar ES/EN switch drives (persisted from main.js). */
const languageOptions = computed(() => [
  { code: 'es', label: t('app.settingsPrefsLanguageEs'), hint: t('app.settingsPrefsLanguageEsHint'), short: 'ES' },
  { code: 'en', label: t('app.settingsPrefsLanguageEn'), hint: t('app.settingsPrefsLanguageEnHint'), short: 'EN' },
])

function setLocale(code) {
  if (locale.value !== code) locale.value = code
}

function onLanguageKeydown(event) {
  if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
  event.preventDefault()
  const next = locale.value === 'es' ? 'en' : 'es'
  setLocale(next)
  document.getElementById(`settings-lang-${next}`)?.focus()
}

const previewSample = computed(() => ({
  date: new Intl.DateTimeFormat(intlLocale.value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()),
  amount: new Intl.NumberFormat(intlLocale.value, {
    style: 'currency',
    currency: 'PEN',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
  }).format(1250.5),
}))

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

function focusProviderName() {
  document.getElementById('settingsProviderName')?.focus()
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

/** Mercado Pago not configured / gateway down: friendly copy instead of the raw server text. */
function isPaymentGatewayUnavailable(err) {
  const code = String(err?.code ?? '')
  return (
    code.startsWith('MP_') ||
    code === 'NETWORK_ERROR' ||
    code === 'TIMEOUT' ||
    ['HTTP_404', 'HTTP_405', 'HTTP_502', 'HTTP_503', 'HTTP_504'].includes(code)
  )
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
        : isPaymentGatewayUnavailable(error)
          ? t('app.settingsPlanCheckoutUnavailable')
          : error?.payload?.message || t('app.settingsPlanCheckoutError')
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
  <div class="app-view st">
    <header class="st-head">
      <h1 class="bf-sr-only">{{ t('app.pageSettings') }}</h1>
    </header>

    <!-- Account summary -->
    <section class="st-account" :aria-label="t('app.settingsSummaryAria')">
      <span class="st-avatar st-avatar--lg" aria-hidden="true">{{ accountInitials }}</span>
      <div class="st-account__main">
        <div class="st-account__row">
          <h2 class="st-account__name">{{ display.name || display.email || '—' }}</h2>
          <span v-if="roleLabel" class="st-pill st-pill--navy">{{ roleLabel }}</span>
        </div>
        <ul class="st-account__meta" role="list">
          <li v-if="display.email">
            <i class="pi pi-envelope" aria-hidden="true" />
            <span>{{ display.email }}</span>
          </li>
          <li v-if="isAdmin">
            <i class="pi pi-building" aria-hidden="true" />
            <span>{{ primaryBuilding?.name || (buildingLoading ? '…' : t('app.settingsNoBuilding')) }}</span>
          </li>
          <li v-else-if="residentUnitLabel">
            <i class="pi pi-home" aria-hidden="true" />
            <span>{{ residentUnitLabel }}</span>
          </li>
        </ul>
      </div>
      <div v-if="isAdmin && subscription" class="st-account__plan">
        <span class="st-pill st-pill--blue">
          <i class="pi pi-credit-card" aria-hidden="true" />
          {{ t('app.settingsPlanPillLabel', { name: planDisplayName }) }}
        </span>
        <span v-if="planStatus" class="st-pill" :class="`st-pill--${planStatus.tone}`">{{ planStatus.label }}</span>
      </div>
    </section>

    <p v-if="isLoading" class="st-status" role="status">{{ t('app.settingsLoadingProfile') }}</p>
    <p v-else-if="loadError" class="st-notice st-notice--warn" role="status">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      <span>{{ t('app.settingsProfileLoadError') }}</span>
    </p>

    <div
      v-if="isAdmin && currentTab !== 'plans' && trialBanner && trialBanner.tone === 'error'"
      class="st-banner st-banner--error"
      role="alert"
    >
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      <p class="st-banner__text">{{ trialBanner.text }}</p>
      <button type="button" class="st-banner__action" @click="selectTab('plans')">
        {{ t('billing.choosePlanCta') }}
      </button>
    </div>

    <div class="st-layout">
      <nav class="st-nav" :aria-label="t('app.settingsSectionsNav')">
        <div class="st-nav__list" v-bf-seg role="tablist" aria-orientation="vertical" :aria-label="t('app.settingsSectionsNav')">
          <button
            v-for="(tab, index) in settingsTabs"
            :id="`settings-tab-${tab.id}`"
            :key="tab.id"
            type="button"
            role="tab"
            class="st-nav__item"
            :class="{ 'is-active': currentTab === tab.id }"
            :aria-selected="currentTab === tab.id"
            :aria-controls="`settings-panel-${tab.id}`"
            :tabindex="currentTab === tab.id ? 0 : -1"
            @click="selectTab(tab.id)"
            @keydown="onTabKeydown($event, index)"
          >
            <i :class="tab.icon" aria-hidden="true" />
            <span>{{ tab.label }}</span>
          </button>
        </div>
      </nav>

      <div class="st-content">
        <!-- Perfil (admin) -->
        <section
          v-if="isAdmin && currentTab === 'profile'"
          id="settings-panel-profile"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-admin-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-admin-heading" class="st-card__title">{{ t('app.settingsAdminProfileTitle') }}</h2>
            <p class="st-card__hint">{{ t('app.settingsProfileHint') }}</p>
          </div>
          <div class="st-group">
            <h3 class="st-group__title">{{ t('app.settingsGroupPersonal') }}</h3>
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('auth.fullName') }}</dt>
                <dd :class="{ 'is-empty': !display.name }">{{ display.name || t('app.settingsNotProvided') }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('auth.email') }}</dt>
                <dd :class="{ 'is-empty': !display.email }">{{ display.email || t('app.settingsNotProvided') }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('app.settingsAdminDniLabel') }}</dt>
                <dd :class="{ 'is-empty': !display.dni }">{{ display.dni || t('app.settingsNotProvided') }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('app.settingsAdminAddressLabel') }}</dt>
                <dd :class="{ 'is-empty': !display.address }">{{ display.address || t('app.settingsNotProvided') }}</dd>
              </div>
            </dl>
          </div>
          <div class="st-group">
            <h3 class="st-group__title">{{ t('app.settingsGroupCompany') }}</h3>
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('app.settingsAdminCompanyLabel') }}</dt>
                <dd :class="{ 'is-empty': !display.company }">{{ display.company || t('app.settingsNotProvided') }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('app.settingsAdminRucLabel') }}</dt>
                <dd :class="{ 'is-empty': !display.ruc }">{{ display.ruc || t('app.settingsNotProvided') }}</dd>
              </div>
            </dl>
          </div>
        </section>

        <!-- Perfil (resident) -->
        <section
          v-if="!isAdmin && currentTab === 'profile'"
          id="settings-panel-profile"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-resident-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-resident-heading" class="st-card__title">{{ t('app.settingsResidentProfileTitle') }}</h2>
            <p class="st-card__hint">{{ t('app.settingsProfileHint') }}</p>
          </div>
          <div class="st-group">
            <h3 class="st-group__title">{{ t('app.settingsGroupPersonal') }}</h3>
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('app.residentNameLabel') }}</dt>
                <dd :class="{ 'is-empty': !display.name }">{{ display.name || t('app.settingsNotProvided') }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('auth.email') }}</dt>
                <dd :class="{ 'is-empty': !display.email }">{{ display.email || t('app.settingsNotProvided') }}</dd>
              </div>
            </dl>
          </div>
          <div class="st-group">
            <h3 class="st-group__title">{{ t('app.settingsGroupHome') }}</h3>
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('app.residentFloorLabel') }}</dt>
                <dd :class="{ 'is-empty': display.floor == null || display.floor === '' }">
                  {{ display.floor != null && display.floor !== '' ? display.floor : t('app.settingsNotProvided') }}
                </dd>
              </div>
              <div class="st-field">
                <dt>{{ t('app.residentCodeLabel') }}</dt>
                <dd :class="{ 'is-empty': display.code == null || display.code === '' }">
                  {{ display.code != null && display.code !== '' ? display.code : t('app.settingsNotProvided') }}
                </dd>
              </div>
              <div v-if="display.admissionDate" class="st-field">
                <dt>{{ t('app.settingsResidentAdmissionLabel') }}</dt>
                <dd>{{ formatLongDate(display.admissionDate) || display.admissionDate }}</dd>
              </div>
            </dl>
          </div>
        </section>

        <!-- Edificio (admin) -->
        <section
          v-if="isAdmin && currentTab === 'building'"
          id="settings-panel-building"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-building-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-building-heading" class="st-card__title">{{ t('buildings.cardTitle') }}</h2>
            <p class="st-card__hint">{{ t('app.settingsBuildingHint') }}</p>
          </div>
          <p v-if="buildingLoading" class="st-status" role="status">{{ t('buildings.loading') }}</p>
          <div v-else-if="buildingLoadError" class="st-notice st-notice--error" role="alert">
            <i class="pi pi-times-circle" aria-hidden="true" />
            <span>{{ t('buildings.loadError') }}</span>
            <button type="button" class="st-notice__action" @click="loadBuildings">{{ t('billing.plans.retry') }}</button>
          </div>
          <template v-else-if="primaryBuilding && !isEditingBuilding">
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('buildings.form.name') }}</dt>
                <dd>{{ primaryBuilding.name }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('buildings.form.departmentCount') }}</dt>
                <dd>{{ primaryBuilding.departmentCount }}</dd>
              </div>
              <div class="st-field st-field--wide">
                <dt>{{ t('buildings.form.address') }}</dt>
                <dd>{{ primaryBuilding.address }}</dd>
              </div>
            </dl>
            <p v-if="buildings.length > 1" class="st-card__hint st-card__hint--below">
              {{ t('app.settingsMoreBuildings', { n: buildings.length - 1 }, buildings.length - 1) }}
            </p>
            <div class="st-card__foot">
              <p v-if="buildingNotice" class="st-notice st-notice--ok" role="status">
                <i class="pi pi-check-circle" aria-hidden="true" />
                <span>{{ buildingNotice }}</span>
              </p>
              <button type="button" class="st-btn st-btn--primary" @click="isEditingBuilding = true">
                <i class="pi pi-pencil" aria-hidden="true" />
                {{ t('buildings.edit') }}
              </button>
            </div>
          </template>
          <template v-else>
            <p v-if="!primaryBuilding" class="st-note">
              <i class="pi pi-info-circle" aria-hidden="true" />
              <span>{{ t('buildings.missingHint') }}</span>
            </p>
            <BuildingForm
              :building="primaryBuilding"
              :submit-label="primaryBuilding ? t('buildings.saveChanges') : t('buildings.form.submit')"
              :show-skip="Boolean(primaryBuilding)"
              columns
              @saved="onBuildingSaved"
              @skip="isEditingBuilding = false"
            />
          </template>
        </section>

        <!-- Plan y facturación (admin) -->
        <section
          v-if="isAdmin && currentTab === 'plans'"
          id="settings-panel-plans"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-plans-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-plans-heading" class="st-card__title">{{ t('app.settingsPlansTitle') }}</h2>
            <p class="st-card__hint">{{ t('billing.plans.subtitle') }}</p>
          </div>

          <div
            v-if="trialBanner"
            class="st-banner"
            :class="`st-banner--${trialBanner.tone}`"
            :role="trialBanner.tone === 'error' ? 'alert' : 'status'"
          >
            <i class="pi" :class="trialBanner.tone === 'info' ? 'pi-clock' : 'pi-exclamation-triangle'" aria-hidden="true" />
            <p class="st-banner__text">{{ trialBanner.text }}</p>
          </div>

          <div class="st-stats">
            <article class="st-stat st-stat--blue">
              <div class="st-stat__head">
                <h3 class="st-stat__label">{{ t('app.settingsPlanSummaryCurrent') }}</h3>
                <span class="st-stat__icon st-stat__icon--blue"><i class="pi pi-credit-card" aria-hidden="true" /></span>
              </div>
              <p class="st-stat__value">{{ planDisplayName }}</p>
              <p class="st-stat__hint">{{ planPriceLabel }}</p>
            </article>
            <article class="st-stat st-stat--green">
              <div class="st-stat__head">
                <h3 class="st-stat__label">{{ t('app.settingsPlanSummaryResidents') }}</h3>
                <span class="st-stat__icon st-stat__icon--green"><i class="pi pi-users" aria-hidden="true" /></span>
              </div>
              <p class="st-stat__value">
                {{ t('app.settingsPlanSummaryResidentsValue', { current: residentsCount, max: activeResidentLimit }) }}
              </p>
              <div
                class="st-meter"
                role="progressbar"
                :aria-valuenow="residentUsagePercent"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="t('app.settingsPlanUsageLine', { current: residentsCount, max: activeResidentLimit })"
              >
                <span class="st-meter__fill" :style="{ width: `${residentUsagePercent}%` }" />
              </div>
              <p class="st-stat__hint">
                {{ t('app.settingsPlanUsageLine', { current: residentsCount, max: activeResidentLimit }) }}
              </p>
            </article>
            <article class="st-stat" :class="`st-stat--${planStatus?.tone === 'red' ? 'red' : planStatus?.tone === 'green' ? 'green' : 'amber'}`">
              <div class="st-stat__head">
                <h3 class="st-stat__label">{{ t('app.settingsPlanSummaryStatus') }}</h3>
                <span
                  class="st-stat__icon"
                  :class="`st-stat__icon--${planStatus?.tone === 'red' ? 'red' : planStatus?.tone === 'green' ? 'green' : 'amber'}`"
                >
                  <i class="pi" :class="planStatus?.tone === 'green' ? 'pi-check' : planStatus?.tone === 'red' ? 'pi-exclamation-triangle' : 'pi-clock'" aria-hidden="true" />
                </span>
              </div>
              <p class="st-stat__value st-stat__value--sm">{{ planStatus?.short || planStatus?.label || '—' }}</p>
              <p class="st-stat__hint">{{ planStatusHint }}</p>
            </article>
          </div>

          <p v-if="planSaveNotice" class="st-notice st-notice--ok" role="status">
            <i class="pi pi-check-circle" aria-hidden="true" />
            <span>{{ planSaveNotice }}</span>
          </p>
          <p v-if="planError" class="st-notice st-notice--error" role="alert">
            <i class="pi pi-times-circle" aria-hidden="true" />
            <span>{{ planError }}</span>
          </p>
          <p v-if="planLoading" class="st-status" role="status">{{ t('app.settingsPlanLoading') }}</p>

          <SubscriptionPlansSection
            :current-plan-id="selectedPlanId"
            :subscription="subscription"
            :busy-plan-id="planCheckoutPlanId"
            :disabled="planLoading"
            :suggested-plan-id="suggestedPlanId"
            @select="selectPlan"
          />
        </section>

        <!-- Ajustes de finanzas (admin) -->
        <section
          v-if="isAdmin && currentTab === 'finance'"
          id="settings-panel-finance"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-late-fee-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-late-fee-heading" class="st-card__title">{{ t('app.settingsTabFinance') }}</h2>
            <p class="st-card__hint">{{ t('app.settingsFinanceHint') }}</p>
          </div>
          <p v-if="lateFeeLoading" class="st-status" role="status">{{ t('financeAdmin.loading') }}</p>
          <form class="st-form" novalidate @submit.prevent="onSaveLateFee">
            <div class="st-form__grid">
              <div class="st-input-field">
                <label for="settingsLateFeePerDay">{{ t('financeAdmin.lateFeePerDay') }}</label>
                <div class="st-affix">
                  <span class="st-affix__prefix" aria-hidden="true">S/</span>
                  <input
                    id="settingsLateFeePerDay"
                    v-model.number="lateFeePerDay"
                    type="number"
                    min="0"
                    step="0.01"
                    inputmode="decimal"
                    class="st-input"
                    aria-describedby="settingsLateFeeHint"
                    :aria-invalid="Boolean(lateFeeError)"
                  />
                </div>
                <p id="settingsLateFeeHint" class="st-input-field__hint">{{ t('financeAdmin.lateFeeHint') }}</p>
              </div>
            </div>
            <div class="st-card__foot">
              <p v-if="lateFeeNotice" class="st-notice st-notice--ok" role="status">
                <i class="pi pi-check-circle" aria-hidden="true" />
                <span>{{ lateFeeNotice }}</span>
              </p>
              <p v-if="lateFeeError" class="st-notice st-notice--error" role="alert">
                <i class="pi pi-times-circle" aria-hidden="true" />
                <span>{{ lateFeeError }}</span>
              </p>
              <button type="submit" class="st-btn st-btn--primary" :disabled="isSavingLateFee || lateFeeLoading">
                <i class="pi" :class="isSavingLateFee ? 'pi-spin pi-spinner' : 'pi-check'" aria-hidden="true" />
                {{ isSavingLateFee ? t('app.settingsSaving') : t('app.settingsSaveChanges') }}
              </button>
            </div>
          </form>
        </section>

        <!-- Admisión (admin) -->
        <template v-if="isAdmin && currentTab === 'admission'">
          <section
            id="settings-panel-admission"
            class="st-card"
            role="tabpanel"
            aria-labelledby="settings-admission-rules-heading"
          >
            <div class="st-card__head">
              <h2 id="settings-admission-rules-heading" class="st-card__title">
                {{ t('financeAdmin.admissionRulesTitle') }}
              </h2>
              <p class="st-card__hint">{{ t('financeAdmin.admissionRulesHint') }}</p>
            </div>
            <p v-if="lateFeeLoading" class="st-status" role="status">{{ t('financeAdmin.loading') }}</p>
            <form class="st-form" novalidate @submit.prevent="onSaveAdmissionRules">
              <div class="st-form__grid">
                <div class="st-input-field">
                  <label for="settingsAdmissionPayFromDay">{{ t('financeAdmin.admissionRangeFrom') }}</label>
                  <input
                    id="settingsAdmissionPayFromDay"
                    v-model.number="admissionPayFromDay"
                    type="number"
                    min="1"
                    max="31"
                    step="1"
                    inputmode="numeric"
                    class="st-input"
                  />
                </div>
                <div class="st-input-field">
                  <label for="settingsAdmissionPayToDay">{{ t('financeAdmin.admissionRangeTo') }}</label>
                  <input
                    id="settingsAdmissionPayToDay"
                    v-model.number="admissionPayToDay"
                    type="number"
                    min="1"
                    max="31"
                    step="1"
                    inputmode="numeric"
                    class="st-input"
                  />
                </div>
              </div>
              <p class="st-note" aria-live="polite">
                <i class="pi pi-info-circle" aria-hidden="true" />
                <span>
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
                </span>
              </p>
              <div class="st-card__foot">
                <p v-if="admissionRuleNotice" class="st-notice st-notice--ok" role="status">
                  <i class="pi pi-check-circle" aria-hidden="true" />
                  <span>{{ admissionRuleNotice }}</span>
                </p>
                <p v-if="admissionRuleError" class="st-notice st-notice--error" role="alert">
                  <i class="pi pi-times-circle" aria-hidden="true" />
                  <span>{{ admissionRuleError }}</span>
                </p>
                <button type="submit" class="st-btn st-btn--primary" :disabled="isSavingAdmissionRules || lateFeeLoading">
                  <i class="pi" :class="isSavingAdmissionRules ? 'pi-spin pi-spinner' : 'pi-check'" aria-hidden="true" />
                  {{ isSavingAdmissionRules ? t('app.settingsSaving') : t('app.settingsSaveChanges') }}
                </button>
              </div>
            </form>
          </section>

          <section class="st-card" aria-labelledby="settings-admission-residents-heading">
            <div class="st-card__head st-card__head--row">
              <div>
                <h2 id="settings-admission-residents-heading" class="st-card__title">
                  {{ t('financeAdmin.admissionResidentsTitle') }}
                </h2>
                <p class="st-card__hint">{{ t('financeAdmin.admissionResidentsHint') }}</p>
              </div>
              <span class="st-pill st-pill--soft">
                {{ t('app.settingsAdmissionResidentsCount', { n: financesStore.state.residents.length }, financesStore.state.residents.length) }}
              </span>
            </div>
            <label class="st-search" for="settingsAdmissionResidentSearch">
              <span class="visually-hidden">{{ t('financeAdmin.extraSearch') }}</span>
              <i class="pi pi-search" aria-hidden="true" />
              <input
                id="settingsAdmissionResidentSearch"
                v-model="admissionResidentSearch"
                type="search"
                :placeholder="t('financeAdmin.extraSearchPlaceholder')"
              />
            </label>
            <div v-if="!financesStore.state.residents.length" class="st-empty">
              <span class="st-empty__icon"><i class="pi pi-users" aria-hidden="true" /></span>
              <p class="st-empty__text">{{ t('financeAdmin.admissionResidentsEmpty') }}</p>
            </div>
            <div v-else-if="!admissionResidents.length" class="st-empty">
              <span class="st-empty__icon"><i class="pi pi-search" aria-hidden="true" /></span>
              <p class="st-empty__text">{{ t('financeAdmin.admissionResidentsNone') }}</p>
              <button type="button" class="st-btn" @click="admissionResidentSearch = ''">
                <i class="pi pi-times" aria-hidden="true" />
                {{ t('app.settingsClearSearch') }}
              </button>
            </div>
            <ul v-else class="st-list" role="list">
              <li v-for="resident in admissionResidents" :key="resident.id" class="st-row">
                <span class="st-avatar" aria-hidden="true">{{ initialsOf(resident.name) }}</span>
                <div class="st-row__text">
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
                  class="st-toggle"
                  :aria-pressed="Boolean(resident.billFromNextMonth)"
                  :disabled="Boolean(billingResidentId) || lateFeeLoading"
                  @click="onToggleBillFromNextMonth(resident)"
                >
                  <span class="st-toggle__track" aria-hidden="true"><span class="st-toggle__knob" /></span>
                  <span>
                    {{ resident.billFromNextMonth ? t('app.billFromNextMonthOn') : t('app.billFromNextMonthAction') }}
                  </span>
                </button>
              </li>
            </ul>
            <p v-if="billingResidentError" class="st-notice st-notice--error" role="alert">
              <i class="pi pi-times-circle" aria-hidden="true" />
              <span>{{ billingResidentError }}</span>
            </p>
          </section>
        </template>

        <!-- Proveedores (admin) -->
        <template v-if="isAdmin && currentTab === 'providers'">
          <section
            id="settings-panel-providers"
            class="st-card"
            role="tabpanel"
            aria-labelledby="settings-providers-heading"
          >
            <div class="st-card__head">
              <h2 id="settings-providers-heading" class="st-card__title">{{ t('app.settingsProvidersTitle') }}</h2>
              <p class="st-card__hint">{{ t('app.settingsProvidersHint') }}</p>
            </div>
            <form class="st-form" novalidate @submit.prevent="addServiceProvider">
              <h3 class="st-group__title">{{ t('app.settingsProvidersAddTitle') }}</h3>
              <div class="st-form__grid">
                <div class="st-input-field st-input-field--wide">
                  <label for="settingsProviderName">{{ t('app.settingsProvidersName') }}</label>
                  <input
                    id="settingsProviderName"
                    v-model="providerDraft.name"
                    type="text"
                    class="st-input"
                    :placeholder="t('app.settingsProvidersNamePlaceholder')"
                    :disabled="providersSaving"
                    maxlength="80"
                    autocomplete="organization"
                  />
                </div>
                <div class="st-input-field">
                  <label for="settingsProviderPhone">{{ t('app.settingsProvidersPhone') }}</label>
                  <input
                    id="settingsProviderPhone"
                    v-model="providerDraft.phone"
                    type="tel"
                    class="st-input"
                    :placeholder="t('app.settingsProvidersPhonePlaceholder')"
                    :disabled="providersSaving"
                    maxlength="30"
                    autocomplete="tel"
                  />
                </div>
                <div class="st-input-field">
                  <label for="settingsProviderSpecialty">{{ t('app.settingsProvidersSpecialty') }}</label>
                  <input
                    id="settingsProviderSpecialty"
                    v-model="providerDraft.specialty"
                    type="text"
                    class="st-input"
                    :placeholder="t('app.settingsProvidersSpecialtyPlaceholder')"
                    :disabled="providersSaving"
                    maxlength="60"
                  />
                </div>
              </div>
              <div class="st-card__foot">
                <p v-if="providersNotice" class="st-notice st-notice--ok" role="status">
                  <i class="pi pi-check-circle" aria-hidden="true" />
                  <span>{{ providersNotice }}</span>
                </p>
                <p v-if="providersError" class="st-notice st-notice--error" role="alert">
                  <i class="pi pi-times-circle" aria-hidden="true" />
                  <span>{{ providersError }}</span>
                </p>
                <button
                  type="submit"
                  class="st-btn st-btn--primary"
                  :disabled="providersSaving || providersLoading || !String(providerDraft.name || '').trim()"
                >
                  <i class="pi" :class="providersSaving ? 'pi-spin pi-spinner' : 'pi-plus'" aria-hidden="true" />
                  {{ t('app.settingsProvidersAdd') }}
                </button>
              </div>
            </form>
          </section>

          <section class="st-card" aria-labelledby="settings-providers-list-heading" :aria-busy="providersLoading">
            <div class="st-card__head st-card__head--row">
              <h2 id="settings-providers-list-heading" class="st-card__title">{{ t('app.settingsProvidersListTitle') }}</h2>
              <span class="st-pill st-pill--soft">
                {{ t('app.settingsProvidersCount', { n: serviceProviders.length }, serviceProviders.length) }}
              </span>
            </div>
            <p v-if="providersLoading" class="st-status" role="status">{{ t('app.settingsProvidersLoading') }}</p>
            <div v-else-if="!serviceProviders.length" class="st-empty">
              <span class="st-empty__icon"><i class="pi pi-wrench" aria-hidden="true" /></span>
              <p class="st-empty__text">{{ t('app.settingsProvidersEmpty') }}</p>
              <button
                type="button"
                class="st-btn st-btn--primary"
                @click="focusProviderName"
              >
                <i class="pi pi-plus" aria-hidden="true" />
                {{ t('app.settingsProvidersAdd') }}
              </button>
            </div>
            <ul v-else class="st-list" role="list">
              <li v-for="provider in serviceProviders" :key="provider.id" class="st-row">
                <span class="st-avatar st-avatar--amber" aria-hidden="true">{{ initialsOf(provider.name) }}</span>
                <div class="st-row__text">
                  <strong>{{ provider.name }}</strong>
                  <span v-if="provider.specialty || provider.phone">
                    <template v-if="provider.specialty">{{ provider.specialty }}</template>
                    <template v-if="provider.specialty && provider.phone"> · </template>
                    <template v-if="provider.phone">{{ provider.phone }}</template>
                  </span>
                </div>
                <button
                  type="button"
                  class="st-btn st-btn--danger st-btn--sm"
                  :aria-label="t('app.settingsProvidersDeleteAria', { name: provider.name })"
                  :disabled="Boolean(deletingProviderId) || providersSaving"
                  @click="removeServiceProvider(provider.id)"
                >
                  <i
                    class="pi"
                    :class="deletingProviderId === String(provider.id) ? 'pi-spin pi-spinner' : 'pi-trash'"
                    aria-hidden="true"
                  />
                  <span class="st-btn__label">{{ t('app.settingsProvidersDelete') }}</span>
                </button>
              </li>
            </ul>
          </section>
        </template>

        <!-- Seguridad (resident) -->
        <section
          v-if="isResident && currentTab === 'security'"
          id="settings-panel-security"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-resident-password-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-resident-password-heading" class="st-card__title">
              {{ t('app.settingsResidentPasswordTitle') }}
            </h2>
            <p class="st-card__hint">{{ t('app.settingsResidentPasswordHint') }}</p>
          </div>
          <form class="st-form settings-resident-password" @submit.prevent="onSaveResidentPassword">
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
            <div class="st-form__grid">
              <div class="st-input-field">
                <label for="settingsResidentPassword">{{ t('auth.passwordPlaceholder') }}</label>
                <input
                  id="settingsResidentPassword"
                  v-model="residentPassword"
                  type="password"
                  autocomplete="new-password"
                  minlength="6"
                  class="st-input"
                  aria-describedby="settingsResidentPasswordRule"
                  :aria-invalid="Boolean(residentPasswordError)"
                  :disabled="residentPasswordSaving"
                />
              </div>
              <div class="st-input-field">
                <label for="settingsResidentPasswordConfirm">{{ t('auth.passwordConfirmPlaceholder') }}</label>
                <input
                  id="settingsResidentPasswordConfirm"
                  v-model="residentPasswordConfirm"
                  type="password"
                  autocomplete="new-password"
                  minlength="6"
                  class="st-input"
                  aria-describedby="settingsResidentPasswordRule"
                  :aria-invalid="Boolean(residentPasswordError)"
                  :disabled="residentPasswordSaving"
                />
              </div>
            </div>
            <p id="settingsResidentPasswordRule" class="st-input-field__hint">{{ t('app.settingsPasswordRule') }}</p>
            <div class="st-card__foot">
              <p v-if="residentPasswordNotice" class="st-notice st-notice--ok" role="status">
                <i class="pi pi-check-circle" aria-hidden="true" />
                <span>{{ residentPasswordNotice }}</span>
              </p>
              <p v-if="residentPasswordError" class="st-notice st-notice--error" role="alert">
                <i class="pi pi-times-circle" aria-hidden="true" />
                <span>{{ residentPasswordError }}</span>
              </p>
              <button type="submit" class="st-btn st-btn--primary" :disabled="residentPasswordSaving">
                <i class="pi" :class="residentPasswordSaving ? 'pi-spin pi-spinner' : 'pi-lock'" aria-hidden="true" />
                {{ residentPasswordSaving ? t('app.settingsSaving') : t('app.settingsResidentPasswordSave') }}
              </button>
            </div>
          </form>
        </section>

        <!-- Idioma y preferencias -->
        <section
          v-if="currentTab === 'preferences'"
          id="settings-panel-preferences"
          class="st-card"
          role="tabpanel"
          aria-labelledby="settings-prefs-heading"
        >
          <div class="st-card__head">
            <h2 id="settings-prefs-heading" class="st-card__title">{{ t('app.settingsTabPreferences') }}</h2>
            <p class="st-card__hint">{{ t('app.settingsPrefsHint') }}</p>
          </div>
          <div class="st-group">
            <h3 id="settings-lang-label" class="st-group__title">{{ t('app.settingsPrefsLanguage') }}</h3>
            <div class="st-lang" v-bf-seg role="radiogroup" aria-labelledby="settings-lang-label">
              <button
                v-for="option in languageOptions"
                :id="`settings-lang-${option.code}`"
                :key="option.code"
                type="button"
                role="radio"
                class="st-lang__option"
                :class="{ 'is-active': locale === option.code }"
                :aria-checked="locale === option.code"
                :tabindex="locale === option.code ? 0 : -1"
                :lang="option.code === 'es' ? 'es' : 'en'"
                @click="setLocale(option.code)"
                @keydown="onLanguageKeydown"
              >
                <span class="st-lang__code" aria-hidden="true">{{ option.short }}</span>
                <span class="st-lang__text">
                  <strong>{{ option.label }}</strong>
                  <small>{{ option.hint }}</small>
                </span>
                <i class="pi st-lang__check" :class="locale === option.code ? 'pi-check-circle' : 'pi-circle'" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="st-group">
            <h3 class="st-group__title">{{ t('app.settingsPrefsPreview') }}</h3>
            <dl class="st-fields">
              <div class="st-field">
                <dt>{{ t('app.settingsPrefsPreviewDate') }}</dt>
                <dd>{{ previewSample.date }}</dd>
              </div>
              <div class="st-field">
                <dt>{{ t('app.settingsPrefsPreviewAmount') }}</dt>
                <dd>{{ previewSample.amount }}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.st {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.st *,
.st *::before,
.st *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.st-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

/* ---------- Buttons ---------- */
.st-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.st-btn .pi {
  font-size: 0.78rem;
}

.st-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.st-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.st-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.st-btn--danger {
  color: #b42318;
}

.st-btn--danger:hover:not(:disabled) {
  background: #fde4e4;
}

.st-btn--sm {
  min-height: 2.1rem;
  padding: 0.35rem 0.8rem;
  font-size: 0.78rem;
}

.st-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.st-btn:focus-visible,
.st-nav__item:focus-visible,
.st-toggle:focus-visible,
.st-lang__option:focus-visible,
.st-banner__action:focus-visible,
.st-notice__action:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

/* ---------- Pills ---------- */
.st-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
  background: #f1f5f9;
  color: #334155;
}

.st-pill .pi {
  font-size: 0.7rem;
}

.st-pill--navy { background: #1e3a8a; color: #fff; }
.st-pill--blue { background: #e8eefc; color: #1e3a8a; }
.st-pill--green { background: #e3f4e8; color: #166534; }
.st-pill--amber { background: #fdf3dc; color: #92400e; }
.st-pill--red { background: #fde4e4; color: #b42318; }
.st-pill--soft { background: #f1f5f9; color: #334155; }

/* ---------- Account summary ---------- */
.st-account {
  display: flex;
  align-items: center;
  gap: 1rem 1.1rem;
  flex-wrap: wrap;
  padding: 1rem 1.25rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.st-account__main {
  flex: 1 1 12rem;
  min-width: 0;
}

.st-account__row {
  display: flex;
  align-items: center;
  gap: 0.5rem 0.6rem;
  flex-wrap: wrap;
}

.st-account__name {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.st-account__meta {
  list-style: none;
  margin: 0.35rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.1rem;
  font-size: 0.82rem;
  color: #475569;
}

.st-account__meta li {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.st-account__meta .pi {
  font-size: 0.78rem;
  color: #94a3b8;
}

.st-account__plan {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.st-avatar {
  flex-shrink: 0;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.st-avatar--lg {
  width: 3.25rem;
  height: 3.25rem;
  font-size: 1rem;
  background: #1e3a8a;
  color: #fff;
}

.st-avatar--amber {
  background: #fdf3dc;
  color: #92400e;
}

/* ---------- Status / notices / banners ---------- */
.st-status {
  margin: 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

.st-notice {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0;
  padding: 0.55rem 0.9rem;
  border-radius: 14px;
  font-size: 0.8rem;
  line-height: 1.4;
}

.st-notice > span {
  flex: 1;
  min-width: 0;
}

.st-notice--ok { background: #e3f4e8; color: #14532d; }
.st-notice--ok > .pi { color: #15803d; }
.st-notice--error { background: #fde4e4; color: #7f1d1d; }
.st-notice--error > .pi { color: #b42318; }
.st-notice--warn { background: #fdf3dc; color: #78350f; }
.st-notice--warn > .pi { color: #b45309; }

.st-notice__action,
.st-banner__action {
  flex-shrink: 0;
  padding: 0.35rem 0.85rem;
  border: none;
  border-radius: 999px;
  background: #fff;
  color: inherit;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
}

.st-notice__action:hover,
.st-banner__action:hover {
  text-decoration: underline;
}

.st-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0;
  padding: 0.6rem 0.65rem 0.6rem 1rem;
  border-radius: 16px;
  font-size: 0.82rem;
  line-height: 1.4;
}

.st-banner__text {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.st-banner--info { background: #e8eefc; color: #1e3a8a; }
.st-banner--warn { background: #fdf3dc; color: #78350f; }
.st-banner--warn > .pi { color: #b45309; }
.st-banner--error { background: #fde4e4; color: #7f1d1d; }
.st-banner--error > .pi { color: #b42318; }

.st-note {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.65rem 0.85rem;
  border-radius: 14px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.8rem;
  line-height: 1.45;
}

.st-note .pi {
  margin-top: 0.15rem;
  font-size: 0.78rem;
}

/* ---------- Layout: section nav + content ---------- */
.st-layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
}

.st-nav {
  position: sticky;
  top: 1rem;
  padding: 0.5rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.st-nav__list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 4px;
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.06);
}

.st-nav__item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: color 0.28s ease;
}

.st-nav__item .pi {
  width: 1rem;
  font-size: 0.85rem;
  color: #64748b;
  text-align: center;
}

.st-nav__item:hover:not(.is-active) {
  color: #0f172a;
}

.st-nav__item.is-active {
  background: transparent;
  color: #0f172a;
}

.st-nav__item.is-active .pi {
  color: #1e3a8a;
}

.st-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

/* ---------- Section cards ---------- */
.st-card {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  padding: 1.25rem 1.35rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.st-card__head {
  min-width: 0;
}

.st-card__head--row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  flex-wrap: wrap;
}

.st-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.st-card__hint {
  margin: 0.3rem 0 0;
  max-width: 46rem;
  font-size: 0.8rem;
  line-height: 1.5;
  color: #6e6e73;
}

.st-card__hint--below {
  margin-top: -0.4rem;
}

.st-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.6rem 0.75rem;
  flex-wrap: wrap;
  padding-top: 1rem;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
}

.st-card__foot .st-notice {
  flex: 1 1 16rem;
  margin-right: auto;
}

/* Groups of read-only fields in two columns */
.st-group {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.st-group + .st-group {
  padding-top: 1.1rem;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
}

.st-group__title {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 650;
  color: #0f172a;
}

.st-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  margin: 0;
}

.st-field {
  min-width: 0;
  padding: 0.7rem 0.85rem;
  border-radius: 14px;
  background: #f8fafc;
}

.st-field--wide {
  grid-column: 1 / -1;
}

.st-field dt {
  margin: 0 0 0.2rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
}

.st-field dd {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.st-field dd.is-empty {
  font-weight: 500;
  color: #94a3b8;
}

/* Editable forms */
.st-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.st-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem 1rem;
}

.st-input-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.st-input-field--wide {
  grid-column: 1 / -1;
}

.st-input-field > label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.st-input-field__hint {
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.st-input {
  width: 100%;
  min-height: 2.6rem;
  padding: 0 0.85rem;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.875rem;
  color: #0f172a;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.st-input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.15);
}

.st-input:disabled {
  background: #f8fafc;
  color: #64748b;
}

.st-input[aria-invalid='true'] {
  border-color: #b42318;
}

.st-affix {
  position: relative;
  display: flex;
  align-items: center;
}

.st-affix__prefix {
  position: absolute;
  left: 0.85rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: #64748b;
  pointer-events: none;
}

.st-affix .st-input {
  padding-left: 2.2rem;
  font-variant-numeric: tabular-nums;
}

/* Search */
.st-search {
  position: relative;
  display: block;
  max-width: 24rem;
}

.st-search .pi {
  position: absolute;
  left: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8rem;
  color: #94a3b8;
  pointer-events: none;
}

.st-search input {
  width: 100%;
  height: 2.4rem;
  padding: 0 0.9rem 0 2.2rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #f8fafc;
  font: inherit;
  font-size: 0.84rem;
  color: #0f172a;
}

.st-search input:focus {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  background: #fff;
}

/* Lists (residents, providers) */
.st-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 26rem;
  overflow-y: auto;
  border: 1px solid rgba(15, 23, 42, 0.07);
  border-radius: 14px;
}

.st-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
}

.st-row + .st-row {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.st-row__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.st-row__text strong {
  font-size: 0.875rem;
  font-weight: 650;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.st-row__text span {
  font-size: 0.75rem;
  color: #6e6e73;
}

/* Switch-like toggle (billFromNextMonth) */
.st-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.8rem 0.35rem 0.4rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.st-toggle:hover:not(:disabled) {
  background: #f8fafc;
}

.st-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.st-toggle[aria-pressed='true'] {
  background: #e8eefc;
  border-color: transparent;
  color: #1e3a8a;
}

.st-toggle__track {
  position: relative;
  width: 1.9rem;
  height: 1.1rem;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.st-toggle__knob {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}

.st-toggle[aria-pressed='true'] .st-toggle__track {
  background: #1e3a8a;
}

.st-toggle[aria-pressed='true'] .st-toggle__knob {
  transform: translateX(0.8rem);
}

/* Empty state */
.st-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 1.75rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.st-empty__icon {
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  background: #fff;
  color: #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05rem;
}

.st-empty__text {
  margin: 0;
  max-width: 28rem;
  font-size: 0.85rem;
  line-height: 1.45;
  color: #475569;
}

/* Plan summary tiles */
.st-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.st-stat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0.95rem 1.05rem 1rem;
  border-radius: 16px;
  background: var(--stat-bg, #f1f5f9);
}

.st-stat--blue { --stat-bg: #e8eefc; }
.st-stat--green { --stat-bg: #e3f4e8; }
.st-stat--amber { --stat-bg: #fdf3dc; }
.st-stat--red { --stat-bg: #fde4e4; }

.st-stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.st-stat__label {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: #475569;
}

.st-stat__icon {
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.85rem;
  background: #fff;
}

.st-stat__icon--blue { color: #1e3a8a; }
.st-stat__icon--green { color: #15803d; }
.st-stat__icon--amber { color: #b45309; }
.st-stat__icon--red { color: #b42318; }

.st-stat__value {
  margin: 0 0 0.35rem;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.st-stat__value--sm {
  font-size: 1.1rem;
  letter-spacing: -0.02em;
}

.st-stat__hint {
  margin: auto 0 0;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
  color: #6e6e73;
}

.st-meter {
  height: 0.4rem;
  margin: 0.1rem 0 0.5rem;
  border-radius: 999px;
  background: #fff;
  overflow: hidden;
}

.st-meter__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #15803d;
  transition: width 0.2s ease;
}

/* Language picker */
.st-lang {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.06);
}

.st-lang__option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.8rem 0.95rem;
  border-radius: 16px;
  border: 1px solid transparent;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.st-lang__option:hover:not(.is-active) {
  background: rgba(255, 255, 255, 0.45);
}

.st-lang__option.is-active {
  border-color: transparent;
  background: transparent;
}

.st-lang__code {
  flex-shrink: 0;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 700;
}

.st-lang__option.is-active .st-lang__code {
  background: #fff;
}

.st-lang__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.st-lang__text strong {
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
}

.st-lang__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.st-lang__check {
  flex-shrink: 0;
  font-size: 1rem;
  color: #cbd5e1;
}

.st-lang__option.is-active .st-lang__check {
  color: #1e3a8a;
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

/* ---------- Responsive ---------- */
@media (max-width: 1100px) {
  .st-layout {
    grid-template-columns: 13rem minmax(0, 1fr);
  }
  .st-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .st-stats .st-stat:last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 900px) {
  .st-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.9rem;
  }
  .st-nav {
    position: static;
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
  }
  .st-nav__list {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .st-nav__item {
    width: auto;
    padding: 0.45rem 0.9rem;
    font-size: 0.8rem;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .st-account {
    padding: 0.9rem 1rem;
  }
  .st-account__plan {
    width: 100%;
    justify-content: flex-start;
  }
  .st-card {
    padding: 1rem 0.95rem;
  }
  .st-fields,
  .st-form__grid,
  .st-stats,
  .st-lang {
    grid-template-columns: minmax(0, 1fr);
  }
  .st-stats .st-stat:last-child {
    grid-column: auto;
  }
  .st-card__foot {
    flex-direction: column;
    align-items: stretch;
  }
  .st-card__foot .st-notice {
    flex-basis: auto;
    margin-right: 0;
  }
  .st-card__foot .st-btn {
    width: 100%;
  }
  .st-banner {
    flex-wrap: wrap;
  }
  .st-banner__action {
    margin-left: auto;
  }
  .st-search {
    max-width: none;
  }
  .st-row {
    flex-wrap: wrap;
  }
  .st-row .st-toggle {
    margin-left: 3.15rem;
    white-space: normal;
    text-align: left;
  }
  .st-btn__label {
    display: none;
  }
  .st-row .st-btn--sm {
    width: 2.25rem;
    min-height: 2.25rem;
    padding: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .st-btn,
  .st-input,
  .st-toggle__track,
  .st-toggle__knob,
  .st-meter__fill {
    transition: none;
  }
}
</style>
