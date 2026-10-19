<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import Chart from 'primevue/chart'
import { financesApi } from '@/finances/infrastructure/financesApi.js'
import { adminManagementExpensesApi } from '@/finances/infrastructure/adminManagementExpensesApi.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const { t, locale } = useI18n()

const kpi = ref({
  totalResidents: 0,
  occupiedUnits: 0,
  emptyUnits: 0,
  totalDebt: 0,
})

// RF023 / US023: morosidad crítica = deuda vencida; roja solo si supera el umbral del presupuesto.
const delinquency = ref({
  previousMonthDebt: 0,
  trend: 'flat',
  trendDelta: 0,
  monthlyBudget: 0,
  threshold: 0.15,
  criticalAmount: 0,
  isCritical: false,
})

function applyKpi(kpiData) {
  kpi.value = {
    totalResidents: Number(kpiData.totalResidents) || 0,
    occupiedUnits: Number(kpiData.occupiedUnits) || 0,
    emptyUnits: Number(kpiData.emptyUnits) || 0,
    totalDebt: Number(kpiData.totalDebt ?? kpiData.totalPendingDebt) || 0,
  }
  const d = kpiData.delinquency || {}
  delinquency.value = {
    previousMonthDebt: Number(d.previousMonthDebt) || 0,
    trend: d.trend === 'up' || d.trend === 'down' ? d.trend : 'flat',
    trendDelta: Number(d.trendDelta) || 0,
    monthlyBudget: Number(d.monthlyBudget) || 0,
    threshold: Number(d.threshold) || 0.15,
    criticalAmount: Number(d.criticalAmount) || 0,
    isCritical: Boolean(d.isCritical),
  }
}

const thresholdPct = computed(() => Math.round(delinquency.value.threshold * 100))

const delinquencySubtext = computed(() => {
  const d = delinquency.value
  if (d.monthlyBudget <= 0) return t('financeOps.kpiNoBudget')
  if (d.isCritical)
    return t('financeOps.kpiCriticalHint', { pct: thresholdPct.value, amount: nfPen.value(d.criticalAmount) })
  return t('financeOps.kpiUnderThreshold', { pct: thresholdPct.value, amount: nfPen.value(d.criticalAmount) })
})

const trendLabel = computed(() => {
  const d = delinquency.value
  if (d.trend === 'flat') return t('financeOps.kpiTrendFlat')
  const amount = nfPen.value(Math.abs(d.trendDelta))
  return d.trend === 'up'
    ? t('financeOps.kpiTrendUp', { amount })
    : t('financeOps.kpiTrendDown', { amount })
})

// "Descuenta el pago en tiempo real": refresca el KPI al volver a la pestaña y cada minuto.
async function refreshKpi() {
  try {
    const data = await financesApi.getDashboardKpis()
    if (data && typeof data === 'object') {
      applyKpi(data)
      kpiLoadFailed.value = false
    }
  } catch {
    // Silencioso: se mantiene el último valor mostrado.
  }
}

function onVisibility() {
  if (document.visibilityState === 'visible') refreshKpi()
}

let kpiTimer = null
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', refreshKpi)
  kpiTimer = setInterval(refreshKpi, 60000)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('focus', refreshKpi)
  if (kpiTimer) clearInterval(kpiTimer)
})

const recentIncidents = ref([])
const reservations = ref([])
const spacesById = ref(new Map())
const isLoading = ref(true)
const chartHasData = ref(false)
/** RNF012: main dashboard loads that failed (shown with a retry action). */
const kpiLoadFailed = ref(false)
const listsLoadFailed = ref(false)

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function spaceName(spaceId) {
  return spacesById.value.get(spaceId)?.name ?? t('app.spaceFallbackName')
}

function guestCount(row) {
  return Array.isArray(row?.guests) ? row.guests.filter((g) => String(g?.name ?? '').trim()).length : 0
}

