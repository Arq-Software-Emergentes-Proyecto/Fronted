<script setup>
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import InputNumber from 'primevue/inputnumber'
import Dialog from 'primevue/dialog'
import Paginator from 'primevue/paginator'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { residentExtraChargesApi } from '../../../finances/infrastructure/residentExtraChargesApi.js'
import { useFinancesStore } from '../../../finances/application/financesStore.js'
import { financesApi } from '../../../finances/infrastructure/financesApi.js'
import DebtTrafficLightGrid from '../../../finances/presentation/components/DebtTrafficLightGrid.vue'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'
import {
  addMonths,
  applyLateFeeToReceipt,
  computeChargeDates,
  currentStatementMonthKey,
  findCharge,
  formatDayMonth,
  formatMonthLabel,
  normalizeCharge,
  normalizeMonthKey,
  normalizeSettings,
  parseMonthKey,
  todayYmd,
  toMonthKey,
} from '../../../finances/domain/billingCycle.js'

const { t, locale } = useI18n()
const store = useFinancesStore()

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

const nfPen = computed(() => (value) => {
  const n = Number(value)
  return new Intl.NumberFormat(intlLocale.value, {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0)
})

const uiState = ref({
  isLoaded: false,
})

const editSettings = ref({
  lateFeePerDay: 0,
  admissionPayFromDay: 1,
  admissionPayToDay: 7,
  monthlyCharges: [],
})

/** Month the page is looking at (summary, fee column, "Generate receipts", fee dialog default). */
const selectedMonth = ref(currentStatementMonthKey())

function shiftMonthKey(monthKey, delta) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return monthKey
  const next = addMonths(parsed.year, parsed.month0, delta)
  return toMonthKey(next.year, next.month0)
}

function shiftSelectedMonth(delta) {
  selectedMonth.value = shiftMonthKey(selectedMonth.value, delta)
}

const selectedMonthLabel = computed(() => chargeMonthLabel(selectedMonth.value))

/** Page-level feedback (receipts generated, with counts). */
const notice = ref({ text: '', tone: 'ok' })

function showNotice(text, tone = 'ok') {
  notice.value = { text, tone }
}

function dismissNotice() {
  notice.value = { text: '', tone: 'ok' }
}

// --- Monthly fee (dialog "Configurar cuota") ---
const chargeForm = ref({
  month: '',
  amount: null,
  billingStart: '',
  billingEnd: '',
  paymentOpen: '',
})
const chargeError = ref('')
/** RNF003: highlighted fields of the monthly-charge and extra-charge forms. */
const chargeInvalid = ref({ month: false, paymentOpen: false, amount: false })
const extraInvalid = ref({ resident: false, title: false, amount: false, description: false })
const isSavingCharge = ref(false)
const isChargeDialogOpen = ref(false)

const selectedCharge = computed(() =>
  findCharge(editSettings.value.monthlyCharges, chargeForm.value.month),
)
/** True from saving a fee until the dialog is reopened: keeps its button for the green confirmation. */
const chargeJustSaved = ref(false)
const isChargeRegistered = computed(() => Boolean(selectedCharge.value) && !chargeJustSaved.value)
const isReceiptsModalOpen = ref(false)
const extraCharges = ref([])
const residentsSearch = ref('')
const selectedResidentId = ref('')
const extraForm = ref({
  title: '',
  amount: null,
  description: '',
})
const extraError = ref('')
const isSavingExtra = ref(false)
const isExtraDialogOpen = ref(false)

const chargePeriodLabel = computed(() => {
  if (!chargeForm.value.billingStart || !chargeForm.value.billingEnd) return '—'
  return t('financeAdmin.chargePeriodValue', {
    start: formatDayMonth(chargeForm.value.billingStart, locale.value),
    end: formatDayMonth(chargeForm.value.billingEnd, locale.value),
  })
})

function chargeMonthLabel(month) {
  return formatMonthLabel(month, locale.value)
}

function applySettingsToForm(settings) {
  const normalized = normalizeSettings(settings || {})
  editSettings.value = {
    lateFeePerDay: normalized.lateFeePerDay,
    admissionPayFromDay: normalized.admissionPayFromDay,
    admissionPayToDay: normalized.admissionPayToDay,
    monthlyCharges: normalized.monthlyCharges,
  }
}

function resetChargeForm(monthKey) {
  const month = normalizeMonthKey(monthKey || currentStatementMonthKey())
  const dates = computeChargeDates(month)
  const existing = findCharge(editSettings.value.monthlyCharges, month)
  chargeForm.value = {
    month,
    amount: existing?.amount ?? null,
    billingStart: dates.billingStart,
    billingEnd: dates.billingEnd,
    paymentOpen: existing?.paymentOpen || dates.paymentOpen,
  }
  chargeError.value = ''
}

function shiftChargeMonth(delta) {
  chargeJustSaved.value = false
  chargeInvalid.value = { month: false, paymentOpen: false, amount: false }
  resetChargeForm(shiftMonthKey(chargeForm.value.month, delta))
}

function openChargeDialog(monthKey) {
  chargeJustSaved.value = false
  chargeInvalid.value = { month: false, paymentOpen: false, amount: false }
  resetChargeForm(monthKey || selectedMonth.value)
  isChargeDialogOpen.value = true
}

function closeChargeDialog() {
  isChargeDialogOpen.value = false
}

function settingsPayload() {
  return {
    lateFeePerDay: editSettings.value.lateFeePerDay,
    admissionPayFromDay: editSettings.value.admissionPayFromDay,
    admissionPayToDay: editSettings.value.admissionPayToDay,
    monthlyCharges: editSettings.value.monthlyCharges,
  }
}

async function loadFinancePage() {
  await store.loadData()
  applySettingsToForm(store.state.settings)
  selectedMonth.value = store.currentBillingMonthKey.value || currentStatementMonthKey()
  resetChargeForm(selectedMonth.value)
  extraCharges.value = await residentExtraChargesApi.list().catch(() => [])
  uiState.value.isLoaded = true
  await Promise.all([loadBillingAlerts(), loadCalendar()])
}

onMounted(loadFinancePage)

// --- RF021 / US021: alertas de facturación + generación manual (TS003) ---
const billingAlerts = ref([])
const isGeneratingReceipts = ref(false)

async function loadBillingAlerts() {
  billingAlerts.value = await financesApi.getBillingAlerts().catch(() => [])
}

function billingAlertMonthLabel(alert) {
  return chargeMonthLabel(alert?.month) || String(alert?.month ?? '')
}

async function onGenerateReceipts(event) {
  if (isGeneratingReceipts.value) return
  isGeneratingReceipts.value = true
  dismissNotice()
  // Bill exactly the month shown in the month selector (not whatever the server deems current).
  const month = selectedMonth.value
  const knownReceiptIds = new Set((store.state.receipts || []).map((receipt) => String(receipt.id)))
  try {
    const result = await store.generateMonthlyReceipts(month)
    const label = chargeMonthLabel(result?.month || month)
    if (Number(result?.created) > 0) {
      await confirmSuccess(event, t('feedback.receiptsGenerated'))
      // Highlight the residents that just got a receipt.
      ;(store.state.receipts || [])
        .filter((receipt) => !knownReceiptIds.has(String(receipt.id)))
        .forEach((receipt) => markFresh('financeResident', receipt.residentId))
    }
    showNotice(
      Number(result?.created) > 0
        ? t('financeOps.generateDone', {
            created: result.created,
            month: label,
            already: Number(result.alreadyBilled) || 0,
          })
        : t('financeOps.generateNone', { month: label }),
    )
    await loadCalendar()
  } catch (e) {
    showNotice(
      e?.code === 'MISSING_MONTHLY_CHARGE'
        ? t('financeOps.generateMissing', { month: chargeMonthLabel(month) })
        : t('financeOps.generateError'),
      'error',
    )
  } finally {
    isGeneratingReceipts.value = false
    await loadBillingAlerts()
  }
}

