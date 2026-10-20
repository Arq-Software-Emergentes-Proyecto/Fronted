<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import {
  fixedPayoutRecipientsApi,
  addDaysYMD,
  compareYMD,
  formatLocalYYYYMMDD,
} from '@/finances/infrastructure/fixedPayoutRecipientsApi.js'
import { adminManagementExpensesApi } from '@/finances/infrastructure/adminManagementExpensesApi.js'
import { sharedUtilityServicesApi } from '@/finances/infrastructure/sharedUtilityServicesApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'
import { financesApi } from '@/finances/infrastructure/financesApi.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'

const { t, locale } = useI18n()
const { state, loadData } = useFinancesStore()

const expenses = ref([])
const costsLoading = ref(false)
const costsLoadError = ref('')

const sharedServices = ref([])
const servicesLoading = ref(false)
const servicesLoadError = ref('')

const fixedRecipients = ref([])
const fixedLoading = ref(false)
const fixedLoadError = ref('')

const modalOpen = ref(false)
const saving = ref(false)
const submitError = ref('')
const processingPhoto = ref(false)

const serviceModalOpen = ref(false)
const serviceSaving = ref(false)
const serviceSubmitError = ref('')

const fixedModalOpen = ref(false)
const fixedSaving = ref(false)
const fixedSubmitError = ref('')
const fixedProcessingPhoto = ref(false)

const form = reactive({
  name: '',
  amount: null,
  purchaseDate: '',
  invoicePhotoUrl: '',
})

// US030 "Registro con monto inválido": campo en rojo + mensaje bajo el campo.
const fieldErrors = reactive({ name: '', amount: '', purchaseDate: '' })

function clearFieldErrors() {
  fieldErrors.name = ''
  fieldErrors.amount = ''
  fieldErrors.purchaseDate = ''
}

watch(() => form.name, () => { fieldErrors.name = '' })
watch(() => form.amount, () => { fieldErrors.amount = '' })
watch(() => form.purchaseDate, () => { fieldErrors.purchaseDate = '' })

// RF030: balance neto del mes seleccionado (ingresos − egresos), calculado en el servidor.
function currentMonthInput() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const balanceMonth = ref(currentMonthInput())
const monthBalance = ref({ month: '', income: 0, expenses: 0, net: 0 })
const balanceLoading = ref(false)
const balanceError = ref('')

function monthKeyOf(value) {
  const raw = String(value ?? '').trim()
  return raw.length >= 7 ? raw.slice(0, 7) : ''
}

/** Respaldo local (modo demo sin backend): mismo criterio que el gráfico Ingresos vs Egresos. */
function localMonthBalance(month) {
  const income = state.receipts
    .filter((r) => r.status === 'Paid' && monthKeyOf(r.issueDate) === month)
    .reduce((sum, r) => sum + receiptTotalPaid(r), 0)
  const spent = expenses.value
    .filter((e) => monthKeyOf(e.purchaseDate) === month)
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
  return { month, income, expenses: spent, net: income - spent }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
/** Request sequence: only the latest month request may update the card. */
let balanceSeq = 0
let balanceDebounce = 0

async function loadMonthBalance() {
  const raw = String(balanceMonth.value ?? '').trim()
  // An empty picker means "current month"; anything else must be a real YYYY-MM.
  const month = raw ? raw : currentMonthInput()
  const seq = ++balanceSeq
  if (!MONTH_RE.test(month)) {
    balanceLoading.value = false
    balanceError.value = t('financeOps.netBalanceMonthInvalid')
    return
  }
  balanceLoading.value = true
  balanceError.value = ''
  try {
    const result = await financesApi.getMonthlyBalance(month)
    if (seq !== balanceSeq) return
    monthBalance.value = result
  } catch {
    if (seq !== balanceSeq) return
    if (OPEN_WIREFRAME_ACCESS) {
      // Demo without backend: same criterion as the Income vs Expenses chart.
      monthBalance.value = localMonthBalance(month)
    } else {
      monthBalance.value = { month, income: 0, expenses: 0, net: 0 }
      balanceError.value = t('financeOps.netBalanceLoadError')
    }
  } finally {
    if (seq === balanceSeq) balanceLoading.value = false
  }
}

watch(balanceMonth, () => {
  if (balanceDebounce) window.clearTimeout(balanceDebounce)
  balanceDebounce = window.setTimeout(() => {
    balanceDebounce = 0
    void loadMonthBalance()
  }, 300)
})
onBeforeUnmount(() => {
  if (balanceDebounce) window.clearTimeout(balanceDebounce)
  balanceDebounce = 0
  balanceSeq += 1
})

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

/** Month the page is looking at, always a valid YYYY-MM (falls back to the current month). */
const selectedMonthKey = computed(() => {
  const key = monthKeyOf(balanceMonth.value)
  return MONTH_RE.test(key) ? key : currentMonthInput()
})

/** Month stepper (replaces the native month input, which renders in the browser's language). */
function shiftBalanceMonth(delta) {
  const [y, m] = selectedMonthKey.value.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  balanceMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Localized month name for use mid-sentence ("octubre de 2026" / "October 2026"). */
const balanceMonthText = computed(() => {
  const [y, m] = selectedMonthKey.value.split('-').map(Number)
  if (!y || !m) return ''
  return new Date(y, m - 1, 1).toLocaleDateString(intlLocale.value, {
    month: 'long',
    year: 'numeric',
  })
})

/** Same label capitalized, for the stepper ("Octubre de 2026"). */
const balanceMonthLabel = computed(() => {
  const label = balanceMonthText.value
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
})

const serviceForm = reactive({
  type: 'water',
  amount: null,
})

const fixedForm = reactive({
  name: '',
  dni: '',
  phone: '',
  salary: null,
  intervalDays: 30,
  photoUrl: '',
})

const serviceTypeOptions = computed(() => [
  { label: t('sharedServices.typeWater'), value: 'water' },
  { label: t('sharedServices.typeElectricity'), value: 'electricity' },
])

const MAX_IMAGE_DIMENSION = 1024
const IMAGE_OUTPUT_QUALITY = 0.82

function receiptTotalPaid(r) {
  if (!r || r.status !== 'Paid') return 0
  if (typeof r.getTotalAmount === 'function') {
    return Number(r.getTotalAmount()) || 0
  }
  return (Number(r.amount) || 0) + (Number(r.lateFee) || 0)
}

const grossCollected = computed(() =>
  state.receipts.reduce((sum, r) => sum + receiptTotalPaid(r), 0),
)

const totalCosts = computed(() =>
  expenses.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
)

const totalFixedPaid = computed(() =>
  fixedRecipients.value.reduce((sum, r) => {
    const hist = Array.isArray(r.paymentHistory) ? r.paymentHistory : []
    return sum + hist.reduce((s, h) => s + (Number(h.amount) || 0), 0)
  }, 0),
)

const balanceAfterAll = computed(
  () => grossCollected.value - totalCosts.value - totalFixedPaid.value,
)

const fixedHistoryRows = computed(() => {
  const rows = []
  for (const r of fixedRecipients.value) {
    for (const h of r.paymentHistory || []) {
      rows.push({
        rowKey: `${r.id}_${h.id}`,
        paidOn: h.paidOn,
        amount: Number(h.amount) || 0,
        recipientName: r.name,
      })
    }
  }
  rows.sort((a, b) => compareYMD(String(b.paidOn), String(a.paidOn)))
  return rows
})

const previewFirstFixedDue = computed(() => {
  const n =
    fixedForm.intervalDays === null ||
    fixedForm.intervalDays === undefined ||
    fixedForm.intervalDays === ''
      ? Number.NaN
      : Number(fixedForm.intervalDays)
  if (!Number.isFinite(n)) return ''
  const days = Math.max(1, Math.floor(n))
  return addDaysYMD(formatLocalYYYYMMDD(), days)
})

const nfCurrency = computed(
  () => (value) =>
    new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: 'PEN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(value) ? value : 0),
)

const nfDate = computed(
  () => (isoOrYmd) => {
    const s = String(isoOrYmd ?? '').trim()
    if (!s) return '—'
    const d =
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s)
    if (!Number.isFinite(d.getTime())) return s
    // "7 oct. 2026" / "Oct 7, 2026"
    return new Intl.DateTimeFormat(intlLocale.value, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d)
  },
)

/* ---------- Presentation helpers (tabs, lists) ---------- */

const activeTab = ref('expenses')
const TAB_KEYS = ['expenses', 'services', 'fixed']

const tabs = computed(() => [
  { key: 'expenses', label: t('collectionsMgmt.tabExpenses'), count: expenses.value.length },
  { key: 'services', label: t('collectionsMgmt.tabServices'), count: sharedServices.value.length },
  { key: 'fixed', label: t('collectionsMgmt.tabFixed'), count: fixedRecipients.value.length },
])

function selectTab(key) {
  activeTab.value = key
}

/** WAI-ARIA tabs: arrows move between tabs, Home/End jump to the ends. */
function onTabKeydown(event) {
  const idx = TAB_KEYS.indexOf(activeTab.value)
  let next = -1
  if (event.key === 'ArrowRight') next = (idx + 1) % TAB_KEYS.length
  else if (event.key === 'ArrowLeft') next = (idx - 1 + TAB_KEYS.length) % TAB_KEYS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TAB_KEYS.length - 1
  if (next < 0) return
  event.preventDefault()
  activeTab.value = TAB_KEYS[next]
  document.getElementById(`cme-tab-${TAB_KEYS[next]}`)?.focus()
}

/** Expenses tab: only the selected month by default, so its total matches "Gastos del mes". */
const expensesOnlyMonth = ref(true)

const sortedExpenses = computed(() =>
  [...expenses.value].sort((a, b) =>
    String(b.purchaseDate ?? '').localeCompare(String(a.purchaseDate ?? '')),
  ),
)

const visibleExpenses = computed(() =>
  expensesOnlyMonth.value
    ? sortedExpenses.value.filter((e) => monthKeyOf(e.purchaseDate) === selectedMonthKey.value)
    : sortedExpenses.value,
)

const visibleExpensesTotal = computed(() =>
  visibleExpenses.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
)

function serviceSplitText(row) {
  const total = nfCurrency.value(Number(row.amount) || 0)
  const count = Number(row.residentCount) || 0
  if (count <= 0) return t('collectionsMgmt.serviceNoUnits', { total })
  const share = nfCurrency.value(Number(row.perResidentShare) || 0)
  return t('collectionsMgmt.serviceSplit', { total, share, count }, count)
}

function intervalDaysOf(row) {
  return Math.max(1, Math.floor(Number(row?.intervalDays) || 0))
}

function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0].charAt(0)
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''
  return `${first}${last}`.toUpperCase()
}