const todayReservations = computed(() => {
  const key = todayKey()
  return reservations.value
    .filter((row) => String(row.date ?? '') === key)
    .slice()
    .sort((a, b) => String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')))
})

const todayGuestSummary = computed(() => {
  const withGuests = todayReservations.value.filter((row) => guestCount(row) > 0).length
  return {
    depts: todayReservations.value.length,
    withGuests,
  }
})

const nfPen = computed(
  () => (value) =>
    new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: 'PEN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(Number(value)) ? Number(value) : 0),
)

function monthLabelFromKey(monthKey) {
  const [year, month] = String(monthKey ?? '').split('-').map(Number)
  if (!year || !month) return String(monthKey ?? '')
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return new Intl.DateTimeFormat(loc, { month: 'short' }).format(new Date(year, month - 1, 1))
}

function buildChartFromMonthlyApi(monthlyChart) {
  const rows = Array.isArray(monthlyChart) ? monthlyChart : []
  const labels = rows.map((row) => monthLabelFromKey(row.monthKey))
  const incomeData = rows.map((row) => Number(row.income) || 0)
  const expenseData = rows.map((row) => Number(row.expenses) || 0)
  const hasData = incomeData.some((v) => v > 0) || expenseData.some((v) => v > 0)
  return { labels, incomeData, expenseData, hasData }
}

function monthKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthKeyFromIso(value) {
  const raw = String(value ?? '').trim()
  return raw.length >= 7 ? raw.slice(0, 7) : ''
}

function buildChartFromTransactions(payments, expenses, receipts) {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i -= 1) {
    months.push(new Date(now.getFullYear(), now.getMonth() - i, 1))
  }

  const labels = months.map((m) => monthLabelFromKey(monthKeyFromDate(m)))

  const incomeData = months.map((m) => {
    const key = monthKeyFromDate(m)
    const fromPayments = (payments ?? [])
      .filter((p) => monthKeyFromIso(p.paidAt) === key)
      .reduce((sum, p) => sum + Number(p.amount ?? 0), 0)
    if (fromPayments > 0) return fromPayments
    return (receipts ?? [])
      .filter((r) => r.status === 'Paid' && monthKeyFromIso(r.issueDate) === key)
      .reduce((sum, r) => sum + Number(r.amount ?? 0) + Number(r.lateFee ?? 0) + Number(r.extraCharges ?? 0), 0)
  })

  const expenseData = months.map((m) => {
    const key = monthKeyFromDate(m)
    return (expenses ?? [])
      .filter((e) => monthKeyFromIso(e.purchaseDate) === key)
      .reduce((sum, e) => sum + Number(e.amount ?? 0), 0)
  })

  const hasData = incomeData.some((v) => v > 0) || expenseData.some((v) => v > 0)
  return { labels, incomeData, expenseData, hasData }
}

const chartData = ref({
  labels: [],
  datasets: [
    {
      label: t('dashboard.income'),
      backgroundColor: 'rgba(52, 199, 89, 0.45)',
      borderColor: '#34c759',
      borderWidth: 1,
      borderRadius: 6,
      data: [],
    },
    {
      label: t('dashboard.expenses'),
      backgroundColor: 'rgba(255, 59, 48, 0.4)',
      borderColor: '#ff3b30',
      borderWidth: 1,
      borderRadius: 6,
      data: [],
    },
  ],
})

function applyChartData({ labels, incomeData, expenseData, hasData }) {
  chartHasData.value = hasData
  chartData.value = {
    labels,
    datasets: [
      { ...chartData.value.datasets[0], label: t('dashboard.income'), data: incomeData },
      { ...chartData.value.datasets[1], label: t('dashboard.expenses'), data: expenseData },
    ],
  }
}

async function loadAdminChart(kpiData) {
  const fromApi = buildChartFromMonthlyApi(kpiData?.monthlyChart)
  if (fromApi.hasData) {
    applyChartData(fromApi)
    return
  }

  const [payments, expenses, receipts] = await Promise.all([
    financesApi.getAllPayments(),
    adminManagementExpensesApi.list(),
    financesApi.getReceipts(),
  ])
  applyChartData(buildChartFromTransactions(payments, expenses, receipts))
}

