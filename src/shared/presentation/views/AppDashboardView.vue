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
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { supportApi } from '@/residentCare/infrastructure/supportApi.js'
import KpiSparkline from '@/shared/presentation/components/dashboard/KpiSparkline.vue'
import DashboardHeroArt from '@/shared/presentation/components/dashboard/DashboardHeroArt.vue'

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
  overdueResidents: 0,
})
const billingAlerts = ref([])

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
    overdueResidents: Number(d.overdueResidents) || 0,
  }
  billingAlerts.value = Array.isArray(kpiData.billingAlerts) ? kpiData.billingAlerts : []
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
const allIncidents = ref([])
const residents = ref([])
const pendingChats = ref(0)
/** Deuda vencida por mes de emisión (semáforo RF029), para la tendencia de morosidad. */
const overdueByMonth = ref([])
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
    // Datos complementarios (tendencias y "Para hoy"): si fallan, el panel sigue funcionando.
    loadInsights()

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
      allIncidents.value = incidentsData
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

async function loadInsights() {
  const [residentsResult, summaryResult, calendarResult] = await Promise.allSettled([
    residentsApi.list(),
    supportApi.getSummary(),
    financesApi.getPaymentCalendar({ months: SERIES_MONTHS }),
  ])
  residents.value = residentsResult.status === 'fulfilled' && Array.isArray(residentsResult.value) ? residentsResult.value : []
  pendingChats.value = summaryResult.status === 'fulfilled' ? summaryResult.value.pending : 0
  if (calendarResult.status === 'fulfilled') {
    const { months, residents: rows } = calendarResult.value
    overdueByMonth.value = months.map((month) =>
      rows.reduce((sum, row) => {
        const cell = (row.cells || []).find((c) => c.month === month)
        return cell?.status === 'overdue' ? sum + (Number(cell.amount) || 0) : sum
      }, 0),
    )
  } else {
    overdueByMonth.value = []
  }
}

// ---------- Tendencias de los KPI (últimos meses) ----------
const SERIES_MONTHS = 6

function lastMonthEnds(count) {
  const now = new Date()
  return Array.from({ length: count }, (_, i) => {
    const end = new Date(now.getFullYear(), now.getMonth() - (count - 1 - i) + 1, 0)
    return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
  })
}

/** Residentes y departamentos ocupados al cierre de cada mes, según la fecha de ingreso. */
const occupancySeries = computed(() => {
  const ends = lastMonthEnds(SERIES_MONTHS)
  return ends.map((endYmd) => {
    const present = residents.value.filter((r) => !r.admissionDate || r.admissionDate <= endYmd)
    const units = new Set(present.map((r) => String(r.code || r.id)))
    return { residents: present.length, units: units.size }
  })
})

const residentsSeries = computed(() =>
  residents.value.length ? occupancySeries.value.map((m) => m.residents) : [],
)
const occupiedSeries = computed(() =>
  residents.value.length ? occupancySeries.value.map((m) => m.units) : [],
)
const emptySeries = computed(() =>
  totalUnits.value > 0 && residents.value.length
    ? occupancySeries.value.map((m) => Math.max(0, totalUnits.value - m.units))
    : [],
)

function seriesDelta(series) {
  if (series.length < 2) return 0
  return series[series.length - 1] - series[series.length - 2]
}

function countDeltaLabel(series) {
  const delta = seriesDelta(series)
  if (!delta) return t('dashboard.deltaFlat')
  return t('dashboard.deltaThisMonth', { delta: `${delta > 0 ? '+' : '−'}${Math.abs(delta)}` })
}

/** Para unidades vacías y morosidad, subir es malo. */
function deltaTone(series, upIsGood = true) {
  const delta = seriesDelta(series)
  if (!delta) return 'flat'
  return (delta > 0) === upIsGood ? 'good' : 'bad'
}

// ---------- "Para hoy": pendientes accionables ----------
const unresolvedIncidents = computed(() => {
  const list = allIncidents.value.filter((row) => (row.status || 'open') !== 'resolved')
  return {
    total: list.length,
    open: list.filter((row) => (row.status || 'open') === 'open').length,
    inProgress: list.filter((row) => row.status === 'in-progress').length,
  }
})

