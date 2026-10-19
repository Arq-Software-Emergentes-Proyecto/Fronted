<script setup>
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import { useSession } from '@/iam/application/sessionStore.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { announcementsApi } from '@/communications/infrastructure/announcementsApi.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { buildingsApi } from '@/profiles/infrastructure/buildingsApi.js'
import {
  compareAnnouncementsForCarousel,
  isAnnouncementActive,
} from '@/communications/domain/model/announcementConstants.js'
import noAnnouncementsIllustration from '@/communications/presentation/assets/no-announcements.svg'
import { todayYmd } from '@/finances/domain/billingCycle.js'
import { useResidentPaymentStore } from '@/finances/application/residentPaymentStore.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import KpiSparkline from '@/shared/presentation/components/dashboard/KpiSparkline.vue'
import DashboardHeroArt from '@/shared/presentation/components/dashboard/DashboardHeroArt.vue'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()
const { state: paymentState, loadData: loadFinanceData } = useResidentPaymentStore()

const profile = computed(() => sessionState.profile ?? {})
const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

const reservations = ref([])
const spacesById = ref(new Map())
const isLoadingReservations = ref(false)

const announcements = ref([])
const isLoadingAnnouncements = ref(false)

const incidents = ref([])
const isLoadingIncidents = ref(false)

/** Nombre del edificio (encabezado); opcional: si falla, el panel sigue funcionando. */
const buildingName = ref('')

/** RNF012: the dashboard data (or the finance summary) could not be loaded. */
const dashboardLoadFailed = ref(false)
const isRetrying = ref(false)
const showLoadError = computed(
  () => !isLoadingReservations.value && (dashboardLoadFailed.value || Boolean(paymentState.error)),
)

const currentIndex = ref(0)
const showAllAnnouncements = ref(false)
const showAllIncidents = ref(false)
const showAllReservations = ref(false)

// Local calendar day (Lima), not UTC: after 19:00 UTC-5 the ISO date is already tomorrow.
const todayIso = todayYmd()

// ---------- Encabezado ----------
const firstName = computed(() => String(profile.value.name ?? '').trim().split(/\s+/)[0] || '')
const todayLong = computed(() =>
  new Intl.DateTimeFormat(intlLocale.value, { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(),
  ),
)
const unitLabel = computed(() => {
  const floor = String(profile.value.floor ?? '').trim()
  const code = String(profile.value.code ?? '').trim()
  if (floor && code) return t('resident.heroUnit', { floor, code })
  if (code) return t('resident.heroUnitCode', { code })
  return ''
})

// ---------- Reservas ----------
const allUpcomingReservations = computed(() => {
  return reservations.value
    .filter((r) => r.status !== 'CANCELLED' && r.date >= todayIso)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date)
      return a.startTime.localeCompare(b.startTime)
    })
})

/** US018: full booking history (past, upcoming and cancelled), newest first. */
const reservationHistory = computed(() =>
  reservations.value.slice().sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return String(b.startTime).localeCompare(String(a.startTime))
  }),
)

function reservationHistoryStatus(r) {
  if (r.status === 'CANCELLED') return { key: 'cancelled', label: t('socialSpaces.statusCancelled') }
  const now = new Date()
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (r.date < localToday || (r.date === localToday && String(r.endTime) <= nowTime)) {
    return { key: 'finished', label: t('socialSpaces.statusFinished') }
  }
  if (r.date === localToday) return { key: 'today', label: t('socialSpaces.statusToday') }
  return { key: 'confirmed', label: t('socialSpaces.statusConfirmed') }
}

const todayReservations = computed(() => {
  return allUpcomingReservations.value.filter((r) => r.date === todayIso)
})

const otherUpcomingReservations = computed(() => {
  return allUpcomingReservations.value.filter((r) => r.date > todayIso)
})

/** Reservas de hoy y de los próximos días que se muestran en la tarjeta (máx. 3, hoy primero). */
const reservationRows = computed(() => [
  ...todayReservations.value.slice(0, 3).map((r) => ({ ...r, isToday: true })),
  ...otherUpcomingReservations.value
    .slice(0, Math.max(0, 3 - todayReservations.value.length))
    .map((r) => ({ ...r, isToday: false })),
])

/** Reservas de hoy que aún no terminaron ("Para hoy"). */
const activeTodayReservations = computed(() =>
  todayReservations.value.filter((r) => reservationHistoryStatus(r).key === 'today'),
)

/** Próxima reserva vigente (excluye las de hoy que ya terminaron). */
const nextReservation = computed(
  () => allUpcomingReservations.value.find((r) => reservationHistoryStatus(r).key !== 'finished') ?? null,
)

// RF019/RF020: el servidor ya devuelve solo vigentes ordenados por prioridad; se re-aplica en cliente
// por si un comunicado vence con el dashboard abierto (nunca se muestra uno vencido como vigente).
const activeAnnouncements = computed(() =>
  announcements.value
    .filter((a) => isAnnouncementActive(a))
    .slice()
    .sort(compareAnnouncementsForCarousel),
)

watch(
  () => activeAnnouncements.value.length,
  (len) => {
    if (currentIndex.value >= len) currentIndex.value = 0
  },
)

const currentAnnouncement = computed(() => activeAnnouncements.value[currentIndex.value] ?? null)
const urgentAnnouncements = computed(() => activeAnnouncements.value.filter((a) => a.priority === 'urgent'))

const incidentsSummary = computed(() => {
  const summary = { open: 0, inProgress: 0, resolved: 0 }
  incidents.value.forEach((i) => {
    if (i.status === 'open') summary.open++
    else if (i.status === 'in-progress') summary.inProgress++
    else if (i.status === 'resolved') summary.resolved++
  })
  return summary
})

// RF017 / US017: la dona resume SOLO el mes actual (cuotas del mes o que vencen este mes),
// más la deuda vencida que sigue impaga (arrastre). Sin movimientos → anillo gris neutro.
const currentMonthKey = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})()

function isFeeOverdue(fee) {
  if (fee.status !== 'Pendiente') return false
  const due = new Date(fee.dueDate + 'T00:00:00')
  const now = new Date(todayIso + 'T00:00:00')
  return due < now
}

function isMonthMovement(fee, monthKey) {
  return String(fee.billingMonth || '') === monthKey || String(fee.dueDate || '').startsWith(monthKey)
}

function isCurrentMonthMovement(fee) {
  return isMonthMovement(fee, currentMonthKey)
}

/** Cuotas que cuentan en el resumen del mes: las del mes actual + las vencidas impagas. */
const summaryFees = computed(() =>
  (paymentState.fees || []).filter((f) => isCurrentMonthMovement(f) || isFeeOverdue(f)),
)