async function loadDashboard() {
  isLoading.value = true
  kpiLoadFailed.value = false
  listsLoadFailed.value = false
  try {
    const [kpiResult, incidentsResult, reservationsResult, spacesResult] = await Promise.allSettled([
      financesApi.getDashboardKpis(),
      incidentsApi.list(),
      reservationsApi.listAllForAdmin(),
      spacesApi.list(),
    ])

    kpiLoadFailed.value = kpiResult.status === 'rejected'
    listsLoadFailed.value = [incidentsResult, reservationsResult, spacesResult].some((r) => r.status === 'rejected')

    const kpiData = kpiResult.status === 'fulfilled' ? kpiResult.value : null
    if (kpiData && typeof kpiData === 'object') {
      applyKpi(kpiData)

      await loadAdminChart(kpiData)
    }

    const incidentsData = incidentsResult.status === 'fulfilled' ? incidentsResult.value : []
    if (Array.isArray(incidentsData)) {
      recentIncidents.value = [...incidentsData]
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
        .slice(0, 5)
    }

    const reservationsData = reservationsResult.status === 'fulfilled' ? reservationsResult.value : []
    const spaces = spacesResult.status === 'fulfilled' ? spacesResult.value : []
    reservations.value = Array.isArray(reservationsData) ? reservationsData : []
    spacesById.value = new Map((Array.isArray(spaces) ? spaces : []).map((s) => [s.id, s]))
  } catch (error) {
    console.error('Error loading dashboard data:', error)
    kpiLoadFailed.value = true
  } finally {
    isLoading.value = false
  }
}

onMounted(loadDashboard)

function incidentStatusLabel(status) {
  switch (status) {
    case 'open':
      return t('incidentStatusOpen')
    case 'in-progress':
      return t('incidentStatusInProgress')
    case 'resolved':
      return t('incidentStatusResolved')
    default:
      return String(status ?? '—')
  }
}

function departmentLabel(row) {
  const code = String(row?.residentCode ?? '').trim()
  if (code) return t('dashboard.deptLabel', { code })
  return t('dashboard.deptUnknown')
}

function guestNames(row) {
  return (Array.isArray(row?.guests) ? row.guests : [])
    .map((g) => String(g?.name ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

function slotLabel(row) {
  return `${row.startTime ?? ''} – ${row.endTime ?? ''}`
}

const nfDate = computed(
  () => (iso) => {
    const s = String(iso ?? '').trim()
    if (!s) return ''
    const d = new Date(s)
    if (!Number.isFinite(d.getTime())) return s
    const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
    return new Intl.DateTimeFormat(loc, { dateStyle: 'medium' }).format(d)
  },
)

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      position: 'bottom',
      labels: {
        usePointStyle: true,
        pointStyle: 'circle',
        padding: 16,
        font: { size: 11, weight: '500' },
        color: '#6e6e73',
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { font: { size: 11, weight: '500' }, color: '#86868b' },
    },
    y: {
      beginAtZero: true,
      grid: { color: 'rgba(0,0,0,0.05)' },
      ticks: {
        font: { size: 11 },
        color: '#86868b',
        callback: (v) => (v >= 1000 ? `S/ ${(v / 1000).toFixed(0)}k` : `S/ ${v}`),
      },
    },
  },
})
</script>