// --- RF029 / US029: semáforo residente × mes ---
const calendar = ref({ months: [], residents: [], dueSoonDays: 5 })
const calendarLoading = ref(false)
const calendarError = ref('')

async function loadCalendar() {
  calendarLoading.value = true
  calendarError.value = ''
  try {
    calendar.value = await financesApi.getPaymentCalendar({ months: 6 })
  } catch {
    calendarError.value = t('financeOps.trafficLoadError')
  } finally {
    calendarLoading.value = false
  }
}

const calendarByResident = computed(
  () => new Map((calendar.value.residents || []).map((row) => [String(row.residentId), row])),
)

function shortMonth(monthKey) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return String(monthKey ?? '')
  const label = new Date(parsed.year, parsed.month0, 1)
    .toLocaleDateString(intlLocale.value, { month: 'short' })
    .replace('.', '')
  // es-PE capitalizes standalone months ("May."); Spanish writes them in lower case ("7 set.").
  return locale.value === 'es' ? label.toLocaleLowerCase('es-PE') : label
}

const calendarRangeLabel = computed(() => {
  const months = calendar.value.months || []
  if (!months.length) return ''
  return t('financeAdmin.chargePeriodValue', {
    start: shortMonth(months[0]),
    end: shortMonth(months[months.length - 1]),
  })
})

// --- RF022: recibo descargable de meses pagados ---
const downloadingReceiptId = ref('')
const downloadError = ref('')

async function downloadPaidReceipt(receipt) {
  if (!receipt?.id || downloadingReceiptId.value) return
  downloadingReceiptId.value = String(receipt.id)
  downloadError.value = ''
  try {
    await financesApi.downloadReceiptPdf(receipt.id)
  } catch {
    downloadError.value = t('financeOps.downloadError')
  } finally {
    downloadingReceiptId.value = ''
  }
}

function receiptPayable(receipt) {
  return (
    Number(receipt?.amount) +
    Number(receipt?.lateFee || 0) +
    Number(receipt?.extraCharges || 0)
  )
}

function residentSearchText(resident) {
  const name = String(resident?.name ?? '')
  const floor = String(resident?.floor ?? '')
  const code = String(resident?.code ?? '')
  return [name, floor, code, `piso ${floor}`, `depto ${code}`, `dept ${code}`, `${floor}-${code}`]
    .join(' ')
    .toLowerCase()
}

function residentInitials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function residentFloorApt(resident) {
  return t('financeAdmin.residentFloorApt', {
    floor: resident?.floor || '—',
    code: resident?.code || '—',
  })
}

function receiptMonthKey(receipt) {
  return (
    normalizeMonthKey(String(receipt?.billingMonth || '').trim()) ||
    String(normalizeYmd(receipt?.dueDate) || '').slice(0, 7)
  )
}

function isReceiptOverdue(receipt, today = todayYmd()) {
  const key = receiptStatusKey(receipt?.status)
  if (key === 'Paid') return false
  if (key === 'Overdue') return true
  const due = normalizeYmd(receipt?.dueDate)
  return Boolean(due) && today >= due
}

// --- One residents table (status of the selected month + traffic light + overdue) ---
const residentRows = computed(() => {
  const rows = store.getResidentFinancialStatus.value || []
  const month = selectedMonth.value
  const hasCalendar = !calendarError.value && (calendar.value.residents || []).length > 0
  return rows
    .map((resident) => {
      const cal = calendarByResident.value.get(String(resident.id)) || null
      const monthStatus =
        month === resident.currentBillingMonth
          ? resident.monthStatus
          : store.residentMonthStatus(resident, month)
      // Overdue amount: same source as the traffic light; receipts are the fallback when it failed.
      const overdueAmount = hasCalendar
        ? Number(cal?.overdueAmount) || 0
        : (resident.receipts || [])
            .filter((receipt) => isReceiptOverdue(receipt))
            .reduce((sum, receipt) => sum + receiptPayable(receipt), 0)
      const isOverdue = overdueAmount > 0 || Boolean(cal?.hasOverdue) || monthStatus === 'Overdue'
      const group = isOverdue
        ? 'overdue'
        : monthStatus === 'Paid' || monthStatus === 'Exempt'
          ? 'upToDate'
          : 'pending'
      return { ...resident, cal, monthStatus, overdueAmount, group }
    })
    .sort(
      (a, b) =>
        String(a.floor ?? '').localeCompare(String(b.floor ?? ''), undefined, { numeric: true }) ||
        String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }) ||
        String(a.name ?? '').localeCompare(String(b.name ?? '')),
    )
})

const statusFilter = ref('all')
const searchedRows = computed(() => {
  const query = residentsSearch.value.trim().toLowerCase()
  if (!query) return residentRows.value
  return residentRows.value.filter((row) => residentSearchText(row).includes(query))
})

const filterOptions = computed(() => {
  const rows = searchedRows.value
  const count = (group) => rows.filter((row) => row.group === group).length
  return [
    { key: 'all', label: t('financeAdmin.filterAll'), count: rows.length },
    { key: 'pending', label: t('financeAdmin.filterPending'), count: count('pending') },
    { key: 'overdue', label: t('financeAdmin.filterOverdue'), count: count('overdue') },
    { key: 'upToDate', label: t('financeAdmin.filterUpToDate'), count: count('upToDate') },
  ]
})

const filteredRows = computed(() =>
  statusFilter.value === 'all'
    ? searchedRows.value
    : searchedRows.value.filter((row) => row.group === statusFilter.value),
)

const PAGE_SIZE = 10
const pageFirst = ref(0)
const pagedRows = computed(() =>
  filteredRows.value.slice(pageFirst.value, pageFirst.value + PAGE_SIZE),
)
watch([statusFilter, residentsSearch], () => {
  pageFirst.value = 0
})

function nextPaymentDateLabel(row) {
  return formatDayMonth(normalizeYmd(row?.nextPaymentDate), locale.value) || '—'
}

function nextPaymentRelative(row) {
  const days = Number(row?.daysUntilNextPayment)
  if (!Number.isFinite(days)) return ''
  return new Intl.RelativeTimeFormat(intlLocale.value, { numeric: 'auto' }).format(days, 'day')
}

function nextPaymentTone(row) {
  const days = Number(row?.daysUntilNextPayment)
  if (days < 0) return 'late'
  if (days <= (Number(calendar.value.dueSoonDays) || 5)) return 'soon'
  return ''
}

// --- Summary cards (selected month) ---
const monthReceipts = computed(() => {
  const lateFeePerDay = editSettings.value.lateFeePerDay
  return (store.state.receipts || [])
    .filter((receipt) => receiptMonthKey(receipt) === selectedMonth.value)
    .map((receipt) => applyLateFeeToReceipt(receipt, lateFeePerDay))
})