const historyOpen = ref(false)

const fixedHistoryTotal = computed(() =>
  fixedHistoryRows.value.reduce((sum, h) => sum + (Number(h.amount) || 0), 0),
)

function refreshAll() {
  loadData()
  loadCosts()
  loadSharedServices()
  loadFixedRecipients()
  void loadMonthBalance()
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'))
    reader.readAsDataURL(file)
  })
}

async function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('IMAGE_DECODE_ERROR'))
    img.src = dataUrl
  })
}

async function processImageFile(file) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('IMAGE_INVALID')
  }
  const originalDataUrl = await readFileAsDataUrl(file)
  const img = await loadImageElement(originalDataUrl)

  const ratio = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1),
  )
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * ratio))
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('IMAGE_CANVAS_ERROR')
  context.drawImage(img, 0, 0, width, height)
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return canvas.toDataURL(mime, IMAGE_OUTPUT_QUALITY)
}

async function loadCosts() {
  costsLoading.value = true
  costsLoadError.value = ''
  try {
    expenses.value = await adminManagementExpensesApi.list()
  } catch {
    costsLoadError.value = t('collectionsMgmt.loadCostsError')
    expenses.value = []
  } finally {
    costsLoading.value = false
  }
}

function serviceTypeLabel(type) {
  if (type === 'water') return t('sharedServices.typeWater')
  if (type === 'electricity') return t('sharedServices.typeElectricity')
  return String(type ?? '—')
}

async function loadSharedServices() {
  servicesLoading.value = true
  servicesLoadError.value = ''
  try {
    sharedServices.value = await sharedUtilityServicesApi.list()
  } catch {
    servicesLoadError.value = t('sharedServices.loadError')
    sharedServices.value = []
  } finally {
    servicesLoading.value = false
  }
}

async function loadFixedRecipients() {
  fixedLoading.value = true
  fixedLoadError.value = ''
  try {
    fixedRecipients.value = await fixedPayoutRecipientsApi.listWithDueApplied()
  } catch {
    fixedLoadError.value = t('fixedPay.loadError')
    fixedRecipients.value = []
  } finally {
    fixedLoading.value = false
  }
}

function resetForm() {
  form.name = ''
  form.amount = null
  // Most expenses are recorded the day they happen: start from today (still editable).
  form.purchaseDate = formatLocalYYYYMMDD()
  form.invoicePhotoUrl = ''
  submitError.value = ''
  clearFieldErrors()
}

function openModal() {
  resetForm()
  modalOpen.value = true
}

function closeModal() {
  modalOpen.value = false
}

function resetFixedForm() {
  fixedForm.name = ''
  fixedForm.dni = ''
  fixedForm.phone = ''
  fixedForm.salary = null
  fixedForm.intervalDays = 30
  fixedForm.photoUrl = ''
  fixedSubmitError.value = ''
}

function resetServiceForm() {
  serviceForm.type = 'water'
  serviceForm.amount = null
  serviceSubmitError.value = ''
}

function openServiceModal() {
  resetServiceForm()
  serviceModalOpen.value = true
}

function closeServiceModal() {
  serviceModalOpen.value = false
}

function openFixedModal() {
  resetFixedForm()
  fixedModalOpen.value = true
}

function closeFixedModal() {
  fixedModalOpen.value = false
}

async function onInvoiceChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  processingPhoto.value = true
  submitError.value = ''
  try {
    form.invoicePhotoUrl = await processImageFile(file)
  } catch {
    submitError.value = t('collectionsMgmt.invoiceInvalid')
    form.invoicePhotoUrl = ''
  } finally {
    processingPhoto.value = false
  }
}

async function onFixedPhotoChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  fixedProcessingPhoto.value = true
  fixedSubmitError.value = ''
  try {
    fixedForm.photoUrl = await processImageFile(file)
  } catch {
    fixedSubmitError.value = t('fixedPay.photoInvalid')
    fixedForm.photoUrl = ''
  } finally {
    fixedProcessingPhoto.value = false
  }
}

async function submitCost(event) {
  if (saving.value) return
  submitError.value = ''

  const amt =
    form.amount === null || form.amount === undefined || form.amount === ''
      ? Number.NaN
      : Number(form.amount)

  clearFieldErrors()
  if (!form.name.trim()) fieldErrors.name = t('financeOps.expenseNameRequired')
  if (!Number.isFinite(amt) || amt <= 0) fieldErrors.amount = t('financeOps.expenseAmountInvalid')
  if (!String(form.purchaseDate).trim()) fieldErrors.purchaseDate = t('financeOps.expenseDateRequired')
  if (fieldErrors.name || fieldErrors.amount || fieldErrors.purchaseDate) {
    submitError.value = t('collectionsMgmt.requiredCostFields')
    return
  }

  saving.value = true
  try {
    const created = await adminManagementExpensesApi.add({
      name: form.name,
      amount: amt,
      purchaseDate: form.purchaseDate,
      invoicePhotoUrl: form.invoicePhotoUrl,
    })
    await confirmSuccess(event, t('feedback.expenseAdded'))
    closeModal()
    // The header buttons open these dialogs from any tab: show the list the new item is in.
    selectTab('expenses')
    await loadCosts()
    markFresh('expense', created?.id)
    await loadMonthBalance()
  } catch (err) {
    const field = err?.field || err?.payload?.field
    if (err?.code === 'ADMIN_EXPENSE_AMOUNT_INVALID' || field === 'amount') {
      fieldErrors.amount = t('financeOps.expenseAmountInvalid')
      submitError.value = t('collectionsMgmt.requiredCostFields')
    } else if (err?.code === 'ADMIN_EXPENSE_NAME_REQUIRED' || field === 'name') {
      fieldErrors.name = t('financeOps.expenseNameRequired')
      submitError.value = t('collectionsMgmt.requiredCostFields')
    } else if (err?.code === 'ADMIN_EXPENSE_DATE_INVALID' || field === 'purchaseDate') {
      fieldErrors.purchaseDate = t('financeOps.expenseDateRequired')
      submitError.value = t('collectionsMgmt.requiredCostFields')
    } else if (err?.code === 'ADMIN_EXPENSE_FIELDS_REQUIRED') {
      submitError.value = t('collectionsMgmt.requiredCostFields')
    } else {
      submitError.value = t('collectionsMgmt.saveCostError')
    }
  } finally {
    saving.value = false
  }
}