const todayWithGuests = computed(() => todayReservations.value.filter((row) => guestCount(row) > 0))

const missingMonthlyCharge = computed(
  () =>
    !isLoading.value &&
    !kpiLoadFailed.value &&
    (billingAlerts.value.some((a) => String(a?.code ?? a?.type ?? a).includes('MISSING_MONTHLY_CHARGE')) ||
      delinquency.value.monthlyBudget <= 0),
)

const agendaItems = computed(() => {
  const items = []
  const inc = unresolvedIncidents.value
  if (inc.total > 0) {
    items.push({
      key: 'incidents',
      tone: 'red',
      icon: 'pi-flag',
      badge: inc.total,
      title: t('dashboard.agendaIncidentsTitle', { n: inc.total }, inc.total),
      short: t('dashboard.agendaIncidentsShort'),
      detail: t('dashboard.agendaIncidentsDetail', { open: inc.open, progress: inc.inProgress }),
      action: t('dashboard.agendaIncidentsAction'),
      to: { name: AppRouteNames.APP_INCIDENTS },
    })
  }
  if (pendingChats.value > 0) {
    items.push({
      key: 'chats',
      tone: 'blue',
      icon: 'pi-comments',
      badge: pendingChats.value,
      title: t('dashboard.agendaChatsTitle', { n: pendingChats.value }, pendingChats.value),
      short: t('dashboard.agendaChatsShort'),
      detail: t('dashboard.agendaChatsDetail'),
      action: t('dashboard.agendaChatsAction'),
      to: { name: AppRouteNames.APP_RESIDENT_HELP },
    })
  }
  if (missingMonthlyCharge.value) {
    items.push({
      key: 'budget',
      tone: 'amber',
      icon: 'pi-wallet',
      badge: '!',
      title: t('dashboard.agendaBudgetTitle'),
      short: t('dashboard.agendaBudgetShort'),
      detail: t('dashboard.agendaBudgetDetail'),
      action: t('dashboard.agendaBudgetAction'),
      to: { name: AppRouteNames.APP_FINANCE },
    })
  }
  if (delinquency.value.overdueResidents > 0) {
    const n = delinquency.value.overdueResidents
    items.push({
      key: 'overdue',
      tone: 'orange',
      icon: 'pi-exclamation-circle',
      badge: n,
      title: t('dashboard.agendaOverdueTitle', { n }, n),
      short: t('dashboard.agendaOverdueShort'),
      detail: t('dashboard.agendaOverdueDetail', { amount: nfPen.value(kpi.value.totalDebt) }),
      action: t('dashboard.agendaOverdueAction'),
      to: { name: AppRouteNames.APP_FINANCE },
    })
  }
  if (todayWithGuests.value.length > 0) {
    const first = todayWithGuests.value[0]
    const n = todayWithGuests.value.length
    items.push({
      key: 'guests',
      tone: 'green',
      icon: 'pi-calendar',
      badge: n,
      title: t('dashboard.agendaGuestsTitle', { n }, n),
      short: t('dashboard.agendaGuestsShort'),
      detail: t('dashboard.agendaGuestsDetail', { space: spaceName(first.spaceId), time: first.startTime || '—' }),
      action: t('dashboard.agendaGuestsAction'),
      to: { name: AppRouteNames.APP_GENERATION },
    })
  }
  return items
})

const heroStatus = computed(() => {
  const parts = []
  const inc = unresolvedIncidents.value.total
  if (inc > 0) parts.push(t('dashboard.heroStatusIncidents', { n: inc }, inc))
  const res = todayReservations.value.length
  if (res > 0) parts.push(t('dashboard.heroStatusReservations', { n: res }, res))
  return { text: parts.length ? parts.join(' · ') : t('dashboard.heroStatusClear'), alert: inc > 0 }
})

