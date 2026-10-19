<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import Toast from 'primevue/toast'
import Dialog from 'primevue/dialog'
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
import { todayYmd } from '@/finances/domain/billingCycle.js'
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
// Local calendar day (Lima), not UTC: after 19:00 UTC-5 the ISO date is already tomorrow.
const todayIso = todayYmd()
const isProcessing = ref(false)

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
      detail: isPaymentGatewayUnavailable(err)
        ? t('residentFinance.paymentUnavailableDetail')
        : err?.payload?.message || err?.message || t('residentFinance.paymentErrorDetail'),
      life: 5000,
    })
  } finally {
    isProcessing.value = false
  }
}

function getDaysUntilDue(dueDate) {
  if (!dueDate) return Infinity
  const due = new Date(String(dueDate).slice(0, 10) + 'T00:00:00')
  if (!Number.isFinite(due.getTime())) return Infinity
  const now = new Date(todayIso + 'T00:00:00')
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24))
}

const dueSoonDays = computed(() => Number(myCalendar.value?.dueSoonDays) || 5)

/** 'overdue' | 'dueSoon' | 'pending' for an unpaid receipt. */
function feeTone(fee) {
  const days = getDaysUntilDue(fee.dueDate)
  if (days < 0) return 'overdue'
  if (days <= dueSoonDays.value) return 'dueSoon'
  return 'pending'
}

function feeStatusLabel(fee) {
  const tone = feeTone(fee)
  if (tone === 'overdue') return t('residentFinance.statusOverdue')
  if (tone === 'dueSoon') return t('residentFinance.statusDueSoon')
  return t('residentFinance.statusPending')
}

function feeStatusClass(fee) {
  return `rf-pill--${feeTone(fee)}`
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

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))
const currentYear = todayIso.slice(0, 4)

function capitalize(text) {
  const str = String(text ?? '')
  return str ? str.charAt(0).toLocaleUpperCase(intlLocale.value) + str.slice(1) : str
}

/** "31 oct." (adds the year only when it is not the current one). */
function formatShortDate(iso) {
  if (!iso) return '—'
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00')
  if (!Number.isFinite(d.getTime())) return String(iso)
  const opts = { day: 'numeric', month: 'short' }
  if (String(iso).slice(0, 4) !== currentYear) opts.year = 'numeric'
  return d.toLocaleDateString(intlLocale.value, opts)
}

/** "Vence el 31 oct. · en 12 días" / "Venció el 30 sep. · hace 19 días". */
function dueText(fee) {
  if (!fee?.dueDate) return ''
  const days = getDaysUntilDue(fee.dueDate)
  const date = formatShortDate(fee.dueDate)
  if (!Number.isFinite(days)) return capitalize(t('residentFinance.dueOn', { date }))
  if (days < 0) {
    const n = -days
    return capitalize(
      `${t('residentFinance.dueWas', { date })} · ${t('residentFinance.relOverdue', { n }, n)}`,
    )
  }
  return capitalize(
    `${t('residentFinance.dueOn', { date })} · ${t('residentFinance.relDue', { n: days }, days)}`,
  )
}

/** Date of the billed month (yyyy-MM…, or a Spanish "Agosto 2026" label); null if unknown. */
function monthDate(value) {
  const str = String(value ?? '').trim()
  const iso = str.match(/^(\d{4})-(\d{2})/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, 1)
  const idx = monthNamesEs.findIndex((m) => str.toLowerCase().includes(m.toLowerCase()))
  const year = str.match(/(\d{4})/)
  if (idx >= 0 && year) return new Date(Number(year[1]), idx, 1)
  return null
}

function feeMonthValue(fee) {
  return fee?.billingMonth || fee?.month || fee?.dueDate
}

function monthLabel(value) {
  return capitalize(translateMonth(value))
}

/** Month tile: short month + year. */
function monthTile(value) {
  const d = monthDate(value)
  if (!d) return { month: '—', year: '' }
  return {
    month: d.toLocaleDateString(intlLocale.value, { month: 'short' }).replace('.', ''),
    year: String(d.getFullYear()),
  }
}

function feeBreakdown(fee) {
  const amount = Number(fee?.amount) || 0
  const lateFee = Number(fee?.lateFee) || 0
  const extraCharges = Number(fee?.extraCharges) || 0
  const base = fee?.baseAmount != null ? Number(fee.baseAmount) || 0 : amount - lateFee - extraCharges
  return { base, lateFee, extraCharges, total: amount }
}

