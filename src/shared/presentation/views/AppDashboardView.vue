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
import { buildingsApi } from '@/profiles/infrastructure/buildingsApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'

const { t, locale } = useI18n()
const session = useSession()

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

// Encabezado: saludo, fecha y edificio registrado (si existe).
const buildingName = ref('')
const firstName = computed(() => String(session.state.profile?.name ?? '').trim().split(/\s+/)[0] || '')
const todayLong = computed(() =>
  new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date()),
)

const totalUnits = computed(() => kpi.value.occupiedUnits + kpi.value.emptyUnits)
const occupancyPct = computed(() =>
  totalUnits.value > 0 ? Math.round((kpi.value.occupiedUnits / totalUnits.value) * 100) : 0,
)

/** Estado de la morosidad frente al umbral (RF023): crítico, bajo control o sin presupuesto configurado. */
const delinquencyState = computed(() => {
  if (delinquency.value.monthlyBudget <= 0) return 'none'
  return delinquency.value.isCritical ? 'critical' : 'healthy'
})
const thresholdUsagePct = computed(() => {
  const limit = delinquency.value.criticalAmount
  if (!(limit > 0)) return 0
  return Math.min(100, Math.round((kpi.value.totalDebt / limit) * 100))
})

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
const chartTotals = ref({ income: 0, expenses: 0 })
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
      backgroundColor: '#1e3a8a',
      hoverBackgroundColor: '#172554',
      borderWidth: 0,
      borderRadius: 8,
      borderSkipped: false,
      maxBarThickness: 22,
      data: [],
    },
    {
      label: t('dashboard.expenses'),
      backgroundColor: '#f4a261',
      hoverBackgroundColor: '#e76f51',
      borderWidth: 0,
      borderRadius: 8,
      borderSkipped: false,
      maxBarThickness: 22,
      data: [],
    },
  ],
})