const summary = computed(() => {
  const receipts = monthReceipts.value
  const paid = receipts.filter((receipt) => receiptStatusKey(receipt.status) === 'Paid')
  const unpaid = receipts.filter((receipt) => receiptStatusKey(receipt.status) !== 'Paid')
  const rows = residentRows.value
  const overdueRows = rows.filter((row) => row.overdueAmount > 0)
  const upToDate = rows.filter((row) => row.group === 'upToDate').length
  return {
    issued: receipts.length,
    toCollect: unpaid.reduce((sum, receipt) => sum + receiptPayable(receipt), 0),
    toCollectCount: unpaid.length,
    collected: paid.reduce((sum, receipt) => sum + receiptPayable(receipt), 0),
    collectedCount: paid.length,
    overdue: overdueRows.reduce((sum, row) => sum + row.overdueAmount, 0),
    overdueResidents: overdueRows.length,
    upToDate,
    total: rows.length,
  }
})

const kpiPills = computed(() => {
  const s = summary.value
  const month = selectedMonthLabel.value
  const overdue = s.overdue > 0
  return [
    {
      key: 'toCollect',
      tone: 'blue',
      icon: 'pi-clock',
      label: t('financeAdmin.kpiToCollect'),
      value: nfPen.value(s.toCollect),
      hint: s.issued
        ? t('financeAdmin.kpiToCollectHint', { n: s.toCollectCount, month }, s.toCollectCount)
        : t('financeAdmin.kpiNoReceipts', { month }),
    },
    {
      key: 'collected',
      tone: 'green',
      icon: 'pi-wallet',
      label: t('financeAdmin.kpiCollected'),
      value: nfPen.value(s.collected),
      hint: t('financeAdmin.kpiCollectedHint', { n: s.collectedCount, month }, s.collectedCount),
    },
    {
      key: 'overdue',
      tone: overdue ? 'red' : 'amber',
      icon: 'pi-exclamation-triangle',
      label: t('financeAdmin.kpiOverdue'),
      value: nfPen.value(s.overdue),
      alert: overdue,
      hint: s.overdueResidents
        ? t('financeOps.trafficOverdueCount', { n: s.overdueResidents })
        : t('financeAdmin.kpiOverdueNone'),
    },
    {
      key: 'upToDate',
      tone: 'orange',
      icon: 'pi-users',
      label: t('financeAdmin.kpiUpToDate'),
      value: s.upToDate,
      total: s.total,
      hint: t('financeAdmin.kpiUpToDateHint', { month }),
    },
  ]
})

// --- Extra charge (row dialog "Agregar monto") ---
const selectedExtraResident = computed(
  () =>
    (store.state.residents || []).find(
      (resident) => String(resident.id) === String(selectedResidentId.value),
    ) || null,
)

function resetExtraForm() {
  extraForm.value = { title: '', amount: null, description: '' }
  extraError.value = ''
  extraInvalid.value = { resident: false, title: false, amount: false, description: false }
}

function openExtraDialog(row) {
  resetExtraForm()
  selectedResidentId.value = row?.id ?? ''
  isExtraDialogOpen.value = true
}

function closeExtraDialog() {
  if (isSavingExtra.value) return
  isExtraDialogOpen.value = false
}

async function onAddExtraCharge(event) {
  const title = String(extraForm.value.title ?? '').trim()
  const description = String(extraForm.value.description ?? '').trim()
  const amount = Number(extraForm.value.amount)
  extraInvalid.value = {
    resident: !selectedResidentId.value,
    title: !title,
    amount: extraForm.value.amount == null || !Number.isFinite(amount) || amount <= 0,
    description: !description,
  }
  if (Object.values(extraInvalid.value).some(Boolean)) {
    extraError.value = t('financeAdmin.extraRequired')
    return
  }

  isSavingExtra.value = true
  extraError.value = ''
  const residentId = selectedResidentId.value
  try {
    const created = await residentExtraChargesApi.add({
      residentId,
      title,
      amount,
      description,
    })
    await store.loadData()
    applySettingsToForm(store.state.settings)
    await confirmSuccess(event, t('feedback.extraChargeAdded'))
    isSavingExtra.value = false
    isExtraDialogOpen.value = false
    extraCharges.value = [created, ...extraCharges.value]
    resetExtraForm()
    markFresh('financeResident', residentId)
    await loadCalendar()
  } catch (e) {
    extraError.value = e?.payload?.message || t('auth.genericError')
  } finally {
    isSavingExtra.value = false
  }
}

async function persistCharges(nextCharges) {
  const updated = await store.updateSettings({
    ...settingsPayload(),
    monthlyCharges: nextCharges,
  })
  applySettingsToForm(updated)
}

async function onSaveCharge(event) {
  const month = normalizeMonthKey(chargeForm.value.month)
  const amount = Number(chargeForm.value.amount)
  const billingStart = String(chargeForm.value.billingStart ?? '').trim()
  const billingEnd = String(chargeForm.value.billingEnd ?? '').trim()
  const paymentOpen = String(chargeForm.value.paymentOpen ?? '').trim()
  if (findCharge(editSettings.value.monthlyCharges, month)) {
    chargeError.value = t('financeAdmin.chargeLocked', { month: chargeMonthLabel(month) })
    return
  }
  chargeInvalid.value = {
    month: !month,
    paymentOpen: !paymentOpen,
    amount: chargeForm.value.amount == null || !Number.isFinite(amount) || amount <= 0,
  }
  if (Object.values(chargeInvalid.value).some(Boolean)) {
    chargeError.value = t('financeAdmin.chargeRequired')
    return
  }

  isSavingCharge.value = true
  chargeError.value = ''
  try {
    const nextCharge = normalizeCharge({
      id: `charge-${month}`,
      month,
      amount,
      billingStart,
      billingEnd,
      paymentOpen,
    })
    // Set before saving: the fee becomes "registered" as soon as the settings come back.
    chargeJustSaved.value = true
    await persistCharges([nextCharge, ...editSettings.value.monthlyCharges])
    await confirmSuccess(event, t('feedback.monthlyChargeSaved'))
    isChargeDialogOpen.value = false
    resetChargeForm(month)
    await loadBillingAlerts()
  } catch (e) {
    chargeJustSaved.value = false
    chargeError.value = e?.payload?.message || t('auth.genericError')
  } finally {
    isSavingCharge.value = false
  }
}

function openReceiptsModal() {
  isReceiptsModalOpen.value = true
}

function closeReceiptsModal() {
  isReceiptsModalOpen.value = false
}

function residentById(id) {
  return (store.state.residents || []).find((resident) => String(resident.id) === String(id)) || null
}

function receiptStatusKey(status) {
  const raw = String(status ?? '')
  if (raw === 'Paid' || raw === 'Pagado') return 'Paid'
  if (raw === 'Overdue' || raw === 'En Mora') return 'Overdue'
  return 'Pending'
}

