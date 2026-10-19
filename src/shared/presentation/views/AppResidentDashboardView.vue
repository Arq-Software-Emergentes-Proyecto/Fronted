<script setup>
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { announcementsApi } from '@/communications/infrastructure/announcementsApi.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import {
  compareAnnouncementsForCarousel,
  isAnnouncementActive,
} from '@/communications/domain/model/announcementConstants.js'
import noAnnouncementsIllustration from '@/communications/presentation/assets/no-announcements.svg'
import { todayYmd } from '@/finances/domain/billingCycle.js'
import { useResidentPaymentStore } from '@/finances/application/residentPaymentStore.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()
const { state: paymentState, loadData: loadFinanceData } = useResidentPaymentStore()

const profile = computed(() => sessionState.profile ?? {})

const reservations = ref([])
const spacesById = ref(new Map())
const isLoadingReservations = ref(false)

const announcements = ref([])
const isLoadingAnnouncements = ref(false)

const incidents = ref([])
const isLoadingIncidents = ref(false)

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

function isCurrentMonthMovement(fee) {
  return (
    String(fee.billingMonth || '') === currentMonthKey ||
    String(fee.dueDate || '').startsWith(currentMonthKey)
  )
}

const financeSummary = computed(() => {
  const fees = (paymentState.fees || []).filter(
    (f) => isCurrentMonthMovement(f) || isFeeOverdue(f),
  )
  const amount = (f) => Number(f.amount) || 0
  const paid = fees.filter((f) => f.status === 'Pagado').reduce((sum, f) => sum + amount(f), 0)
  const pending = fees.filter((f) => f.status === 'Pendiente').reduce((sum, f) => sum + amount(f), 0)
  const overdue = fees.filter(isFeeOverdue).reduce((sum, f) => sum + amount(f), 0)

  return { paid, pending, overdue, total: paid + pending }
})

const financeMonthLabel = computed(() => {
  const [y, m] = currentMonthKey.split('-').map(Number)
  const label = new Date(y, m - 1, 1).toLocaleDateString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    month: 'long',
    year: 'numeric',
  })
  return label.charAt(0).toUpperCase() + label.slice(1)
})

function prevAnn() {
  if (currentIndex.value > 0) currentIndex.value--
  else currentIndex.value = Math.max(0, activeAnnouncements.value.length - 1)
}

function nextAnn() {
  if (currentIndex.value < activeAnnouncements.value.length - 1) currentIndex.value++
  else currentIndex.value = 0
}

function spaceNameFor(reservation) {
  return spacesById.value.get(reservation.spaceId)?.name ?? t('app.spaceFallbackName')
}

function priorityClass(priority) {
  return `ann-badge--${priority}`
}

function priorityLabel(priority) {
  const map = {
    normal: t('information.priorityNormal'),
    important: t('information.priorityImportant'),
    urgent: t('information.priorityUrgent'),
  }
  return map[priority] ?? map.normal
}

function formatCurrency(val) {
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    style: 'currency',
    currency: 'PEN',
  }).format(val)
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

function isExpired(iso) {
  if (!iso) return false
  return new Date() > new Date(iso)
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return String(iso)
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

function formatExpiry(iso) {
  if (!iso) return ''
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return new Date(iso).toLocaleDateString(loc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function durationLabel(days) {
  if (!days) return ''
  if (days === 7) return t('information.duration7')
  if (days === 15) return t('information.duration15')
  if (days === 30) return t('information.duration30')
  return `${days} ${t('information.durationDays')}`
}

const chartCanvas = ref(null)

function drawChart() {
  const ctx = chartCanvas.value?.getContext('2d')
  if (!ctx) return

  const { paid, pending, overdue } = financeSummary.value
  const total = paid + pending

  const width = chartCanvas.value.width
  const height = chartCanvas.value.height
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) / 2 - 10

  ctx.clearRect(0, 0, width, height)

  if (total === 0) {
    // US017 "Residente sin historial": anillo gris neutro.
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI)
    ctx.fillStyle = '#e5e5ea'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius * 0.7, 0, 2 * Math.PI)
    ctx.fillStyle = '#fff'
    ctx.fill()
    return
  }

  const data = [
    { val: paid, color: '#34c759' },
    { val: pending - overdue, color: '#ff9500' },
    { val: overdue, color: '#ff3b30' },
  ]

  let startAngle = -Math.PI / 2
  data.forEach((item) => {
    if (item.val <= 0) return
    const sliceAngle = (item.val / total) * 2 * Math.PI

    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle)
    ctx.closePath()
    ctx.fillStyle = item.color
    ctx.fill()

    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()

    startAngle += sliceAngle
  })

  ctx.beginPath()
  ctx.arc(centerX, centerY, radius * 0.7, 0, 2 * Math.PI)
  ctx.fillStyle = '#fff'
  ctx.fill()
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