<template>
  <div class="app-view app-view--ai">
    <header class="dash-head">
      <h1 class="dash-head__title">{{ t('dashboard.title') }}</h1>
      <p class="dash-head__sub">{{ t('dashboard.subtitle') }}</p>
    </header>

    <div class="finance-page">
      <section class="finance-panel" aria-labelledby="dashboard-kpi-heading">
        <h2 id="dashboard-kpi-heading" class="finance-panel__section-title">
          {{ t('dashboard.financialOverview') }}
        </h2>

        <LoadErrorRetry
          v-if="!isLoading && (kpiLoadFailed || listsLoadFailed)"
          :loading="isLoading"
          @retry="loadDashboard"
        />

        <div class="kpi-grid custom-scrollbar">
          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-blue">
                <i class="pi pi-users" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('dashboard.totalResidents') }}</span>
            </div>
            <div class="kpi-value">{{ isLoading ? '…' : kpi.totalResidents }}</div>
            <span class="kpi-subtext">{{ t('dashboard.kpiRegistered') }}</span>
          </div>

          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-green">
                <i class="pi pi-building" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('dashboard.occupiedUnits') }}</span>
            </div>
            <div class="kpi-value">{{ isLoading ? '…' : kpi.occupiedUnits }}</div>
            <span class="kpi-subtext">{{ t('dashboard.kpiActiveDepts') }}</span>
          </div>

          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-orange">
                <i class="pi pi-home" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('dashboard.emptyUnits') }}</span>
            </div>
            <div class="kpi-value">{{ isLoading ? '…' : kpi.emptyUnits }}</div>
            <span class="kpi-subtext">{{ t('dashboard.kpiAvailable') }}</span>
          </div>

          <div
            class="kpi-card"
            :class="{ 'card-danger': delinquency.isCritical }"
            :aria-live="delinquency.isCritical ? 'polite' : 'off'"
          >
            <div class="kpi-header">
              <div class="kpi-icon" :class="delinquency.isCritical ? 'icon-red' : 'icon-orange'">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('dashboard.criticalDelinquency') }}</span>
            </div>
            <div class="kpi-value-row">
              <div class="kpi-value" :class="{ 'text-red': delinquency.isCritical }">
                {{ isLoading ? '…' : nfPen(kpi.totalDebt) }}
              </div>
              <span
                v-if="!isLoading"
                class="kpi-trend"
                :class="`kpi-trend--${delinquency.trend}`"
                :title="trendLabel"
              >
                <i
                  class="pi"
                  :class="
                    delinquency.trend === 'up'
                      ? 'pi-arrow-up-right'
                      : delinquency.trend === 'down'
                        ? 'pi-arrow-down-right'
                        : 'pi-minus'
                  "
                  aria-hidden="true"
                ></i>
                <span class="visually-hidden">{{ trendLabel }}</span>
              </span>
            </div>
            <span class="kpi-subtext" :class="{ 'subtext-red': delinquency.isCritical }">
              {{ isLoading ? t('dashboard.kpiAccumulatedDebt') : trendLabel }}
            </span>
            <span v-if="!isLoading" class="kpi-subtext kpi-subtext--hint">{{ delinquencySubtext }}</span>
          </div>
        </div>
      </section>

      <section class="finance-panel" aria-labelledby="dashboard-reservations-heading">
        <div class="panel-head">
          <h2 id="dashboard-reservations-heading" class="finance-panel__section-title">
            {{ t('dashboard.todayReservations') }}
          </h2>
          <p v-if="!isLoading && todayReservations.length" class="panel-head__meta">
            {{
              t('dashboard.todaySummary', {
                depts: todayGuestSummary.depts,
                withGuests: todayGuestSummary.withGuests,
              })
            }}
          </p>
        </div>
        <p class="panel-hint">{{ t('dashboard.todayReservationsHint') }}</p>

        <p v-if="isLoading" class="dash-empty">{{ t('dashboard.todayReservationsLoading') }}</p>
        <p v-else-if="!todayReservations.length" class="dash-empty">
          {{ t('dashboard.todayReservationsEmpty') }}
        </p>
        <ul v-else class="dash-list" role="list">
          <li v-for="row in todayReservations" :key="row.id" class="dash-row">
            <div class="dash-row__main">
              <span class="dash-row__title">{{ departmentLabel(row) }}</span>
              <span class="dash-row__meta">
                {{ row.residentName || '—' }} · {{ spaceName(row.spaceId) }} · {{ slotLabel(row) }}
              </span>
            </div>
            <div class="dash-row__side">
              <span
                class="guest-badge"
                :class="guestCount(row) ? 'guest-badge--yes' : 'guest-badge--no'"
              >
                {{
                  guestCount(row)
                    ? t('dashboard.guestCount', { n: guestCount(row) })
                    : t('dashboard.guestNone')
                }}
              </span>
              <span v-if="guestCount(row)" class="dash-row__guests">{{ guestNames(row) }}</span>
            </div>
          </li>
        </ul>
      </section>

      <div class="grid-layout">
        <section class="finance-panel flex-1" aria-labelledby="dashboard-incidents-heading">
          <h2 id="dashboard-incidents-heading" class="finance-panel__section-title">
            {{ t('dashboard.recentIncidents') }}
          </h2>

          <p v-if="!recentIncidents.length && !isLoading" class="dash-empty">
            {{ t('dashboard.incidentsEmpty') }}
          </p>

          <ul v-else class="dash-list" role="list">
            <li v-for="row in recentIncidents" :key="row.id" class="dash-row">
              <div class="dash-row__main">
                <span class="dash-row__title">{{ row.title || row.description }}</span>
                <span class="dash-row__meta">
                  {{ row.residentName || '—' }}
                  <template v-if="row.createdAt"> · {{ nfDate(row.createdAt) }}</template>
                </span>
              </div>
              <span class="inc-badge" :class="`inc-badge--${row.status || 'open'}`">
                {{ incidentStatusLabel(row.status) }}
              </span>
            </li>
          </ul>
        </section>

        <section class="finance-panel flex-1" aria-labelledby="dashboard-chart-heading">
          <h2 id="dashboard-chart-heading" class="finance-panel__section-title">
            {{ t('dashboard.income') }} / {{ t('dashboard.expenses') }}
          </h2>
          <div class="dashboard-chart-wrap">
            <p v-if="!isLoading && !chartHasData" class="dashboard-chart-empty">
              {{ t('dashboard.chartEmpty') }}
            </p>
            <Chart
              v-else-if="!isLoading"
              type="bar"
              :data="chartData"
              :options="chartOptions"
              class="dashboard-chart"
            />
          </div>
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

