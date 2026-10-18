<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import Toast from 'primevue/toast'
import { useToast } from 'primevue/usetoast'
import { useRoute, useRouter } from 'vue-router'
import {
  checkoutMaintenanceFees,
  confirmMaintenancePayment,
} from '@/finances/infrastructure/mercadoPagoService.js'
import {
  clearPendingCheckout,
  MpPendingKeys,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { useResidentPaymentStore } from '@/finances/application/residentPaymentStore.js'
import { financesApi } from '@/finances/infrastructure/financesApi.js'
import DebtTrafficLightGrid from '@/finances/presentation/components/DebtTrafficLightGrid.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const { t, locale } = useI18n()
const { state } = useSession()
const route = useRoute()
const router = useRouter()
const { state: paymentState, loadData } = useResidentPaymentStore()
const toast = useToast()

const profile = computed(() => state.profile ?? {})
const todayIso = new Date().toISOString().slice(0, 10)
const isProcessing = ref(false)

const fees = computed(() => paymentState.fees || [])
const paymentHistory = computed(() =>
  [...(paymentState.paymentHistory || [])].sort((a, b) =>
    String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')),
  ),
)

const pendingFees = computed(() =>
  fees.value
    .filter((f) => f.status === 'Pendiente')
    .slice()
    .sort((a, b) => String(a.dueDate ?? '').localeCompare(String(b.dueDate ?? ''))),
)

const pendingTotal = computed(() =>
  pendingFees.value.reduce((sum, f) => sum + Number(f.amount || 0), 0),
)

const hasOverdue = computed(() =>
  pendingFees.value.some((f) => getDaysUntilDue(f.dueDate) < 0),
)

onMounted(async () => {
  if (profile.value.id) await Promise.all([loadData(profile.value.id), loadMyCalendar()])
  await handlePaymentReturnFromRoute()
})

watch(
  () => profile.value.id,
  async (id, prev) => {
    if (id && id !== prev) await Promise.all([loadData(id), loadMyCalendar()])
  },
)

// RF029: mis meses en el semáforo (el backend limita al residente autenticado).
const myCalendar = ref({ months: [], residents: [], dueSoonDays: 5 })
const myCalendarLoading = ref(false)
const myCalendarError = ref('')

async function loadMyCalendar() {
  myCalendarLoading.value = true
  myCalendarError.value = ''
  try {
    myCalendar.value = await financesApi.getPaymentCalendar({ months: 6 })
  } catch {
    myCalendarError.value = t('financeOps.trafficLoadError')
  } finally {
    myCalendarLoading.value = false
  }
}

// RF022 / US022: recibo descargable del pago aprobado.
const downloadingPaymentId = ref('')

async function downloadReceipt(pay) {
  if (!pay?.id || downloadingPaymentId.value) return
  downloadingPaymentId.value = String(pay.id)
  try {
    await financesApi.downloadPaymentReceipt(pay.id)
  } catch {
    toast.add({
      severity: 'error',
      summary: t('financeOps.downloadReceipt'),
      detail: t('financeOps.downloadError'),
      life: 4000,
    })
  } finally {
    downloadingPaymentId.value = ''
  }
}

async function handlePaymentReturnFromRoute() {
  if (!profile.value.id) return

  const status = String(
    route.query.status ?? route.query.collection_status ?? route.query.payment ?? '',
  ).toLowerCase()
  const paymentRaw = route.query.payment_id ?? route.query.collection_id
  const hasReturn = Boolean(status || paymentRaw)
  if (!hasReturn) return

  const clearReturn = () => {
    clearPendingCheckout(MpPendingKeys.maintenance)
    router.replace({ path: route.path })
  }

  if (status === 'failure' || status === 'rejected' || status === 'cancelled' || status === 'null') {
    toast.add({
      severity: 'error',
      summary: t('residentFinance.paymentErrorTitle'),
      detail: t('residentFinance.paymentErrorDetail'),
      life: 5000,
    })
    clearReturn()
    return
  }

  if (status === 'pending' || status === 'in_process' || status === 'in_mediation') {
    toast.add({
      severity: 'warn',
      summary: t('residentFinance.paymentPendingTitle'),
      detail: t('residentFinance.paymentPendingDetail'),
      life: 5000,
    })
    clearReturn()
    return
  }

  if (status && status !== 'success' && status !== 'approved') return

  try {
    const paymentId = paymentRaw != null && String(paymentRaw).length ? Number(paymentRaw) : null

    if (!Number.isFinite(paymentId)) {
      toast.add({
        severity: 'warn',
        summary: t('residentFinance.paymentPendingTitle'),
        detail: t('residentFinance.paymentPendingDetail'),
        life: 5000,
      })
      clearReturn()
      return
    }

    await confirmMaintenancePayment({
      residentId: profile.value.id,
      paymentId,
    })

    await Promise.all([loadData(profile.value.id), loadMyCalendar()])
    toast.add({
      severity: 'success',
      summary: t('residentFinance.paymentSuccessTitle'),
      detail: `${t('residentFinance.paymentSuccessDetail')} ${t('financeOps.paymentReceiptReady')}`,
      life: 6000,
    })
  } catch {
    await loadData(profile.value.id)
    toast.add({
      severity: 'warn',
      summary: t('residentFinance.paymentPendingTitle'),
      detail: t('residentFinance.paymentPendingDetail'),
      life: 5000,
    })
  } finally {
    clearReturn()
  }
}

async function startMaintenanceCheckout() {
  if (isProcessing.value || pendingTotal.value === 0 || !profile.value.id) return

  isProcessing.value = true
  try {
    const checkout = await checkoutMaintenanceFees({
      residentId: profile.value.id,
      payerEmail: profile.value.email || undefined,
      amount: pendingTotal.value,
      title: t('residentFinance.payNow'),
    })

    if (checkout.initPoint) {
      window.location.assign(checkout.initPoint)
      return
    }

    throw new Error(t('residentFinance.paymentErrorDetail'))
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: t('residentFinance.paymentErrorTitle'),
      detail: err?.payload?.message || err?.message || t('residentFinance.paymentErrorDetail'),
      life: 5000,
    })
  } finally {
    isProcessing.value = false
  }
}