const chargeReceiptGroups = computed(() => {
  const receipts = store.state.receipts || []
  const lateFeePerDay = editSettings.value.lateFeePerDay
  return editSettings.value.monthlyCharges.map((charge) => ({
    charge,
    receipts: receipts
      .filter((receipt) => String(receipt.billingMonth || '') === String(charge.month))
      .map((receipt) => {
        const withFee = applyLateFeeToReceipt(receipt, lateFeePerDay)
        const resident = residentById(withFee.residentId)
        return {
          ...withFee,
          residentName: resident?.name || '—',
          residentFloor: resident?.floor ?? '',
          residentCode: resident?.code ?? '',
          statusKey: receiptStatusKey(withFee.status),
        }
      }),
  }))
})

// --- Payment history (row dialog "Historial") ---
const selectedHistoryResidentId = ref('')
const isHistoryDialogOpen = ref(false)

const selectedHistoryResident = computed(
  () =>
    (store.state.residents || []).find(
      (resident) => String(resident.id) === String(selectedHistoryResidentId.value),
    ) || null,
)

function openHistoryDialog(row) {
  selectedHistoryResidentId.value = row?.id ?? ''
  downloadError.value = ''
  isHistoryDialogOpen.value = true
}

const historyExtraCharges = computed(() => {
  const resident = selectedHistoryResident.value
  if (!resident) return []
  return extraCharges.value.filter(
    (item) => String(item.residentId) === String(resident.id),
  )
})

const historyPaidMonths = computed(() => {
  const resident = selectedHistoryResident.value
  if (!resident) return []
  const lateFeePerDay = editSettings.value.lateFeePerDay
  return (store.state.receipts || [])
    .filter((receipt) => String(receipt.residentId) === String(resident.id))
    .map((receipt) => applyLateFeeToReceipt(receipt, lateFeePerDay))
    .filter((receipt) => receiptStatusKey(receipt.status) === 'Paid')
    .map((receipt) => {
      const month =
        String(receipt.billingMonth || '').trim() ||
        String(normalizeYmd(receipt.dueDate) || '').slice(0, 7)
      return {
        ...receipt,
        month,
        monthLabel: chargeMonthLabel(month) || month,
      }
    })
    .sort((a, b) => String(b.month).localeCompare(String(a.month)))
})

function formatLongDate(ymd) {
  const match = String(normalizeYmd(ymd)).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return ''
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(
    intlLocale.value,
    { day: 'numeric', month: 'short', year: 'numeric' },
  )
}