const pendingBreakdown = computed(() =>
  pendingFees.value.reduce(
    (acc, fee) => {
      const b = feeBreakdown(fee)
      acc.base += b.base
      acc.lateFee += b.lateFee
      acc.extraCharges += b.extraCharges
      return acc
    },
    { base: 0, lateFee: 0, extraCharges: 0 },
  ),
)

const nextDueFee = computed(() => pendingFees.value[0] ?? null)

const heroTone = computed(() => {
  if (!pendingFees.value.length) return 'green'
  return hasOverdue.value ? 'red' : 'blue'
})

const paidThisYear = computed(() => {
  const rows = paymentHistory.value.filter((p) => String(p.paidAt ?? '').slice(0, 4) === currentYear)
  return { total: rows.reduce((sum, p) => sum + Number(p.amount || 0), 0), count: rows.length }
})

const myCells = computed(() => {
  const row = myCalendar.value?.residents?.[0]
  return Array.isArray(row?.cells) ? row.cells : []
})

const monthsSummary = computed(() => {
  const billed = myCells.value.filter((c) => c.status && c.status !== 'none')
  return {
    paid: billed.filter((c) => c.status === 'paid').length,
    billed: billed.length,
    overdue: billed.filter((c) => c.status === 'overdue').length,
  }
})

const latestPayment = computed(() => paymentHistory.value[0] ?? null)

function refreshAll() {
  if (!profile.value.id) return
  Promise.all([loadData(profile.value.id), loadMyCalendar()])
}

// Detail dialog (pending receipt breakdown or a confirmed payment).
const detail = ref(null)
const detailOpen = computed({
  get: () => Boolean(detail.value),
  set: (open) => {
    if (!open) detail.value = null
  },
})

function openFeeDetail(fee) {
  detail.value = { kind: 'fee', item: fee }
}

function openPaymentDetail(pay) {
  detail.value = { kind: 'payment', item: pay }
}

const detailTitle = computed(() => {
  if (!detail.value) return ''
  const { kind, item } = detail.value
  return kind === 'fee'
    ? t('residentFinance.detailFeeTitle', { month: translateMonth(feeMonthValue(item)) })
    : t('residentFinance.detailPaymentTitle', { month: translateMonth(item.feeMonth) })
})
</script>