.dash-head {
  padding: 0.15rem 0.15rem 0.25rem;
}

.dash-head__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--apple-text, #1d1d1f);
}

.dash-head__sub {
  margin: 0.2rem 0 0;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
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
}

.panel-head .finance-panel__section-title {
  margin-bottom: 0;
}

.panel-head__meta {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--apple-blue, #1e3a8a);
}

.panel-hint {
  margin: 0.35rem 0 0.85rem;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.kpi-grid {
  /* Containing block for absolutely positioned (visually-hidden) children so they stay in the scroller. */
  position: relative;
  display: flex;
  flex-direction: row;
  gap: 0.85rem;
  overflow-x: auto;
  padding-bottom: 0.15rem;
}

.kpi-card {
  flex: 1;
  min-width: 12.5rem;
  background: #f5f5f7;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 14px;
  padding: 1rem 1.05rem 1.1rem;
  display: flex;
  flex-direction: column;
}

.kpi-header {
  display: flex;
  align-items: center;
  margin-bottom: 0.75rem;
}

.kpi-icon {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 0.7rem;
  font-size: 0.95rem;
}

.icon-blue { background: #e8eefc; color: #1e3a8a; }
.icon-green { background: #e8f5e9; color: #1b7a3d; }
.icon-orange { background: #fff3e0; color: #e65100; }
.icon-red { background: #fdecee; color: #b42318; }

.kpi-label {
  color: #6e6e73;
  font-weight: 500;
  font-size: 0.8125rem;
  letter-spacing: -0.01em;
}

.kpi-value {
  color: #1d1d1f;
  font-weight: 650;
  font-size: 1.55rem;
  letter-spacing: -0.03em;
  margin-bottom: 0.3rem;
}

.kpi-subtext {
  color: #86868b;
  font-size: 0.75rem;
  font-weight: 500;
}

.subtext-red { color: #b42318; }

.kpi-value-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.kpi-trend {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.75rem;
  background: #ececf0;
  color: #6e6e73;
}

/* Deuda que sube es mala (rojo); que baja es buena (verde). */
.kpi-trend--up { background: #fdecee; color: #b42318; }
.kpi-trend--down { background: #e8f5e9; color: #1b7a3d; }

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

.kpi-subtext--hint {
  margin-top: 0.2rem;
  font-size: 0.7rem;
  color: #86868b;
}
.text-red { color: #b42318; }
.card-danger { background: #fff7f7; }

.custom-scrollbar::-webkit-scrollbar {
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: #d2d2d7;
  border-radius: 10px;
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
  max-width: 14rem;
}

.dash-row__guests {
  font-size: 0.72rem;
  line-height: 1.35;
  color: #6e6e73;
  text-align: right;
}

.guest-badge,
.inc-badge {
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

.guest-badge--no {
  background: #eeeef0;
  color: #6e6e73;
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

.grid-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.grid-layout > .flex-1 {
  flex: 1 1 0;
  min-width: 0;
}
@media (min-width: 1024px) {
  .grid-layout {
    flex-direction: row;
  }
}

.dashboard-chart-wrap {
  height: 300px;
  position: relative;
}
.dashboard-chart-empty {
  margin: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #6e6e73;
  font-size: 0.875rem;
  padding: 1rem;
}
.dashboard-chart {
  height: 100%;
}

@media (max-width: 720px) {
  .dash-row {
    flex-direction: column;
  }
  .dash-row__side {
    align-items: flex-start;
    max-width: none;
  }
  .dash-row__guests {
    text-align: left;
  }
}
</style>
