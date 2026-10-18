<script setup>
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import { residentExtraChargesApi } from '../../../finances/infrastructure/residentExtraChargesApi.js'
import { useFinancesStore } from '../../../finances/application/financesStore.js'
import { financesApi } from '../../../finances/infrastructure/financesApi.js'
import DebtTrafficLightGrid from '../../../finances/presentation/components/DebtTrafficLightGrid.vue'
import {
  applyLateFeeToReceipt,
  computeChargeDates,
  currentStatementMonthKey,
  findCharge,
  formatDayMonth,
  formatMonthLabel,
  normalizeCharge,
  normalizeMonthKey,
  normalizeSettings,
} from '../../../finances/domain/billingCycle.js'

const { t, locale } = useI18n()
const store = useFinancesStore()

const nfPen = computed(() => (value) => {
  const n = Number(value)
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
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

const chargeForm = ref({
  month: '',
  amount: null,
  billingStart: '',
  billingEnd: '',
  paymentOpen: '',
})
const chargeError = ref('')
const isSavingCharge = ref(false)

const selectedCharge = computed(() =>
  findCharge(editSettings.value.monthlyCharges, chargeForm.value.month),
)
const isChargeRegistered = computed(() => Boolean(selectedCharge.value))
const isReceiptsModalOpen = ref(false)
const extraCharges = ref([])
const extraSearch = ref('')
const residentsSearch = ref('')
const selectedResidentId = ref('')
const extraForm = ref({
  title: '',
  amount: null,
  description: '',
})
const extraError = ref('')
const isSavingExtra = ref(false)

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

function onChargeMonthChange() {
  resetChargeForm(chargeForm.value.month)
}

function settingsPayload() {
  return {
    lateFeePerDay: editSettings.value.lateFeePerDay,
    admissionPayFromDay: editSettings.value.admissionPayFromDay,
    admissionPayToDay: editSettings.value.admissionPayToDay,
    monthlyCharges: editSettings.value.monthlyCharges,
  }
}

onMounted(async () => {
  await store.loadData()
  applySettingsToForm(store.state.settings)
  resetChargeForm()
  extraCharges.value = await residentExtraChargesApi.list().catch(() => [])
  uiState.value.isLoaded = true
  await Promise.all([loadBillingAlerts(), loadCalendar()])
})

// --- RF021 / US021: alertas de facturación + generación manual (TS003) ---
const billingAlerts = ref([])
const isGeneratingReceipts = ref(false)
const generateMessage = ref('')
const generateTone = ref('ok')

async function loadBillingAlerts() {
  billingAlerts.value = await financesApi.getBillingAlerts().catch(() => [])
}

function billingAlertMonthLabel(alert) {
  return chargeMonthLabel(alert?.month) || String(alert?.month ?? '')
}

function focusChargeSettings(alert) {
  if (alert?.month) resetChargeForm(alert.month)
  document.getElementById('finance-settings-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  setTimeout(() => document.getElementById('chargeAmount')?.querySelector('input')?.focus(), 350)
}

async function onGenerateReceipts() {
  if (isGeneratingReceipts.value) return
  isGeneratingReceipts.value = true
  generateMessage.value = ''
  const month = store.currentBillingMonthKey.value
  try {
    const result = await store.generateMonthlyReceipts()
    const label = chargeMonthLabel(result?.month || month)
    generateTone.value = 'ok'
    generateMessage.value = Number(result?.created) > 0
      ? t('financeOps.generateDone', {
          created: result.created,
          month: label,
          already: Number(result.alreadyBilled) || 0,
        })
      : t('financeOps.generateNone', { month: label })
    await loadCalendar()
  } catch (e) {
    generateTone.value = 'error'
    generateMessage.value = e?.code === 'MISSING_MONTHLY_CHARGE'
      ? t('financeOps.generateMissing', { month: chargeMonthLabel(month) })
      : t('financeOps.generateError')
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

const filteredCalendarRows = computed(() => {
  const rows = calendar.value.residents || []
  const query = residentsSearch.value.trim().toLowerCase()
  if (!query) return rows
  return rows.filter((row) => residentSearchText(row).includes(query))
})

const calendarOverdueCount = computed(
  () => (calendar.value.residents || []).filter((row) => row.hasOverdue).length,
)

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

function residentLabel(resident) {
  if (!resident) return ''
  const code = String(resident.code ?? '').trim()
  return code ? `${resident.name} · ${code}` : String(resident.name ?? '')
}

const extraResidentMatches = computed(() => {
  const query = extraSearch.value.trim().toLowerCase()
  const residents = store.state.residents || []
  if (!query) return residents
  return residents.filter((resident) => residentSearchText(resident).includes(query))
})

const filteredResidentStatus = computed(() => {
  const rows = store.getResidentFinancialStatus.value || []
  const query = residentsSearch.value.trim().toLowerCase()
  if (!query) return rows
  return rows.filter((resident) => residentSearchText(resident).includes(query))
})

const selectedExtraResident = computed(
  () =>
    (store.state.residents || []).find(
      (resident) => String(resident.id) === String(selectedResidentId.value),
    ) || null,
)

const historyExtraCharges = computed(() => {
  const resident = selectedHistoryResident.value
  if (!resident) return []
  return extraCharges.value.filter(
    (item) => String(item.residentId) === String(resident.id),
  )
})

function selectExtraResident(resident) {
  selectedResidentId.value = resident.id
  extraSearch.value = residentLabel(resident)
  extraError.value = ''
}

function resetExtraForm() {
  extraForm.value = { title: '', amount: null, description: '' }
  extraError.value = ''
}

async function onAddExtraCharge() {
  if (!selectedResidentId.value) {
    extraError.value = t('financeAdmin.extraRequired')
    return
  }
  const title = String(extraForm.value.title ?? '').trim()
  const description = String(extraForm.value.description ?? '').trim()
  const amount = Number(extraForm.value.amount)
  if (!title || !description || !Number.isFinite(amount) || amount <= 0) {
    extraError.value = t('financeAdmin.extraRequired')
    return
  }

  isSavingExtra.value = true
  extraError.value = ''
  try {
    const created = await residentExtraChargesApi.add({
      residentId: selectedResidentId.value,
      title,
      amount,
      description,
    })
    extraCharges.value = [created, ...extraCharges.value]
    resetExtraForm()
    await store.loadData()
    applySettingsToForm(store.state.settings)
  } catch (e) {
    extraError.value = e.message
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

async function onSaveCharge() {
  const month = normalizeMonthKey(chargeForm.value.month)
  const amount = Number(chargeForm.value.amount)
  const billingStart = String(chargeForm.value.billingStart ?? '').trim()
  const billingEnd = String(chargeForm.value.billingEnd ?? '').trim()
  const paymentOpen = String(chargeForm.value.paymentOpen ?? '').trim()
  if (findCharge(editSettings.value.monthlyCharges, month)) {
    chargeError.value = t('financeAdmin.chargeLocked', { month: chargeMonthLabel(month) })
    return
  }
  if (!month || !Number.isFinite(amount) || amount <= 0 || !paymentOpen) {
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
    await persistCharges([nextCharge, ...editSettings.value.monthlyCharges])
    resetChargeForm(month)
    await loadBillingAlerts()
    alert(t('financeAdmin.chargeSaved'))
  } catch (e) {
    chargeError.value = e.message
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

const historySearch = ref('')
const selectedHistoryResidentId = ref('')

const historyResidentMatches = computed(() => {
  const query = historySearch.value.trim().toLowerCase()
  const residents = store.state.residents || []
  if (!query) return []
  return residents.filter((resident) => {
    const hay = `${resident.name ?? ''} ${resident.code ?? ''} ${resident.floor ?? ''}`.toLowerCase()
    return hay.includes(query)
  })
})

const selectedHistoryResident = computed(
  () =>
    (store.state.residents || []).find(
      (resident) => String(resident.id) === String(selectedHistoryResidentId.value),
    ) || null,
)

function selectHistoryResident(resident) {
  selectedHistoryResidentId.value = resident.id
  historySearch.value = resident.name
}

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
  if(status === 'Paid') return 'status-paid';
  if(status === 'Pending') return 'status-pending';
  if(status === 'Overdue') return 'status-overdue';
  if(status === 'Unbilled') return 'status-unbilled';
  if(status === 'Exempt') return 'status-unbilled';
  return '';
}

const residentsStatusMonthLabel = computed(() =>
  chargeMonthLabel(store.currentBillingMonthKey.value),
)
</script>

<template>
  <div v-if="uiState.isLoaded" class="app-view">
    <div class="finance-page">
      <div
        v-for="alertItem in billingAlerts"
        :key="`${alertItem.code}-${alertItem.month}`"
        class="billing-alert"
        role="alert"
      >
        <i class="pi pi-exclamation-triangle billing-alert__icon" aria-hidden="true" />
        <div class="billing-alert__text">
          <strong>{{ t('financeOps.billingAlertTitle') }}</strong>
          <span>{{ t('financeOps.billingAlertBody', { month: billingAlertMonthLabel(alertItem) }) }}</span>
        </div>
        <Button
          type="button"
          class="billing-alert__btn"
          :label="t('financeOps.billingAlertAction')"
          @click="focusChargeSettings(alertItem)"
        />
      </div>

      <section class="finance-panel import-panel" aria-labelledby="finance-settings-heading">
        <div class="mgmt-panel-toolbar">
          <h2 id="finance-settings-heading" class="finance-panel__section-title finance-panel__section-title--plain">
            <i class="pi pi-cog" aria-hidden="true" />
            {{ t('financeAdmin.settingsTitle') }}
          </h2>
          <Button
            type="button"
            class="import-dropzone__btn"
            :label="t('financeAdmin.viewReceipts')"
            @click="openReceiptsModal"
          />
        </div>

        <div class="settings-grid">
          <label class="settings-field" for="chargeMonth">
            <span>{{ t('financeAdmin.chargeMonth') }}</span>
            <input
              id="chargeMonth"
              v-model="chargeForm.month"
              type="month"
              class="settings-native-input"
              @change="onChargeMonthChange"
            />
          </label>
          <div class="settings-field">
            <span>{{ t('financeAdmin.chargePeriod') }}</span>
            <p class="settings-period">{{ chargePeriodLabel }}</p>
          </div>
          <label class="settings-field" for="chargePaymentOpen">
            <span>{{ t('financeAdmin.chargePaymentOpen') }}</span>
            <input
              id="chargePaymentOpen"
              v-model="chargeForm.paymentOpen"
              type="date"
              class="settings-native-input"
              :disabled="isChargeRegistered"
            />
          </label>
          <label class="settings-field" for="chargeAmount">
            <span>{{ t('financeAdmin.chargeAmount') }}</span>
            <InputNumber
              id="chargeAmount"
              v-model="chargeForm.amount"
              :minFractionDigits="2"
              :maxFractionDigits="2"
              :min="0"
              mode="currency"
              currency="PEN"
              locale="es-PE"
              class="settings-input"
              :disabled="isChargeRegistered"
            />
          </label>
        </div>

        <div class="settings-actions">
          <p v-if="chargeError" class="settings-error">{{ chargeError }}</p>
          <p v-else-if="isChargeRegistered" class="settings-locked">
            {{ t('financeAdmin.chargeLocked', { month: chargeMonthLabel(chargeForm.month) }) }}
          </p>
          <Button
            v-if="!isChargeRegistered"
            type="button"
            class="import-dropzone__btn"
            :label="t('financeAdmin.addCharge')"
            :loading="isSavingCharge"
            @click="onSaveCharge"
          />
        </div>

        <div class="settings-billing">
          <p class="settings-billing__hint">{{ t('financeOps.generateHint') }}</p>
          <p
            v-if="generateMessage"
            class="settings-billing__msg"
            :class="{ 'settings-billing__msg--error': generateTone === 'error' }"
            role="status"
          >
            {{ generateMessage }}
          </p>
          <Button
            type="button"
            class="import-dropzone__btn"
            icon="pi pi-file-plus"
            :label="t('financeOps.generateNow', { month: residentsStatusMonthLabel })"
            :loading="isGeneratingReceipts"
            @click="onGenerateReceipts"
          />
        </div>
      </section>

      <section
        class="finance-panel finance-panel--table import-panel"
        aria-labelledby="finance-residents-heading"
      >
        <div class="mgmt-panel-toolbar">
          <h2 id="finance-residents-heading" class="finance-panel__section-title">
            <i class="pi pi-users" aria-hidden="true" />
            {{ t('financeAdmin.residentsPanelTitle') }}
            <span class="finance-panel__title-month">{{ residentsStatusMonthLabel }}</span>
          </h2>
        </div>
        <label class="settings-field" for="residentsStatusSearch">
          <input
            id="residentsStatusSearch"
            v-model="residentsSearch"
            type="search"
            class="settings-native-input"
            :placeholder="t('financeAdmin.extraSearchPlaceholder')"
            :aria-label="t('financeAdmin.extraSearch')"
          />
        </label>
          <DataTable
            :value="filteredResidentStatus"
            responsiveLayout="scroll"
            class="finance-data finance-table"
            :paginator="true"
            :rows="10"
            :empty-message="t('financeAdmin.extraNoResidents')"
          >
            <Column field="name" :header="t('financeAdmin.tableResident')">
              <template #body="slotProps">
                <div class="resident-info">
                  <strong>{{ slotProps.data.name }}</strong>
                  <small>{{
                    t('financeAdmin.residentFloorApt', {
                      floor: slotProps.data.floor,
                      code: slotProps.data.code,
                    })
                  }}</small>
                </div>
              </template>
            </Column>
            <Column field="admissionDate" :header="t('financeAdmin.tableAdmission')" />
            <Column field="nextPaymentDate" :header="t('financeAdmin.tableNextPayment')">
              <template #body="slotProps">
                <span class="finance-date-cell">{{ slotProps.data.nextPaymentDate }}</span>
              </template>
            </Column>
            <Column :header="t('financeAdmin.tableCountdown')">
              <template #body="slotProps">
                <span
                  class="days-left"
                  :class="{ urgent: slotProps.data.daysUntilNextPayment <= 5 }"
                >
                  {{ t('financeAdmin.daysRemaining', { n: slotProps.data.daysUntilNextPayment }) }}
                </span>
              </template>
            </Column>
            <Column :header="t('financeAdmin.tableMonthStatus', { month: residentsStatusMonthLabel })">
              <template #body="slotProps">
                <span
                  class="status-badge"
                  :class="getStatusBadgeClass(slotProps.data.monthStatus)"
                >
                  {{ t(`financeAdmin.status${slotProps.data.monthStatus}`) }}
                </span>
              </template>
            </Column>
          </DataTable>
      </section>

      <section class="finance-panel import-panel" aria-labelledby="finance-traffic-heading">
        <div class="mgmt-panel-toolbar">
          <h2 id="finance-traffic-heading" class="finance-panel__section-title">
            <i class="pi pi-circle-fill traffic-title-icon" aria-hidden="true" />
            {{ t('financeOps.trafficTitle') }}
            <span v-if="calendarOverdueCount" class="finance-panel__title-month traffic-title-count">
              {{ t('financeOps.trafficOverdueCount', { n: calendarOverdueCount }) }}
            </span>
          </h2>
        </div>
        <p class="traffic-hint">{{ t('financeOps.trafficHint') }}</p>
        <DebtTrafficLightGrid
          :months="calendar.months"
          :residents="filteredCalendarRows"
          :due-soon-days="calendar.dueSoonDays"
          :loading="calendarLoading"
          :error="calendarError"
        />
      </section>

      <div class="finance-split">
      <section
        class="finance-panel import-panel"
        aria-labelledby="finance-extra-heading"
      >
        <div class="mgmt-panel-toolbar">
          <h2 id="finance-extra-heading" class="finance-panel__section-title">
            <i class="pi pi-plus-circle" aria-hidden="true" />
            {{ t('financeAdmin.extraTitle') }}
          </h2>
        </div>

        <label class="settings-field" for="extraResidentSearch">
          <input
            id="extraResidentSearch"
            v-model="extraSearch"
            type="search"
            class="settings-native-input"
            :placeholder="t('financeAdmin.extraSearchPlaceholder')"
            :aria-label="t('financeAdmin.extraSearch')"
            @input="selectedResidentId = ''"
          />
        </label>

        <ul v-if="extraSearch.trim() && !selectedExtraResident" class="extra-resident-list" role="listbox">
          <li v-if="!extraResidentMatches.length" class="extra-resident-list__empty">
            {{ t('financeAdmin.extraNoResidents') }}
          </li>
          <li
            v-for="resident in extraResidentMatches"
            :key="resident.id"
            class="extra-resident-list__item"
            role="option"
            @click="selectExtraResident(resident)"
          >
            <strong>{{ resident.name }}</strong>
            <span>{{
              t('financeAdmin.residentFloorApt', {
                floor: resident.floor,
                code: resident.code,
              })
            }}</span>
          </li>
        </ul>

        <div class="settings-grid extra-form-grid">
          <label class="settings-field" for="extraTitle">
            <span>{{ t('financeAdmin.extraAmountTitle') }}</span>
            <input
              id="extraTitle"
              v-model="extraForm.title"
              type="text"
              maxlength="80"
              class="settings-native-input"
              :disabled="!selectedResidentId"
            />
          </label>
          <label class="settings-field" for="extraAmount">
            <span>{{ t('financeAdmin.extraAmount') }}</span>
            <InputNumber
              id="extraAmount"
              v-model="extraForm.amount"
              :minFractionDigits="2"
              :maxFractionDigits="2"
              :min="0"
              mode="currency"
              currency="PEN"
              locale="es-PE"
              class="settings-input"
              :disabled="!selectedResidentId"
            />
          </label>
          <label class="settings-field extra-form-grid__full" for="extraDescription">
            <span>{{ t('financeAdmin.extraDescription') }}</span>
            <textarea
              id="extraDescription"
              v-model="extraForm.description"
              class="settings-native-input settings-textarea"
              maxlength="240"
              rows="2"
              :disabled="!selectedResidentId"
            />
          </label>
        </div>

        <div class="settings-actions">
          <p v-if="extraError" class="settings-error">{{ extraError }}</p>
          <Button
            type="button"
            class="import-dropzone__btn"
            :label="t('financeAdmin.extraAdd')"
            :loading="isSavingExtra"
            :disabled="!selectedResidentId"
            @click="onAddExtraCharge"
          />
        </div>
      </section>

      <section
        class="finance-panel finance-panel--history import-panel"
        aria-labelledby="finance-history-heading"
      >
        <div class="mgmt-panel-toolbar">
          <h2 id="finance-history-heading" class="finance-panel__section-title">
            <i class="pi pi-wallet" aria-hidden="true" />
            {{ t('financeAdmin.paymentHistory') }}
          </h2>
        </div>

        <label class="settings-field" for="historyResidentSearch">
          <input
            id="historyResidentSearch"
            v-model="historySearch"
            type="search"
            class="settings-native-input"
            :placeholder="t('financeAdmin.extraSearchPlaceholder')"
            :aria-label="t('financeAdmin.historySearch')"
            @input="selectedHistoryResidentId = ''"
          />
        </label>

        <ul v-if="historySearch.trim() && !selectedHistoryResident" class="extra-resident-list" role="listbox">
          <li v-if="!historyResidentMatches.length" class="extra-resident-list__empty">
            {{ t('financeAdmin.extraNoResidents') }}
          </li>
          <li
            v-for="resident in historyResidentMatches"
            :key="resident.id"
            class="extra-resident-list__item"
            role="option"
            @click="selectHistoryResident(resident)"
          >
            <strong>{{ resident.name }}</strong>
            <span>{{
              t('financeAdmin.residentFloorApt', {
                floor: resident.floor,
                code: resident.code,
              })
            }}</span>
          </li>
        </ul>

        <div v-if="!selectedHistoryResident" class="import-empty">
          <i class="pi pi-search" aria-hidden="true" />
          <span>{{ t('financeAdmin.historySearchHint') }}</span>
        </div>
        <div v-else>
          <p class="settings-locked">
            {{ t('financeAdmin.extraSelected', { name: selectedHistoryResident.name }) }}
          </p>
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
                <span class="small-badge status-paid">{{ t('financeAdmin.statusPaid') }}</span>
                <button
                  type="button"
                  class="rc-download"
                  :disabled="downloadingReceiptId === String(rc.id)"
                  :aria-label="`${t('financeOps.downloadReceipt')} · ${rc.monthLabel}`"
                  @click="downloadPaidReceipt(rc)"
                >
                  <i class="pi pi-download" aria-hidden="true" />
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
              <span class="small-badge">{{ t('financeAdmin.receiptExtraLabel') }}</span>
            </li>
          </ul>
          <div v-else class="import-empty">
            <i class="pi pi-inbox" aria-hidden="true" />
            <span>{{ t('financeAdmin.historyEmptyPaid') }}</span>
          </div>
          <p v-if="downloadError" class="settings-error" role="alert">{{ downloadError }}</p>
        </div>
      </section>
      </div>

      <p class="mgmt-view-footer" role="note">
        {{ t('financeAdmin.subtitle') }}
      </p>
    </div>

    <div
      v-if="isReceiptsModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeReceiptsModal"
    >
      <section
        class="resident-modal resident-modal--wide bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('financeAdmin.receiptsModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('financeAdmin.receiptsModalTitle') }}</h3>
        <div v-if="!chargeReceiptGroups.length" class="import-empty">
          <i class="pi pi-inbox" aria-hidden="true" />
          <span>{{ t('financeAdmin.emptyCharges') }}</span>
        </div>
        <ul v-else class="r-list charge-list" role="list">
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
                  <span>{{ rc.residentName }}</span>
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
                <span class="small-badge" :class="getStatusBadgeClass(rc.statusKey)">
                  {{ t(`financeAdmin.status${rc.statusKey}`) }}
                </span>
              </li>
              <li v-if="!group.receipts.length" class="empty-list">
                {{ t('financeAdmin.emptyChargeReceipts') }}
              </li>
            </ul>
          </li>
        </ul>
        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.closeAction')"
          :stagger="false"
          @confirm="closeReceiptsModal"
        />
      </section>
    </div>
  </div>

  <div v-else class="app-view finance-loading" role="status" aria-live="polite">
    <div class="import-status">
      <i class="pi pi-spin pi-spinner" aria-hidden="true" />
      <span>{{ t('financeAdmin.loading') }}</span>
    </div>
  </div>
</template>

<style scoped>
.billing-alert {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  padding: 0.9rem 1.1rem;
  border-radius: 14px;
  background: #fff4e5;
  border: 1px solid #ffd8a8;
  color: #7a3e00;
}

.billing-alert__icon {
  font-size: 1.15rem;
  color: #e65100;
}

.billing-alert__text {
  flex: 1;
  min-width: 14rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.85rem;
  line-height: 1.4;
}

.billing-alert__btn {
  flex-shrink: 0;
}

.settings-billing {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  margin-top: 1rem;
  padding-top: 0.9rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.settings-billing__hint {
  flex: 1;
  min-width: 14rem;
  margin: 0;
  font-size: 0.78rem;
  color: #6e6e73;
}

.settings-billing__msg {
  margin: 0;
  font-size: 0.8125rem;
  color: #1b7a3d;
}

.settings-billing__msg--error {
  color: #b42318;
}

.traffic-hint {
  margin: -0.35rem 0 0.85rem;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.traffic-title-icon {
  color: #ff3b30;
  font-size: 0.8rem;
}

.traffic-title-count {
  color: #b42318;
}

.rc-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.rc-download {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1d1d1f;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.rc-download:hover:not(:disabled) {
  background: #f5f5f7;
}

.rc-download:disabled {
  opacity: 0.6;
  cursor: progress;
}

.app-view {
  padding: 1.75rem 1.5rem 1.25rem;
  width: 100%;
  max-width: none;
  min-height: 100dvh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.finance-page {
  margin-top: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-height: 0;
}

.finance-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 2.5rem;
  align-items: start;
}

.finance-split > .finance-panel {
  min-width: 0;
}

@media (max-width: 900px) {
  .finance-split {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
  }
}

.finance-panel {
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.finance-panel--table {
  padding: 1.2rem 1.25rem 1.35rem;
  overflow: hidden;
}

.finance-panel__section-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--apple-text, #1d1d1f);
  text-transform: capitalize;
}

.finance-panel__section-title .pi {
  font-size: 1.25rem;
  color: #0071e3;
}

.finance-panel__section-title--plain {
  text-transform: none;
}

.mgmt-panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.mgmt-panel-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.finance-panel > .settings-field {
  --settings-control-height: 2.75rem;
}

.finance-panel--table > .settings-field {
  margin-bottom: 0.85rem;
}

.mgmt-view-footer {
  margin-top: auto;
  padding: 1.5rem 0 0.25rem;
  width: 100%;
  text-align: center;
  font-size: 0.6875rem;
  font-weight: 400;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: #aeaeb2;
}

.app-view :deep(.import-dropzone__btn.p-button) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.8125rem;
  box-shadow: none;
  border: none;
  background: #0071e3;
  color: #ffffff;
}

.app-view :deep(.import-dropzone__btn.p-button:hover) {
  background: #0066cc;
  color: #ffffff;
}

.import-panel .finance-table {
  margin-top: 0.65rem;
}

.finance-panel__title-month {
  display: inline-block;
  margin-left: 0.35rem;
  text-transform: capitalize;
  color: #86868b;
  font-weight: 500;
}

.finance-table {
  margin-top: 0.15rem;
}

.finance-data :deep(.p-datatable) {
  font-size: 0.875rem;
  border: none;
  border-radius: 12px;
  overflow: hidden;
}

.finance-data :deep(.p-datatable-wrapper) {
  border-radius: 12px;
}

.finance-data :deep(.p-datatable-header) {
  background: transparent;
  border: none;
  padding: 0;
}

.finance-data :deep(.p-datatable-thead > tr > th) {
  background: rgba(0, 0, 0, 0.02);
  color: #86868b;
  font-weight: 600;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.055em;
  border: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding: 0.6rem 0.75rem;
}

.finance-data :deep(.p-datatable-tbody > tr) {
  background: transparent;
  transition: background 0.12s ease;
}

.finance-data :deep(.p-datatable-tbody > tr:hover) {
  background: rgba(0, 0, 0, 0.02);
}

.finance-data :deep(.p-datatable-tbody > tr > td) {
  border: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  padding: 0.7rem 0.75rem;
  vertical-align: middle;
  color: var(--apple-text, #1d1d1f);
}

.finance-data :deep(.p-datatable-tbody > tr:last-child > td) {
  border-bottom: none;
}

.finance-data :deep(.p-paginator) {
  background: transparent;
  border: none;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding: 0.6rem 0.5rem;
  font-size: 0.8125rem;
  --p-paginator-page-selected-background: #dbeafe;
  --p-paginator-page-selected-color: #0071e3;
}

.finance-data :deep(.p-paginator .p-paginator-page) {
  min-width: 2rem;
  height: 2rem;
  border-radius: 50%;
}

.finance-data :deep(.p-paginator .p-paginator-page.p-highlight),
.finance-data :deep(.p-paginator .p-paginator-page[data-p-active="true"]),
.finance-data :deep(.p-paginator .p-paginator-page.p-paginator-page-selected) {
  background: #dbeafe;
  color: #0071e3;
  border-color: transparent;
}

.finance-date-cell {
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.resident-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.resident-info strong {
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.resident-info small {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.75rem;
}

.days-left {
  font-weight: 600;
  font-size: 0.8125rem;
  color: #0071e3;
  background: rgba(0, 113, 227, 0.08);
  padding: 0.25rem 0.55rem;
  border-radius: 8px;
}

.days-left.urgent {
  color: #ff3b30;
  background: rgba(255, 59, 48, 0.08);
}

.status-badge {
  padding: 0.25rem 0.65rem;
  border-radius: 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status-paid {
  background: rgba(52, 199, 89, 0.14);
  color: #248a3d;
}

.status-pending {
  background: rgba(255, 149, 0, 0.14);
  color: #c35b00;
}

.status-overdue {
  background: rgba(255, 59, 48, 0.12);
  color: #d70015;
}

.status-unbilled {
  background: rgba(142, 142, 147, 0.14);
  color: #6e6e73;
}

.finance-history__toolbar {
  margin-bottom: 0.65rem;
}

.finance-history__floor-filter {
  min-width: 11rem;
  flex: 0 1 auto;
}

.finance-history__floor-filter :deep(.p-dropdown) {
  border-radius: 8px;
  border: 1px solid #d2d2d7;
  background: #fff;
  font-size: 0.875rem;
  box-shadow: none;
}

.finance-history__floor-filter :deep(.p-dropdown:not(.p-disabled):hover) {
  border-color: rgba(0, 0, 0, 0.14);
}

.finance-history__floor-filter :deep(.p-dropdown:not(.p-disabled).p-focus) {
  outline: none;
  border-color: #0071e3;
  box-shadow: none;
}

.finance-history__floor-filter :deep(.p-dropdown-label) {
  padding: 0.5rem 0.75rem;
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.floor-section {
  margin-bottom: 1.75rem;
}

.floor-section:last-child {
  margin-bottom: 0;
}

.floor-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: capitalize;
  letter-spacing: -0.01em;
  color: #86868b;
  padding-bottom: 0.5rem;
  margin-bottom: 0.5rem;
}

.history-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.finance-card {
  padding: 1.1rem 1.2rem;
  border-radius: 10px;
  background: #fafafa;
  border: 1px solid rgba(0, 0, 0, 0.06);
  transition: box-shadow 0.15s ease;
}

.finance-card:hover {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.finance-card h4 {
  margin: 0 0 0.85rem;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.apt-code {
  color: var(--apple-text-secondary, #6e6e73);
  font-weight: 500;
  font-size: 0.8125rem;
}

.receipt-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.receipt-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  background: #fff;
  padding: 0.65rem 0.75rem;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.rc-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: 0.8125rem;
}

.rc-info span {
  color: var(--apple-text-secondary, #6e6e73);
}

.rc-late-fee {
  color: #c35b00 !important;
}

.rc-info strong {
  color: var(--apple-text, #1d1d1f);
  font-size: 0.9375rem;
  font-weight: 600;
}

.small-badge {
  font-size: 0.6875rem;
  padding: 0.2rem 0.45rem;
  border-radius: 6px;
  font-weight: 600;
}

.empty-list {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.8125rem;
  justify-content: center !important;
  background: transparent !important;
  border: none !important;
}

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

.settings-grid {
  --settings-control-height: 2.75rem;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem 1.25rem;
}

@media (max-width: 720px) {
  .settings-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.extra-form-grid {
  --settings-control-height: 1.375rem;
  margin-top: 1rem;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.65rem 1.25rem;
}

.extra-form-grid .settings-native-input,
.extra-form-grid .settings-input :deep(.p-inputnumber),
.extra-form-grid .settings-input :deep(.p-inputnumber-input) {
  height: var(--settings-control-height);
  line-height: var(--settings-control-height);
  font-size: 0.8125rem;
  padding: 0 0.55rem;
}

.extra-form-grid .settings-input :deep(.p-inputnumber-input) {
  line-height: var(--settings-control-height);
}

.extra-form-grid__full {
  grid-column: 1 / -1;
}

.settings-textarea {
  height: auto;
  min-height: 2.15rem;
  line-height: 1.3;
  padding: 0.3rem 0.55rem;
  resize: vertical;
}

.extra-resident-list {
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  background: #fff;
  max-height: 12rem;
  overflow-y: auto;
}

.extra-resident-list__item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.65rem 0.8rem;
  cursor: pointer;
}

.extra-resident-list__item + .extra-resident-list__item {
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}

.extra-resident-list__item strong {
  font-size: 0.875rem;
  color: #1d1d1f;
}

.extra-resident-list__item span {
  font-size: 0.75rem;
  color: #86868b;
}

.extra-resident-list__item:hover,
.extra-resident-list__item--active {
  background: #f0f7ff;
}

.extra-resident-list__empty {
  padding: 0.75rem 0.8rem;
  color: #86868b;
  font-size: 0.8125rem;
}

.settings-field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  text-transform: none;
}

.settings-field span {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6e6e73;
}

.settings-period {
  margin: 0;
  height: var(--settings-control-height);
  display: flex;
  align-items: center;
  padding: 0 0.7rem;
  border-radius: 8px;
  background: #f5f5f7;
  font-size: 0.875rem;
  font-weight: 600;
  color: #1d1d1f;
  box-sizing: border-box;
}

.settings-input {
  width: 100%;
  height: var(--settings-control-height);
}

.settings-input :deep(.p-inputnumber),
.settings-input :deep(.p-inputnumber-input) {
  width: 100%;
  height: var(--settings-control-height);
}

.settings-input :deep(.p-inputnumber-input) {
  border-radius: 8px;
  border: 1px solid #d2d2d7;
  font-size: 0.875rem;
  padding: 0 0.7rem;
  line-height: var(--settings-control-height);
  box-shadow: none;
  box-sizing: border-box;
}

.settings-input :deep(.p-inputnumber:not(.p-disabled):hover .p-inputnumber-input) {
  border-color: rgba(0, 0, 0, 0.14);
}

.settings-input :deep(.p-inputnumber.p-inputnumber-focus .p-inputnumber-input) {
  border-color: #0071e3;
  box-shadow: none;
  outline: none;
}

.settings-native-input {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: var(--settings-control-height);
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: 0 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  line-height: var(--settings-control-height);
  color: #1d1d1f;
  background: #fff;
  box-sizing: border-box;
}

.settings-native-input::-webkit-date-and-time-value {
  text-align: left;
  min-width: 100%;
}

.settings-native-input:focus {
  outline: none;
  border-color: #0071e3;
}

.settings-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.15rem;
}

.settings-error {
  margin: 0;
  margin-right: auto;
  color: #ff3b30;
  font-size: 0.78rem;
}

.settings-locked {
  margin: 0;
  margin-right: auto;
  color: #86868b;
  font-size: 0.78rem;
}

.settings-native-input:disabled,
.settings-input :deep(.p-inputnumber.p-disabled .p-inputnumber-input) {
  background: #f5f5f7;
  color: #1d1d1f;
  cursor: default;
}

.charge-saved {
  margin-top: 1.5rem;
  padding-top: 1.15rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.charge-saved__title {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: #1d1d1f;
}

.charge-amount {
  flex-shrink: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1d1d1f;
}

.import-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 1.5rem 1rem;
  margin-top: 0.85rem;
  color: #86868b;
  font-size: 0.875rem;
  text-align: center;
}

.import-empty .pi {
  font-size: 1.5rem;
  color: #c7c7cc;
}

.charge-list {
  margin-top: 0.85rem;
}

.r-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.r-card {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  padding: 0.75rem 0.85rem;
  background: #fafafa;
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
  background: #e8e8ed;
  color: #6e6e73;
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
  font-weight: 600;
  font-size: 0.875rem;
  color: #1d1d1f;
}

.r-card__meta {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: #86868b;
}

.r-card__actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.25rem;
}

.receipt-list--modal {
  margin-top: 0.75rem;
}

.resident-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1000;
}

.resident-modal {
  width: min(100%, 26rem);
  background: #ffffff;
  border-radius: 14px;
  border: 1px solid #e8e8ed;
  padding: 1.15rem;
  max-height: 90vh;
  overflow-y: auto;
}

.resident-modal--wide {
  width: min(100%, 36rem);
}

.resident-modal__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #1d1d1f;
}

.resident-modal .charge-list {
  margin-top: 0.85rem;
}

.resident-modal .bf-actions {
  margin-top: 1rem;
}

.app-view :deep(.bf-btn) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  box-shadow: none;
  transform: none;
}

.app-view :deep(.bf-btn--confirm) {
  background: #0071e3;
  color: #ffffff;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):hover) {
  background: #0066cc;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):focus-visible) {
  animation: none;
  box-shadow: none;
}
</style>