<template>
  <div class="app-view rf">
    <Toast position="top-right" />

    <header class="rf-head">
      <div class="rf-head__text">
        <h1 class="rf-head__title">{{ t('residentFinance.pageTitle') }}</h1>
        <p class="rf-head__sub">{{ t('residentFinance.pageSubtitle') }}</p>
      </div>
      <div class="rf-head__actions" role="group" :aria-label="t('residentFinance.headerActions')">
        <button
          type="button"
          class="rf-btn"
          :disabled="paymentState.isLoading || myCalendarLoading"
          @click="refreshAll"
        >
          <i
            class="pi pi-refresh"
            :class="{ 'pi-spin': paymentState.isLoading || myCalendarLoading }"
            aria-hidden="true"
          />
          {{ t('residentFinance.refresh') }}
        </button>
        <button
          v-if="latestPayment"
          type="button"
          class="rf-btn"
          :disabled="Boolean(downloadingPaymentId)"
          :aria-label="`${t('financeOps.downloadReceipt')} · ${translateMonth(latestPayment.feeMonth)}`"
          @click="downloadReceipt(latestPayment)"
        >
          <i class="pi pi-download" aria-hidden="true" />
          {{ t('residentFinance.downloadLatestReceipt') }}
        </button>
      </div>
    </header>

    <LoadErrorRetry
      v-if="paymentState.error"
      :loading="paymentState.isLoading"
      @retry="loadData(profile.id)"
    />

    <div class="rf-top">
      <!-- Por pagar -->
      <section
        class="rf-hero"
        :class="`rf-hero--${heroTone}`"
        aria-labelledby="pending-heading"
        :aria-busy="paymentState.isLoading ? 'true' : 'false'"
      >
        <div class="rf-hero__main">
          <div class="rf-hero__head">
            <span class="rf-icon" :class="`rf-icon--${heroTone}`">
              <i
                class="pi"
                :class="heroTone === 'green' ? 'pi-check-circle' : heroTone === 'red' ? 'pi-exclamation-triangle' : 'pi-wallet'"
                aria-hidden="true"
              />
            </span>
            <h2 id="pending-heading" class="rf-hero__label">
              {{ t('residentFinance.pendingReceiptsTitle') }}
            </h2>
            <span v-if="hasOverdue" class="rf-pill rf-pill--overdue">
              {{ t('residentFinance.kpiOverdueWarning') }}
            </span>
          </div>

          <template v-if="paymentState.isLoading && !fees.length">
            <span class="rf-skel rf-skel--amount" aria-hidden="true" />
            <span class="rf-skel rf-skel--line" aria-hidden="true" />
          </template>
          <template v-else-if="pendingFees.length">
            <p class="rf-hero__amount">{{ formatMoney(pendingTotal) }}</p>
            <p class="rf-hero__due" :class="{ 'is-late': hasOverdue }">
              <i class="pi pi-calendar" aria-hidden="true" />
              <span>{{ dueText(nextDueFee) }}</span>
            </p>
            <p class="rf-hero__count">
              {{ t('residentFinance.heroReceiptsCount', { n: pendingFees.length }, pendingFees.length) }}
            </p>
            <div class="rf-hero__pay">
              <button
                type="button"
                class="rf-btn rf-btn--primary rf-btn--lg"
                :class="{ 'rf-btn--danger': hasOverdue }"
                :disabled="isProcessing || paymentState.isLoading"
                :aria-label="t('residentFinance.payAmount', { amount: formatMoney(pendingTotal) })"
                @click="startMaintenanceCheckout"
              >
                <i
                  class="pi"
                  :class="isProcessing ? 'pi-spin pi-spinner' : 'pi-credit-card'"
                  aria-hidden="true"
                />
                {{ isProcessing ? t('residentFinance.processing') : t('residentFinance.payWithMp') }}
              </button>
              <p class="rf-hero__secure">
                <i class="pi pi-lock" aria-hidden="true" />
                {{ t('residentFinance.securePayment') }}
              </p>
            </div>
          </template>
          <template v-else>
            <p class="rf-hero__amount">{{ formatMoney(0) }}</p>
            <p class="rf-hero__ok-title">{{ t('residentFinance.heroUpToDateTitle') }}</p>
            <p class="rf-hero__ok-text">{{ t('residentFinance.heroUpToDateText') }}</p>
          </template>
        </div>

        <dl
          v-if="pendingFees.length"
          class="rf-breakdown"
          :aria-label="t('residentFinance.breakdownAria')"
        >
          <div class="rf-breakdown__row">
            <dt>{{ t('residentFinance.breakdownFee') }}</dt>
            <dd>{{ formatMoney(pendingBreakdown.base) }}</dd>
          </div>
          <div class="rf-breakdown__row" :class="{ 'is-zero': !pendingBreakdown.lateFee, 'is-late': pendingBreakdown.lateFee > 0 }">
            <dt>{{ t('residentFinance.breakdownLateFee') }}</dt>
            <dd>{{ formatMoney(pendingBreakdown.lateFee) }}</dd>
          </div>
          <div class="rf-breakdown__row" :class="{ 'is-zero': !pendingBreakdown.extraCharges }">
            <dt>{{ t('residentFinance.breakdownExtras') }}</dt>
            <dd>{{ formatMoney(pendingBreakdown.extraCharges) }}</dd>
          </div>
          <div class="rf-breakdown__row rf-breakdown__row--total">
            <dt>{{ t('residentFinance.breakdownTotal') }}</dt>
            <dd>{{ formatMoney(pendingTotal) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Resumen -->
      <section class="rf-kpis" :aria-label="t('residentFinance.summaryAria')">
        <article class="rf-kpi rf-kpi--green">
          <span class="rf-icon rf-icon--green"><i class="pi pi-wallet" aria-hidden="true" /></span>
          <div class="rf-kpi__text">
            <span class="rf-kpi__label">{{ t('residentFinance.kpiPaidYear') }}</span>
            <span class="rf-kpi__value">{{ formatMoney(paidThisYear.total) }}</span>
            <span class="rf-kpi__hint">
              {{ t('residentFinance.kpiPaidYearHint', { n: paidThisYear.count, year: currentYear }, paidThisYear.count) }}
            </span>
          </div>
        </article>

        <article class="rf-kpi" :class="monthsSummary.overdue ? 'rf-kpi--red' : 'rf-kpi--blue'">
          <span class="rf-icon" :class="monthsSummary.overdue ? 'rf-icon--red' : 'rf-icon--blue'">
            <i class="pi pi-calendar" aria-hidden="true" />
          </span>
          <div class="rf-kpi__text">
            <span class="rf-kpi__label">{{ t('residentFinance.kpiMonthsUpToDate') }}</span>
            <span class="rf-kpi__value">
              <template v-if="myCalendarLoading && !myCells.length">…</template>
              <template v-else-if="monthsSummary.billed">
                {{ monthsSummary.paid }}<span class="rf-kpi__of"> / {{ monthsSummary.billed }}</span>
              </template>
              <template v-else>—</template>
            </span>
            <span class="rf-kpi__hint" :class="{ 'is-late': monthsSummary.overdue }">
              {{
                monthsSummary.overdue
                  ? t('residentFinance.kpiMonthsOverdueHint', { n: monthsSummary.overdue }, monthsSummary.overdue)
                  : t('residentFinance.kpiMonthsUpToDateHint')
              }}
            </span>
          </div>
        </article>

        <article class="rf-kpi" :class="hasOverdue ? 'rf-kpi--red' : 'rf-kpi--amber'">
          <span class="rf-icon" :class="hasOverdue ? 'rf-icon--red' : 'rf-icon--amber'">
            <i class="pi pi-clock" aria-hidden="true" />
          </span>
          <div class="rf-kpi__text">
            <span class="rf-kpi__label">{{ t('residentFinance.kpiNextDue') }}</span>
            <span class="rf-kpi__value" :class="{ 'is-late': hasOverdue }">
              {{ nextDueFee ? formatShortDate(nextDueFee.dueDate) : t('residentFinance.kpiNextDueNone') }}
            </span>
            <span class="rf-kpi__hint" :class="{ 'is-late': hasOverdue }">
              {{
                nextDueFee
                  ? `${formatMoney(nextDueFee.amount)} · ${feeStatusLabel(nextDueFee)}`
                  : t('residentFinance.kpiNextDueNoneHint')
              }}
            </span>
          </div>
        </article>
      </section>
    </div>

    <!-- Semáforo de mis cuotas (RF029) -->
    <section class="rf-card" aria-labelledby="my-traffic-heading">
      <div class="rf-card__head">
        <div>
          <h2 id="my-traffic-heading" class="rf-card__title">{{ t('residentFinance.last6Title') }}</h2>
          <p class="rf-card__hint">{{ t('residentFinance.last6Hint') }}</p>
        </div>
      </div>
      <DebtTrafficLightGrid
        compact
        tinted
        :months="myCalendar.months"
        :residents="myCalendar.residents"
        :due-soon-days="myCalendar.dueSoonDays"
        :loading="myCalendarLoading"
        :error="myCalendarError"
        @retry="loadMyCalendar"
      />
    </section>

    <!-- Recibos pendientes -->
    <section class="rf-card" aria-labelledby="pending-list-heading">
      <div class="rf-card__head">
        <div>
          <h2 id="pending-list-heading" class="rf-card__title">
            {{ t('residentFinance.pendingListTitle') }}
          </h2>
          <p class="rf-card__hint">{{ t('residentFinance.pendingListHint') }}</p>
        </div>
        <span v-if="pendingFees.length" class="rf-card__meta">{{ formatMoney(pendingTotal) }}</span>
      </div>

      <p v-if="paymentState.isLoading && !fees.length" class="rf-empty">…</p>
      <div v-else-if="!pendingFees.length" class="rf-empty">
        <i class="pi pi-check-circle" aria-hidden="true" />
        {{ t('residentFinance.pendingReceiptsEmpty') }}
      </div>
      <ul v-else class="rf-list" role="list">
        <li
          v-for="fee in pendingFees"
          :key="fee.id"
          class="rf-row"
          :class="{ 'rf-row--danger': feeTone(fee) === 'overdue' }"
        >
          <span class="rf-tile" :class="`rf-tile--${feeTone(fee)}`" aria-hidden="true">
            <span class="rf-tile__month">{{ monthTile(feeMonthValue(fee)).month }}</span>
            <span class="rf-tile__year">{{ monthTile(feeMonthValue(fee)).year }}</span>
          </span>
          <div class="rf-row__main">
            <span class="rf-row__title">{{ fee.concept || t('residentFinance.defaultConcept') }}</span>
            <span class="rf-row__meta">
              <span>{{ monthLabel(feeMonthValue(fee)) }}</span>
              <span class="rf-row__sep" aria-hidden="true">·</span>
              <span :class="{ 'is-late': feeTone(fee) === 'overdue' }">{{ dueText(fee) }}</span>
            </span>
          </div>
          <div class="rf-row__side">
            <span class="rf-row__amount">{{ formatMoney(fee.amount) }}</span>
            <span class="rf-pill" :class="feeStatusClass(fee)">{{ feeStatusLabel(fee) }}</span>
            <div class="rf-row__actions">
              <button
                type="button"
                class="rf-btn rf-btn--sm"
                :aria-label="`${t('residentFinance.viewDetail')} · ${translateMonth(feeMonthValue(fee))}`"
                @click="openFeeDetail(fee)"
              >
                {{ t('residentFinance.viewDetail') }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- Historial de pagos -->
    <section class="rf-card" aria-labelledby="history-heading">
      <div class="rf-card__head">
        <div>
          <h2 id="history-heading" class="rf-card__title">
            {{ t('residentFinance.paymentHistoryTitle') }}
          </h2>
          <p class="rf-card__hint">{{ t('residentFinance.historyHint') }}</p>
        </div>
      </div>

      <p v-if="paymentState.isLoading && !paymentHistory.length" class="rf-empty">…</p>
      <div v-else-if="!paymentHistory.length" class="rf-empty">
        <i class="pi pi-receipt" aria-hidden="true" />
        {{ t('residentFinance.noPaymentsYet') }}
      </div>
      <ul v-else class="rf-list" role="list">
        <li v-for="pay in paymentHistory" :key="pay.id" class="rf-row">
          <span class="rf-tile rf-tile--paid" aria-hidden="true">
            <span class="rf-tile__month">{{ monthTile(pay.feeMonth).month }}</span>
            <span class="rf-tile__year">{{ monthTile(pay.feeMonth).year }}</span>
          </span>
          <div class="rf-row__main">
            <span class="rf-row__title">{{ pay.concept || t('residentFinance.defaultConcept') }}</span>
            <span class="rf-row__meta">
              <span>{{ monthLabel(pay.feeMonth) }}</span>
              <span class="rf-row__sep" aria-hidden="true">·</span>
              <span>{{ t('residentFinance.paidOn', { date: formatDateTime(pay.paidAt) }) }}</span>
              <template v-if="pay.method">
                <span class="rf-row__sep" aria-hidden="true">·</span>
                <span class="rf-chip">{{ pay.method }}</span>
              </template>
            </span>
          </div>
          <div class="rf-row__side">
            <span class="rf-row__amount">{{ formatMoney(pay.amount) }}</span>
            <span class="rf-pill rf-pill--paid">{{ t('residentFinance.statusPaid') }}</span>
            <div class="rf-row__actions">
              <button
                type="button"
                class="rf-btn rf-btn--sm rf-btn--ghost"
                :aria-label="`${t('residentFinance.viewDetail')} · ${translateMonth(pay.feeMonth)}`"
                @click="openPaymentDetail(pay)"
              >
                {{ t('residentFinance.viewDetail') }}
              </button>
              <button
                type="button"
                class="rf-btn rf-btn--sm"
                :disabled="downloadingPaymentId === String(pay.id)"
                :aria-label="`${t('financeOps.downloadReceipt')} · ${translateMonth(pay.feeMonth)}`"
                @click="downloadReceipt(pay)"
              >
                <i
                  class="pi"
                  :class="downloadingPaymentId === String(pay.id) ? 'pi-spin pi-spinner' : 'pi-download'"
                  aria-hidden="true"
                />
                {{
                  downloadingPaymentId === String(pay.id)
                    ? t('financeOps.downloading')
                    : t('financeOps.downloadReceipt')
                }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <Dialog
      v-model:visible="detailOpen"
      modal
      :header="detailTitle"
      class="rf-dialog"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
    >
      <template v-if="detail?.kind === 'fee'">
        <div class="rf-dialog__hero">
          <span class="rf-dialog__amount">{{ formatMoney(detail.item.amount) }}</span>
          <span class="rf-pill" :class="feeStatusClass(detail.item)">{{ feeStatusLabel(detail.item) }}</span>
        </div>
        <dl class="rf-dialog__list">
          <div>
            <dt>{{ t('residentFinance.colConcept') }}</dt>
            <dd>{{ detail.item.concept || t('residentFinance.defaultConcept') }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.colMonth') }}</dt>
            <dd>{{ monthLabel(feeMonthValue(detail.item)) }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.colDueDate') }}</dt>
            <dd :class="{ 'is-late': feeTone(detail.item) === 'overdue' }">{{ dueText(detail.item) }}</dd>
          </div>
          <div class="is-sep">
            <dt>{{ t('residentFinance.breakdownFee') }}</dt>
            <dd>{{ formatMoney(feeBreakdown(detail.item).base) }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.breakdownLateFee') }}</dt>
            <dd :class="{ 'is-late': feeBreakdown(detail.item).lateFee > 0 }">
              {{ formatMoney(feeBreakdown(detail.item).lateFee) }}
            </dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.breakdownExtras') }}</dt>
            <dd>{{ formatMoney(feeBreakdown(detail.item).extraCharges) }}</dd>
          </div>
          <div class="is-total">
            <dt>{{ t('residentFinance.breakdownTotal') }}</dt>
            <dd>{{ formatMoney(detail.item.amount) }}</dd>
          </div>
        </dl>
      </template>
      <template v-else-if="detail?.kind === 'payment'">
        <div class="rf-dialog__hero">
          <span class="rf-dialog__amount">{{ formatMoney(detail.item.amount) }}</span>
          <span class="rf-pill rf-pill--paid">{{ t('residentFinance.statusPaid') }}</span>
        </div>
        <dl class="rf-dialog__list">
          <div>
            <dt>{{ t('residentFinance.colConcept') }}</dt>
            <dd>{{ detail.item.concept || t('residentFinance.defaultConcept') }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.colMonth') }}</dt>
            <dd>{{ monthLabel(detail.item.feeMonth) }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.colPaidAt') }}</dt>
            <dd>{{ formatDateTime(detail.item.paidAt) }}</dd>
          </div>
          <div>
            <dt>{{ t('residentFinance.colMethod') }}</dt>
            <dd>{{ detail.item.method || t('residentFinance.methodUnknown') }}</dd>
          </div>
          <div v-if="detail.item.reference">
            <dt>{{ t('residentFinance.colReference') }}</dt>
            <dd class="is-mono">{{ detail.item.reference }}</dd>
          </div>
        </dl>
      </template>
      <template #footer>
        <button type="button" class="rf-btn" @click="detailOpen = false">
          {{ t('residentFinance.detailClose') }}
        </button>
        <button
          v-if="detail?.kind === 'payment'"
          type="button"
          class="rf-btn rf-btn--primary"
          :disabled="downloadingPaymentId === String(detail.item.id)"
          @click="downloadReceipt(detail.item)"
        >
          <i
            class="pi"
            :class="downloadingPaymentId === String(detail.item.id) ? 'pi-spin pi-spinner' : 'pi-download'"
            aria-hidden="true"
          />
          {{
            downloadingPaymentId === String(detail.item.id)
              ? t('financeOps.downloading')
              : t('financeOps.downloadReceipt')
          }}
        </button>
        <button
          v-else-if="detail?.kind === 'fee'"
          type="button"
          class="rf-btn rf-btn--primary"
          :disabled="isProcessing || paymentState.isLoading"
          :aria-label="t('residentFinance.payAmount', { amount: formatMoney(pendingTotal) })"
          @click="startMaintenanceCheckout"
        >
          <i class="pi" :class="isProcessing ? 'pi-spin pi-spinner' : 'pi-credit-card'" aria-hidden="true" />
          {{ isProcessing ? t('residentFinance.processing') : t('residentFinance.payAmount', { amount: formatMoney(pendingTotal) }) }}
        </button>
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

.rf {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.is-late {
  color: #b42318 !important;
}

/* ---------- Header ---------- */
.rf-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.rf-head__text {
  min-width: 0;
}

.rf-head__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.rf-head__sub {
  margin: 0.25rem 0 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

.rf-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ---------- Buttons / pills ---------- */
.rf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 0.95rem;
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

.rf-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.rf-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.rf-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.rf-btn--danger {
  background: #b42318;
  border-color: #b42318;
}

.rf-btn--danger:hover:not(:disabled) {
  background: #912018;
  border-color: #912018;
}

.rf-btn--lg {
  min-height: 2.9rem;
  padding: 0.65rem 1.35rem;
  font-size: 0.9rem;
}

.rf-btn--sm {
  min-height: 2rem;
  padding: 0.3rem 0.8rem;
  font-size: 0.76rem;
}

.rf-btn--ghost {
  border-color: transparent;
  background: transparent;
}

.rf-btn:disabled {
  opacity: 0.65;
  cursor: progress;
}

.rf-btn:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.rf-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
  background: #e8eefc;
  color: #1e3a8a;
}

.rf-pill--paid { background: #e3f4e8; color: #15803d; }
.rf-pill--pending { background: #e8eefc; color: #1e3a8a; }
.rf-pill--dueSoon { background: #fdf3dc; color: #92400e; }
.rf-pill--overdue { background: #fde4e4; color: #b42318; }

.rf-hero .rf-pill--overdue {
  background: #fff;
}

.rf-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 600;
}

.rf-icon {
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.95rem;
  background: #fff;
}

.rf-icon--blue { color: #1e3a8a; }
.rf-icon--green { color: #15803d; }
.rf-icon--amber { color: #b45309; }
.rf-icon--red { color: #b42318; }

/* ---------- Top: hero + summary ---------- */
.rf-top {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 0.9rem;
  align-items: stretch;
}

.rf-hero {
  border-radius: 18px;
  padding: 1.3rem 1.35rem;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(14rem, 19rem);
  gap: 1.25rem;
  align-items: start;
  min-width: 0;
}

.rf-hero--blue { background: #e8eefc; }
.rf-hero--red { background: #fde4e4; }
.rf-hero--green { background: #e3f4e8; grid-template-columns: minmax(0, 1fr); }

.rf-hero__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
}

.rf-hero__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.rf-hero__label {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: #334155;
}

.rf-hero__amount {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 2.6rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.rf-hero--red .rf-hero__amount {
  color: #7f1d1d;
}

.rf-hero__due {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0.55rem 0 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: #1e3a8a;
}

.rf-hero__due .pi {
  font-size: 0.85rem;
}

.rf-hero__count {
  margin: 0.2rem 0 0;
  font-size: 0.8rem;
  color: #6e6e73;
}

.rf-hero__pay {
  margin-top: auto;
  padding-top: 1.2rem;
  display: flex;
  align-items: center;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
}

.rf-hero__secure {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  font-size: 0.75rem;
  color: #6e6e73;
}

.rf-hero__secure .pi {
  font-size: 0.72rem;
}

.rf-hero__ok-title {
  margin: 0.6rem 0 0;
  font-size: 1rem;
  font-weight: 650;
  color: #14532d;
}

.rf-hero__ok-text {
  margin: 0.2rem 0 0;
  font-size: 0.84rem;
  line-height: 1.45;
  color: #4b5563;
}

.rf-breakdown {
  margin: 0;
  padding: 0.6rem 1rem;
  border-radius: 14px;
  background: #fff;
  display: flex;
  flex-direction: column;
}

.rf-breakdown__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0;
  font-size: 0.84rem;
}

.rf-breakdown__row + .rf-breakdown__row {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.rf-breakdown__row dt {
  color: #475569;
}

.rf-breakdown__row dd {
  margin: 0;
  font-weight: 650;
  color: #0f172a;
  white-space: nowrap;
}

.rf-breakdown__row.is-zero dd,
.rf-breakdown__row.is-zero dt {
  color: #94a3b8;
}

.rf-breakdown__row.is-late dt,
.rf-breakdown__row.is-late dd {
  color: #b42318;
}

.rf-breakdown__row--total {
  border-top: 1px solid rgba(15, 23, 42, 0.12) !important;
  font-size: 0.92rem;
}

.rf-breakdown__row--total dt {
  font-weight: 650;
  color: #0f172a;
}

.rf-skel {
  display: block;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.75);
}

.rf-skel--amount {
  width: 12rem;
  height: 2.6rem;
}

.rf-skel--line {
  width: 9rem;
  height: 0.9rem;
  margin-top: 0.7rem;
}

.rf-kpis {
  display: grid;
  grid-template-rows: repeat(3, minmax(0, 1fr));
  gap: 0.9rem;
  min-width: 0;
}

.rf-kpi {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.95rem 1.05rem;
  border-radius: 16px;
  min-width: 0;
}

.rf-kpi--blue { background: #e8eefc; }
.rf-kpi--green { background: #e3f4e8; }
.rf-kpi--amber { background: #fdf3dc; }
.rf-kpi--red { background: #fde4e4; }

.rf-kpi__text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.rf-kpi__label {
  color: #6e6e73;
  font-weight: 600;
  font-size: 0.76rem;
}

.rf-kpi__value {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.3rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rf-kpi__of {
  font-size: 0.95rem;
  font-weight: 600;
  color: #94a3b8;
  letter-spacing: 0;
}

.rf-kpi__hint {
  font-size: 0.74rem;
  color: #6e6e73;
  line-height: 1.35;
}

/* ---------- White cards ---------- */
.rf-card {
  padding: 1.2rem 1.25rem 1.15rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.rf-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.95rem;
}

.rf-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.rf-card__hint {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
}

.rf-card__meta {
  flex-shrink: 0;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.82rem;
  font-weight: 700;
  white-space: nowrap;
}

.rf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 1.4rem 1rem;
  color: #6e6e73;
  font-size: 0.85rem;
  text-align: center;
}

.rf-empty .pi {
  font-size: 1.4rem;
  color: #cbd5e1;
}

.rf-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.rf-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem 0.9rem;
  padding: 0.8rem 0.25rem;
}

.rf-row + .rf-row {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.rf-tile {
  width: 3rem;
  height: 3rem;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.05;
  background: #e8eefc;
  color: #1e3a8a;
}

.rf-tile--paid { background: #e3f4e8; color: #15803d; }
.rf-tile--dueSoon { background: #fdf3dc; color: #92400e; }
.rf-tile--overdue { background: #fde4e4; color: #b42318; }

.rf-tile__month {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.rf-tile__year {
  font-size: 0.66rem;
  font-weight: 600;
  opacity: 0.8;
}

.rf-row__main {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.rf-row__title {
  font-size: 0.9rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.rf-row__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.15rem 0.4rem;
  font-size: 0.78rem;
  color: #6e6e73;
  line-height: 1.4;
}

.rf-row__sep {
  color: #cbd5e1;
}

.rf-row__side {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.rf-row__actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.rf-row__amount {
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
  white-space: nowrap;
  min-width: 5.5rem;
  text-align: right;
}

/* ---------- Responsive ---------- */
@media (max-width: 1180px) {
  .rf-top {
    grid-template-columns: minmax(0, 1fr);
  }
  .rf-kpis {
    grid-template-rows: none;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .rf-head {
    align-items: flex-start;
  }
  .rf-head__title {
    font-size: 1.4rem;
  }
  .rf-hero {
    grid-template-columns: minmax(0, 1fr);
    padding: 1.1rem 1.05rem;
  }
  .rf-hero__amount {
    font-size: 2.2rem;
  }
  .rf-hero__pay {
    flex-direction: column;
    align-items: stretch;
  }
  .rf-hero__pay .rf-btn {
    width: 100%;
  }
  .rf-hero__secure {
    justify-content: center;
  }
  .rf-kpis {
    grid-template-columns: minmax(0, 1fr);
  }
  .rf-card {
    padding: 1rem 1rem 0.9rem;
  }
  .rf-row {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }
  .rf-row__side {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
  .rf-row__amount {
    min-width: 0;
    text-align: left;
    margin-right: auto;
  }
  .rf-row__meta {
    flex-direction: column;
    align-items: flex-start;
  }
  .rf-row__sep {
    display: none;
  }
  .rf-row__actions {
    flex: 1 1 100%;
  }
  .rf-row__actions .rf-btn {
    flex: 1 1 0;
  }
  .rf-row__actions .rf-btn--ghost {
    border-color: rgba(15, 23, 42, 0.12);
  }
}
</style>

<style>
/* Dialog is teleported to <body>: unscoped, prefixed with .rf-dialog. */
.rf-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.rf-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.5rem;
}

.rf-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.rf-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.rf-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.rf-dialog .rf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 0.95rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.rf-dialog .rf-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.rf-dialog .rf-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.rf-dialog .rf-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.rf-dialog .rf-btn:disabled {
  opacity: 0.65;
  cursor: progress;
}

.rf-dialog .rf-btn:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.rf-dialog__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: #f5f7fb;
  margin-bottom: 0.6rem;
}

.rf-dialog__amount {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.rf-dialog .rf-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
  background: #e8eefc;
  color: #1e3a8a;
}

.rf-dialog .rf-pill--paid { background: #e3f4e8; color: #15803d; }
.rf-dialog .rf-pill--dueSoon { background: #fdf3dc; color: #92400e; }
.rf-dialog .rf-pill--overdue { background: #fde4e4; color: #b42318; }

.rf-dialog__list {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.rf-dialog__list > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.55rem 0.15rem;
  font-size: 0.84rem;
}

.rf-dialog__list > div + div {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.rf-dialog__list > div.is-sep {
  border-top-color: rgba(15, 23, 42, 0.14);
}

.rf-dialog__list dt {
  color: #6e6e73;
  flex-shrink: 0;
}

.rf-dialog__list dd {
  margin: 0;
  font-weight: 600;
  color: #0f172a;
  text-align: right;
  overflow-wrap: anywhere;
}

.rf-dialog__list .is-total dt,
.rf-dialog__list .is-total dd {
  font-weight: 700;
  color: #0f172a;
  font-size: 0.92rem;
}

.rf-dialog__list .is-late {
  color: #b42318;
}

.rf-dialog__list .is-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
</style>