function getDaysUntilDue(dueDate) {
  const due = new Date(dueDate + 'T00:00:00')
  const now = new Date(todayIso + 'T00:00:00')
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24))
}

function feeStatusLabel(fee) {
  const days = getDaysUntilDue(fee.dueDate)
  if (days < 0) return t('residentFinance.statusOverdue')
  if (days <= 5) return t('residentFinance.statusDueSoon')
  return t('residentFinance.statusPending')
}

function feeStatusClass(fee) {
  const days = getDaysUntilDue(fee.dueDate)
  if (days < 0) return 'inc-badge--open'
  if (days <= 5) return 'inc-badge--in-progress'
  return 'guest-badge--yes'
}

function formatMoney(val) {
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(val) || 0)
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return String(iso)
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return (
    d.toLocaleDateString(loc, { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
  )
}

function formatDueDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00')
  if (!Number.isFinite(d.getTime())) return String(iso)
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return d.toLocaleDateString(loc, { day: '2-digit', month: 'short', year: 'numeric' })
}

const monthNamesEs = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
]
const monthNamesEn = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function translateMonth(value) {
  if (!value) return '—'
  const str = String(value).trim()

  const dateMatch = str.match(/^(\d{4})-(\d{2})/)
  if (dateMatch) {
    const d = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, 1)
    const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
    return d.toLocaleDateString(loc, { month: 'long', year: 'numeric' })
  }

  const esIdx = monthNamesEs.findIndex((m) => str.includes(m))
  if (esIdx >= 0) {
    const yearMatch = str.match(/(\d{4})/)
    const year = yearMatch ? yearMatch[1] : ''
    const name = locale.value === 'es' ? monthNamesEs[esIdx] : monthNamesEn[esIdx]
    return year ? `${name} ${year}` : name
  }

  return str
}
</script>