function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

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
        <p v-if="!isLoading" class="dash-hero__status" role="status">
          <span class="dash-hero__status-dot" :class="{ 'is-alert': heroStatus.alert }" aria-hidden="true"></span>
          {{ heroStatus.text }}
        </p>
      </div>
      <DashboardHeroArt class="dash-hero__art" />
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

    <section v-if="!isLoading" class="dash-card agenda" aria-labelledby="dashboard-agenda-heading">
      <div class="dash-card__head">
        <div>
          <h2 id="dashboard-agenda-heading" class="dash-card__title">{{ t('dashboard.agendaTitle') }}</h2>
          <p class="dash-card__hint">{{ t('dashboard.agendaHint') }}</p>
        </div>
      </div>
      <ul v-if="agendaItems.length" class="agenda__grid" role="list">
        <li
          v-for="item in agendaItems"
          :key="item.key"
          class="agenda-item"
          :class="`agenda-item--${item.tone}`"
          :title="`${item.title} · ${item.detail}`"
        >
          <span class="agenda-item__icon" aria-hidden="true">
            <i class="pi" :class="item.icon"></i>
            <b>{{ item.badge }}</b>
          </span>
          <div class="agenda-item__text">
            <strong aria-hidden="true">{{ item.short }}</strong>
            <span class="visually-hidden">{{ item.title }} · {{ item.detail }}</span>
          </div>
          <RouterLink :to="item.to" class="agenda-item__action">{{ item.action }}</RouterLink>
        </li>
      </ul>
      <div v-else class="agenda-clear">
        <span class="agenda-clear__icon" aria-hidden="true"><i class="pi pi-check"></i></span>
        <div>
          <strong>{{ t('dashboard.agendaAllClear') }}</strong>
          <span>{{ t('dashboard.agendaAllClearDetail') }}</span>
        </div>
      </div>
    </section>

    <section class="kpi-grid" :aria-label="t('dashboard.financialOverview')">
      <article class="kpi-card kpi-card--blue">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.totalResidents') }}</span>
          <span class="kpi-icon icon-blue"><i class="pi pi-users" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">{{ isLoading ? '…' : kpi.totalResidents }}</div>
        <span class="kpi-subtext">{{ t('dashboard.kpiRegistered') }}</span>
        <div v-if="residentsSeries.length" class="kpi-trendline">
          <span class="kpi-delta" :class="`kpi-delta--${deltaTone(residentsSeries)}`">{{ countDeltaLabel(residentsSeries) }}</span>
          <KpiSparkline :points="residentsSeries" color="#1e3a8a" />
        </div>
        <i class="pi pi-users kpi-watermark" aria-hidden="true"></i>
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
        <span class="kpi-subtext">
          {{ totalUnits ? t('dashboard.occupancy', { pct: occupancyPct }) : t('dashboard.kpiActiveDepts') }}
        </span>
        <div v-if="occupiedSeries.length" class="kpi-trendline">
          <span class="kpi-delta" :class="`kpi-delta--${deltaTone(occupiedSeries)}`">{{ countDeltaLabel(occupiedSeries) }}</span>
          <KpiSparkline :points="occupiedSeries" color="#15803d" />
        </div>
        <i class="pi pi-building kpi-watermark" aria-hidden="true"></i>
      </article>

      <article class="kpi-card kpi-card--orange">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('dashboard.emptyUnits') }}</span>
          <span class="kpi-icon icon-orange"><i class="pi pi-home" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">{{ isLoading ? '…' : kpi.emptyUnits }}</div>
        <span class="kpi-subtext">{{ t('dashboard.kpiAvailable') }}</span>
        <div v-if="emptySeries.length" class="kpi-trendline">
          <span class="kpi-delta" :class="`kpi-delta--${deltaTone(emptySeries, false)}`">{{ countDeltaLabel(emptySeries) }}</span>
          <KpiSparkline :points="emptySeries" color="#c2410c" />
        </div>
        <i class="pi pi-home kpi-watermark" aria-hidden="true"></i>
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
        <span class="kpi-subtext" :class="{ 'subtext-red': delinquency.isCritical }">
          {{ isLoading ? t('dashboard.kpiAccumulatedDebt') : trendLabel }}
        </span>
        <span v-if="!isLoading" class="kpi-subtext kpi-subtext--hint">
          {{ delinquencySubtext }}
          <template v-if="delinquencyState !== 'none'"> · {{ t('dashboard.thresholdUsage', { pct: thresholdUsagePct }) }}</template>
        </span>
        <div v-if="overdueByMonth.length > 1" class="kpi-trendline">
          <span class="kpi-delta kpi-delta--flat">{{ t('dashboard.last6Months') }}</span>
          <KpiSparkline :points="overdueByMonth" :color="delinquency.isCritical ? '#b42318' : '#b45309'" />
        </div>
        <i class="pi pi-exclamation-triangle kpi-watermark" aria-hidden="true"></i>
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
          <span class="inc-row__avatar" aria-hidden="true">{{ initials(row.residentName) }}</span>
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
  flex-direction: column;
  align-items: flex-start;
  gap: 1.1rem;
  min-height: 11.5rem;
  padding: 1.5rem 22rem 1.5rem 1.6rem;
  border-radius: 20px;
  color: #fff;
  background: #1e3a8a;
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