const financeSummary = computed(() => {
  const fees = summaryFees.value
  const amount = (f) => Number(f.amount) || 0
  const paid = fees.filter((f) => f.status === 'Pagado').reduce((sum, f) => sum + amount(f), 0)
  const pending = fees.filter((f) => f.status === 'Pendiente').reduce((sum, f) => sum + amount(f), 0)
  const overdue = fees.filter(isFeeOverdue).reduce((sum, f) => sum + amount(f), 0)

  return { paid, pending, overdue, total: paid + pending }
})

const paidPct = computed(() =>
  financeSummary.value.total > 0 ? Math.round((financeSummary.value.paid / financeSummary.value.total) * 100) : 0,
)

/** Cuota pendiente con el vencimiento más próximo (o la vencida más antigua). */
const nextDueFee = computed(
  () =>
    summaryFees.value
      .filter((f) => f.status === 'Pendiente' && f.dueDate)
      .slice()
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] ?? null,
)

const financeMonthLabel = computed(() => {
  const [y, m] = currentMonthKey.split('-').map(Number)
  const label = new Date(y, m - 1, 1).toLocaleDateString(intlLocale.value, {
    month: 'long',
    year: 'numeric',
  })
  return label.charAt(0).toUpperCase() + label.slice(1)
})

// ---------- Tendencias (últimos 6 meses) ----------
const SERIES_MONTHS = 6
const lastMonthKeys = (() => {
  const now = new Date()
  return Array.from({ length: SERIES_MONTHS }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (SERIES_MONTHS - 1 - i), 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
})()

/** Pagado por mes con el mismo criterio del resumen: el último punto = "Pagado este mes". */
const paidSeries = computed(() => {
  const fees = paymentState.fees || []
  const series = lastMonthKeys.map((key) =>
    fees
      .filter((f) => f.status === 'Pagado' && isMonthMovement(f, key))
      .reduce((sum, f) => sum + (Number(f.amount) || 0), 0),
  )
  return series.some((v) => v > 0) ? series : []
})

/** Incidencias reportadas por mes. */
const incidentsSeries = computed(() => {
  if (!incidents.value.length) return []
  return lastMonthKeys.map(
    (key) => incidents.value.filter((i) => String(i.createdAt ?? '').slice(0, 7) === key).length,
  )
})

// ---------- Estado del encabezado y "Para hoy" ----------
const financeReady = computed(
  () => !isLoadingReservations.value && !paymentState.isLoading && !paymentState.error && !dashboardLoadFailed.value,
)

const heroStatus = computed(() => {
  const { pending, overdue } = financeSummary.value
  if (overdue > 0) {
    return { tone: 'red', text: t('resident.statusOverdue', { amount: formatCurrency(overdue) }) }
  }
  if (pending > 0) {
    const due = nextDueFee.value?.dueDate
    return {
      tone: 'orange',
      text: due
        ? t('resident.statusDue', { amount: formatCurrency(pending), date: formatShortDay(due) })
        : t('resident.statusPending', { amount: formatCurrency(pending) }),
    }
  }
  return { tone: 'green', text: t('resident.statusClear') }
})

const unresolvedIncidents = computed(() => incidentsSummary.value.open + incidentsSummary.value.inProgress)

const agendaItems = computed(() => {
  const items = []
  const { pending, overdue } = financeSummary.value
  if (financeReady.value && pending > 0) {
    const due = nextDueFee.value?.dueDate
    items.push({
      key: 'payment',
      tone: overdue > 0 ? 'red' : 'orange',
      icon: 'pi-wallet',
      badge: summaryFees.value.filter((f) => f.status === 'Pendiente').length,
      short: overdue > 0 ? t('resident.agendaOverdueShort') : t('resident.agendaPaymentShort'),
      detail: due
        ? t('resident.agendaPaymentDetail', { amount: formatCurrency(pending), date: formatShortDay(due) })
        : formatCurrency(pending),
      action: t('resident.agendaPaymentAction'),
      to: { name: AppRouteNames.APP_RESIDENT_FINANCE },
    })
  }
  if (activeTodayReservations.value.length > 0) {
    const first = activeTodayReservations.value[0]
    const n = activeTodayReservations.value.length
    items.push({
      key: 'reservation',
      tone: 'blue',
      icon: 'pi-calendar',
      badge: n,
      short: t('resident.agendaReservationShort', { time: first.startTime }),
      detail: `${t('resident.agendaReservationTitle', n)} · ${spaceNameFor(first)} · ${first.startTime} – ${first.endTime}`,
      action: t('resident.agendaReservationAction'),
      to: { name: AppRouteNames.APP_RESIDENT_GENERATION },
    })
  }
  if (unresolvedIncidents.value > 0) {
    const n = unresolvedIncidents.value
    items.push({
      key: 'incidents',
      tone: 'amber',
      icon: 'pi-flag',
      badge: n,
      short: t('resident.agendaIncidentsShort'),
      detail: `${t('resident.agendaIncidentsTitle', n)} · ${t('resident.agendaIncidentsDetail', {
        open: incidentsSummary.value.open,
        progress: incidentsSummary.value.inProgress,
      })}`,
      action: t('resident.agendaIncidentsAction'),
      to: { name: AppRouteNames.APP_RESIDENT_INCIDENTS },
    })
  }
  if (urgentAnnouncements.value.length > 0) {
    const n = urgentAnnouncements.value.length
    items.push({
      key: 'urgent',
      tone: 'red',
      icon: 'pi-megaphone',
      badge: n,
      short: t('resident.agendaUrgentShort'),
      detail: `${t('resident.agendaUrgentTitle', n)} · ${urgentAnnouncements.value[0].title}`,
      action: t('resident.agendaUrgentAction'),
      onClick: () => {
        currentIndex.value = Math.max(0, activeAnnouncements.value.indexOf(urgentAnnouncements.value[0]))
        showAllAnnouncements.value = true
      },
    })
  }
  return items
})

// ---------- Carrusel ----------
function prevAnn() {
  if (currentIndex.value > 0) currentIndex.value--
  else currentIndex.value = Math.max(0, activeAnnouncements.value.length - 1)
}

function nextAnn() {
  if (currentIndex.value < activeAnnouncements.value.length - 1) currentIndex.value++
  else currentIndex.value = 0
}

// ---------- Formato ----------
function spaceNameFor(reservation) {
  return spacesById.value.get(reservation.spaceId)?.name ?? t('app.spaceFallbackName')
}

function priorityLabel(priority) {
  const map = {
    normal: t('information.priorityNormal'),
    important: t('information.priorityImportant'),
    urgent: t('information.priorityUrgent'),
  }
  return map[priority] ?? map.normal
}

function priorityKey(priority) {
  return ['urgent', 'important'].includes(priority) ? priority : 'normal'
}

function formatCurrency(val) {
  return new Intl.NumberFormat(intlLocale.value, {
    style: 'currency',
    currency: 'PEN',
  }).format(Number(val) || 0)
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

function incidentIcon(status) {
  if (status === 'resolved') return 'pi-check'
  if (status === 'in-progress') return 'pi-wrench'
  return 'pi-flag'
}

function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

function isExpired(iso) {
  if (!iso) return false
  return new Date() > new Date(iso)
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return String(iso)
  return new Intl.DateTimeFormat(intlLocale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

function formatExpiry(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(intlLocale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** 'YYYY-MM-DD' → Date local (sin desfase UTC). */
function ymdToDate(ymd) {
  const m = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function formatShortDay(ymd) {
  const d = ymdToDate(ymd)
  if (!d) return String(ymd ?? '')
  return new Intl.DateTimeFormat(intlLocale.value, { day: 'numeric', month: 'short' }).format(d)
}

function formatResDate(ymd) {
  const d = ymdToDate(ymd)
  if (!d) return String(ymd ?? '')
  return new Intl.DateTimeFormat(intlLocale.value, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  }).format(d)
}

function dateParts(ymd) {
  const d = ymdToDate(ymd)
  if (!d) return { day: '—', month: '' }
  return {
    day: d.getDate(),
    month: new Intl.DateTimeFormat(intlLocale.value, { month: 'short' }).format(d).replace('.', ''),
  }
}

function nextReservationWhen(r) {
  const when = r.date === todayIso ? t('socialSpaces.statusToday') : formatResDate(r.date)
  return `${when} · ${r.startTime} – ${r.endTime}`
}

function durationLabel(days) {
  if (!days) return ''
  if (days === 7) return t('information.duration7')
  if (days === 15) return t('information.duration15')
  if (days === 30) return t('information.duration30')
  return `${days} ${t('information.durationDays')}`
}

// ---------- Dona RF017 ----------
const DONUT_SIZE = 168
const DONUT_COLORS = { paid: '#16a34a', pending: '#f59e0b', overdue: '#dc2626', empty: '#e5e7eb' }
const chartCanvas = ref(null)

function drawChart() {
  const canvas = chartCanvas.value
  const ctx = canvas?.getContext('2d')
  if (!ctx) return

  // Nítido en pantallas de alta densidad.
  const dpr = window.devicePixelRatio || 1
  const px = Math.round(DONUT_SIZE * dpr)
  if (canvas.width !== px) {
    canvas.width = px
    canvas.height = px
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const { paid, pending, overdue } = financeSummary.value
  const total = paid + pending
  const center = DONUT_SIZE / 2
  const thickness = 18
  const radius = DONUT_SIZE / 2 - thickness / 2 - 4

  ctx.clearRect(0, 0, DONUT_SIZE, DONUT_SIZE)
  ctx.lineWidth = thickness
  ctx.lineCap = 'butt'

  if (total === 0) {
    // US017 "Residente sin historial": anillo gris neutro.
    ctx.beginPath()
    ctx.arc(center, center, radius, 0, 2 * Math.PI)
    ctx.strokeStyle = DONUT_COLORS.empty
    ctx.stroke()
    return
  }

  const data = [
    { val: paid, color: DONUT_COLORS.paid },
    { val: pending - overdue, color: DONUT_COLORS.pending },
    { val: overdue, color: DONUT_COLORS.overdue },
  ].filter((item) => item.val > 0)

  const gap = data.length > 1 ? 0.04 : 0
  let startAngle = -Math.PI / 2
  data.forEach((item) => {
    const sliceAngle = (item.val / total) * 2 * Math.PI
    ctx.beginPath()
    ctx.arc(center, center, radius, startAngle + gap / 2, startAngle + sliceAngle - gap / 2)
    ctx.strokeStyle = item.color
    ctx.stroke()
    startAngle += sliceAngle
  })
}

watch(
  () => financeSummary.value,
  () => {
    nextTick(() => {
      drawChart()
    })
  },
  { deep: true },
)

// ---------- Carga ----------
async function loadBuildingName() {
  try {
    const buildings = await buildingsApi.mine()
    buildingName.value = String(buildings?.[0]?.name ?? '').trim()
  } catch {
    buildingName.value = ''
  }
}

async function loadInitialData() {
  if (!profile.value.id) return

  isLoadingReservations.value = true
  isLoadingAnnouncements.value = true
  isLoadingIncidents.value = true
  dashboardLoadFailed.value = false
  loadBuildingName()

  try {
    const [resList, spaces, annList, allIncidents] = await Promise.all([
      // RF018: historial completo de reservas (incluye pasadas y canceladas).
      reservationsApi.listByResident(profile.value.id, { includeCancelled: true }),
      spacesApi.list(),
      announcementsApi.listActive(),
      // RF018: historial del residente filtrado en el servidor.
      incidentsApi.listByResident(profile.value.id),
    ])

    reservations.value = resList
    spacesById.value = new Map(spaces.map((s) => [s.id, s]))
    announcements.value = annList
    incidents.value = allIncidents

    await loadFinanceData(profile.value.id)
  } catch (err) {
    console.error('Error loading dashboard data', err)
    dashboardLoadFailed.value = true
  } finally {
    isLoadingReservations.value = false
    isLoadingAnnouncements.value = false
    isLoadingIncidents.value = false
  }
}

watch(
  () => profile.value.id,
  (newId, oldId) => {
    if (newId && newId !== oldId) {
      loadInitialData()
    }
  },
)

async function retryLoad() {
  isRetrying.value = true
  try {
    await loadInitialData()
  } finally {
    isRetrying.value = false
  }
}

onMounted(() => {
  loadInitialData()
  // El anillo gris se dibuja aunque no haya datos (el watch solo corre si cambian).
  nextTick(() => drawChart())
})
</script>

<template>
  <div class="app-view app-view--ai dash">
    <header class="dash-hero">
      <div class="dash-hero__text">
        <p class="dash-hero__date">
          {{ todayLong }}<template v-if="buildingName"> · {{ buildingName }}</template>
        </p>
        <h1 class="dash-hero__title">
          {{ firstName ? t('resident.greeting', { name: firstName }) : t('resident.dashboardTitle') }}
        </h1>
        <p class="dash-hero__sub">
          <template v-if="unitLabel">
            <i class="pi pi-home" aria-hidden="true"></i>
            {{ unitLabel }} ·
          </template>
          {{ t('resident.heroSub') }}
        </p>
        <p v-if="financeReady" class="dash-hero__status" role="status">
          <span class="dash-hero__status-dot" :class="`is-${heroStatus.tone}`" aria-hidden="true"></span>
          {{ heroStatus.text }}
        </p>
      </div>
      <DashboardHeroArt class="dash-hero__art" />
      <nav class="dash-actions" :aria-label="t('resident.quickActions')">
        <RouterLink
          :to="{ name: AppRouteNames.APP_RESIDENT_FINANCE }"
          class="dash-action dash-action--primary"
        >
          <i class="pi pi-wallet" aria-hidden="true"></i>
          <span>{{ t('resident.quickPay') }}</span>
        </RouterLink>
        <RouterLink :to="{ name: AppRouteNames.APP_RESIDENT_SERVICES }" class="dash-action">
          <i class="pi pi-calendar-plus" aria-hidden="true"></i>
          <span>{{ t('resident.quickReserve') }}</span>
        </RouterLink>
        <RouterLink :to="{ name: AppRouteNames.APP_RESIDENT_INCIDENTS }" class="dash-action">
          <i class="pi pi-flag" aria-hidden="true"></i>
          <span>{{ t('resident.quickIncident') }}</span>
        </RouterLink>
        <RouterLink :to="{ name: AppRouteNames.APP_RESIDENT_SUPPORT }" class="dash-action">
          <i class="pi pi-sparkles" aria-hidden="true"></i>
          <span>{{ t('resident.quickAssistant') }}</span>
        </RouterLink>
      </nav>
    </header>

    <LoadErrorRetry v-if="showLoadError" :loading="isRetrying" @retry="retryLoad" />

    <section
      v-if="!isLoadingReservations && agendaItems.length"
      class="dash-card agenda"
      aria-labelledby="resident-agenda-heading"
    >
      <div class="dash-card__head">
        <div>
          <h2 id="resident-agenda-heading" class="dash-card__title">{{ t('resident.agendaTitle') }}</h2>
          <p class="dash-card__hint">{{ t('resident.agendaHint') }}</p>
        </div>
      </div>
      <ul class="agenda__grid" role="list">
        <li
          v-for="item in agendaItems"
          :key="item.key"
          class="agenda-item"
          :class="`agenda-item--${item.tone}`"
          :title="`${item.short} · ${item.detail}`"
        >
          <span class="agenda-item__icon" aria-hidden="true">
            <i class="pi" :class="item.icon"></i>
            <b>{{ item.badge }}</b>
          </span>
          <div class="agenda-item__text">
            <strong aria-hidden="true">{{ item.short }}</strong>
            <span class="visually-hidden">{{ item.short }} · {{ item.detail }}</span>
          </div>
          <RouterLink v-if="item.to" :to="item.to" class="agenda-item__action">{{ item.action }}</RouterLink>
          <button v-else type="button" class="agenda-item__action" @click="item.onClick">
            {{ item.action }}
          </button>
        </li>
      </ul>
    </section>

    <section class="kpi-grid" :aria-label="t('resident.financeChartTitle')">
      <article
        class="kpi-card"
        :class="financeSummary.overdue > 0 ? 'kpi-card--red' : 'kpi-card--orange'"
        :aria-live="financeSummary.overdue > 0 ? 'polite' : 'off'"
      >
        <div class="kpi-header">
          <span class="kpi-label">{{ t('resident.kpiToPay') }}</span>
          <span class="kpi-icon" :class="financeSummary.overdue > 0 ? 'icon-red' : 'icon-orange'">
            <i class="pi pi-wallet" aria-hidden="true"></i>
          </span>
        </div>
        <div class="kpi-value-row">
          <div class="kpi-value" :class="{ 'text-red': financeSummary.overdue > 0 }">
            {{ isLoadingReservations ? '…' : formatCurrency(financeSummary.pending) }}
          </div>
          <span
            v-if="!isLoadingReservations"
            class="kpi-state"
            :class="
              financeSummary.overdue > 0
                ? 'kpi-state--critical'
                : financeSummary.pending > 0
                  ? 'kpi-state--pending'
                  : 'kpi-state--healthy'
            "
          >
            {{
              financeSummary.overdue > 0
                ? t('resident.financeChartOverdue')
                : financeSummary.pending > 0
                  ? t('resident.financeChartPending')
                  : t('resident.kpiStateUpToDate')
            }}
          </span>
        </div>
        <span class="kpi-subtext" :class="{ 'subtext-red': financeSummary.overdue > 0 }">
          <template v-if="financeSummary.overdue > 0">
            {{ t('resident.kpiOverdueAmount', { amount: formatCurrency(financeSummary.overdue) }) }}
          </template>
          <template v-else-if="nextDueFee">
            {{ t('resident.kpiDueOn', { date: formatShortDay(nextDueFee.dueDate) }) }}
          </template>
          <template v-else>{{ t('resident.kpiNothingDue') }}</template>
        </span>
        <div v-if="financeSummary.pending > 0" class="kpi-trendline">
          <RouterLink :to="{ name: AppRouteNames.APP_RESIDENT_FINANCE }" class="kpi-link">
            {{ t('resident.quickPay') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </RouterLink>
        </div>
        <i class="pi pi-wallet kpi-watermark" aria-hidden="true"></i>
      </article>

      <article class="kpi-card kpi-card--green">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('resident.kpiPaidMonth') }}</span>
          <span class="kpi-icon icon-green"><i class="pi pi-check-circle" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">
          {{ isLoadingReservations ? '…' : formatCurrency(financeSummary.paid) }}
        </div>
        <span class="kpi-subtext">
          {{
            financeSummary.total > 0
              ? t('resident.kpiPaidOf', { pct: paidPct, total: formatCurrency(financeSummary.total) })
              : t('financeOps.donutEmpty')
          }}
        </span>
        <div v-if="paidSeries.length" class="kpi-trendline">
          <span class="kpi-delta kpi-delta--flat">{{ t('dashboard.last6Months') }}</span>
          <KpiSparkline :points="paidSeries" color="#15803d" />
        </div>
        <i class="pi pi-check-circle kpi-watermark" aria-hidden="true"></i>
      </article>

      <article class="kpi-card kpi-card--blue">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('resident.kpiNextReservation') }}</span>
          <span class="kpi-icon icon-blue"><i class="pi pi-calendar" aria-hidden="true"></i></span>
        </div>
        <template v-if="isLoadingReservations">
          <div class="kpi-value">…</div>
        </template>
        <template v-else-if="nextReservation">
          <div class="kpi-value kpi-value--text">{{ spaceNameFor(nextReservation) }}</div>
          <span class="kpi-subtext">{{ nextReservationWhen(nextReservation) }}</span>
        </template>
        <template v-else>
          <div class="kpi-value kpi-value--muted">—</div>
          <span class="kpi-subtext">{{ t('resident.kpiNoReservation') }}</span>
        </template>
        <div v-if="!isLoadingReservations" class="kpi-trendline">
          <span class="kpi-delta kpi-delta--flat">
            {{ t('resident.kpiUpcomingCount', { n: allUpcomingReservations.length }, allUpcomingReservations.length) }}
          </span>
          <RouterLink
            v-if="!nextReservation"
            :to="{ name: AppRouteNames.APP_RESIDENT_SERVICES }"
            class="kpi-link"
          >
            {{ t('resident.quickReserve') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </RouterLink>
        </div>
        <i class="pi pi-calendar kpi-watermark" aria-hidden="true"></i>
      </article>

      <article class="kpi-card kpi-card--amber">
        <div class="kpi-header">
          <span class="kpi-label">{{ t('resident.kpiOpenIncidents') }}</span>
          <span class="kpi-icon icon-amber"><i class="pi pi-flag" aria-hidden="true"></i></span>
        </div>
        <div class="kpi-value">{{ isLoadingIncidents ? '…' : incidentsSummary.open }}</div>
        <span class="kpi-subtext">
          {{
            t('resident.kpiIncidentsBreakdown', {
              progress: incidentsSummary.inProgress,
              resolved: incidentsSummary.resolved,
            })
          }}
        </span>
        <div v-if="incidentsSeries.length" class="kpi-trendline">
          <span class="kpi-delta kpi-delta--flat">{{ t('resident.kpiReportedTrend') }}</span>
          <KpiSparkline :points="incidentsSeries" color="#b45309" />
        </div>
        <i class="pi pi-flag kpi-watermark" aria-hidden="true"></i>
      </article>
    </section>

    <div class="dash-grid">
      <section class="dash-card ann-card" aria-labelledby="resident-announcements-heading">
        <div class="dash-card__head">
          <div>
            <h2 id="resident-announcements-heading" class="dash-card__title">
              {{ t('resident.announcementsTitle') }}
            </h2>
            <p v-if="activeAnnouncements.length > 1" class="dash-card__hint">
              {{ t('resident.annCounter', { current: currentIndex + 1, total: activeAnnouncements.length }) }}
            </p>
          </div>
          <div class="ann-card__actions">
            <template v-if="activeAnnouncements.length > 1">
              <button type="button" class="nav-btn" :aria-label="t('resident.announcementsPrev')" @click="prevAnn">
                <i class="pi pi-chevron-left" aria-hidden="true"></i>
              </button>
              <button type="button" class="nav-btn" :aria-label="t('resident.announcementsNext')" @click="nextAnn">
                <i class="pi pi-chevron-right" aria-hidden="true"></i>
              </button>
            </template>
            <button
              v-if="activeAnnouncements.length > 0"
              type="button"
              class="dash-link"
              @click="showAllAnnouncements = true"
            >
              {{ t('information.seeAll') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <p v-if="isLoadingAnnouncements" class="dash-empty">…</p>
        <div v-else-if="activeAnnouncements.length === 0" class="ann-empty">
          <img
            :src="noAnnouncementsIllustration"
            :alt="t('announcementFeed.emptyCarouselAlt')"
            class="ann-empty__img"
            width="160"
            height="120"
          />
          <p class="dash-empty ann-empty__text">{{ t('announcementFeed.emptyCarousel') }}</p>
        </div>
        <template v-else>
          <Transition name="fade" mode="out-in">
            <article
              :key="currentIndex"
              class="ann-slide"
              :class="`ann-slide--${priorityKey(currentAnnouncement.priority)}`"
              aria-live="polite"
            >
              <div class="ann-slide__top">
                <span class="ann-badge" :class="`ann-badge--${priorityKey(currentAnnouncement.priority)}`">
                  <i
                    v-if="currentAnnouncement.priority === 'urgent'"
                    class="pi pi-exclamation-triangle"
                    aria-hidden="true"
                  ></i>
                  {{ priorityLabel(currentAnnouncement.priority) }}
                </span>
                <span v-if="currentAnnouncement.expiresAt" class="ann-slide__expiry">
                  {{ t('information.expiresOn', { date: formatExpiry(currentAnnouncement.expiresAt) }) }}
                </span>
              </div>
              <h3 class="ann-slide__title">{{ currentAnnouncement.title }}</h3>
              <p class="ann-slide__body">{{ currentAnnouncement.body }}</p>
              <div class="ann-slide__footer">
                <span class="ann-avatar" aria-hidden="true">{{ initials(currentAnnouncement.authorName) }}</span>
                <span class="ann-slide__author">
                  <strong>{{ currentAnnouncement.authorName }}</strong>
                  <time v-if="currentAnnouncement.createdAt">{{ formatDate(currentAnnouncement.createdAt) }}</time>
                </span>
              </div>
            </article>
          </Transition>
          <div v-if="activeAnnouncements.length > 1" class="carousel-dots">
            <button
              v-for="(ann, i) in activeAnnouncements"
              :key="ann.id ?? i"
              type="button"
              class="carousel-dot"
              :class="{ active: i === currentIndex }"
              :aria-label="t('resident.annGoTo', { n: i + 1 })"
              :aria-current="i === currentIndex ? 'true' : undefined"
              @click="currentIndex = i"
            />
          </div>
        </template>
      </section>

      <section class="dash-card" aria-labelledby="resident-chart-heading">
        <div class="dash-card__head">
          <div>
            <h2 id="resident-chart-heading" class="dash-card__title">
              {{ t('resident.financeChartTitle') }}
            </h2>
            <p class="dash-card__hint">{{ t('financeOps.donutMonthHint', { month: financeMonthLabel }) }}</p>
          </div>
          <RouterLink :to="{ name: AppRouteNames.APP_RESIDENT_FINANCE }" class="dash-link">
            {{ t('resident.seeFinance') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </RouterLink>
        </div>
        <div class="chart-flex">
          <div class="canvas-wrapper">
            <canvas
              ref="chartCanvas"
              :width="DONUT_SIZE"
              :height="DONUT_SIZE"
              :style="{ width: `${DONUT_SIZE}px`, height: `${DONUT_SIZE}px` }"
              role="img"
              :aria-label="
                financeSummary.total > 0
                  ? `${t('resident.financeChartTitle')}: ${paidPct}% ${t('resident.financeChartPaid')}`
                  : t('financeOps.donutEmpty')
              "
            ></canvas>
            <div class="chart-center-text">
              <span v-if="financeSummary.total > 0" class="center-percent">{{ paidPct }}%</span>
              <span v-else class="center-percent center-percent--empty">—</span>
              <span class="center-label">{{ t('resident.financeChartPaid') }}</span>
            </div>
          </div>
          <div v-if="financeSummary.total === 0" class="chart-empty-msg">
            <i class="pi pi-chart-pie" aria-hidden="true"></i>
            <span>{{ t('financeOps.donutEmpty') }}</span>
          </div>
          <ul v-else class="chart-legend" role="list">
            <li class="legend-item">
              <span class="dot dot--paid" aria-hidden="true"></span>
              <span class="label">{{ t('resident.financeChartPaid') }}</span>
              <span class="val">{{ formatCurrency(financeSummary.paid) }}</span>
            </li>
            <li class="legend-item">
              <span class="dot dot--pending" aria-hidden="true"></span>
              <span class="label">{{ t('resident.financeChartPending') }}</span>
              <span class="val">{{ formatCurrency(financeSummary.pending - financeSummary.overdue) }}</span>
            </li>
            <li class="legend-item">
              <span class="dot dot--overdue" aria-hidden="true"></span>
              <span class="label">{{ t('resident.financeChartOverdue') }}</span>
              <span class="val" :class="{ 'text-red': financeSummary.overdue > 0 }">
                {{ formatCurrency(financeSummary.overdue) }}
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <div class="dash-grid dash-grid--even">
      <section class="dash-card" aria-labelledby="resident-reservations-heading">
        <div class="dash-card__head">
          <div class="dash-card__title-row">
            <h2 id="resident-reservations-heading" class="dash-card__title">
              {{ t('resident.reservationsReminderTitle') }}
            </h2>
            <span v-if="!isLoadingReservations && allUpcomingReservations.length" class="dash-chip">
              {{ allUpcomingReservations.length }}
            </span>
          </div>
          <button
            v-if="reservations.length > 0"
            type="button"
            class="dash-link"
            @click="showAllReservations = true"
          >
            {{ t('resident.seeAll') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </button>
        </div>

        <p v-if="isLoadingReservations" class="dash-empty">…</p>
        <div v-else-if="allUpcomingReservations.length === 0" class="dash-empty dash-empty--box">
          <i class="pi pi-calendar" aria-hidden="true"></i>
          <span>{{ t('resident.reservationsReminderEmpty') }}</span>
        </div>
        <ul v-else class="dash-list" role="list">
          <li
            v-for="res in reservationRows"
            :key="(res.isToday ? 'today-' : 'other-') + res.id"
            class="res-row"
            :class="{ 'res-row--today': res.isToday }"
          >
            <span class="res-row__date" aria-hidden="true">
              <strong>{{ dateParts(res.date).day }}</strong>
              <small>{{ dateParts(res.date).month }}</small>
            </span>
            <div class="dash-row__main">
              <span class="dash-row__title">{{ spaceNameFor(res) }}</span>
              <span class="dash-row__meta">
                {{ formatResDate(res.date) }} · {{ res.startTime }} – {{ res.endTime }}
              </span>
            </div>
            <span
              v-if="res.isToday"
              class="guest-badge"
              :class="`resv-status--${reservationHistoryStatus(res).key}`"
            >
              {{ reservationHistoryStatus(res).label }}
            </span>
          </li>
        </ul>
      </section>

      <section class="dash-card" aria-labelledby="resident-incidents-heading">
        <div class="dash-card__head">
          <div class="dash-card__title-row">
            <h2 id="resident-incidents-heading" class="dash-card__title">
              {{ t('resident.incidentsSummaryTitle') }}
            </h2>
          </div>
          <button
            v-if="incidents.length > 0"
            type="button"
            class="dash-link"
            @click="showAllIncidents = true"
          >
            {{ t('resident.seeAll') }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </button>
        </div>

        <ul v-if="!isLoadingIncidents && incidents.length" class="inc-stats" role="list">
          <li class="inc-stat inc-stat--open">
            <strong>{{ incidentsSummary.open }}</strong> {{ t('resident.incidentsOpen') }}
          </li>
          <li class="inc-stat inc-stat--in-progress">
            <strong>{{ incidentsSummary.inProgress }}</strong> {{ t('resident.incidentsInProgress') }}
          </li>
          <li class="inc-stat inc-stat--resolved">
            <strong>{{ incidentsSummary.resolved }}</strong> {{ t('resident.incidentsResolved') }}
          </li>
        </ul>

        <p v-if="isLoadingIncidents" class="dash-empty">…</p>
        <div v-else-if="incidents.length === 0" class="dash-empty dash-empty--box">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <span>{{ t('resident.incidentsEmpty') }}</span>
        </div>
        <ul v-else class="dash-list" role="list">
          <li
            v-for="inc in incidents.slice(0, 5)"
            :key="inc.id"
            class="inc-row"
            :class="`inc-row--${inc.status || 'open'}`"
          >
            <span class="inc-row__icon" aria-hidden="true">
              <i class="pi" :class="incidentIcon(inc.status)"></i>
            </span>
            <div class="dash-row__main">
              <span class="dash-row__title">{{ inc.title || inc.description }}</span>
              <span class="dash-row__meta">{{ formatDate(inc.createdAt) }}</span>
            </div>
            <span class="inc-badge" :class="`inc-badge--${inc.status || 'open'}`">
              {{ incidentStatusLabel(inc.status) }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <Dialog
      v-model:visible="showAllAnnouncements"
      modal
      dismissable-mask
      :header="t('information.allAnnouncementsTitle')"
      class="rd-dialog"
      :style="{ width: 'min(36rem, 94vw)' }"
      :draggable="false"
    >
      <div class="dialog-list">
        <article
          v-for="ann in activeAnnouncements"
          :key="ann.id"
          class="ann-all-item"
          :class="[
            `ann-all-item--${priorityKey(ann.priority)}`,
            { 'ann-all-item--expired': isExpired(ann.expiresAt) },
          ]"
        >
          <div class="ann-all-item__top">
            <span class="ann-badge" :class="`ann-badge--${priorityKey(ann.priority)}`">
              {{ priorityLabel(ann.priority) }}
            </span>
            <div class="ann-all-item__meta">
              <span v-if="ann.duration" class="ann-tag">
                {{ durationLabel(ann.duration) }}
              </span>
              <span v-if="isExpired(ann.expiresAt)" class="ann-tag ann-tag--expired">
                {{ t('information.expired') }}
              </span>
            </div>
          </div>
          <h3 class="ann-all-item__title">{{ ann.title }}</h3>
          <p class="ann-all-item__body">{{ ann.body }}</p>
          <div class="ann-all-item__footer">
            <span class="ann-all-item__author">
              <span class="ann-avatar ann-avatar--sm" aria-hidden="true">{{ initials(ann.authorName) }}</span>
              {{ ann.authorName }}
            </span>
            <div class="ann-dates">
              <time class="ann-created">{{ formatDate(ann.createdAt) }}</time>
              <span v-if="ann.expiresAt" class="ann-expiry">
                {{ t('information.expiresOn', { date: formatExpiry(ann.expiresAt) }) }}
              </span>
            </div>
          </div>
        </article>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="showAllIncidents"
      modal
      dismissable-mask
      :header="t('resident.incidentsTitle')"
      class="rd-dialog"
      :style="{ width: 'min(36rem, 94vw)' }"
      :draggable="false"
    >
      <ul class="dash-list" role="list">
        <li
          v-for="inc in incidents"
          :key="inc.id"
          class="inc-row"
          :class="`inc-row--${inc.status || 'open'}`"
        >
          <span class="inc-row__icon" aria-hidden="true">
            <i class="pi" :class="incidentIcon(inc.status)"></i>
          </span>
          <div class="dash-row__main">
            <span class="dash-row__title">{{ inc.title || inc.description }}</span>
            <span v-if="inc.title" class="dash-row__meta">{{ inc.description }}</span>
            <span class="dash-row__meta">
              {{ formatDate(inc.createdAt) }}
              <template v-if="inc.provider">
                · {{ inc.provider }}<template v-if="inc.providerPhone"> ({{ inc.providerPhone }})</template>
              </template>
            </span>
            <span v-if="inc.resolutionComment" class="dash-row__meta">
              {{ t('incidentFlow.resolutionTitle') }}: {{ inc.resolutionComment }}
            </span>
          </div>
          <span class="inc-badge" :class="`inc-badge--${inc.status || 'open'}`">
            {{ incidentStatusLabel(inc.status) }}
          </span>
        </li>
      </ul>
    </Dialog>

    <Dialog
      v-model:visible="showAllReservations"
      modal
      dismissable-mask
      :header="t('socialSpaces.historyTitle')"
      class="rd-dialog"
      :style="{ width: 'min(36rem, 94vw)' }"
      :draggable="false"
    >
      <p v-if="!reservationHistory.length" class="dash-empty">
        {{ t('socialSpaces.historyEmpty') }}
      </p>
      <ul v-else class="dash-list" role="list">
        <li
          v-for="res in reservationHistory"
          :key="res.id"
          class="res-row"
          :class="{ 'res-row--cancelled': res.status === 'CANCELLED' }"
        >
          <span class="res-row__date" aria-hidden="true">
            <strong>{{ dateParts(res.date).day }}</strong>
            <small>{{ dateParts(res.date).month }}</small>
          </span>
          <div class="dash-row__main">
            <span class="dash-row__title">{{ spaceNameFor(res) }}</span>
            <span class="dash-row__meta">
              {{ formatResDate(res.date) }} · {{ res.startTime }} – {{ res.endTime }}
            </span>
          </div>
          <span class="guest-badge" :class="`resv-status--${reservationHistoryStatus(res).key}`">
            {{ reservationHistoryStatus(res).label }}
          </span>
        </li>
      </ul>
    </Dialog>
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

.dash-hero__text {
  min-width: 0;
  max-width: 100%;
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

.dash-hero__sub .pi {
  font-size: 0.78rem;
  margin-right: 0.15rem;
}

.dash-hero__status {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  max-width: 100%;
  margin: 0.8rem 0 0;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.35;
}

.dash-hero__status-dot {
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #16a34a;
}

.dash-hero__status-dot.is-orange {
  background: #ea580c;
}

.dash-hero__status-dot.is-red {
  background: #dc2626;
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
  position: relative;
  z-index: 1;
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

/* ---------- Cards ---------- */
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
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  color: #1e3a8a;
  background: #e8eefc;
  white-space: nowrap;
}

.dash-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: #1e3a8a;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}

.dash-link:hover {
  text-decoration: underline;
}

.dash-link .pi {
  font-size: 0.7rem;
}

.dash-link:focus-visible,
.nav-btn:focus-visible,
.carousel-dot:focus-visible,
.kpi-link:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 1rem;
}

.dash-grid--even {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* ---------- Para hoy ---------- */
.agenda__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  /* Pills del mismo ancho (máx. 4 pendientes): uno solo no se estira a todo el ancho. */
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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
  border: none;
  border-radius: 999px;
  background: #fff;
  color: var(--agenda-ink);
  font: inherit;
  font-size: 0.76rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.agenda-item__action:hover {
  text-decoration: underline;
}

.agenda-item__action:focus-visible {
  outline: 2px solid var(--agenda-ink);
  outline-offset: 2px;
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
  min-width: 0;
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

.kpi-card--blue { --kpi-bg: #e8eefc; }
.kpi-card--green { --kpi-bg: #e3f4e8; }
.kpi-card--orange { --kpi-bg: #fdeee2; }
.kpi-card--amber { --kpi-bg: #fdf3dc; }
.kpi-card--red { --kpi-bg: #fde4e4; }

.kpi-card--blue .kpi-watermark { color: #1e3a8a; }
.kpi-card--green .kpi-watermark { color: #15803d; }
.kpi-card--orange .kpi-watermark { color: #c2410c; }
.kpi-card--amber .kpi-watermark { color: #b45309; }
.kpi-card--red .kpi-watermark { color: #b42318; }

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
  background: #fff;
}

.icon-blue { color: #1e3a8a; }
.icon-green { color: #15803d; }
.icon-orange { color: #c2410c; }
.icon-amber { color: #b45309; }
.icon-red { color: #b42318; }

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

.kpi-value--text {
  font-size: 1.35rem;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kpi-value--muted {
  color: #94a3b8;
}

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

.kpi-state {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: #fff;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.kpi-state--critical { color: #b42318; }
.kpi-state--pending { color: #c2410c; }
.kpi-state--healthy { color: #15803d; }

.kpi-subtext {
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
}

.subtext-red { color: #b42318; }
.text-red { color: #b42318; }

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

.kpi-delta--flat { color: #64748b; }

.kpi-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  background: #fff;
  color: #0f172a;
  font-size: 0.74rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}

.kpi-link:hover {
  text-decoration: underline;
}

.kpi-link .pi {
  font-size: 0.65rem;
}

/* ---------- Comunicados ---------- */
.ann-card {
  display: flex;
  flex-direction: column;
  min-height: 15rem;
}

.ann-card__actions {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.ann-card__actions .dash-link {
  margin-left: 0.35rem;
}

.nav-btn {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 999px;
  background: #fff;
  color: #0f172a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.75rem;
}

.nav-btn:hover {
  background: #f1f5f9;
}

.ann-slide {
  --ann-bg: #e8eefc;
  --ann-ink: #1e3a8a;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 1rem 1.1rem;
  border-radius: 14px;
  background: var(--ann-bg);
  min-height: 0;
}

.ann-slide--urgent { --ann-bg: #fde4e4; --ann-ink: #b42318; }
.ann-slide--important { --ann-bg: #fdeee2; --ann-ink: #c2410c; }
.ann-slide--normal { --ann-bg: #e8eefc; --ann-ink: #1e3a8a; }

.ann-slide__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.65rem;
}

.ann-slide__expiry {
  font-size: 0.72rem;
  font-weight: 500;
  color: #475569;
}

.ann-slide__title {
  margin: 0 0 0.4rem;
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.ann-slide__body {
  margin: 0;
  font-size: 0.875rem;
  color: #334155;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ann-slide__footer {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin-top: auto;
  padding-top: 0.9rem;
}

.ann-slide__author {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 0.74rem;
  line-height: 1.3;
  color: #475569;
}

.ann-slide__author strong {
  font-weight: 650;
  color: #0f172a;
}

.ann-avatar {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #fff;
  color: var(--ann-ink, #1e3a8a);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
}

.ann-avatar--sm {
  width: 1.6rem;
  height: 1.6rem;
  font-size: 0.6rem;
}

.ann-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.14rem 0.55rem;
  border-radius: 999px;
  background: #fff;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
}

.ann-badge .pi {
  font-size: 0.62rem;
}

.ann-badge--normal { color: #1e3a8a; }
.ann-badge--important { color: #c2410c; }
.ann-badge--urgent { color: #b42318; }

.carousel-dots {
  display: flex;
  justify-content: center;
  gap: 0.2rem;
  padding-top: 0.6rem;
}

.carousel-dot {
  position: relative;
  width: 1.5rem;
  height: 1.25rem;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.carousel-dot::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #cbd5e1;
  transform: translate(-50%, -50%);
  transition: width 0.2s ease, background 0.2s ease;
}

.carousel-dot.active::before {
  width: 18px;
  background: #1e3a8a;
}

.ann-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 0 0.25rem;
  text-align: center;
}

.ann-empty__img {
  width: 10rem;
  max-width: 100%;
  height: auto;
}

.ann-empty__text {
  margin: 0;
  font-weight: 500;
}

/* ---------- Dona ---------- */
.chart-flex {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.canvas-wrapper {
  position: relative;
  width: 168px;
  height: 168px;
  flex-shrink: 0;
}

.canvas-wrapper canvas {
  display: block;
}

.chart-center-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.center-percent {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.center-percent--empty {
  color: #94a3b8;
}

.center-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
}

.chart-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 10rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  border-radius: 12px;
  background: #f8fafc;
}

.dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 3px;
  flex-shrink: 0;
}

.dot--paid { background: #16a34a; }
.dot--pending { background: #f59e0b; }
.dot--overdue { background: #dc2626; }

.legend-item .label {
  font-size: 0.8125rem;
  color: #475569;
  flex: 1;
}

.legend-item .val {
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
}

.legend-item .val.text-red {
  color: #b42318;
}

.chart-empty-msg {
  flex: 1;
  min-width: 10rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.95rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px dashed rgba(15, 23, 42, 0.12);
  font-size: 0.85rem;
  color: #6e6e73;
}

.chart-empty-msg .pi {
  font-size: 1.05rem;
  color: #94a3b8;
}

/* ---------- Listas ---------- */
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

.dash-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.dash-row__main {
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
  overflow-wrap: anywhere;
}

.dash-row__meta {
  font-size: 0.78rem;
  color: #6e6e73;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* Reservas: bloque de fecha + detalle */
.res-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.65rem 0.8rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.05);
}

.res-row--today {
  background: #e8eefc;
  border-color: transparent;
}

.res-row__date {
  flex-shrink: 0;
  width: 3.1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.35rem 0.3rem;
  border-radius: 10px;
  background: #e8eefc;
  color: #1e3a8a;
  line-height: 1.1;
}

.res-row--today .res-row__date {
  background: #fff;
}

.res-row__date strong {
  font-size: 1.05rem;
  font-weight: 700;
}

.res-row__date small {
  font-size: 0.66rem;
  font-weight: 600;
  text-transform: capitalize;
  opacity: 0.8;
}

.res-row--cancelled .dash-row__title {
  text-decoration: line-through;
  color: #86868b;
}

.res-row--cancelled .res-row__date {
  background: #f1f5f9;
  color: #94a3b8;
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

.resv-status--confirmed,
.resv-status--today {
  background: #e3f4e8;
  color: #15803d;
}

.res-row--today .resv-status--today,
.res-row--today .resv-status--finished {
  background: #fff;
}

.resv-status--finished {
  background: #eef0f3;
  color: #64748b;
}

.resv-status--cancelled {
  background: #fde4e4;
  color: #b42318;
}

/* Incidencias: tarjetas sólidas según estado */
.inc-stats {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.inc-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
  white-space: nowrap;
}

.inc-stat strong {
  font-weight: 750;
}

.inc-stat--open { background: #fde4e4; color: #b42318; }
.inc-stat--in-progress { background: #fdeee2; color: #c2410c; }
.inc-stat--resolved { background: #e3f4e8; color: #15803d; }

.inc-row {
  --inc-ink: #b42318;
  --inc-bg: #fde4e4;
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.75rem 0.85rem;
  border-radius: 14px;
  background: var(--inc-bg);
}

.inc-row--open { --inc-ink: #b42318; --inc-bg: #fde4e4; }
.inc-row--in-progress { --inc-ink: #c2410c; --inc-bg: #fdeee2; }
.inc-row--resolved { --inc-ink: #15803d; --inc-bg: #e3f4e8; }

.inc-row__icon {
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  background: #fff;
  color: var(--inc-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
}

.inc-badge {
  background: #fff;
  color: var(--inc-ink, #b42318);
}

/* ---------- Diálogo de comunicados ---------- */
.dialog-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.ann-all-item {
  --ann-bg: #e8eefc;
  --ann-ink: #1e3a8a;
  border-radius: 14px;
  padding: 0.9rem 1rem;
  background: var(--ann-bg);
}

.ann-all-item--urgent { --ann-bg: #fde4e4; --ann-ink: #b42318; }
.ann-all-item--important { --ann-bg: #fdeee2; --ann-ink: #c2410c; }
.ann-all-item--normal { --ann-bg: #f1f5f9; --ann-ink: #1e3a8a; }

.ann-all-item--expired {
  opacity: 0.65;
}

.ann-all-item__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.ann-all-item__meta {
  display: flex;
  gap: 0.4rem;
}

.ann-tag {
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: #fff;
  color: #475569;
}

.ann-tag--expired {
  color: #b42318;
}

.ann-all-item__title {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
  font-weight: 650;
  color: #0f172a;
}

.ann-all-item__body {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: #334155;
  line-height: 1.45;
}

.ann-all-item__footer {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  border-top: 1px solid rgba(15, 23, 42, 0.08);
  padding-top: 0.65rem;
}

.ann-all-item__author {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.74rem;
  font-weight: 600;
  color: #0f172a;
}

.ann-dates {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.15rem;
}

.ann-created {
  font-size: 0.72rem;
  color: #64748b;
}

.ann-expiry {
  font-size: 0.72rem;
  color: #15803d;
  font-weight: 600;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
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
  .dash-grid,
  .dash-grid--even {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 0.9rem 2rem;
  }
  .dash-hero {
    padding: 1.2rem 1.1rem;
  }
  .dash-hero__title {
    font-size: 1.35rem;
  }
  .dash-hero__status {
    border-radius: 14px;
  }
  .dash-actions {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dash-action {
    justify-content: center;
    padding: 0.55rem 0.6rem;
    text-align: center;
  }
  .agenda__grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .kpi-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.7rem;
  }
  .kpi-value {
    font-size: 1.5rem;
  }
  .chart-flex {
    flex-direction: column;
    align-items: stretch;
  }
  .canvas-wrapper {
    align-self: center;
  }
  .res-row,
  .inc-row {
    flex-wrap: wrap;
  }
  .res-row .guest-badge,
  .inc-row .inc-badge {
    margin-left: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kpi-card,
  .dash-action,
  .carousel-dot::before {
    transition: none;
  }
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.rd-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 85vh;
}

.rd-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.rd-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.rd-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 1.25rem;
}
</style>