function normalizeYmd(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) return isoMatch[1]
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) return ''
  const y = parsed.getFullYear()
  const m = String(parsed.getMonth() + 1).padStart(2, '0')
  const d = String(parsed.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const getStatusBadgeClass = (status) => {
  if (status === 'Paid') return 'status-paid'
  if (status === 'Pending') return 'status-pending'
  if (status === 'Overdue') return 'status-overdue'
  if (status === 'Unbilled') return 'status-unbilled'
  if (status === 'Exempt') return 'status-unbilled'
  return ''
}
</script>

<template>
  <div v-if="uiState.isLoaded" class="app-view fin">
    <header class="fin-head">
      <h1 class="bf-sr-only">{{ t('financeAdmin.pageTitle') }}</h1>
      <div class="fin-head__controls">
        <div class="fin-month" role="group" :aria-label="t('financeAdmin.monthSelectorLabel')">
          <button
            type="button"
            class="fin-month__step"
            :aria-label="t('financeAdmin.monthPrev')"
            :title="t('financeAdmin.monthPrev')"
            @click="shiftSelectedMonth(-1)"
          >
            <i class="pi pi-chevron-left" aria-hidden="true" />
          </button>
          <span class="fin-month__label" aria-live="polite">
            <i class="pi pi-calendar" aria-hidden="true" />
            {{ selectedMonthLabel }}
          </span>
          <button
            type="button"
            class="fin-month__step"
            :aria-label="t('financeAdmin.monthNext')"
            :title="t('financeAdmin.monthNext')"
            @click="shiftSelectedMonth(1)"
          >
            <i class="pi pi-chevron-right" aria-hidden="true" />
          </button>
        </div>
        <div class="fin-head__actions" role="group" :aria-label="t('financeAdmin.headerActions')">
          <button type="button" class="fin-btn" @click="openReceiptsModal">
            <i class="pi pi-list" aria-hidden="true" />
            {{ t('financeAdmin.viewReceipts') }}
          </button>
          <button type="button" class="fin-btn" @click="openChargeDialog()">
            <i class="pi pi-cog" aria-hidden="true" />
            {{ t('financeAdmin.configureCharge') }}
          </button>
          <button
            type="button"
            class="fin-btn fin-btn--primary"
            :disabled="isGeneratingReceipts"
            :aria-label="t('financeOps.generateNow', { month: selectedMonthLabel })"
            :title="t('financeOps.generateHint')"
            @click="onGenerateReceipts"
          >
            <i
              class="pi"
              :class="isGeneratingReceipts ? 'pi-spin pi-spinner' : 'pi-file-plus'"
              aria-hidden="true"
            />
            {{ t('financeAdmin.generateAction') }}
          </button>
        </div>
      </div>
    </header>

    <LoadErrorRetry
      v-if="store.state.error"
      :loading="store.state.isLoading"
      @retry="loadFinancePage"
    />

    <div
      v-for="alertItem in billingAlerts"
      :key="`${alertItem.code}-${alertItem.month}`"
      class="fin-alert"
      role="alert"
    >
      <i class="pi pi-exclamation-triangle fin-alert__icon" aria-hidden="true" />
      <p class="fin-alert__text">
        <strong>{{ t('financeOps.billingAlertTitle') }}.</strong>
        {{ t('financeOps.billingAlertBody', { month: billingAlertMonthLabel(alertItem) }) }}
      </p>
      <button type="button" class="fin-alert__btn" @click="openChargeDialog(alertItem.month)">
        {{ t('financeOps.billingAlertAction') }}
      </button>
    </div>

    <div
      v-if="notice.text"
      class="fin-notice"
      :class="`fin-notice--${notice.tone}`"
      :role="notice.tone === 'error' ? 'alert' : 'status'"
    >
      <i
        class="pi"
        :class="notice.tone === 'error' ? 'pi-times-circle' : 'pi-check-circle'"
        aria-hidden="true"
      />
      <p class="fin-notice__text">{{ notice.text }}</p>
      <button
        type="button"
        class="fin-notice__close"
        :aria-label="t('financeAdmin.dismissNotice')"
        @click="dismissNotice"
      >
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>

    <KpiPills :items="kpiPills" :aria-label="t('financeAdmin.summaryAria', { month: selectedMonthLabel })" />

    <section class="fin-card" aria-labelledby="finance-residents-heading">
      <div class="fin-card__head">
        <div>
          <h2 id="finance-residents-heading" class="fin-card__title">
            {{ t('financeAdmin.residentsPanelTitle') }}
          </h2>
          <p class="fin-card__hint">{{ t('financeAdmin.residentsHint') }}</p>
        </div>
      </div>

      <div class="fin-toolbar">
        <div class="fin-filters" v-bf-seg role="group" :aria-label="t('financeAdmin.filterAria')">
          <button
            v-for="option in filterOptions"
            :key="option.key"
            type="button"
            class="fin-filter"
            :class="[`fin-filter--${option.key}`, { 'is-active': statusFilter === option.key }]"
            :aria-pressed="statusFilter === option.key ? 'true' : 'false'"
            @click="statusFilter = option.key"
          >
            {{ option.label }}
            <span class="fin-filter__count">{{ option.count }}</span>
          </button>
        </div>
        <label class="fin-search" for="residentsStatusSearch">
          <i class="pi pi-search" aria-hidden="true" />
          <input
            id="residentsStatusSearch"
            v-model="residentsSearch"
            type="search"
            :placeholder="t('financeAdmin.extraSearchPlaceholder')"
            :aria-label="t('financeAdmin.extraSearch')"
          />
        </label>
      </div>

      <DebtTrafficLightGrid
        class="fin-legend"
        legend-only
        :months="calendar.months"
        :residents="calendar.residents"
        :due-soon-days="calendar.dueSoonDays"
        :loading="calendarLoading"
        :error="calendarError"
        @retry="loadCalendar"
      />

      <div class="fin-table-wrap">
        <table class="fin-table">
          <thead>
            <tr>
              <th scope="col">{{ t('financeAdmin.tableResident') }}</th>
              <th scope="col">{{ t('financeAdmin.tableMonthStatus', { month: selectedMonthLabel }) }}</th>
              <th scope="col">{{ t('financeAdmin.colNextPayment') }}</th>
              <th scope="col">
                {{ t('financeAdmin.colLast6') }}
                <span v-if="calendarRangeLabel" class="fin-table__th-sub">{{ calendarRangeLabel }}</span>
              </th>
              <th scope="col" class="is-num">{{ t('financeOps.trafficOverdue') }}</th>
              <th scope="col" class="is-actions">
                <span class="visually-hidden">{{ t('financeAdmin.colActions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in pagedRows"
              :key="row.id"
              :class="[`is-${row.group}`, { 'bf-fresh': isFresh('financeResident', row.id) }]"
            >
              <td class="c-resident">
                <div class="fin-res">
                  <span class="fin-avatar" :class="`fin-avatar--${row.group}`" aria-hidden="true">
                    {{ residentInitials(row.name) }}
                  </span>
                  <div class="fin-res__text">
                    <strong>{{ row.name }}</strong>
                    <small>{{ residentFloorApt(row) }}</small>
                  </div>
                </div>
              </td>
              <td :data-label="t('financeAdmin.tableMonthStatus', { month: selectedMonthLabel })">
                <span class="fin-pill" :class="getStatusBadgeClass(row.monthStatus)">
                  {{ t(`financeAdmin.status${row.monthStatus}`) }}
                </span>
              </td>
              <td :data-label="t('financeAdmin.colNextPayment')">
                <span class="fin-date">{{ nextPaymentDateLabel(row) }}</span>
                <span class="fin-rel" :class="nextPaymentTone(row) && `fin-rel--${nextPaymentTone(row)}`">
                  {{ nextPaymentRelative(row) }}
                </span>
              </td>
              <td :data-label="t('financeAdmin.colLast6')">
                <span v-if="calendarLoading" class="fin-muted">…</span>
                <DebtTrafficLightGrid
                  v-else
                  inline
                  :months="calendar.months"
                  :residents="row.cal ? [row.cal] : []"
                  :due-soon-days="calendar.dueSoonDays"
                />
              </td>
              <td class="is-num" :data-label="t('financeOps.trafficOverdue')">
                <span :class="row.overdueAmount > 0 ? 'fin-amount--danger' : 'fin-muted'">
                  {{ row.overdueAmount > 0 ? nfPen(row.overdueAmount) : '—' }}
                </span>
              </td>
              <td class="c-actions">
                <div class="fin-row-actions">
                  <button
                    type="button"
                    class="fin-chip"
                    :aria-label="`${t('financeAdmin.extraAdd')} · ${row.name}`"
                    @click="openExtraDialog(row)"
                  >
                    <i class="pi pi-plus" aria-hidden="true" />
                    {{ t('financeAdmin.extraAdd') }}
                  </button>
                  <button
                    type="button"
                    class="fin-chip"
                    :aria-label="`${t('financeAdmin.rowHistory')} · ${row.name}`"
                    @click="openHistoryDialog(row)"
                  >
                    <i class="pi pi-history" aria-hidden="true" />
                    {{ t('financeAdmin.rowHistory') }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!filteredRows.length" class="fin-table__empty-row">
              <td colspan="6">
                <div class="fin-empty">
                  <i class="pi pi-inbox" aria-hidden="true" />
                  <span>
                    {{
                      residentRows.length
                        ? t('financeAdmin.emptyFiltered')
                        : t('financeAdmin.extraNoResidents')
                    }}
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Paginator
        v-if="filteredRows.length > PAGE_SIZE"
        v-model:first="pageFirst"
        class="fin-paginator"
        :rows="PAGE_SIZE"
        :total-records="filteredRows.length"
      />
    </section>

    <!-- Configurar cuota -->
    <Dialog
      v-model:visible="isChargeDialogOpen"
      modal
      :header="t('financeAdmin.chargeDialogTitle')"
      class="fin-dialog"
      :style="{ width: 'min(30rem, 94vw)' }"
      :draggable="false"
      :closable="!isSavingCharge"
    >
      <div class="fin-form">
        <div class="fin-field">
          <span id="chargeMonthLabel" class="fin-field__label">{{ t('financeAdmin.chargeMonth') }}</span>
          <div
            class="fin-month fin-month--field"
            role="group"
            aria-labelledby="chargeMonthLabel"
            :aria-invalid="chargeInvalid.month ? 'true' : 'false'"
          >
            <button
              type="button"
              class="fin-month__step"
              :aria-label="t('financeAdmin.monthPrev')"
              @click="shiftChargeMonth(-1)"
            >
              <i class="pi pi-chevron-left" aria-hidden="true" />
            </button>
            <span class="fin-month__label" aria-live="polite">{{ chargeMonthLabel(chargeForm.month) }}</span>
            <button
              type="button"
              class="fin-month__step"
              :aria-label="t('financeAdmin.monthNext')"
              @click="shiftChargeMonth(1)"
            >
              <i class="pi pi-chevron-right" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="fin-field">
          <span class="fin-field__label">{{ t('financeAdmin.chargePeriod') }}</span>
          <p class="fin-readonly">{{ chargePeriodLabel }}</p>
        </div>
        <label class="fin-field" for="chargePaymentOpen">
          <span class="fin-field__label">{{ t('financeAdmin.chargePaymentOpen') }}</span>
          <input
            id="chargePaymentOpen"
            v-model="chargeForm.paymentOpen"
            type="date"
            class="fin-input"
            :lang="intlLocale"
            required
            :disabled="isChargeRegistered"
            :aria-invalid="chargeInvalid.paymentOpen ? 'true' : 'false'"
            :aria-describedby="chargeInvalid.paymentOpen ? 'charge-form-error' : undefined"
            @input="chargeInvalid.paymentOpen = false"
          />
        </label>
        <label class="fin-field" for="chargeAmount">
          <span class="fin-field__label">{{ t('financeAdmin.chargeAmount') }}</span>
          <InputNumber
            v-model="chargeForm.amount"
            input-id="chargeAmount"
            :min-fraction-digits="2"
            :max-fraction-digits="2"
            :min="0"
            mode="currency"
            currency="PEN"
            :locale="intlLocale"
            class="fin-number"
            :disabled="isChargeRegistered"
            :invalid="chargeInvalid.amount"
            :pt="{ pcInputText: { root: { 'aria-describedby': chargeInvalid.amount ? 'charge-form-error' : undefined } } }"
            @update:model-value="chargeInvalid.amount = false"
          />
        </label>
      </div>
      <p v-if="chargeError" id="charge-form-error" class="fin-form-error" role="alert">{{ chargeError }}</p>
      <p v-else-if="isChargeRegistered" class="fin-locked">
        <i class="pi pi-lock" aria-hidden="true" />
        {{ t('financeAdmin.chargeLocked', { month: chargeMonthLabel(chargeForm.month) }) }}
      </p>
      <p class="fin-dialog-hint">{{ t('financeOps.generateHint') }}</p>
      <template #footer>
        <ConfirmActions
          :cancel-label="isChargeRegistered ? t('app.closeAction') : t('app.cancelAction')"
          :confirm-label="t('financeAdmin.saveCharge')"
          :show-confirm="!isChargeRegistered"
          :loading="isSavingCharge"
          :stagger="false"
          @cancel="closeChargeDialog"
          @confirm="onSaveCharge"
        />
      </template>
    </Dialog>

    <!-- Agregar monto -->
    <Dialog
      v-model:visible="isExtraDialogOpen"
      modal
      :header="t('financeAdmin.extraDialogTitle')"
      class="fin-dialog"
      :style="{ width: 'min(30rem, 94vw)' }"
      :draggable="false"
      :closable="!isSavingExtra"
    >
      <div v-if="selectedExtraResident" class="fin-res fin-res--chip">
        <span class="fin-avatar" aria-hidden="true">{{ residentInitials(selectedExtraResident.name) }}</span>
        <div class="fin-res__text">
          <strong>{{ selectedExtraResident.name }}</strong>
          <small>{{ residentFloorApt(selectedExtraResident) }}</small>
        </div>
      </div>
      <div class="fin-form fin-form--single">
        <label class="fin-field" for="extraTitle">
          <span class="fin-field__label">{{ t('financeAdmin.extraAmountTitle') }}</span>
          <input
            id="extraTitle"
            v-model="extraForm.title"
            type="text"
            maxlength="80"
            class="fin-input"
            required
            :aria-invalid="extraInvalid.title ? 'true' : 'false'"
            :aria-describedby="extraInvalid.title ? 'extra-form-error' : undefined"
            @input="extraInvalid.title = false"
          />
        </label>
        <label class="fin-field" for="extraAmount">
          <span class="fin-field__label">{{ t('financeAdmin.extraAmount') }}</span>
          <InputNumber
            v-model="extraForm.amount"
            input-id="extraAmount"
            :min-fraction-digits="2"
            :max-fraction-digits="2"
            :min="0"
            mode="currency"
            currency="PEN"
            :locale="intlLocale"
            class="fin-number"
            :invalid="extraInvalid.amount"
            :pt="{ pcInputText: { root: { 'aria-describedby': extraInvalid.amount ? 'extra-form-error' : undefined } } }"
            @update:model-value="extraInvalid.amount = false"
          />
        </label>
        <label class="fin-field" for="extraDescription">
          <span class="fin-field__label">{{ t('financeAdmin.extraDescription') }}</span>
          <textarea
            id="extraDescription"
            v-model="extraForm.description"
            class="fin-input fin-textarea"
            maxlength="240"
            rows="3"
            required
            :aria-invalid="extraInvalid.description ? 'true' : 'false'"
            :aria-describedby="extraInvalid.description ? 'extra-form-error' : undefined"
            @input="extraInvalid.description = false"
          />
        </label>
      </div>
      <p v-if="extraError" id="extra-form-error" class="fin-form-error" role="alert">{{ extraError }}</p>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('financeAdmin.extraAdd')"
          :loading="isSavingExtra"
          :stagger="false"
          @cancel="closeExtraDialog"
          @confirm="onAddExtraCharge"
        />
      </template>
    </Dialog>

    <!-- Historial de pagos -->
    <Dialog
      v-model:visible="isHistoryDialogOpen"
      modal
      :header="t('financeAdmin.historyDialogTitle')"
      class="fin-dialog"
      :style="{ width: 'min(32rem, 94vw)' }"
      :draggable="false"
    >
      <template v-if="selectedHistoryResident">
        <div class="fin-res fin-res--chip">
          <span class="fin-avatar" aria-hidden="true">{{ residentInitials(selectedHistoryResident.name) }}</span>
          <div class="fin-res__text">
            <strong>{{ selectedHistoryResident.name }}</strong>
            <small>
              {{ residentFloorApt(selectedHistoryResident) }}
              <template v-if="formatLongDate(selectedHistoryResident.admissionDate)">
                · {{ t('financeAdmin.admissionOn', { date: formatLongDate(selectedHistoryResident.admissionDate) }) }}
              </template>
            </small>
          </div>
        </div>
        <ul
          v-if="historyPaidMonths.length || historyExtraCharges.length"
          class="receipt-list"
          role="list"
        >
          <li v-for="rc in historyPaidMonths" :key="rc.id">
            <div class="rc-info">
              <span>{{ rc.monthLabel }}</span>
              <strong>{{ nfPen(receiptPayable(rc)) }}</strong>
            </div>
            <div class="rc-actions">
              <span class="fin-pill status-paid">{{ t('financeAdmin.statusPaid') }}</span>
              <button
                type="button"
                class="fin-chip"
                :disabled="downloadingReceiptId === String(rc.id)"
                :aria-label="`${t('financeOps.downloadReceipt')} · ${rc.monthLabel}`"
                @click="downloadPaidReceipt(rc)"
              >
                <i
                  class="pi"
                  :class="downloadingReceiptId === String(rc.id) ? 'pi-spin pi-spinner' : 'pi-download'"
                  aria-hidden="true"
                />
                {{
                  downloadingReceiptId === String(rc.id)
                    ? t('financeOps.downloading')
                    : t('financeOps.downloadReceipt')
                }}
              </button>
            </div>
          </li>
          <li v-for="item in historyExtraCharges" :key="item.id">
            <div class="rc-info">
              <span>{{ item.title }}</span>
              <span>{{ item.description }}</span>
              <strong>{{ nfPen(item.amount) }}</strong>
            </div>
            <span class="fin-pill status-extra">{{ t('financeAdmin.receiptExtraLabel') }}</span>
          </li>
        </ul>
        <div v-else class="fin-empty">
          <i class="pi pi-inbox" aria-hidden="true" />
          <span>{{ t('financeAdmin.historyEmptyPaid') }}</span>
        </div>
        <p v-if="downloadError" class="fin-form-error" role="alert">{{ downloadError }}</p>
      </template>
      <template #footer>
        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.closeAction')"
          :stagger="false"
          @confirm="isHistoryDialogOpen = false"
        />
      </template>
    </Dialog>

    <!-- Ver recibos -->
    <Dialog
      v-model:visible="isReceiptsModalOpen"
      modal
      :header="t('financeAdmin.receiptsModalTitle')"
      class="fin-dialog"
      :style="{ width: 'min(38rem, 94vw)' }"
      :draggable="false"
    >
      <div v-if="!chargeReceiptGroups.length" class="fin-empty">
        <i class="pi pi-inbox" aria-hidden="true" />
        <span>{{ t('financeAdmin.emptyCharges') }}</span>
      </div>
      <ul v-else class="r-list" role="list">
        <li v-for="group in chargeReceiptGroups" :key="group.charge.id" class="r-card">
          <div class="r-card__row">
            <span class="r-card__avatar" aria-hidden="true">
              <i class="pi pi-calendar" />
            </span>
            <div class="r-card__body">
              <p class="r-card__name">{{ chargeMonthLabel(group.charge.month) }}</p>
              <p class="r-card__meta">
                {{
                  t('financeAdmin.chargeDatesHint', {
                    start: formatDayMonth(group.charge.billingStart, locale),
                    end: formatDayMonth(group.charge.billingEnd, locale),
                    open: formatDayMonth(group.charge.paymentOpen, locale),
                  })
                }}
              </p>
            </div>
            <strong class="charge-amount">{{ nfPen(group.charge.amount) }}</strong>
          </div>
          <ul class="receipt-list receipt-list--modal">
            <li v-for="rc in group.receipts" :key="rc.id">
              <div class="rc-info">
                <span class="rc-info__name">{{ rc.residentName }}</span>
                <span>{{
                  t('financeAdmin.residentFloorApt', {
                    floor: rc.residentFloor,
                    code: rc.residentCode,
                  })
                }}</span>
                <span>{{
                  t('financeAdmin.receiptDue')
                }}: {{ formatDayMonth(normalizeYmd(rc.dueDate), locale) }}</span>
                <span v-if="Number(rc.lateFee) > 0" class="rc-late-fee">
                  {{ t('financeAdmin.receiptLateFee', { amount: nfPen(rc.lateFee), n: rc.lateDays || 0 }) }}
                </span>
                <span v-if="Number(rc.extraCharges) > 0">
                  {{ t('financeAdmin.receiptExtra', { amount: nfPen(rc.extraCharges) }) }}
                </span>
                <strong>{{ nfPen(receiptPayable(rc)) }}</strong>
              </div>
              <span class="fin-pill" :class="getStatusBadgeClass(rc.statusKey)">
                {{ t(`financeAdmin.status${rc.statusKey}`) }}
              </span>
            </li>
            <li v-if="!group.receipts.length" class="empty-list">
              {{ t('financeAdmin.emptyChargeReceipts') }}
            </li>
          </ul>
        </li>
      </ul>
      <template #footer>
        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.closeAction')"
          :stagger="false"
          @confirm="closeReceiptsModal"
        />
      </template>
    </Dialog>
  </div>

  <div v-else class="app-view finance-loading" role="status" aria-live="polite">
    <div class="import-status">
      <i class="pi pi-spin pi-spinner" aria-hidden="true" />
      <span>{{ t('financeAdmin.loading') }}</span>
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

.fin {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ---------- Header ---------- */
.fin-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.fin-head__controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.fin-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Month selector: arrows + localized label (avoids the browser's English month input). */
.fin-month {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.15rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
}

.fin-month__step {
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
}

.fin-month__step:hover {
  background: #e8eefc;
}

.fin-month__label {
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

.fin-month__label .pi {
  font-size: 0.8rem;
  color: #1e3a8a;
}

.fin-month--field {
  width: 100%;
  justify-content: space-between;
  border-radius: 12px;
  border-color: #d2d2d7;
}

.fin-btn {
  display: inline-flex;
  align-items: center;
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

.fin-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.fin-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.fin-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.fin-btn:disabled {
  opacity: 0.7;
  cursor: progress;
}

.fin-btn:focus-visible,
.fin-month__step:focus-visible,
.fin-filter:focus-visible,
.fin-chip:focus-visible,
.fin-alert__btn:focus-visible,
.fin-notice__close:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

/* ---------- Alerts / notices ---------- */
.fin-alert,
.fin-notice {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.55rem 0.5rem 0.95rem;
  border-radius: 999px;
  font-size: 0.8rem;
  line-height: 1.35;
}

.fin-alert {
  background: #fdf3dc;
  color: #78350f;
}

.fin-alert__icon {
  color: #b45309;
  flex-shrink: 0;
}

.fin-alert__text,
.fin-notice__text {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.fin-alert__btn {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  border: none;
  border-radius: 999px;
  background: #fff;
  color: #92400e;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
}

.fin-alert__btn:hover {
  text-decoration: underline;
}

.fin-notice--ok {
  background: #e3f4e8;
  color: #14532d;
}

.fin-notice--ok > .pi {
  color: #15803d;
}

.fin-notice--error {
  background: #fde4e4;
  color: #7f1d1d;
}

.fin-notice--error > .pi {
  color: #b42318;
}

.fin-notice__close {
  flex-shrink: 0;
  width: 1.8rem;
  height: 1.8rem;
  border: none;
  border-radius: 50%;
  background: #fff;
  color: inherit;
  cursor: pointer;
  font-size: 0.7rem;
}

/* ---------- Residents card ---------- */
.fin-card {
  padding: 1.2rem 1.25rem 1.1rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.fin-card__head {
  margin-bottom: 0.9rem;
}

.fin-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
  text-transform: none;
}

.fin-card__hint {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
}

.fin-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}

.fin-filters {
  display: flex;
  flex-wrap: wrap;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.fin-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.5rem 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.fin-filter:hover:not(.is-active) {
  color: #0f172a;
}

.fin-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.fin-filter.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.fin-filter.is-active .fin-filter__count {
  background: #f1f5f9;
  color: #0f172a;
}

.fin-filter--overdue:not(.is-active) .fin-filter__count {
  background: #fde4e4;
  color: #b42318;
}

.fin-filter--pending:not(.is-active) .fin-filter__count {
  background: #fdf3dc;
  color: #92400e;
}

.fin-filter--upToDate:not(.is-active) .fin-filter__count {
  background: #e3f4e8;
  color: #15803d;
}

.fin-search {
  position: relative;
  flex: 0 1 18rem;
  min-width: 12rem;
}

.fin-search .pi {
  position: absolute;
  left: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8rem;
  color: #94a3b8;
  pointer-events: none;
}

.fin-search input {
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

.fin-search input:focus {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  background: #fff;
}

.fin-legend {
  margin-bottom: 0.6rem;
}

.fin-legend :deep(.tl-legend) {
  gap: 0.35rem 0.9rem;
}

/* Table */
.fin-table-wrap {
  overflow-x: auto;
}

.fin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.fin-table th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
  background: #f8fafc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  white-space: nowrap;
}

.fin-table th:first-child {
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}

.fin-table th:last-child {
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}

.fin-table__th-sub {
  margin-left: 0.3rem;
  font-weight: 500;
  color: #94a3b8;
}

.fin-table td {
  padding: 0.7rem 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  vertical-align: middle;
  color: #0f172a;
}

.fin-table tbody tr:last-child td {
  border-bottom: none;
}

.fin-table tbody tr:not(.fin-table__empty-row):hover td {
  background: #fafbfd;
}

.fin-table .is-num {
  text-align: right;
  white-space: nowrap;
}

.fin-table .is-actions,
.fin-table .c-actions {
  text-align: right;
}

.fin-res {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
}

.fin-res__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fin-res__text strong {
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fin-res__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.fin-res--chip {
  padding: 0.65rem 0.75rem;
  margin-bottom: 1rem;
  border-radius: 14px;
  background: #f1f5f9;
}

.fin-avatar {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.fin-res--chip .fin-avatar {
  background: #fff;
}

.fin-avatar--overdue { background: #fde4e4; color: #b42318; }
.fin-avatar--pending { background: #fdf3dc; color: #92400e; }
.fin-avatar--upToDate { background: #e3f4e8; color: #15803d; }

.fin-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.status-paid { background: #e3f4e8; color: #15803d; }
.status-pending { background: #fdf3dc; color: #92400e; }
.status-overdue { background: #fde4e4; color: #b42318; }
.status-unbilled { background: #f1f5f9; color: #64748b; }
.status-extra { background: #e8eefc; color: #1e3a8a; }

.fin-date {
  display: block;
  font-weight: 600;
  white-space: nowrap;
}

.fin-rel {
  display: block;
  font-size: 0.74rem;
  color: #6e6e73;
  white-space: nowrap;
}

.fin-rel--soon { color: #b45309; font-weight: 600; }
.fin-rel--late { color: #b42318; font-weight: 600; }

.fin-muted {
  color: #94a3b8;
}

.fin-amount--danger {
  color: #b42318;
  font-weight: 650;
}

.fin-row-actions {
  display: inline-flex;
  gap: 0.35rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.fin-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.fin-chip .pi {
  font-size: 0.7rem;
}

.fin-chip:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.fin-chip:disabled {
  opacity: 0.6;
  cursor: progress;
}

.fin-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 1.5rem 1rem;
  color: #6e6e73;
  font-size: 0.85rem;
  text-align: center;
}

.fin-empty .pi {
  font-size: 1.4rem;
  color: #cbd5e1;
}

.fin-paginator {
  margin-top: 0.5rem;
}

.fin-paginator :deep(.p-paginator) {
  background: transparent;
  padding: 0.4rem 0;
}

/* ---------- Dialog forms ---------- */
.fin-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem 1rem;
}

.fin-form--single {
  grid-template-columns: minmax(0, 1fr);
}

.fin-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.fin-field__label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.fin-input,
.fin-readonly,
.fin-number :deep(.p-inputnumber-input) {
  width: 100%;
  height: 2.6rem;
  padding: 0 0.8rem;
  border-radius: 12px;
  border: 1px solid #d2d2d7;
  background: #fff;
  font: inherit;
  font-size: 0.875rem;
  color: #0f172a;
  box-shadow: none;
}

.fin-number {
  width: 100%;
}

.fin-readonly {
  margin: 0;
  display: flex;
  align-items: center;
  background: #f1f5f9;
  border-color: transparent;
  font-weight: 600;
}

.fin-textarea {
  height: auto;
  min-height: 4.5rem;
  padding: 0.6rem 0.8rem;
  line-height: 1.4;
  resize: vertical;
}

.fin-input:focus,
.fin-number :deep(.p-inputnumber-input:focus) {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  border-color: #1e3a8a;
}

.fin-input:disabled,
.fin-number :deep(.p-inputnumber-input:disabled) {
  background: #f1f5f9;
  color: #475569;
  cursor: default;
}

.fin-input[aria-invalid='true'],
.fin-number :deep(.p-inputnumber-input.p-invalid),
.fin-number :deep(.p-invalid .p-inputnumber-input) {
  border-color: #dc2626;
  background: #fff7f7;
}

.fin-form-error {
  margin: 0.85rem 0 0;
  color: #b42318;
  font-size: 0.8rem;
}

.fin-locked {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0.9rem 0 0;
  padding: 0.6rem 0.75rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.78rem;
  line-height: 1.4;
}

.fin-locked .pi {
  margin-top: 0.1rem;
  font-size: 0.75rem;
}

.fin-dialog-hint {
  margin: 0.85rem 0 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

/* ---------- Receipts lists (history + receipts modal) ---------- */
.receipt-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.receipt-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  background: #fff;
  padding: 0.65rem 0.8rem;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.rc-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: 0.8rem;
  min-width: 0;
}

.rc-info span {
  color: #6e6e73;
}

.rc-info__name {
  color: #0f172a !important;
  font-weight: 600;
}

.rc-late-fee {
  color: #b45309 !important;
}

.rc-info strong {
  color: #0f172a;
  font-size: 0.92rem;
  font-weight: 650;
}

.rc-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.empty-list {
  color: #6e6e73;
  font-size: 0.8rem;
  justify-content: center !important;
  background: transparent !important;
  border: none !important;
}

.r-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.r-card {
  border-radius: 14px;
  padding: 0.8rem 0.85rem;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.06);
}

.r-card__row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.r-card__avatar {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: #e8eefc;
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
}

.r-card__body {
  flex: 1;
  min-width: 0;
}

.r-card__name {
  margin: 0;
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
}

.r-card__meta {
  margin: 0.15rem 0 0;
  font-size: 0.74rem;
  color: #6e6e73;
}

.charge-amount {
  flex-shrink: 0;
  font-size: 0.92rem;
  font-weight: 650;
  color: #0f172a;
}

.receipt-list--modal {
  margin-top: 0.7rem;
}

/* ---------- Loading ---------- */
.finance-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 45vh;
}

.import-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 2rem 1rem;
  color: #86868b;
  font-size: 0.875rem;
  text-align: center;
}

.import-status .pi {
  font-size: 1.5rem;
  color: #c7c7cc;
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
  .fin-head__controls {
    justify-content: flex-start;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .fin-head,
  .fin-head__controls,
  .fin-head__actions {
    width: 100%;
  }
  .fin-month {
    width: 100%;
    justify-content: space-between;
  }
  .fin-head__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .fin-btn {
    justify-content: center;
    padding-inline: 0.6rem;
  }
  .fin-btn--primary {
    grid-column: 1 / -1;
    order: -1;
  }
  .fin-alert,
  .fin-notice {
    border-radius: 16px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .fin-alert__btn {
    margin-left: auto;
  }
  .fin-card {
    padding: 1rem 0.85rem;
  }
  .fin-search {
    flex: 1 1 100%;
    min-width: 0;
  }
  .fin-form {
    grid-template-columns: minmax(0, 1fr);
  }

  /* The table becomes one card per resident. */
  .fin-table-wrap {
    overflow: visible;
  }
  .fin-table,
  .fin-table tbody,
  .fin-table tr,
  .fin-table td {
    display: block;
    width: 100%;
  }
  .fin-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  .fin-table tbody {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .fin-table tbody tr:not(.fin-table__empty-row) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.7rem 0.75rem;
    padding: 0.85rem;
    border-radius: 16px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: #fff;
  }
  .fin-table tbody tr:not(.fin-table__empty-row):hover td {
    background: transparent;
  }
  .fin-table td {
    padding: 0;
    border: none;
    text-align: left !important;
    min-width: 0;
  }
  .fin-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.25rem;
    font-size: 0.68rem;
    font-weight: 600;
    color: #6e6e73;
  }
  .fin-table .c-resident,
  .fin-table .c-actions {
    grid-column: 1 / -1;
  }
  .fin-table .c-actions {
    padding-top: 0.6rem;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
  }
  .fin-row-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }
  .fin-chip {
    justify-content: center;
    padding-block: 0.45rem;
  }
  .receipt-list li {
    flex-direction: column;
    align-items: stretch;
  }
  .receipt-list li > .fin-pill {
    align-self: flex-start;
  }
  .rc-actions {
    justify-content: space-between;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fin-btn {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.fin-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.fin-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.fin-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.fin-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.fin-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
}
</style>