async function loadInitialData() {
  if (!profile.value.id) return

  isLoadingReservations.value = true
  isLoadingAnnouncements.value = true
  isLoadingIncidents.value = true
  dashboardLoadFailed.value = false

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
  <div class="app-view app-view--ai">
    <h1 class="visually-hidden">{{ t('resident.dashboardTitle') }}</h1>

    <div class="finance-page">
      <section class="finance-panel" aria-labelledby="resident-kpi-heading">
        <h2 id="resident-kpi-heading" class="finance-panel__section-title">
          {{ t('resident.financeChartTitle') }}
        </h2>

        <LoadErrorRetry v-if="showLoadError" :loading="isRetrying" @retry="retryLoad" />

        <div class="kpi-grid custom-scrollbar">
          <div class="kpi-card" :class="{ 'card-danger': financeSummary.overdue > 0 }">
            <div class="kpi-header">
              <div class="kpi-icon icon-orange">
                <i class="pi pi-wallet" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('resident.kpiPendingAmount') }}</span>
            </div>
            <div class="kpi-value" :class="{ 'text-red': financeSummary.overdue > 0 }">
              {{ formatCurrency(financeSummary.pending) }}
            </div>
            <span class="kpi-subtext" :class="{ 'subtext-red': financeSummary.overdue > 0 }">
              {{
                financeSummary.overdue > 0
                  ? t('resident.financeChartOverdue')
                  : t('resident.financeChartPending')
              }}
            </span>
          </div>

          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-green">
                <i class="pi pi-check-circle" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('resident.kpiPaidTotal') }}</span>
            </div>
            <div class="kpi-value">{{ formatCurrency(financeSummary.paid) }}</div>
            <span class="kpi-subtext">{{ t('resident.financeChartPaid') }}</span>
          </div>

          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-red">
                <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('resident.kpiOpenIncidents') }}</span>
            </div>
            <div class="kpi-value">{{ incidentsSummary.open }}</div>
            <span class="kpi-subtext">{{ t('resident.incidentsOpen') }}</span>
          </div>

          <div class="kpi-card">
            <div class="kpi-header">
              <div class="kpi-icon icon-blue">
                <i class="pi pi-calendar" aria-hidden="true"></i>
              </div>
              <span class="kpi-label">{{ t('resident.kpiUpcomingReservations') }}</span>
            </div>
            <div class="kpi-value">{{ allUpcomingReservations.length }}</div>
            <span class="kpi-subtext">{{ t('resident.reservationsReminderTitle') }}</span>
          </div>
        </div>
      </section>

      <div class="grid-layout">
        <section class="finance-panel flex-1" aria-labelledby="resident-chart-heading">
          <h2 id="resident-chart-heading" class="finance-panel__section-title">
            {{ t('resident.financeChartTitle') }}
          </h2>
          <p class="chart-month">{{ t('financeOps.donutMonthHint', { month: financeMonthLabel }) }}</p>
          <div class="chart-wrap">
            <div class="chart-flex">
              <div class="canvas-wrapper">
                <canvas
                  ref="chartCanvas"
                  width="160"
                  height="160"
                  role="img"
                  :aria-label="
                    financeSummary.total > 0
                      ? t('resident.financeChartTitle')
                      : t('financeOps.donutEmpty')
                  "
                ></canvas>
                <div class="chart-center-text">
                  <span v-if="financeSummary.total > 0" class="center-percent">
                    {{ Math.round((financeSummary.paid / financeSummary.total) * 100) }}%
                  </span>
                  <span v-else class="center-percent center-percent--empty">—</span>
                  <span class="center-label">{{ t('resident.financeChartPaid') }}</span>
                </div>
              </div>
              <p v-if="financeSummary.total === 0" class="dash-empty chart-empty-msg">
                {{ t('financeOps.donutEmpty') }}
              </p>
              <div v-else class="chart-legend">
                <div class="legend-item">
                  <span class="dot dot--paid"></span>
                  <span class="label">{{ t('resident.financeChartPaid') }}</span>
                  <span class="val">{{ formatCurrency(financeSummary.paid) }}</span>
                </div>
                <div class="legend-item">
                  <span class="dot dot--pending"></span>
                  <span class="label">{{ t('resident.financeChartPending') }}</span>
                  <span class="val">{{
                    formatCurrency(financeSummary.pending - financeSummary.overdue)
                  }}</span>
                </div>
                <div class="legend-item">
                  <span class="dot dot--overdue"></span>
                  <span class="label">{{ t('resident.financeChartOverdue') }}</span>
                  <span class="val">{{ formatCurrency(financeSummary.overdue) }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          class="finance-panel flex-1 ann-section"
          :class="currentAnnouncement ? priorityClass(currentAnnouncement.priority) : null"
          aria-labelledby="resident-announcements-heading"
        >
          <div class="panel-head">
            <h2 id="resident-announcements-heading" class="finance-panel__section-title">
              {{ t('resident.announcementsTitle') }}
            </h2>
            <div class="ann-section__actions">
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
                class="btn-see-all"
                @click="showAllAnnouncements = true"
              >
                {{ t('information.seeAll') }}
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
          <Transition v-else name="fade" mode="out-in">
            <article :key="currentIndex" class="ann-content">
              <div class="ann-content__top">
                <span class="ann-badge" :class="priorityClass(currentAnnouncement.priority)">
                  {{ priorityLabel(currentAnnouncement.priority) }}
                </span>
                <span class="ann-author">{{ currentAnnouncement.authorName }}</span>
              </div>
              <h3 class="ann-content__title">{{ currentAnnouncement.title }}</h3>
              <p class="ann-content__body">{{ currentAnnouncement.body }}</p>
              <div v-if="activeAnnouncements.length > 1" class="carousel-dots">
                <button
                  v-for="(_, i) in activeAnnouncements"
                  :key="i"
                  type="button"
                  class="carousel-dot"
                  :class="{ active: i === currentIndex }"
                  @click="currentIndex = i"
                />
              </div>
            </article>
          </Transition>
        </section>
      </div>

      <section class="finance-panel" aria-labelledby="resident-reservations-heading">
        <div class="panel-head">
          <h2 id="resident-reservations-heading" class="finance-panel__section-title">
            {{ t('resident.reservationsReminderTitle') }}
          </h2>
          <button
            v-if="reservations.length > 0"
            type="button"
            class="btn-see-all"
            @click="showAllReservations = true"
          >
            {{ t('information.seeAll') }}
          </button>
        </div>

        <p v-if="isLoadingReservations" class="dash-empty">…</p>
        <p v-else-if="allUpcomingReservations.length === 0" class="dash-empty">
          {{ t('resident.reservationsReminderEmpty') }}
        </p>
        <ul v-else class="dash-list" role="list">
          <template v-if="todayReservations.length > 0">
            <li
              v-for="res in todayReservations.slice(0, 3)"
              :key="'today-' + res.id"
              class="dash-row"
            >
              <div class="dash-row__main">
                <span class="dash-row__title">{{ spaceNameFor(res) }}</span>
                <span class="dash-row__meta">{{ res.startTime }} – {{ res.endTime }}</span>
              </div>
              <div class="dash-row__side">
                <span class="guest-badge guest-badge--yes">{{ t('importView.today') }}</span>
                <span class="dash-row__guests">{{ res.date }}</span>
              </div>
            </li>
          </template>
          <li
            v-for="res in otherUpcomingReservations.slice(
              0,
              Math.max(0, 3 - todayReservations.length),
            )"
            :key="'other-' + res.id"
            class="dash-row"
          >
            <div class="dash-row__main">
              <span class="dash-row__title">{{ spaceNameFor(res) }}</span>
              <span class="dash-row__meta">{{ res.startTime }} – {{ res.endTime }}</span>
            </div>
            <div class="dash-row__side">
              <span class="guest-badge guest-badge--no">{{ res.date }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section class="finance-panel" aria-labelledby="resident-incidents-heading">
        <div class="panel-head">
          <h2 id="resident-incidents-heading" class="finance-panel__section-title">
            {{ t('resident.incidentsSummaryTitle') }}
          </h2>
          <button
            v-if="incidents.length > 0"
            type="button"
            class="btn-see-all"
            @click="showAllIncidents = true"
          >
            {{ t('information.seeAll') }}
          </button>
        </div>

        <div v-if="!isLoadingIncidents && incidents.length" class="inc-stat-row">
          <div class="inc-stat">
            <span class="inc-stat__count">{{ incidentsSummary.open }}</span>
            <span class="inc-stat__label">{{ t('resident.incidentsOpen') }}</span>
          </div>
          <div class="inc-stat">
            <span class="inc-stat__count">{{ incidentsSummary.inProgress }}</span>
            <span class="inc-stat__label">{{ t('resident.incidentsInProgress') }}</span>
          </div>
          <div class="inc-stat">
            <span class="inc-stat__count">{{ incidentsSummary.resolved }}</span>
            <span class="inc-stat__label">{{ t('resident.incidentsResolved') }}</span>
          </div>
        </div>

        <p v-if="isLoadingIncidents" class="dash-empty">…</p>
        <p v-else-if="incidents.length === 0" class="dash-empty">
          {{ t('resident.incidentsEmpty') }}
        </p>
        <ul v-else class="dash-list" role="list">
          <li v-for="inc in incidents.slice(0, 5)" :key="inc.id" class="dash-row">
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

    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="showAllAnnouncements"
          class="modal-overlay"
          @click.self="showAllAnnouncements = false"
        >
          <div
            class="modal-content"
            role="dialog"
            :aria-label="t('information.allAnnouncementsTitle')"
          >
            <header class="modal-header">
              <h2 class="modal-title">{{ t('information.allAnnouncementsTitle') }}</h2>
              <button type="button" class="modal-close" @click="showAllAnnouncements = false">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </header>
            <div class="modal-body">
              <article
                v-for="ann in activeAnnouncements"
                :key="ann.id"
                class="ann-all-item"
                :class="{
                  'ann-all-item--urgent': ann.priority === 'urgent',
                  'ann-all-item--expired': isExpired(ann.expiresAt),
                }"
              >
                <div class="ann-all-item__top">
                  <span class="ann-badge" :class="priorityClass(ann.priority)">
                    {{ priorityLabel(ann.priority) }}
                  </span>
                  <div class="ann-all-item__meta">
                    <span v-if="ann.duration" class="ann-duration-tag">
                      {{ durationLabel(ann.duration) }}
                    </span>
                    <span v-if="isExpired(ann.expiresAt)" class="ann-expired-tag">
                      {{ t('information.expired') }}
                    </span>
                  </div>
                </div>
                <h3 class="ann-all-item__title">{{ ann.title }}</h3>
                <p class="ann-all-item__body">{{ ann.body }}</p>
                <div class="ann-all-item__footer">
                  <span class="ann-author">{{ ann.authorName }}</span>
                  <div class="ann-dates">
                    <time class="ann-created">{{ formatDate(ann.createdAt) }}</time>
                    <span v-if="ann.expiresAt" class="ann-expiry">
                      {{ t('information.expiresOn', { date: formatExpiry(ann.expiresAt) }) }}
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showAllIncidents" class="modal-overlay" @click.self="showAllIncidents = false">
          <div class="modal-content" role="dialog" :aria-label="t('resident.incidentsTitle')">
            <header class="modal-header">
              <h2 class="modal-title">{{ t('resident.incidentsTitle') }}</h2>
              <button type="button" class="modal-close" @click="showAllIncidents = false">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </header>
            <div class="modal-body">
              <ul class="dash-list" role="list">
                <li v-for="inc in incidents" :key="inc.id" class="dash-row">
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
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="showAllReservations"
          class="modal-overlay"
          @click.self="showAllReservations = false"
        >
          <div
            class="modal-content"
            role="dialog"
            :aria-label="t('socialSpaces.historyTitle')"
          >
            <header class="modal-header">
              <h2 class="modal-title">{{ t('socialSpaces.historyTitle') }}</h2>
              <button type="button" class="modal-close" @click="showAllReservations = false">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </header>
            <div class="modal-body">
              <p v-if="!reservationHistory.length" class="dash-empty">
                {{ t('socialSpaces.historyEmpty') }}
              </p>
              <ul v-else class="dash-list" role="list">
                <li
                  v-for="res in reservationHistory"
                  :key="res.id"
                  class="dash-row"
                  :class="{ 'dash-row--cancelled': res.status === 'CANCELLED' }"
                >
                  <div class="dash-row__main">
                    <span class="dash-row__title">{{ spaceNameFor(res) }}</span>
                    <span class="dash-row__meta">
                      {{ res.date }} · {{ res.startTime }} – {{ res.endTime }}
                    </span>
                  </div>
                  <span
                    class="guest-badge"
                    :class="`resv-status--${reservationHistoryStatus(res).key}`"
                  >
                    {{ reservationHistoryStatus(res).label }}
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
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