async function submitSharedService(event) {
  if (serviceSaving.value) return
  serviceSubmitError.value = ''

  const amt =
    serviceForm.amount === null || serviceForm.amount === undefined || serviceForm.amount === ''
      ? Number.NaN
      : Number(serviceForm.amount)

  if (!serviceForm.type || !Number.isFinite(amt) || amt < 0) {
    serviceSubmitError.value = t('sharedServices.requiredFields')
    return
  }

  serviceSaving.value = true
  try {
    const created = await sharedUtilityServicesApi.add({
      type: serviceForm.type,
      amount: amt,
    })
    await confirmSuccess(event, t('feedback.sharedServiceAdded'))
    closeServiceModal()
    selectTab('services')
    await Promise.all([loadSharedServices(), loadData()])
    markFresh('sharedService', created?.id)
  } catch (err) {
    if (err?.code === 'SHARED_SERVICE_FIELDS_REQUIRED') {
      serviceSubmitError.value = t('sharedServices.requiredFields')
    } else {
      serviceSubmitError.value = t('sharedServices.saveError')
    }
  } finally {
    serviceSaving.value = false
  }
}

async function submitFixedRecipient(event) {
  if (fixedSaving.value) return
  fixedSubmitError.value = ''

  const salaryNum =
    fixedForm.salary === null || fixedForm.salary === undefined || fixedForm.salary === ''
      ? Number.NaN
      : Number(fixedForm.salary)

  const intervalRaw = Number(fixedForm.intervalDays)
  const interval = Number.isFinite(intervalRaw) ? Math.floor(intervalRaw) : Number.NaN

  if (
    !fixedForm.name.trim() ||
    !fixedForm.dni.trim() ||
    !fixedForm.phone.trim() ||
    !Number.isFinite(salaryNum) ||
    salaryNum < 0 ||
    !Number.isFinite(interval) ||
    interval < 1
  ) {
    fixedSubmitError.value = t('fixedPay.requiredFields')
    return
  }

  fixedSaving.value = true
  try {
    const created = await fixedPayoutRecipientsApi.add({
      name: fixedForm.name,
      dni: fixedForm.dni,
      phone: fixedForm.phone,
      salary: salaryNum,
      intervalDays: interval,
      photoUrl: fixedForm.photoUrl,
    })
    await confirmSuccess(event, t('feedback.fixedPayoutAdded'))
    closeFixedModal()
    selectTab('fixed')
    await loadFixedRecipients()
    markFresh('fixedPayout', created?.id)
  } catch (err) {
    if (err?.code === 'FIXED_PAYOUT_FIELDS_REQUIRED') {
      fixedSubmitError.value = t('fixedPay.requiredFields')
    } else {
      fixedSubmitError.value = t('fixedPay.saveError')
    }
  } finally {
    fixedSaving.value = false
  }
}

const pendingDelete = ref(null)
const deleting = ref(false)

function deleteCandidateLabel(item) {
  if (!item) return ''
  if (item.kind === 'expense') return String(item.row?.name ?? '')
  if (item.kind === 'fixed') return String(item.row?.name ?? '')
  if (item.kind === 'service') return serviceTypeLabel(item.row?.type)
  return ''
}

function askDelete(kind, row) {
  pendingDelete.value = { kind, row }
}

function closeDelete() {
  if (deleting.value) return
  pendingDelete.value = null
}

async function confirmDelete() {
  const current = pendingDelete.value
  if (!current || deleting.value) return

  deleting.value = true
  try {
    if (current.kind === 'expense') {
      await adminManagementExpensesApi.remove(current.row.id)
      await loadCosts()
      await loadMonthBalance()
    } else if (current.kind === 'service') {
      await sharedUtilityServicesApi.remove(current.row.id)
      await Promise.all([loadSharedServices(), loadData()])
    } else if (current.kind === 'fixed') {
      await fixedPayoutRecipientsApi.remove(current.row.id)
      await loadFixedRecipients()
    }
    pendingDelete.value = null
  } catch {
    if (current.kind === 'expense') costsLoadError.value = t('collectionsMgmt.deleteError')
    else if (current.kind === 'service') servicesLoadError.value = t('sharedServices.deleteError')
    else fixedLoadError.value = t('fixedPay.deleteError')
  } finally {
    deleting.value = false
  }
}

onMounted(async () => {
  loadData()
  loadSharedServices()
  loadFixedRecipients()
  await loadCosts()
  await loadMonthBalance()
})
</script>