function applyChartData({ labels, incomeData, expenseData, hasData }) {
  chartHasData.value = hasData
  chartTotals.value = {
    income: incomeData.reduce((sum, v) => sum + v, 0),
    expenses: expenseData.reduce((sum, v) => sum + v, 0),
  }
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
    const [kpiResult, incidentsResult, reservationsResult, spacesResult, buildingsResult] = await Promise.allSettled([
      financesApi.getDashboardKpis(),
      incidentsApi.list(),
      reservationsApi.listAllForAdmin(),
      spacesApi.list(),
      buildingsApi.mine(),
    ])

    const buildings = buildingsResult.status === 'fulfilled' ? buildingsResult.value : null
    const building = Array.isArray(buildings) ? buildings[0] : buildings
    buildingName.value = String(building?.name ?? '').trim()

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

const openIncidentsCount = computed(
  () => recentIncidents.value.filter((row) => (row.status || 'open') !== 'resolved').length,
)

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
    legend: { display: false },
    tooltip: {
      backgroundColor: '#0f172a',
      padding: 10,
      cornerRadius: 10,
      titleFont: { size: 12, weight: '600' },
      bodyFont: { size: 12 },
      usePointStyle: true,
      boxPadding: 4,
      callbacks: {
        label: (ctx) => ` ${ctx.dataset.label}: S/ ${Number(ctx.parsed.y || 0).toFixed(2)}`,
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      border: { display: false },
      ticks: { font: { size: 11, weight: '500' }, color: '#86868b' },
    },
    y: {
      beginAtZero: true,
      border: { display: false },
      grid: { color: 'rgba(15, 23, 42, 0.06)' },
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
  <div class="app-view app-view--ai dash">
    <header class="dash-hero">
      <div class="dash-hero__text">
        <p class="dash-hero__date">{{ todayLong }}<template v-if="buildingName"> · {{ buildingName }}</template></p>
        <h1 class="dash-hero__title">
          {{ firstName ? t('dashboard.greeting', { name: firstName }) : t('dashboard.title') }}
        </h1>
        <p class="dash-hero__sub">{{ t('dashboard.subtitle') }}</p>
      </div>
      <nav class="dash-actions" :aria-label="t('dashboard.quickActions')">
        <RouterLink :to="{ name: AppRouteNames.APP_FINANCE }" class="dash-action dash-action--primary">
          <i class="pi pi-receipt" aria-hidden="true"></i>
          <span>{{ t('dashboard.quickGenerate') }}</span>
        </RouterLink>
        <RouterLink :to="{ name: AppRouteNames.APP_INFORMATION }" class="dash-action">
          <i class="pi pi-megaphone" aria-hidden="true"></i>
          <span>{{ t('dashboard.quickAnnouncement') }}</span>
        </RouterLink>
        <RouterLink :to="{ name: AppRouteNames.APP_INCIDENTS }" class="dash-action">
          <i class="pi pi-flag" aria-hidden="true"></i>
          <span>{{ t('dashboard.quickIncidents') }}</span>
        </RouterLink>
      </nav>
    </header>

    <LoadErrorRetry
      v-if="!isLoading && (kpiLoadFailed || listsLoadFailed)"
      :loading="isLoading"
      @retry="loadDashboard"
    />

    <section class="kpi-grid" :aria-label="t('dashboard.financialOverview')">
      <article class="kpi-card kpi-card--blue">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.totalResidents') }}</span>
          <span class="kpi-icon icon-blue"><i class="pi pi-users" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">{{ isLoading ? '…' : kpi.totalResidents }}</div>
        <span class="kpi-subtext">{{ t('dashboard.kpiRegistered') }}</span>
      </article>

      <article class="kpi-card kpi-card--green">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.occupiedUnits') }}</span>
          <span class="kpi-icon icon-green"><i class="pi pi-building" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">
          {{ isLoading ? '…' : kpi.occupiedUnits }}
          <span v-if="!isLoading && totalUnits" class="kpi-value__of">/ {{ totalUnits }}</span>
        </div>
        <div
          v-if="!isLoading && totalUnits"
          class="kpi-meter"
          role="meter"
          :aria-valuenow="occupancyPct"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('dashboard.occupancy', { pct: occupancyPct })"
        >
          <span class="kpi-meter__fill kpi-meter__fill--green" :style="{ width: `${occupancyPct}%` }"></span>
        </div>
        <span class="kpi-subtext">
          {{ totalUnits ? t('dashboard.occupancy', { pct: occupancyPct }) : t('dashboard.kpiActiveDepts') }}
        </span>
      </article>

      <article class="kpi-card kpi-card--orange">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.emptyUnits') }}</span>
          <span class="kpi-icon icon-orange"><i class="pi pi-home" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">{{ isLoading ? '…' : kpi.emptyUnits }}</div>
        <span class="kpi-subtext">{{ t('dashboard.kpiAvailable') }}</span>
      </article>

      <article
        class="kpi-card"
        :class="delinquency.isCritical ? 'kpi-card--red card-danger' : 'kpi-card--amber'"
        :aria-live="delinquency.isCritical ? 'polite' : 'off'"
      >
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.criticalDelinquency') }}</span>
          <span class="kpi-icon" :class="delinquency.isCritical ? 'icon-red' : 'icon-amber'">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          </span>
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
          <span v-if="!isLoading" class="kpi-state" :class="`kpi-state--${delinquencyState}`">
            {{
              delinquencyState === 'critical'
                ? t('dashboard.statusCritical')
                : delinquencyState === 'healthy'
                  ? t('dashboard.statusHealthy')
                  : t('dashboard.statusNoBudget')
            }}
          </span>
        </div>
        <div
          v-if="!isLoading && delinquencyState !== 'none'"
          class="kpi-meter"
          role="meter"
          :aria-valuenow="thresholdUsagePct"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('dashboard.thresholdUsage', { pct: thresholdUsagePct })"
        >
          <span
            class="kpi-meter__fill"
            :class="delinquency.isCritical ? 'kpi-meter__fill--red' : 'kpi-meter__fill--amber'"
            :style="{ width: `${thresholdUsagePct}%` }"
          ></span>
        </div>
        <span class="kpi-subtext" :class="{ 'subtext-red': delinquency.isCritical }">
          {{ isLoading ? t('dashboard.kpiAccumulatedDebt') : trendLabel }}
        </span>
        <span v-if="!isLoading" class="kpi-subtext kpi-subtext--hint">{{ delinquencySubtext }}</span>
      </article>
    </section>

    <div class="dash-grid">
      <section class="dash-card dash-card--chart" aria-labelledby="dashboard-chart-heading">
        <div class="dash-card__head">
          <div>
            <h2 id="dashboard-chart-heading" class="dash-card__title">
              {{ t('dashboard.income') }} / {{ t('dashboard.expenses') }}
            </h2>
            <p class="dash-card__hint">{{ t('dashboard.last6Months') }}</p>
          </div>
          <dl v-if="!isLoading && chartHasData" class="chart-totals">
            <div class="chart-totals__item">
              <dt><span class="legend-dot legend-dot--income" aria-hidden="true"></span>{{ t('dashboard.income') }}</dt>
              <dd>{{ nfPen(chartTotals.income) }}</dd>
            </div>
            <div class="chart-totals__item">
              <dt><span class="legend-dot legend-dot--expense" aria-hidden="true"></span>{{ t('dashboard.expenses') }}</dt>
              <dd>{{ nfPen(chartTotals.expenses) }}</dd>
            </div>
            <div class="chart-totals__item">
              <dt>{{ t('dashboard.net') }}</dt>
              <dd :class="chartTotals.income - chartTotals.expenses < 0 ? 'text-red' : 'text-green'">
                {{ nfPen(chartTotals.income - chartTotals.expenses) }}
              </dd>
            </div>
          </dl>
        </div>
        <div class="dashboard-chart-wrap">
          <p v-if="!isLoading && !chartHasData" class="dashboard-chart-empty">
            <i class="pi pi-chart-bar" aria-hidden="true"></i>
            <span>{{ t('dashboard.chartEmpty') }}</span>
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

      <section class="dash-card" aria-labelledby="dashboard-reservations-heading">
        <div class="dash-card__head">
          <div>
            <h2 id="dashboard-reservations-heading" class="dash-card__title">
              {{ t('dashboard.todayReservations') }}
            </h2>
            <p class="dash-card__hint">{{ t('dashboard.todayReservationsHint') }}</p>
          </div>
          <span v-if="!isLoading && todayReservations.length" class="dash-chip">
            {{
              t('dashboard.todaySummary', {
                depts: todayGuestSummary.depts,
                withGuests: todayGuestSummary.withGuests,
              })
            }}
          </span>
        </div>

        <p v-if="isLoading" class="dash-empty">{{ t('dashboard.todayReservationsLoading') }}</p>
        <div v-else-if="!todayReservations.length" class="dash-empty dash-empty--box">
          <i class="pi pi-calendar" aria-hidden="true"></i>
          <span>{{ t('dashboard.todayReservationsEmpty') }}</span>
        </div>
        <ul v-else class="dash-list" role="list">
          <li v-for="row in todayReservations" :key="row.id" class="res-row">
            <span class="res-row__time">
              <strong>{{ row.startTime || '—' }}</strong>
              <small>{{ row.endTime || '' }}</small>
            </span>
            <div class="res-row__main">
              <span class="dash-row__title">{{ departmentLabel(row) }} · {{ spaceName(row.spaceId) }}</span>
              <span class="dash-row__meta">{{ row.residentName || '—' }}</span>
              <span v-if="guestCount(row)" class="dash-row__guests" :title="guestNames(row)">
                <i class="pi pi-user-plus" aria-hidden="true"></i>
                {{ t('dashboard.guestCount', { n: guestCount(row) }) }} · {{ guestNames(row) }}
              </span>
              <span v-else class="dash-row__guests dash-row__guests--none">{{ t('dashboard.guestNone') }}</span>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <section class="dash-card" aria-labelledby="dashboard-incidents-heading">
      <div class="dash-card__head">
        <div class="dash-card__title-row">
          <h2 id="dashboard-incidents-heading" class="dash-card__title">{{ t('dashboard.recentIncidents') }}</h2>
          <span v-if="!isLoading && openIncidentsCount" class="dash-chip dash-chip--red">
            {{ t('dashboard.openIncidents', { n: openIncidentsCount }) }}
          </span>
        </div>
        <RouterLink :to="{ name: AppRouteNames.APP_INCIDENTS }" class="dash-link">
          {{ t('dashboard.viewAll') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
        </RouterLink>
      </div>

      <div v-if="!recentIncidents.length && !isLoading" class="dash-empty dash-empty--box">
        <i class="pi pi-check-circle" aria-hidden="true"></i>
        <span>{{ t('dashboard.incidentsEmpty') }}</span>
      </div>

      <ul v-else class="inc-list" role="list">
        <li
          v-for="row in recentIncidents"
          :key="row.id"
          class="inc-row"
          :class="`inc-row--${row.status || 'open'}`"
        >
          <span class="inc-row__dot" aria-hidden="true"></span>
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
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.app-view--ai {
  max-width: 88rem;
  padding-top: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

/* ---------- Hero ---------- */
.dash-hero {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.25rem;
  flex-wrap: wrap;
  padding: 1.5rem 1.6rem;
  border-radius: 20px;
  color: #fff;
  background:
    radial-gradient(120% 140% at 100% 0%, rgba(96, 165, 250, 0.35) 0%, rgba(96, 165, 250, 0) 55%),
    linear-gradient(135deg, #1e3a8a 0%, #172554 100%);
  box-shadow: 0 10px 30px rgba(23, 37, 84, 0.18);
}

.dash-hero__date {
  margin: 0 0 0.35rem;
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: rgba(255, 255, 255, 0.72);
}

.dash-hero__date::first-letter {
  text-transform: uppercase;
}

.dash-hero__title {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: #fff;
}

.dash-hero__sub {
  margin: 0.3rem 0 0;
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.78);
}

.dash-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dash-action {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.9rem;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.22);
  transition: background 0.15s ease, transform 0.15s ease;
}

.dash-action:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.dash-action:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.dash-action--primary {
  color: #172554;
  background: #fff;
  border-color: #fff;
}

.dash-action--primary:hover {
  background: #eef2ff;
}

/* ---------- KPI cards ---------- */
.kpi-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.9rem;
}

.kpi-card {
  --kpi-accent: #1e3a8a;
  position: relative;
  overflow: hidden;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  border-radius: 16px;
  padding: 1.05rem 1.1rem 1.1rem;
  display: flex;
  flex-direction: column;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}

.kpi-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: var(--kpi-accent);
}

.kpi-card:hover {
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.07);
  transform: translateY(-1px);
}

.kpi-card--blue { --kpi-accent: #1e3a8a; }
.kpi-card--green { --kpi-accent: #16a34a; }
.kpi-card--orange { --kpi-accent: #ea580c; }
.kpi-card--amber { --kpi-accent: #d97706; }
.kpi-card--red { --kpi-accent: #dc2626; }

.kpi-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
}

.kpi-icon {
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.95rem;
}

.icon-blue { background: #e8eefc; color: #1e3a8a; }
.icon-green { background: #e7f6ec; color: #15803d; }
.icon-orange { background: #fff1e6; color: #c2410c; }
.icon-amber { background: #fef6e4; color: #b45309; }
.icon-red { background: #fdecee; color: #b42318; }

.kpi-label {
  color: #6e6e73;
  font-weight: 600;
  font-size: 0.78rem;
  letter-spacing: 0.01em;
}

.kpi-value {
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.8rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin-bottom: 0.45rem;
}

.kpi-value__of {
  font-size: 1rem;
  font-weight: 600;
  color: #94a3b8;
  letter-spacing: 0;
}

.kpi-subtext {
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
}

.subtext-red { color: #b42318; }

.kpi-value-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-bottom: 0.45rem;
}

.kpi-value-row .kpi-value {
  margin-bottom: 0;
}

.kpi-trend {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.72rem;
  background: #eef0f4;
  color: #64748b;
}

/* Deuda que sube es mala (rojo); que baja es buena (verde). */
.kpi-trend--up { background: #fdecee; color: #b42318; }
.kpi-trend--down { background: #e7f6ec; color: #15803d; }

.kpi-state {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.kpi-state--critical { background: #fdecee; color: #b42318; }
.kpi-state--healthy { background: #e7f6ec; color: #15803d; }
.kpi-state--none { background: #eef0f4; color: #64748b; }

.kpi-meter {
  height: 6px;
  border-radius: 999px;
  background: #eef0f4;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.kpi-meter__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  transition: width 0.4s ease;
}

.kpi-meter__fill--green { background: linear-gradient(90deg, #22c55e, #16a34a); }
.kpi-meter__fill--amber { background: linear-gradient(90deg, #fbbf24, #d97706); }
.kpi-meter__fill--red { background: linear-gradient(90deg, #f87171, #dc2626); }

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
  margin-top: 0.25rem;
  font-size: 0.7rem;
  line-height: 1.4;
  color: #94a3b8;
}

.text-red { color: #b42318; }
.text-green { color: #15803d; }
.card-danger { background: linear-gradient(180deg, #fff5f5 0%, #fff 70%); }

/* ---------- Cards ---------- */
.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 1rem;
}

.dash-card {
  padding: 1.2rem 1.25rem 1.3rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.dash-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.dash-card__title-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.dash-card__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.dash-card__hint {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
}

.dash-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  color: #1e3a8a;
  background: #e8eefc;
  white-space: nowrap;
}

.dash-chip--red {
  color: #b42318;
  background: #fdecee;
}

.dash-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #1e3a8a;
  text-decoration: none;
}

.dash-link:hover { text-decoration: underline; }
.dash-link .pi { font-size: 0.7rem; }

/* Chart */
.chart-totals {
  display: flex;
  gap: 1.25rem;
  margin: 0;
  flex-wrap: wrap;
}

.chart-totals__item dt {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
}

.chart-totals__item dd {
  margin: 0.15rem 0 0;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.chart-totals__item dd.text-red { color: #b42318; }
.chart-totals__item dd.text-green { color: #15803d; }

.legend-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 3px;
  display: inline-block;
}

.legend-dot--income { background: #1e3a8a; }
.legend-dot--expense { background: #f4a261; }

.dashboard-chart-wrap {
  height: 280px;
  position: relative;
}

.dashboard-chart-empty {
  margin: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  text-align: center;
  color: #6e6e73;
  font-size: 0.85rem;
  padding: 1rem 2rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px dashed rgba(15, 23, 42, 0.12);
}

.dashboard-chart-empty .pi {
  font-size: 1.5rem;
  color: #94a3b8;
}

.dashboard-chart {
  height: 100%;
}

/* Lists */
.dash-empty {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #6e6e73;
}

.dash-empty--box {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.95rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px dashed rgba(15, 23, 42, 0.12);
}

.dash-empty--box .pi {
  font-size: 1.05rem;
  color: #94a3b8;
}

.dash-list,
.inc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.dash-row__main,
.res-row__main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.dash-row__title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: #0f172a;
}

.dash-row__meta {
  font-size: 0.78rem;
  color: #6e6e73;
  line-height: 1.4;
}

.dash-row__guests {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.15rem;
  font-size: 0.74rem;
  font-weight: 500;
  line-height: 1.35;
  color: #1e3a8a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dash-row__guests--none { color: #94a3b8; }

/* Reservation rows: time column + details */
.res-row {
  display: flex;
  align-items: stretch;
  gap: 0.85rem;
  padding: 0.7rem 0.8rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.05);
}

.res-row__time {
  flex-shrink: 0;
  min-width: 3.6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.35rem 0.45rem;
  border-radius: 10px;
  background: #e8eefc;
  color: #1e3a8a;
}

.res-row__time strong {
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.res-row__time small {
  font-size: 0.68rem;
  font-weight: 500;
  opacity: 0.75;
}

/* Incident rows: colored status dot + left accent */
.inc-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.6rem;
}

.inc-row {
  --inc-accent: #dc2626;
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.8rem 0.85rem 0.8rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.inc-row::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--inc-accent);
}

.inc-row--open { --inc-accent: #dc2626; }
.inc-row--in-progress { --inc-accent: #ea580c; }
.inc-row--resolved { --inc-accent: #16a34a; }

.inc-row__dot {
  flex-shrink: 0;
  width: 0.55rem;
  height: 0.55rem;
  margin-top: 0.38rem;
  border-radius: 50%;
  background: var(--inc-accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--inc-accent) 15%, transparent);
}

.guest-badge,
.inc-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0.14rem 0.55rem;
  border-radius: 999px;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
}

.inc-badge--open { background: #fdecee; color: #b42318; }
.inc-badge--in-progress { background: #fff1e6; color: #c2410c; }
.inc-badge--resolved { background: #e7f6ec; color: #15803d; }

/* ---------- Responsive ---------- */
@media (max-width: 1180px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dash-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 0.9rem 2rem;
  }
  .dash-hero {
    padding: 1.2rem 1.1rem;
    align-items: flex-start;
  }
  .dash-hero__title {
    font-size: 1.35rem;
  }
  .dash-actions {
    width: 100%;
  }
  .dash-action {
    flex: 1 1 auto;
    justify-content: center;
  }
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
  }
  .kpi-card:last-child {
    grid-column: 1 / -1;
  }
  .kpi-value {
    font-size: 1.5rem;
  }
  .chart-totals {
    gap: 0.9rem;
  }
  .dashboard-chart-wrap {
    height: 240px;
  }
  .inc-list {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .kpi-card,
  .dash-action,
  .kpi-meter__fill {
    transition: none;
  }
}
</style>