.btn-see-all {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--apple-blue, #1e3a8a);
  cursor: pointer;
}

.btn-see-all:hover {
  text-decoration: underline;
}

.kpi-grid {
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

.icon-blue {
  background: #e8eefc;
  color: #1e3a8a;
}
.icon-green {
  background: #e8f5e9;
  color: #1b7a3d;
}
.icon-orange {
  background: #fff3e0;
  color: #e65100;
}
.icon-red {
  background: #fdecee;
  color: #b42318;
}

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

.subtext-red {
  color: #b42318;
}
.text-red {
  color: #b42318;
}
.card-danger {
  background: #fff7f7;
}

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

.grid-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
@media (min-width: 1024px) {
  .grid-layout {
    flex-direction: row;
  }
  .flex-1 {
    flex: 1;
    min-width: 0;
  }
}

.chart-wrap {
  min-height: 10rem;
}

.chart-month {
  margin: -0.45rem 0 0.75rem;
  font-size: 0.75rem;
  color: #86868b;
}

.center-percent--empty {
  color: #aeaeb2;
}

.chart-empty-msg {
  flex: 1;
  min-width: 10rem;
  margin: 0;
  font-size: 0.875rem;
  color: #6e6e73;
}

.chart-flex {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.canvas-wrapper {
  position: relative;
  width: 160px;
  height: 160px;
  flex-shrink: 0;
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
  font-size: 1.35rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: #1d1d1f;
}

.center-label {
  font-size: 0.65rem;
  color: #86868b;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.chart-legend {
  flex: 1;
  min-width: 10rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot--paid {
  background: #34c759;
}
.dot--pending {
  background: #ff9500;
}
.dot--overdue {
  background: #ff3b30;
}

.legend-item .label {
  font-size: 0.8125rem;
  color: #6e6e73;
  flex: 1;
}

.legend-item .val {
  font-weight: 600;
  font-size: 0.875rem;
  color: #1d1d1f;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 10rem;
  text-align: center;
}

.dash-empty {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #6e6e73;
}

.ann-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
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

.resv-status--confirmed,
.resv-status--today {
  background: #e8f5e9;
  color: #1b7a3d;
}

.resv-status--finished {
  background: #eeeef0;
  color: #6e6e73;
}

.resv-status--cancelled {
  background: #fdecee;
  color: #b42318;
}

.dash-row--cancelled .dash-row__title {
  text-decoration: line-through;
  color: #86868b;
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

.inc-stat-row {
  display: flex;
  gap: 0.65rem;
  margin-bottom: 0.85rem;
}

.inc-stat {
  flex: 1;
  background: #f5f5f7;
  border-radius: 12px;
  padding: 0.7rem 0.75rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
}

.inc-stat__count {
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: #1d1d1f;
}

.inc-stat__label {
  font-size: 0.7rem;
  font-weight: 600;
  color: #86868b;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.ann-section {
  display: flex;
  flex-direction: column;
  min-height: 14rem;
}

.ann-section.ann-badge--urgent {
  background: #fff7f7;
  border-color: rgba(180, 35, 24, 0.12);
}

.ann-section.ann-badge--important {
  background: #fffaf2;
  border-color: rgba(230, 81, 0, 0.12);
}

.ann-section__actions {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.nav-btn {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.05);
  color: #1d1d1f;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.nav-btn:hover {
  background: rgba(0, 0, 0, 0.08);
}

.ann-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ann-content__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
}

.ann-badge {
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.ann-badge--normal {
  background: #eeeef0;
  color: #6e6e73;
}
.ann-badge--important {
  background: #fff3e0;
  color: #e65100;
}
.ann-badge--urgent {
  background: #fdecee;
  color: #b42318;
}

.ann-author {
  font-size: 0.72rem;
  color: #86868b;
  font-weight: 500;
}

.ann-content__title {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.ann-content__body {
  margin: 0;
  flex: 1;
  font-size: 0.875rem;
  color: #6e6e73;
  line-height: 1.5;
}

.carousel-dots {
  display: flex;
  justify-content: flex-start;
  gap: 0.4rem;
  margin-top: auto;
  padding-top: 1rem;
}

.carousel-dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #d2d2d7;
  cursor: pointer;
}

.carousel-dot.active {
  background: #1e3a8a;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.modal-content {
  background: #fff;
  width: 100%;
  max-width: 36rem;
  max-height: 80vh;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 1rem 1.15rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.modal-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.modal-close {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 10px;
  background: #f5f5f7;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #1d1d1f;
}

.modal-body {
  padding: 1rem 1.15rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.ann-all-item {
  background: #f5f5f7;
  border-radius: 12px;
  padding: 0.9rem 1rem;
  border-left: 3px solid #d2d2d7;
}

.ann-all-item--urgent {
  border-left-color: #ff3b30;
}
.ann-all-item--expired {
  opacity: 0.65;
}

.ann-all-item__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.ann-all-item__meta {
  display: flex;
  gap: 0.4rem;
}

.ann-duration-tag,
.ann-expired-tag {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 0.12rem 0.45rem;
  border-radius: 980px;
}

.ann-duration-tag {
  background: #e8eefc;
  color: #1e3a8a;
}
.ann-expired-tag {
  background: #fdecee;
  color: #b42318;
}

.ann-all-item__title {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: #1d1d1f;
}

.ann-all-item__body {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  color: #6e6e73;
  line-height: 1.45;
}

.ann-all-item__footer {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 0.75rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding-top: 0.65rem;
}

.ann-dates {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.15rem;
}

.ann-created {
  font-size: 0.72rem;
  color: #86868b;
}
.ann-expiry {
  font-size: 0.72rem;
  color: #1b7a3d;
  font-weight: 500;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
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
  .chart-flex {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