<template>
  <div class="app-view cme">
    <header class="cme-head">
      <h1 class="bf-sr-only">{{ t('collectionsMgmt.pageTitle') }}</h1>
      <div class="cme-head__controls">
        <div class="cme-head__nav">
          <div class="cme-month" role="group" :aria-label="t('collectionsMgmt.monthSelectorLabel')">
            <button
              type="button"
              class="cme-month__step"
              :aria-label="t('financeAdmin.monthPrev')"
              :title="t('financeAdmin.monthPrev')"
              @click="shiftBalanceMonth(-1)"
            >
              <i class="pi pi-chevron-left" aria-hidden="true" />
            </button>
            <span class="cme-month__label" aria-live="polite">
              <i class="pi pi-calendar" aria-hidden="true" />
              {{ balanceMonthLabel }}
            </span>
            <button
              type="button"
              class="cme-month__step"
              :aria-label="t('financeAdmin.monthNext')"
              :title="t('financeAdmin.monthNext')"
              @click="shiftBalanceMonth(1)"
            >
              <i class="pi pi-chevron-right" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="cme-icon-btn"
            :aria-label="t('collectionsMgmt.refresh')"
            :title="t('collectionsMgmt.refresh')"
            :disabled="state.isLoading"
            @click="refreshAll"
          >
            <i class="pi" :class="state.isLoading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
          </button>
        </div>
        <div class="cme-head__actions" role="group" :aria-label="t('collectionsMgmt.headerActions')">
          <button type="button" class="cme-btn" @click="openServiceModal">
            <i class="pi pi-bolt" aria-hidden="true" />
            {{ t('sharedServices.addService') }}
          </button>
          <button type="button" class="cme-btn" @click="openFixedModal">
            <i class="pi pi-user-plus" aria-hidden="true" />
            {{ t('collectionsMgmt.addFixedPayout') }}
          </button>
          <button type="button" class="cme-btn cme-btn--primary" @click="openModal">
            <i class="pi pi-plus" aria-hidden="true" />
            {{ t('collectionsMgmt.registerExpense') }}
          </button>
        </div>
      </div>
    </header>

    <p v-if="state.isLoading && !state.receipts.length" class="cme-status" role="status">
      {{ t('collectionsMgmt.loading') }}
    </p>
    <LoadErrorRetry
      v-else-if="state.error"
      :message="t('collectionsMgmt.loadError')"
      :loading="state.isLoading"
      @retry="refreshAll"
    />

    <template v-else>
      <!-- 1. Month summary: income − expenses = balance -->
      <section class="cme-summary" aria-labelledby="cme-summary-title" :aria-busy="balanceLoading ? 'true' : 'false'">
        <div class="cme-section-head">
          <h2 id="cme-summary-title" class="cme-section-title">
            {{ t('collectionsMgmt.summaryTitle', { month: balanceMonthText }) }}
          </h2>
          <p class="cme-section-hint">{{ t('collectionsMgmt.summaryHint') }}</p>
        </div>

        <div class="cme-eq">
          <article class="cme-stat cme-stat--green">
            <div class="cme-stat__head">
              <h3 class="cme-stat__label">{{ t('collectionsMgmt.incomeLabel') }}</h3>
              <span class="cme-stat__icon cme-stat__icon--green"><i class="pi pi-arrow-down" aria-hidden="true" /></span>
            </div>
            <p class="cme-stat__value">{{ balanceLoading ? '…' : nfCurrency(monthBalance.income) }}</p>
            <p class="cme-stat__hint">{{ t('collectionsMgmt.incomeHint') }}</p>
          </article>

          <span class="cme-eq__op" role="img" :aria-label="t('collectionsMgmt.opMinus')">−</span>

          <article class="cme-stat cme-stat--orange">
            <div class="cme-stat__head">
              <h3 class="cme-stat__label">{{ t('collectionsMgmt.expensesLabel') }}</h3>
              <span class="cme-stat__icon cme-stat__icon--orange"><i class="pi pi-arrow-up" aria-hidden="true" /></span>
            </div>
            <p class="cme-stat__value">{{ balanceLoading ? '…' : nfCurrency(monthBalance.expenses) }}</p>
            <p class="cme-stat__hint">{{ t('collectionsMgmt.expensesHint') }}</p>
          </article>

          <span class="cme-eq__op" role="img" :aria-label="t('collectionsMgmt.opEquals')">=</span>

          <article class="cme-stat" :class="monthBalance.net < 0 ? 'cme-stat--red' : 'cme-stat--green'">
            <div class="cme-stat__head">
              <h3 class="cme-stat__label">{{ t('collectionsMgmt.netLabel') }}</h3>
              <span class="cme-stat__icon" :class="monthBalance.net < 0 ? 'cme-stat__icon--red' : 'cme-stat__icon--green'">
                <i class="pi" :class="monthBalance.net < 0 ? 'pi-arrow-down-right' : 'pi-check'" aria-hidden="true" />
              </span>
            </div>
            <p
              class="cme-stat__value"
              :class="{ 'is-negative': monthBalance.net < 0 }"
              aria-live="polite"
            >
              {{ balanceLoading ? '…' : nfCurrency(monthBalance.net) }}
            </p>
            <p class="cme-stat__hint">
              {{ monthBalance.net < 0 ? t('collectionsMgmt.netHintNegative') : t('collectionsMgmt.netHintPositive') }}
            </p>
          </article>
        </div>
        <p v-if="balanceError" class="cme-inline-error" role="alert">{{ balanceError }}</p>
      </section>

      <!-- 2. All-time cash balance -->
      <section class="cme-cash" aria-labelledby="cme-cash-title">
        <div class="cme-cash__main">
          <span class="cme-cash__icon"><i class="pi pi-wallet" aria-hidden="true" /></span>
          <div class="cme-cash__text">
            <div class="cme-cash__title-row">
              <h2 id="cme-cash-title" class="cme-cash__title">{{ t('collectionsMgmt.cashTitle') }}</h2>
              <span class="cme-pill">{{ t('collectionsMgmt.cashBadge') }}</span>
            </div>
            <p class="cme-cash__hint">{{ t('collectionsMgmt.cashHint') }}</p>
          </div>
        </div>
        <ul class="cme-cash__parts" :title="t('collectionsMgmt.amountHint')">
          <li>{{ t('collectionsMgmt.cashCollected', { amount: nfCurrency(grossCollected) }) }}</li>
          <li>{{ t('collectionsMgmt.cashExpenses', { amount: nfCurrency(totalCosts) }) }}</li>
          <li>{{ t('collectionsMgmt.cashFixed', { amount: nfCurrency(totalFixedPaid) }) }}</li>
        </ul>
        <p class="cme-cash__value" :class="{ 'is-negative': balanceAfterAll < 0 }">
          {{ nfCurrency(balanceAfterAll) }}
        </p>
      </section>

      <!-- 3. Records: expenses · shared utilities · fixed payouts -->
      <section class="cme-card">
        <div class="cme-tabs" v-bf-seg role="tablist" :aria-label="t('collectionsMgmt.tabsLabel')">
          <button
            v-for="tab in tabs"
            :id="`cme-tab-${tab.key}`"
            :key="tab.key"
            type="button"
            role="tab"
            class="cme-tab"
            :class="{ 'is-active': activeTab === tab.key }"
            :aria-selected="activeTab === tab.key ? 'true' : 'false'"
            :aria-controls="`cme-panel-${tab.key}`"
            :tabindex="activeTab === tab.key ? 0 : -1"
            @click="selectTab(tab.key)"
            @keydown="onTabKeydown"
          >
            {{ tab.label }}
            <span class="cme-tab__count">{{ tab.count }}</span>
          </button>
        </div>

        <!-- Expenses -->
        <div
          v-show="activeTab === 'expenses'"
          id="cme-panel-expenses"
          class="cme-panel"
          role="tabpanel"
          aria-labelledby="cme-tab-expenses"
          tabindex="0"
        >
          <div class="cme-panel__bar">
            <p class="cme-panel__intro">{{ t('collectionsMgmt.expensesIntro') }}</p>
            <div class="cme-panel__tools">
              <button
                type="button"
                class="cme-toggle"
                :aria-pressed="expensesOnlyMonth ? 'true' : 'false'"
                @click="expensesOnlyMonth = !expensesOnlyMonth"
              >
                <span class="cme-toggle__track" aria-hidden="true"><span class="cme-toggle__knob" /></span>
                {{ t('collectionsMgmt.onlyMonth', { month: balanceMonthText }) }}
              </button>
              <span v-if="visibleExpenses.length" class="cme-total">
                {{
                  expensesOnlyMonth
                    ? t('collectionsMgmt.totalMonth', { month: balanceMonthText, amount: nfCurrency(visibleExpensesTotal) })
                    : t('collectionsMgmt.totalAll', { amount: nfCurrency(visibleExpensesTotal) })
                }}
              </span>
            </div>
          </div>

          <p v-if="costsLoading && !costsLoadError" class="cme-status">{{ t('collectionsMgmt.loading') }}</p>

          <div v-if="visibleExpenses.length" class="cme-table-wrap">
            <table class="cme-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('collectionsMgmt.colExpense') }}</th>
                  <th scope="col">{{ t('collectionsMgmt.tableDate') }}</th>
                  <th scope="col" class="is-num">{{ t('collectionsMgmt.tableAmount') }}</th>
                  <th scope="col" class="is-actions">
                    <span class="visually-hidden">{{ t('collectionsMgmt.colActions') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleExpenses" :key="row.id" :class="{ 'bf-fresh': isFresh('expense', row.id) }">
                  <td class="c-main">
                    <div class="cme-item">
                      <img
                        v-if="row.invoicePhotoUrl"
                        :src="row.invoicePhotoUrl"
                        :alt="row.name"
                        class="cme-thumb"
                        width="40"
                        height="40"
                      />
                      <span v-else class="cme-thumb cme-thumb--empty" aria-hidden="true">
                        <i class="pi pi-receipt" />
                      </span>
                      <div class="cme-item__text">
                        <strong>{{ row.name }}</strong>
                        <small v-if="!row.invoicePhotoUrl">{{ t('collectionsMgmt.noInvoice') }}</small>
                      </div>
                    </div>
                  </td>
                  <td :data-label="t('collectionsMgmt.tableDate')">{{ nfDate(row.purchaseDate) }}</td>
                  <td class="is-num" :data-label="t('collectionsMgmt.tableAmount')">
                    <strong class="cme-amount">{{ nfCurrency(Number(row.amount) || 0) }}</strong>
                  </td>
                  <td class="c-actions">
                    <button
                      type="button"
                      class="cme-action cme-action--danger"
                      :aria-label="t('collectionsMgmt.deleteExpenseAria', { name: row.name })"
                      :data-tip="t('app.deleteAction')"
                      @click="askDelete('expense', row)"
                    >
                      <i class="pi pi-trash" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="!costsLoading" class="cme-empty">
            <span class="cme-empty__icon"><i class="pi pi-receipt" aria-hidden="true" /></span>
            <p class="cme-empty__text">
              {{
                expensesOnlyMonth && expenses.length
                  ? t('collectionsMgmt.emptyExpensesMonth', { month: balanceMonthText })
                  : t('collectionsMgmt.emptyExpensesAll')
              }}
            </p>
            <div class="cme-empty__actions">
              <button
                v-if="expensesOnlyMonth && expenses.length"
                type="button"
                class="cme-btn"
                @click="expensesOnlyMonth = false"
              >
                {{ t('collectionsMgmt.showAllExpenses') }}
              </button>
              <button type="button" class="cme-btn cme-btn--primary" @click="openModal">
                <i class="pi pi-plus" aria-hidden="true" />
                {{ t('collectionsMgmt.registerExpense') }}
              </button>
            </div>
          </div>

          <LoadErrorRetry
            v-if="costsLoadError"
            compact
            :message="costsLoadError"
            :loading="costsLoading"
            @retry="loadCosts"
          />
        </div>

        <!-- Shared utilities -->
        <div
          v-show="activeTab === 'services'"
          id="cme-panel-services"
          class="cme-panel"
          role="tabpanel"
          aria-labelledby="cme-tab-services"
          tabindex="0"
        >
          <div class="cme-panel__bar">
            <p class="cme-panel__intro">{{ t('sharedServices.splitHint') }}</p>
          </div>

          <p v-if="servicesLoading && !servicesLoadError" class="cme-status">{{ t('collectionsMgmt.loading') }}</p>

          <div v-if="sharedServices.length" class="cme-table-wrap">
            <table class="cme-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('sharedServices.tableType') }}</th>
                  <th scope="col">{{ t('collectionsMgmt.colSplit') }}</th>
                  <th scope="col" class="is-actions">
                    <span class="visually-hidden">{{ t('collectionsMgmt.colActions') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in sharedServices" :key="row.id" :class="{ 'bf-fresh': isFresh('sharedService', row.id) }">
                  <td class="c-main">
                    <div class="cme-item">
                      <span
                        class="cme-thumb cme-thumb--icon"
                        :class="row.type === 'electricity' ? 'is-amber' : 'is-blue'"
                        aria-hidden="true"
                      >
                        <i class="pi" :class="row.type === 'electricity' ? 'pi-bolt' : 'pi-cloud'" />
                      </span>
                      <div class="cme-item__text">
                        <strong>{{ serviceTypeLabel(row.type) }}</strong>
                        <small>{{ t('collectionsMgmt.serviceAddedToBills') }}</small>
                      </div>
                    </div>
                  </td>
                  <td class="c-wide" :data-label="t('collectionsMgmt.colSplit')">{{ serviceSplitText(row) }}</td>
                  <td class="c-actions">
                    <button
                      type="button"
                      class="cme-action cme-action--danger"
                      :aria-label="t('collectionsMgmt.deleteServiceAria', { name: serviceTypeLabel(row.type) })"
                      :data-tip="t('app.deleteAction')"
                      @click="askDelete('service', row)"
                    >
                      <i class="pi pi-trash" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="!servicesLoading" class="cme-empty">
            <span class="cme-empty__icon"><i class="pi pi-bolt" aria-hidden="true" /></span>
            <p class="cme-empty__text">{{ t('sharedServices.emptyServices') }}</p>
            <div class="cme-empty__actions">
              <button type="button" class="cme-btn cme-btn--primary" @click="openServiceModal">
                <i class="pi pi-plus" aria-hidden="true" />
                {{ t('sharedServices.addService') }}
              </button>
            </div>
          </div>

          <LoadErrorRetry
            v-if="servicesLoadError"
            compact
            :message="servicesLoadError"
            :loading="servicesLoading"
            @retry="loadSharedServices"
          />
        </div>

        <!-- Fixed payouts -->
        <div
          v-show="activeTab === 'fixed'"
          id="cme-panel-fixed"
          class="cme-panel"
          role="tabpanel"
          aria-labelledby="cme-tab-fixed"
          tabindex="0"
        >
          <div class="cme-panel__bar">
            <p class="cme-panel__intro">{{ t('collectionsMgmt.fixedIntro') }}</p>
          </div>

          <p v-if="fixedLoading && !fixedLoadError" class="cme-status">{{ t('collectionsMgmt.loading') }}</p>

          <div v-if="fixedRecipients.length" class="cme-table-wrap">
            <table class="cme-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('collectionsMgmt.colPerson') }}</th>
                  <th scope="col" class="is-num">{{ t('collectionsMgmt.tableAmount') }}</th>
                  <th scope="col">{{ t('collectionsMgmt.colFrequency') }}</th>
                  <th scope="col">{{ t('collectionsMgmt.colNextPayout') }}</th>
                  <th scope="col" class="is-actions">
                    <span class="visually-hidden">{{ t('collectionsMgmt.colActions') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in fixedRecipients" :key="row.id" :class="{ 'bf-fresh': isFresh('fixedPayout', row.id) }">
                  <td class="c-main">
                    <div class="cme-item">
                      <img
                        v-if="row.photoUrl"
                        :src="row.photoUrl"
                        :alt="row.name"
                        class="cme-avatar cme-avatar--photo"
                        width="40"
                        height="40"
                      />
                      <span v-else class="cme-avatar" aria-hidden="true">{{ initialsOf(row.name) }}</span>
                      <div class="cme-item__text">
                        <strong>{{ row.name }}</strong>
                        <small>{{ t('collectionsMgmt.dniPhone', { dni: row.dni || '—', phone: row.phone || '—' }) }}</small>
                      </div>
                    </div>
                  </td>
                  <td class="is-num" :data-label="t('collectionsMgmt.tableAmount')">
                    <strong class="cme-amount">{{ nfCurrency(Number(row.salary) || 0) }}</strong>
                  </td>
                  <td :data-label="t('collectionsMgmt.colFrequency')">
                    <span class="cme-pill cme-pill--soft">
                      {{ t('collectionsMgmt.everyDays', { n: intervalDaysOf(row) }, intervalDaysOf(row)) }}
                    </span>
                  </td>
                  <td :data-label="t('collectionsMgmt.colNextPayout')">{{ nfDate(row.nextPaymentDate) }}</td>
                  <td class="c-actions">
                    <button
                      type="button"
                      class="cme-action cme-action--danger"
                      :aria-label="t('collectionsMgmt.deleteFixedAria', { name: row.name })"
                      :data-tip="t('app.deleteAction')"
                      @click="askDelete('fixed', row)"
                    >
                      <i class="pi pi-trash" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="!fixedLoading" class="cme-empty">
            <span class="cme-empty__icon"><i class="pi pi-users" aria-hidden="true" /></span>
            <p class="cme-empty__text">{{ t('fixedPay.emptyRecipients') }}</p>
            <div class="cme-empty__actions">
              <button type="button" class="cme-btn cme-btn--primary" @click="openFixedModal">
                <i class="pi pi-plus" aria-hidden="true" />
                {{ t('collectionsMgmt.addFixedPayout') }}
              </button>
            </div>
          </div>

          <div class="cme-history">
            <button
              type="button"
              class="cme-history__toggle"
              :aria-expanded="historyOpen ? 'true' : 'false'"
              aria-controls="cme-history-body"
              :title="historyOpen ? t('collectionsMgmt.historyHide') : t('collectionsMgmt.historyShow')"
              @click="historyOpen = !historyOpen"
            >
              <i class="pi pi-chevron-down cme-history__chevron" :class="{ 'is-open': historyOpen }" aria-hidden="true" />
              <span class="cme-history__title">{{ t('fixedPay.historyHeading') }}</span>
              <span class="cme-history__meta">
                {{
                  t(
                    'collectionsMgmt.historySummary',
                    { n: fixedHistoryRows.length, amount: nfCurrency(fixedHistoryTotal) },
                    fixedHistoryRows.length,
                  )
                }}
              </span>
            </button>
            <div v-show="historyOpen" id="cme-history-body" class="cme-history__body">
              <div v-if="fixedHistoryRows.length" class="cme-table-wrap">
                <table class="cme-table cme-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('collectionsMgmt.colPaidOn') }}</th>
                      <th scope="col">{{ t('collectionsMgmt.colPerson') }}</th>
                      <th scope="col" class="is-num">{{ t('collectionsMgmt.tableAmount') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in fixedHistoryRows" :key="row.rowKey">
                      <td :data-label="t('collectionsMgmt.colPaidOn')">{{ nfDate(row.paidOn) }}</td>
                      <td :data-label="t('collectionsMgmt.colPerson')">{{ row.recipientName }}</td>
                      <td class="is-num" :data-label="t('collectionsMgmt.tableAmount')">
                        <strong class="cme-amount">{{ nfCurrency(row.amount) }}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="cme-empty cme-empty--inline">{{ t('fixedPay.emptyHistory') }}</p>
            </div>
          </div>

          <LoadErrorRetry
            v-if="fixedLoadError"
            compact
            :message="fixedLoadError"
            :loading="fixedLoading"
            @retry="loadFixedRecipients"
          />
        </div>
      </section>
    </template>

    <!-- Registrar gasto -->
    <Dialog
      v-model:visible="modalOpen"
      modal
      :header="t('collectionsMgmt.modalTitle')"
      class="cme-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
    >
      <div class="cme-form">
        <div class="cme-field">
          <label for="collections-cost-name">{{ t('collectionsMgmt.nameLabel') }}</label>
          <InputText
            id="collections-cost-name"
            v-model="form.name"
            autocomplete="off"
            :invalid="Boolean(fieldErrors.name)"
            :aria-invalid="Boolean(fieldErrors.name)"
            aria-describedby="collections-cost-name-error"
            fluid
          />
          <small v-if="fieldErrors.name" id="collections-cost-name-error" class="cme-field__error">
            {{ fieldErrors.name }}
          </small>
        </div>
        <div class="cme-form__row">
          <div class="cme-field">
            <label for="collections-cost-amount">{{ t('collectionsMgmt.priceLabel') }}</label>
            <InputNumber
              v-model="form.amount"
              input-id="collections-cost-amount"
              :min="0"
              mode="decimal"
              :min-fraction-digits="2"
              :max-fraction-digits="2"
              :invalid="Boolean(fieldErrors.amount)"
              :aria-invalid="Boolean(fieldErrors.amount)"
              aria-describedby="collections-cost-amount-error"
              fluid
            />
            <small v-if="fieldErrors.amount" id="collections-cost-amount-error" class="cme-field__error">
              {{ fieldErrors.amount }}
            </small>
          </div>
          <div class="cme-field">
            <label for="collections-cost-date">{{ t('collectionsMgmt.purchaseDateLabel') }}</label>
            <InputText
              id="collections-cost-date"
              v-model="form.purchaseDate"
              type="date"
              :invalid="Boolean(fieldErrors.purchaseDate)"
              :aria-invalid="Boolean(fieldErrors.purchaseDate)"
              aria-describedby="collections-cost-date-error"
              fluid
            />
            <small v-if="fieldErrors.purchaseDate" id="collections-cost-date-error" class="cme-field__error">
              {{ fieldErrors.purchaseDate }}
            </small>
          </div>
        </div>
        <div class="cme-field">
          <span class="cme-field__label">{{ t('collectionsMgmt.invoiceLabel') }}</span>
          <div class="cme-upload">
            <img
              v-if="form.invoicePhotoUrl"
              :src="form.invoicePhotoUrl"
              :alt="form.name.trim() ? form.name.trim() : t('collectionsMgmt.invoiceLabel')"
              class="cme-upload__preview"
              width="56"
              height="56"
            />
            <span v-else class="cme-upload__preview cme-upload__preview--empty" aria-hidden="true">
              <i class="pi pi-image" />
            </span>
            <div class="cme-upload__body">
              <div class="cme-upload__buttons">
                <label class="cme-file">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                    class="cme-file__input"
                    :disabled="processingPhoto || saving"
                    @change="onInvoiceChange"
                  />
                  <span class="cme-file__trigger">
                    <i class="pi pi-upload" aria-hidden="true" />
                    {{ processingPhoto ? t('collectionsMgmt.processingPhoto') : t('collectionsMgmt.invoiceChoose') }}
                  </span>
                </label>
                <button
                  v-if="form.invoicePhotoUrl"
                  type="button"
                  class="cme-link-btn"
                  @click="form.invoicePhotoUrl = ''"
                >
                  {{ t('collectionsMgmt.removePhoto') }}
                </button>
              </div>
              <p class="cme-field__hint">{{ t('collectionsMgmt.invoiceHint') }}</p>
            </div>
          </div>
        </div>
        <p v-if="submitError" class="cme-form__error" role="alert">{{ submitError }}</p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('collectionsMgmt.accept')"
          :loading="saving"
          @cancel="closeModal"
          @confirm="submitCost"
        />
      </template>
    </Dialog>

    <!-- Agregar servicio compartido -->
    <Dialog
      v-model:visible="serviceModalOpen"
      modal
      :header="t('sharedServices.modalTitle')"
      class="cme-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
    >
      <div class="cme-form">
        <div class="cme-field">
          <label for="shared-service-type">{{ t('sharedServices.typeLabel') }}</label>
          <Select
            v-model="serviceForm.type"
            input-id="shared-service-type"
            :options="serviceTypeOptions"
            option-label="label"
            option-value="value"
            fluid
          />
        </div>
        <div class="cme-field">
          <label for="shared-service-amount">{{ t('sharedServices.totalLabel') }}</label>
          <InputNumber
            v-model="serviceForm.amount"
            input-id="shared-service-amount"
            :min="0"
            mode="decimal"
            :min-fraction-digits="2"
            :max-fraction-digits="2"
            fluid
          />
        </div>
        <p class="cme-form__note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          {{ t('sharedServices.splitHint') }}
        </p>
        <p v-if="serviceSubmitError" class="cme-form__error" role="alert">{{ serviceSubmitError }}</p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('sharedServices.save')"
          :loading="serviceSaving"
          @cancel="closeServiceModal"
          @confirm="submitSharedService"
        />
      </template>
    </Dialog>

    <!-- Agregar pago fijo -->
    <Dialog
      v-model:visible="fixedModalOpen"
      modal
      :header="t('collectionsMgmt.addFixedPayout')"
      class="cme-dialog"
      :style="{ width: 'min(30rem, 94vw)' }"
      :draggable="false"
    >
      <div class="cme-form">
        <div class="cme-field">
          <label for="fixed-pay-name">{{ t('fixedPay.nameLabel') }}</label>
          <InputText id="fixed-pay-name" v-model="fixedForm.name" autocomplete="name" fluid />
        </div>
        <div class="cme-form__row">
          <div class="cme-field">
            <label for="fixed-pay-dni">{{ t('fixedPay.dniLabel') }}</label>
            <InputText id="fixed-pay-dni" v-model="fixedForm.dni" inputmode="numeric" fluid />
          </div>
          <div class="cme-field">
            <label for="fixed-pay-phone">{{ t('fixedPay.phoneLabel') }}</label>
            <InputText
              id="fixed-pay-phone"
              v-model="fixedForm.phone"
              inputmode="tel"
              autocomplete="tel"
              fluid
            />
          </div>
        </div>
        <div class="cme-form__row">
          <div class="cme-field">
            <label for="fixed-pay-salary">{{ t('fixedPay.salaryLabel') }}</label>
            <InputNumber
              v-model="fixedForm.salary"
              input-id="fixed-pay-salary"
              :min="0"
              mode="decimal"
              :min-fraction-digits="2"
              :max-fraction-digits="2"
              fluid
            />
          </div>
          <div class="cme-field">
            <label for="fixed-pay-interval">{{ t('fixedPay.intervalDaysLabel') }}</label>
            <InputNumber
              v-model="fixedForm.intervalDays"
              input-id="fixed-pay-interval"
              :min="1"
              :max="365"
              fluid
            />
          </div>
        </div>
        <p v-if="previewFirstFixedDue" class="cme-form__note">
          <i class="pi pi-calendar" aria-hidden="true" />
          {{ t('fixedPay.firstDueHint', { date: nfDate(previewFirstFixedDue) }) }}
        </p>
        <div class="cme-field">
          <span class="cme-field__label">{{ t('fixedPay.photoLabel') }}</span>
          <div class="cme-upload">
            <img
              v-if="fixedForm.photoUrl"
              :src="fixedForm.photoUrl"
              :alt="fixedForm.name.trim() ? fixedForm.name.trim() : t('fixedPay.photoLabel')"
              class="cme-upload__preview cme-upload__preview--round"
              width="56"
              height="56"
            />
            <span v-else class="cme-upload__preview cme-upload__preview--round cme-upload__preview--empty" aria-hidden="true">
              {{ fixedForm.name.trim() ? initialsOf(fixedForm.name) : '' }}
              <i v-if="!fixedForm.name.trim()" class="pi pi-user" />
            </span>
            <div class="cme-upload__body">
              <div class="cme-upload__buttons">
                <label class="cme-file">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                    class="cme-file__input"
                    :disabled="fixedProcessingPhoto || fixedSaving"
                    @change="onFixedPhotoChange"
                  />
                  <span class="cme-file__trigger">
                    <i class="pi pi-upload" aria-hidden="true" />
                    {{ fixedProcessingPhoto ? t('fixedPay.processingPhoto') : t('fixedPay.photoChoose') }}
                  </span>
                </label>
                <button
                  v-if="fixedForm.photoUrl"
                  type="button"
                  class="cme-link-btn"
                  @click="fixedForm.photoUrl = ''"
                >
                  {{ t('fixedPay.removePhoto') }}
                </button>
              </div>
              <p class="cme-field__hint">{{ t('fixedPay.photoHint') }}</p>
            </div>
          </div>
        </div>
        <p v-if="fixedSubmitError" class="cme-form__error" role="alert">{{ fixedSubmitError }}</p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('fixedPay.save')"
          :loading="fixedSaving"
          @cancel="closeFixedModal"
          @confirm="submitFixedRecipient"
        />
      </template>
    </Dialog>

    <!-- Confirmar eliminación -->
    <Dialog
      :visible="pendingDelete != null"
      modal
      :header="t('collectionsMgmt.deleteModalTitle')"
      class="cme-dialog"
      :style="{ width: 'min(24rem, 94vw)' }"
      :draggable="false"
      :closable="!deleting"
      @update:visible="(open) => { if (!open) closeDelete() }"
    >
      <p class="cme-delete__text">
        {{
          pendingDelete?.kind === 'service'
            ? t('sharedServices.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
            : pendingDelete?.kind === 'fixed'
              ? t('fixedPay.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
              : t('collectionsMgmt.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
        }}
      </p>
      <p v-if="pendingDelete?.kind === 'service'" class="cme-delete__hint">
        {{ t('sharedServices.deleteHint') }}
      </p>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('app.deleteAction')"
          confirm-variant="danger"
          :loading="deleting"
          @cancel="closeDelete"
          @confirm="confirmDelete"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.cme {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.cme *,
.cme *::before,
.cme *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.cme-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.cme-head__controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.cme-head__nav {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.cme-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cme-month {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.15rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
}

.cme-month__step,
.cme-icon-btn {
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.cme-icon-btn {
  width: 2.125rem;
  height: 2.125rem;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
  font-size: 0.85rem;
}

.cme-month__step:hover,
.cme-icon-btn:hover:not(:disabled) {
  background: #e8eefc;
}

.cme-icon-btn:disabled {
  cursor: progress;
  opacity: 0.75;
}

.cme-month__label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-width: 9.5rem;
  padding: 0 0.35rem;
  font-size: 0.85rem;
  font-weight: 650;
  color: #0f172a;
  white-space: nowrap;
}

.cme-month__label .pi {
  font-size: 0.8rem;
  color: #1e3a8a;
}

.cme-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.125rem;
  padding: 0.3rem 0.95rem;
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

.cme-btn .pi {
  font-size: 0.78rem;
}

.cme-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.cme-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.cme-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.cme-btn:focus-visible,
.cme-month__step:focus-visible,
.cme-icon-btn:focus-visible,
.cme-tab:focus-visible,
.cme-toggle:focus-visible,
.cme-action:focus-visible,
.cme-history__toggle:focus-visible,
.cme-panel:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.cme-status {
  margin: 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

/* ---------- Month summary (equation) ---------- */
.cme-summary {
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-width: 0;
}

.cme-section-head {
  display: flex;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
  flex-wrap: wrap;
}

.cme-section-title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.cme-section-hint {
  margin: 0;
  font-size: 0.78rem;
  color: #6e6e73;
}

.cme-eq {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  gap: 0.6rem;
}

.cme-eq__op {
  align-self: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
  color: #475569;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15rem;
  font-weight: 600;
  line-height: 1;
}

.cme-stat {
  background: var(--stat-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cme-stat--green { --stat-bg: #e3f4e8; }
.cme-stat--orange { --stat-bg: #fdeee2; }
.cme-stat--red { --stat-bg: #fde4e4; }

.cme-stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}

.cme-stat__label {
  margin: 0;
  color: #475569;
  font-weight: 600;
  font-size: 0.8rem;
}

.cme-stat__icon {
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

.cme-stat__icon--green { color: #15803d; }
.cme-stat__icon--orange { color: #c2410c; }
.cme-stat__icon--red { color: #b42318; }

.cme-stat__value {
  margin: 0 0 0.4rem;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.65rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cme-stat__value.is-negative {
  color: #b42318;
}

.cme-stat__hint {
  margin: auto 0 0;
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
}

.cme-inline-error {
  margin: 0;
  font-size: 0.8rem;
  color: #b42318;
}

/* ---------- All-time cash strip ---------- */
.cme-cash {
  display: flex;
  align-items: center;
  gap: 0.75rem 1.5rem;
  flex-wrap: wrap;
  padding: 0.85rem 1.1rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.cme-cash__main {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  flex: 1 1 18rem;
}

.cme-cash__icon {
  width: 2.3rem;
  height: 2.3rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.95rem;
}

.cme-cash__text {
  min-width: 0;
}

.cme-cash__title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cme-cash__title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 650;
  color: #0f172a;
}

.cme-cash__hint {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: #6e6e73;
}

.cme-cash__parts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0;
  font-size: 0.78rem;
  color: #475569;
  font-variant-numeric: tabular-nums;
}

.cme-cash__parts li {
  white-space: nowrap;
}

.cme-cash__parts li + li::before {
  content: '·';
  margin: 0 0.5rem;
  color: #94a3b8;
}

.cme-cash__value {
  margin: 0 0 0 auto;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cme-cash__value.is-negative {
  color: #b42318;
}

.cme-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
}

.cme-pill--soft {
  background: #f1f5f9;
  color: #334155;
}

/* ---------- Records card + tabs ---------- */
.cme-card {
  padding: 1.1rem 1.25rem 1.15rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.cme-tabs {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.cme-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.5rem 0.45rem 0.9rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.cme-tab:hover:not(.is-active) {
  color: #0f172a;
}

.cme-tab__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.cme-tab.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.cme-tab.is-active .cme-tab__count {
  background: #f1f5f9;
  color: #0f172a;
}

.cme-panel {
  min-width: 0;
  border-radius: 12px;
}

.cme-panel__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.8rem;
}

.cme-panel__intro {
  margin: 0;
  flex: 1 1 22rem;
  min-width: 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #6e6e73;
}

.cme-panel__tools {
  display: flex;
  align-items: center;
  gap: 0.5rem 0.85rem;
  flex-wrap: wrap;
}

.cme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.8rem 0.35rem 0.4rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.cme-toggle:hover {
  background: #f8fafc;
}

.cme-toggle__track {
  position: relative;
  width: 1.9rem;
  height: 1.1rem;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.cme-toggle__knob {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}

.cme-toggle[aria-pressed='true'] .cme-toggle__track {
  background: #1e3a8a;
}

.cme-toggle[aria-pressed='true'] .cme-toggle__knob {
  transform: translateX(0.8rem);
}

.cme-total {
  font-size: 0.8rem;
  font-weight: 650;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Tables */
.cme-table-wrap {
  overflow-x: auto;
}

.cme-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.cme-table th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
  background: #f8fafc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  white-space: nowrap;
}

.cme-table th:first-child {
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}

.cme-table th:last-child {
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}

.cme-table td {
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  vertical-align: middle;
  color: #0f172a;
}

.cme-table tbody tr:last-child td {
  border-bottom: none;
}

.cme-table tbody tr:hover td {
  background: #fafbfd;
}

.cme-table .is-num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.cme-table .is-actions,
.cme-table .c-actions {
  width: 3.5rem;
  text-align: right;
}

.cme-table--compact td {
  padding-block: 0.5rem;
}

.cme-amount {
  font-weight: 650;
}

.cme-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}

.cme-item__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cme-item__text strong {
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.cme-item__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.cme-thumb {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.cme-thumb--empty,
.cme-thumb--icon {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  color: #94a3b8;
  font-size: 0.9rem;
  border-color: transparent;
}

.cme-thumb--icon.is-blue {
  background: #e8eefc;
  color: #1e3a8a;
}

.cme-thumb--icon.is-amber {
  background: #fdf3dc;
  color: #b45309;
}

.cme-avatar {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.cme-avatar--photo {
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

/* Row icon action with a visible tooltip on hover / keyboard focus. */
.cme-action {
  position: relative;
  width: 2.1rem;
  height: 2.1rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
}

.cme-action--danger {
  background: #dc2626;
  color: #fff;
}

.cme-action--danger:hover {
  background: #b91c1c;
  color: #fff;
}

.cme-action[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  right: calc(100% + 0.4rem);
  top: 50%;
  transform: translateY(-50%);
  padding: 0.25rem 0.55rem;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 2;
}

.cme-action[data-tip]:hover::after,
.cme-action[data-tip]:focus-visible::after {
  opacity: 1;
}

/* Empty state */
.cme-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 1.75rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.cme-empty__icon {
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

.cme-empty__text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.cme-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
}

.cme-empty--inline {
  margin: 0;
  padding: 1rem;
  font-size: 0.82rem;
  color: #6e6e73;
}

/* Payment history (collapsible) */
.cme-history {
  margin-top: 1rem;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
  padding-top: 0.75rem;
}

.cme-history__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0.7rem;
  border: none;
  border-radius: 12px;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: #0f172a;
}

.cme-history__toggle:hover {
  background: #f8fafc;
}

.cme-history__chevron {
  font-size: 0.72rem;
  color: #1e3a8a;
  transition: transform 0.15s ease;
  transform: rotate(-90deg);
}

.cme-history__chevron.is-open {
  transform: rotate(0deg);
}

.cme-history__title {
  font-size: 0.9rem;
  font-weight: 650;
}

.cme-history__meta {
  margin-left: auto;
  font-size: 0.78rem;
  color: #6e6e73;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cme-history__body {
  margin-top: 0.5rem;
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
  .cme-head__controls {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
  .cme-eq {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.35rem;
  }
  .cme-eq__op {
    justify-self: center;
    width: 1.8rem;
    height: 1.8rem;
    font-size: 1rem;
  }
  .cme-stat {
    padding: 0.85rem 1rem 0.9rem;
  }
  .cme-stat__value {
    font-size: 1.4rem;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .cme-head,
  .cme-head__controls,
  .cme-head__actions,
  .cme-head__nav {
    width: 100%;
  }
  .cme-month {
    flex: 1;
    justify-content: space-between;
  }
  .cme-head__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cme-btn {
    padding-inline: 0.6rem;
    white-space: normal;
    text-align: center;
    line-height: 1.2;
  }
  .cme-head__actions .cme-btn--primary {
    grid-column: 1 / -1;
    order: -1;
  }
  .cme-cash {
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
  }
  .cme-cash__main {
    flex-basis: auto;
  }
  .cme-cash__value {
    order: 1;
    margin-left: 0;
  }
  .cme-cash__parts {
    order: 2;
    padding-top: 0.55rem;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
  }
  .cme-cash__parts {
    flex-direction: column;
  }
  .cme-cash__parts li + li::before {
    content: none;
  }
  .cme-card {
    padding: 1rem 0.85rem;
  }
  .cme-tab {
    font-size: 0.8rem;
  }
  .cme-panel__intro {
    flex-basis: 100%;
  }

  /* Tables become one card per row. */
  .cme-table-wrap {
    overflow: visible;
  }
  .cme-table,
  .cme-table tbody,
  .cme-table tr,
  .cme-table td {
    display: block;
    width: 100%;
  }
  .cme-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  .cme-table tbody {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .cme-table tbody tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 0.6rem 0.75rem;
    padding: 0.8rem 0.85rem;
    border-radius: 16px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: #fff;
  }
  .cme-table tbody tr:hover td {
    background: transparent;
  }
  .cme-table td {
    padding: 0;
    border: none;
    text-align: left !important;
    min-width: 0;
  }
  .cme-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.2rem;
    font-size: 0.68rem;
    font-weight: 600;
    color: #6e6e73;
  }
  .cme-table .c-main {
    grid-column: 1 / 3;
    grid-row: 1;
  }
  .cme-table .c-actions {
    grid-column: 3;
    grid-row: 1;
    width: auto;
    align-self: start;
  }
  .cme-table .c-wide {
    grid-column: 1 / -1;
  }
  .cme-table--compact tbody tr {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .cme-history__toggle {
    flex-wrap: wrap;
  }
  .cme-history__meta {
    margin-left: 1.3rem;
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cme-btn,
  .cme-toggle__track,
  .cme-toggle__knob,
  .cme-history__chevron,
  .cme-action[data-tip]::after {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.cme-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.cme-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.cme-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.cme-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.cme-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  gap: 0.5rem;
}

.cme-dialog .cme-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.cme-dialog .cme-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem;
}

.cme-dialog .cme-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.cme-dialog .cme-field > label,
.cme-dialog .cme-field__label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.cme-dialog .cme-field .p-inputtext,
.cme-dialog .cme-field .p-select {
  border-radius: 12px;
}

.cme-dialog .cme-field .p-inputtext {
  min-height: 2.6rem;
}

.cme-dialog .cme-field__hint {
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.cme-dialog .cme-field__error {
  font-size: 0.75rem;
  color: #b42318;
}

.cme-dialog .cme-form__error {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

.cme-dialog .cme-form__note {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.78rem;
  line-height: 1.4;
}

.cme-dialog .cme-form__note .pi {
  margin-top: 0.12rem;
  font-size: 0.75rem;
}

.cme-dialog .cme-upload {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.65rem 0.75rem;
  border-radius: 14px;
  border: 1px dashed rgba(15, 23, 42, 0.18);
  background: #f8fafc;
}

.cme-dialog .cme-upload__preview {
  flex-shrink: 0;
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.cme-dialog .cme-upload__preview--round {
  border-radius: 50%;
}

.cme-dialog .cme-upload__preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: #94a3b8;
  font-size: 0.95rem;
  font-weight: 700;
}

.cme-dialog .cme-upload__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.cme-dialog .cme-upload__buttons {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.cme-dialog .cme-file {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.cme-dialog .cme-file__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.cme-dialog .cme-file__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.42rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 600;
}

.cme-dialog .cme-file:hover .cme-file__trigger {
  background: #e8eefc;
}

.cme-dialog .cme-file:focus-within .cme-file__trigger {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.cme-dialog .cme-link-btn {
  padding: 0.2rem 0.3rem;
  border: none;
  background: none;
  color: #b42318;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.cme-dialog .cme-link-btn:hover {
  text-decoration: underline;
}

.cme-dialog .cme-delete__text {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  color: #0f172a;
}

.cme-dialog .cme-delete__hint {
  margin: 0.7rem 0 0;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #6e6e73;
}

@media (max-width: 480px) {
  .cme-dialog .cme-form__row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