.dash-hero__status {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0.8rem 0 0;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 600;
}

.dash-hero__status-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #16a34a;
}

.dash-hero__status-dot.is-alert {
  background: #ea580c;
}

.dash-hero__art {
  position: absolute;
  right: 1.4rem;
  bottom: 0;
  width: 20rem;
  height: 11rem;
  pointer-events: none;
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
  min-height: 2.125rem;
  padding: 0.35rem 0.9rem;
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
  position: relative;
  overflow: hidden;
  background: var(--kpi-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1.05rem 1.1rem 1.1rem;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease;
}

.kpi-card:hover {
  transform: translateY(-1px);
}

.kpi-card > *:not(.kpi-watermark) {
  position: relative;
  z-index: 1;
}

/* Ícono grande y tenue como marca de agua. */
.kpi-watermark {
  position: absolute;
  right: -0.6rem;
  bottom: -1.3rem;
  font-size: 6.5rem;
  opacity: 0.07;
  pointer-events: none;
  z-index: 0;
}

.kpi-card--blue .kpi-watermark { color: #1e3a8a; }
.kpi-card--green .kpi-watermark { color: #15803d; }
.kpi-card--orange .kpi-watermark { color: #c2410c; }
.kpi-card--amber .kpi-watermark { color: #b45309; }
.kpi-card--red .kpi-watermark { color: #b42318; }

.kpi-trendline {
  margin-top: auto;
  padding-top: 0.75rem;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.6rem;
}

.kpi-trendline :deep(.kpi-sparkline) {
  width: min(7.5rem, 48%);
  height: auto;
}

.kpi-delta {
  padding: 0.16rem 0.55rem;
  border-radius: 999px;
  background: #fff;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
}

.kpi-delta--good { color: #15803d; }
.kpi-delta--bad { color: #b42318; }
.kpi-delta--flat { color: #64748b; }

/* Cada indicador es una tarjeta de color sólido (sin degradados ni franjas). */
.kpi-card--blue { --kpi-bg: #e8eefc; }
.kpi-card--green { --kpi-bg: #e3f4e8; }
.kpi-card--orange { --kpi-bg: #fdeee2; }
.kpi-card--amber { --kpi-bg: #fdf3dc; }
.kpi-card--red { --kpi-bg: #fde4e4; }

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

.icon-blue { background: #fff; color: #1e3a8a; }
.icon-green { background: #fff; color: #15803d; }
.icon-orange { background: #fff; color: #c2410c; }
.icon-amber { background: #fff; color: #b45309; }
.icon-red { background: #fff; color: #b42318; }

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
  background: #fff;
  color: #64748b;
}

/* Deuda que sube es mala (rojo); que baja es buena (verde). */
.kpi-trend--up { color: #b42318; }
.kpi-trend--down { color: #15803d; }

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

.kpi-state--critical { background: #fff; color: #b42318; }
.kpi-state--healthy { background: #fff; color: #15803d; }
.kpi-state--none { background: #fff; color: #64748b; }

.kpi-meter {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.kpi-meter__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  transition: width 0.4s ease;
}

.kpi-meter__fill--green { background: #16a34a; }
.kpi-meter__fill--amber { background: #d97706; }
.kpi-meter__fill--red { background: #dc2626; }

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
  color: #64748b;
}

.text-red { color: #b42318; }
.text-green { color: #15803d; }
/* card-danger: el fondo rojo sólido lo da .kpi-card--red */

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
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.85rem 0.9rem;
  border-radius: 14px;
  background: var(--inc-bg, #f1f5f9);
}

/* Cada incidencia es una tarjeta de color sólido según su estado. */
.inc-row--open { --inc-accent: #dc2626; --inc-bg: #fde4e4; }
.inc-row--in-progress { --inc-accent: #ea580c; --inc-bg: #fdeee2; }
.inc-row--resolved { --inc-accent: #16a34a; --inc-bg: #e3f4e8; }

.inc-row__dot {
  flex-shrink: 0;
  width: 0.55rem;
  height: 0.55rem;
  margin-top: 0.38rem;
  border-radius: 50%;
  background: var(--inc-accent);
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

.inc-badge--open { background: #fff; color: #b42318; }
.inc-badge--in-progress { background: #fff; color: #c2410c; }
.inc-badge--resolved { background: #fff; color: #15803d; }

/* ---------- Para hoy ---------- */
.agenda__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  /* Una sola fila de pills del mismo ancho, sin importar cuántos pendientes haya. */
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 0.6rem;
}

.agenda-item {
  --agenda-ink: #1e3a8a;
  --agenda-bg: #e8eefc;
  --agenda-badge: #1e3a8a;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.45rem 0.4rem 0.5rem;
  border-radius: 999px;
  background: var(--agenda-bg);
}

.agenda-item--red { --agenda-ink: #b42318; --agenda-bg: #fde4e4; --agenda-badge: #dc2626; }
.agenda-item--blue { --agenda-ink: #1e3a8a; --agenda-bg: #e8eefc; --agenda-badge: #1e3a8a; }
.agenda-item--amber { --agenda-ink: #b45309; --agenda-bg: #fdf3dc; --agenda-badge: #d97706; }
.agenda-item--orange { --agenda-ink: #c2410c; --agenda-bg: #fdeee2; --agenda-badge: #ea580c; }
.agenda-item--green { --agenda-ink: #15803d; --agenda-bg: #e3f4e8; --agenda-badge: #16a34a; }

.agenda-item__icon {
  position: relative;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #fff;
  color: var(--agenda-ink);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agenda-item__icon b {
  position: absolute;
  top: -0.3rem;
  right: -0.3rem;
  min-width: 1.1rem;
  height: 1.1rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--agenda-badge);
  color: #fff;
  font-size: 0.64rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agenda-item__text {
  min-width: 0;
  flex: 1;
}

.agenda-item__text strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  letter-spacing: -0.01em;
  color: #0f172a;
}

.agenda-item__action {
  flex-shrink: 0;
  padding: 0.32rem 0.75rem;
  border-radius: 999px;
  background: #fff;
  color: var(--agenda-ink);
  font-size: 0.76rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}

.agenda-item__action:hover {
  text-decoration: underline;
}

.agenda-item__action:focus-visible {
  outline: 2px solid var(--agenda-ink);
  outline-offset: 2px;
}

.agenda-clear {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 0.95rem;
  border-radius: 14px;
  background: #e3f4e8;
}

.agenda-clear__icon {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  background: #fff;
  color: #15803d;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agenda-clear strong {
  display: block;
  font-size: 0.88rem;
  color: #0f172a;
}

.agenda-clear span {
  display: block;
  font-size: 0.75rem;
  color: #6e6e73;
}

.inc-row__avatar {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: #fff;
  color: var(--inc-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
}

/* ---------- Responsive ---------- */
@media (max-width: 1180px) {
  .agenda__grid {
    grid-auto-flow: row;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dash-hero {
    padding-right: 1.6rem;
  }
  .dash-hero__art {
    display: none;
  }
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
  .agenda__grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
  }
  .kpi-card:nth-child(3),
  .kpi-card:last-child {
    grid-column: 1 / -1;
  }
  .kpi-trendline {
    flex-wrap: wrap;
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