<template>
  <div class="app-view app-view--ai">
    <Toast position="top-right" />

    <h1 class="visually-hidden">{{ t('resident.financeTitle') }}</h1>

    <div class="finance-page">
      <LoadErrorRetry
        v-if="paymentState.error"
        :loading="paymentState.isLoading"
        @retry="loadData(profile.id)"
      />

      <!-- Recibos por pagar -->
      <section class="finance-panel" aria-labelledby="pending-heading">
        <div class="panel-head">
          <h2 id="pending-heading" class="finance-panel__section-title">
            {{ t('residentFinance.pendingReceiptsTitle') }}
          </h2>
          <p v-if="pendingFees.length" class="panel-head__meta">
            {{ formatMoney(pendingTotal) }}
          </p>
        </div>

        <p v-if="paymentState.isLoading" class="dash-empty">…</p>
        <p v-else-if="!pendingFees.length" class="dash-empty">
          {{ t('residentFinance.pendingReceiptsEmpty') }}
        </p>
        <template v-else>
          <ul class="dash-list" role="list">
            <li
              v-for="fee in pendingFees"
              :key="fee.id"
              class="dash-row"
              :class="{ 'dash-row--danger': getDaysUntilDue(fee.dueDate) < 0 }"
            >
              <div class="dash-row__main">
                <span class="dash-row__title">
                  {{ fee.concept || t('residentFinance.defaultConcept') }}
                </span>
                <span class="dash-row__meta">
                  {{ translateMonth(fee.month) }}
                  ·
                  {{ t('residentFinance.kpiNextFeeDue', { date: formatDueDate(fee.dueDate) }) }}
                </span>
              </div>
              <div class="dash-row__side">
                <span class="dash-row__amount">{{ formatMoney(fee.amount) }}</span>
                <span class="inc-badge" :class="feeStatusClass(fee)">
                  {{ feeStatusLabel(fee) }}
                </span>
              </div>
            </li>
          </ul>

          <div class="pay-bar">
            <p class="pay-bar__hint">
              {{
                hasOverdue
                  ? t('residentFinance.kpiOverdueWarning')
                  : t('residentFinance.securePayment')
              }}
            </p>
            <button
              type="button"
              class="pay-btn"
              :class="{ 'pay-btn--danger': hasOverdue }"
              :disabled="isProcessing || paymentState.isLoading"
              @click="startMaintenanceCheckout"
            >
              {{
                isProcessing
                  ? t('residentFinance.processing')
                  : t('residentFinance.payAmount', { amount: formatMoney(pendingTotal) })
              }}
            </button>
          </div>
        </template>
      </section>

      <!-- Historial de pagos -->
      <section class="finance-panel" aria-labelledby="history-heading">
        <h2 id="history-heading" class="finance-panel__section-title">
          {{ t('residentFinance.paymentHistoryTitle') }}
        </h2>

        <p v-if="paymentState.isLoading" class="dash-empty">…</p>
        <p v-else-if="!paymentHistory.length" class="dash-empty">
          {{ t('residentFinance.noPaymentsYet') }}
        </p>
        <ul v-else class="dash-list" role="list">
          <li v-for="pay in paymentHistory" :key="pay.id" class="dash-row">
            <div class="dash-row__main">
              <span class="dash-row__title">
                {{ pay.concept || t('residentFinance.defaultConcept') }}
              </span>
              <span class="dash-row__meta">
                {{ translateMonth(pay.feeMonth) }}
                ·
                {{ formatDateTime(pay.paidAt) }}
                <template v-if="pay.method"> · {{ pay.method }}</template>
              </span>
            </div>
            <div class="dash-row__side">
              <span class="dash-row__amount">{{ formatMoney(pay.amount) }}</span>
              <span class="inc-badge inc-badge--resolved">
                {{ t('residentFinance.statusPaid') }}
              </span>
              <button
                type="button"
                class="receipt-btn"
                :disabled="downloadingPaymentId === String(pay.id)"
                :aria-label="`${t('financeOps.downloadReceipt')} · ${translateMonth(pay.feeMonth)}`"
                @click="downloadReceipt(pay)"
              >
                <i class="pi pi-download" aria-hidden="true" />
                {{
                  downloadingPaymentId === String(pay.id)
                    ? t('financeOps.downloading')
                    : t('financeOps.downloadReceipt')
                }}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- Semáforo de mis cuotas (RF029) -->
      <section class="finance-panel" aria-labelledby="my-traffic-heading">
        <h2 id="my-traffic-heading" class="finance-panel__section-title">
          {{ t('financeOps.myTrafficTitle') }}
        </h2>
        <DebtTrafficLightGrid
          compact
          :months="myCalendar.months"
          :residents="myCalendar.residents"
          :due-soon-days="myCalendar.dueSoonDays"
          :loading="myCalendarLoading"
          :error="myCalendarError"
          @retry="loadMyCalendar"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.receipt-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1d1d1f;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.receipt-btn:hover:not(:disabled) {
  background: #f5f5f7;
}

.receipt-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

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

.finance-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.finance-panel {
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.finance-panel__section-title {
  margin: 0 0 0.85rem;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}

.panel-head .finance-panel__section-title {
  margin-bottom: 0;
}

.panel-head__meta {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.dash-error {
  margin: 0;
  padding: 0.75rem 0.9rem;
  border-radius: 12px;
  background: #fff7f7;
  border: 1px solid rgba(180, 35, 24, 0.15);
  color: #b42318;
  font-size: 0.875rem;
}

.dash-empty {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #6e6e73;
}

.dash-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.dash-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.85rem;
  padding: 0.7rem 0.8rem;
  border-radius: 12px;
  background: #f5f5f7;
}

.dash-row--danger {
  background: #fff7f7;
}

.dash-row__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.dash-row__title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.dash-row__meta {
  font-size: 0.78rem;
  color: #6e6e73;
  line-height: 1.4;
}

.dash-row__side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.28rem;
}

.dash-row__amount {
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.inc-badge,
.guest-badge--yes {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
}

.guest-badge--yes {
  background: #e8eefc;
  color: #1e3a8a;
}

.inc-badge--open {
  background: #fdecee;
  color: #b42318;
}

.inc-badge--in-progress {
  background: #fff3e0;
  color: #e65100;
}

.inc-badge--resolved {
  background: #e8f5e9;
  color: #1b7a3d;
}

.pay-bar {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.pay-bar__hint {
  margin: 0;
  font-size: 0.78rem;
  color: #6e6e73;
  line-height: 1.4;
  flex: 1;
  min-width: 12rem;
}

.pay-btn {
  border: none;
  border-radius: 8px;
  padding: 0.7rem 1.15rem;
  background: #0071e3;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
}

.pay-btn:hover:not(:disabled) {
  background: #0066cc;
}

.pay-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.pay-btn--danger {
  background: #ff3b30;
}

.pay-btn--danger:hover:not(:disabled) {
  background: #e0352b;
}

@media (max-width: 720px) {
  .dash-row {
    flex-direction: column;
  }
  .dash-row__side {
    align-items: flex-start;
  }
  .pay-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
