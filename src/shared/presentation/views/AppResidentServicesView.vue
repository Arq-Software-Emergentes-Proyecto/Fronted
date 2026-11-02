<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Dialog from 'primevue/dialog'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'

const { t, locale } = useI18n()
const router = useRouter()
const { state } = useSession()
const profile = computed(() => state.profile ?? {})

/** Same cap the reservations API / server apply (ReservationPolicy.CanHostGuests). */
const MAX_GUESTS = 5

const spaces = ref([])
const isLoadingSpaces = ref(false)
const spacesLoadError = ref('')

const isReserveModalOpen = ref(false)
const selectedSpace = ref(null)
const reservationForm = reactive({
  date: '',
  startTime: '',
  endTime: '',
})
const reservationError = ref('')
const isSubmittingReservation = ref(false)

const allSpaceReservations = ref([])
const isLoadingSpaceReservations = ref(false)
/** RNF012: the calendar availability could not be loaded (do not show every day as free). */
const spaceReservationsLoadError = ref(false)

const calendarMonth = ref(startOfMonth(new Date()))

/** Day the resident last tapped in the calendar: its busy hours are shown in step 2. */
const busyHoursDate = ref('')

/** Booking just confirmed by the server (US026 "envía la confirmación"). */
const confirmation = ref(null)

/** Resident's own active reservations (for "Tu próxima reserva"). */
const myReservations = ref([])
const nowMs = ref(Date.now())
const cancelTarget = ref(null)
const isCancelling = ref(false)
const cancelError = ref('')
const cancelNotice = ref('')

/**
 * Daily window used to paint a day as "full" when no free gap of at least
 * MIN_FREE_GAP_MINUTES remains (the server is still the authority: 409 on overlap).
 */
const DAY_WINDOW_START_MIN = 7 * 60
const DAY_WINDOW_END_MIN = 23 * 60
const MIN_FREE_GAP_MINUTES = 60

function toMinutes(value) {
  const [h, m] = String(value ?? '').split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : Number.NaN
}

function isUnderMaintenance(space) {
  return String(space?.status ?? '').toUpperCase() === 'MAINTENANCE'
}

/** Flat placeholder icon + tint for spaces without a photo. */
const SPACE_VISUALS = [
  { test: /piscin|pool|swim/i, icon: 'pi-sun', tone: 'blue' },
  { test: /gim|gym|fitness/i, icon: 'pi-heart', tone: 'green' },
  { test: /sal[oó]n|hall|event|club|sum\b/i, icon: 'pi-users', tone: 'amber' },
  { test: /parrill|bbq|grill|terraz|roof/i, icon: 'pi-sparkles', tone: 'orange' },
  { test: /cowork|estudio|study|office|oficina/i, icon: 'pi-desktop', tone: 'blue' },
  { test: /juego|kids|play|niñ/i, icon: 'pi-face-smile', tone: 'green' },
]
const FALLBACK_TONES = ['blue', 'green', 'amber', 'orange']

function spaceVisual(space, index = 0) {
  const name = `${space?.name ?? ''} ${space?.description ?? ''}`
  const match = SPACE_VISUALS.find((v) => v.test.test(name))
  return match ?? { icon: 'pi-building', tone: FALLBACK_TONES[index % FALLBACK_TONES.length] }
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function formatDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftMonth(amount) {
  const base = calendarMonth.value
  calendarMonth.value = new Date(base.getFullYear(), base.getMonth() + amount, 1)
}

function prevMonth() {
  shiftMonth(-1)
}

function nextMonth() {
  shiftMonth(1)
}

const todayKey = computed(() => formatDateKey(new Date()))
const tomorrowKey = computed(() => {
  const d = new Date()
  return formatDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
})

/** Do not let the resident navigate to months before the current one (all days would be past). */
const canGoPrevMonth = computed(() => calendarMonth.value > startOfMonth(new Date()))

/** dateKey → 'partial' | 'full' (days without reservations are free). */
const dayStatusByDate = computed(() => {
  const byDate = new Map()
  for (const reservation of allSpaceReservations.value) {
    if (!reservation?.date || reservation.status === 'CANCELLED') continue
    if (!byDate.has(reservation.date)) byDate.set(reservation.date, [])
    byDate.get(reservation.date).push(reservation)
  }
  const maxPerDay = Number(selectedSpace.value?.maxReservationsPerDay) || 0
  const result = new Map()
  for (const [date, list] of byDate) {
    const intervals = list
      .map((r) => [
        Math.max(DAY_WINDOW_START_MIN, toMinutes(r.startTime)),
        Math.min(DAY_WINDOW_END_MIN, toMinutes(r.endTime)),
      ])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a < b)
      .sort((x, y) => x[0] - y[0])
    let cursor = DAY_WINDOW_START_MIN
    let longestGap = 0
    for (const [a, b] of intervals) {
      longestGap = Math.max(longestGap, a - cursor)
      cursor = Math.max(cursor, b)
    }
    longestGap = Math.max(longestGap, DAY_WINDOW_END_MIN - cursor)
    const full = (maxPerDay > 0 && list.length >= maxPerDay) || longestGap < MIN_FREE_GAP_MINUTES
    result.set(date, full ? 'full' : 'partial')
  }
  return result
})

function dayStatusLabel(status) {
  if (status === 'full') return t('socialSpaces.legendFull')
  if (status === 'partial') return t('socialSpaces.legendPartial')
  return t('socialSpaces.legendFree')
}

const calendarDays = computed(() => {
  const month = calendarMonth.value
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (firstOfMonth.getDay() + 6) % 7
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate()

  const buffer = []
  for (let i = offset; i > 0; i--) {
    buffer.push(new Date(month.getFullYear(), month.getMonth(), 1 - i))
  }
  for (let i = 1; i <= daysInMonth; i++) {
    buffer.push(new Date(month.getFullYear(), month.getMonth(), i))
  }
  while (buffer.length < 42) {
    const last = buffer[buffer.length - 1]
    buffer.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1))
  }

  return buffer.map((date) => {
    const key = formatDateKey(date)
    return {
      key,
      label: date.getDate(),
      isCurrentMonth: date.getMonth() === month.getMonth(),
      isToday: key === todayKey.value,
      isPast: key < todayKey.value,
      status: dayStatusByDate.value.get(key) ?? 'free',
      isSelected: key === reservationForm.date,
      isFocused: key === busyHoursDate.value && key !== reservationForm.date,
    }
  })
})

const weekdayLabels = computed(() => {
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: 'short' })
  const labels = []
  // 2024-01-01 was a Monday; iterate Mon..Sun.
  for (let i = 0; i < 7; i++) {
    const date = new Date(2024, 0, 1 + i)
    labels.push(fmt.format(date).replace('.', ''))
  }
  return labels
})

const calendarMonthLabel = computed(() => {
  const fmt = new Intl.DateTimeFormat(locale.value, {
    month: 'long',
    year: 'numeric',
  })
  const label = fmt.format(calendarMonth.value)
  return label.charAt(0).toUpperCase() + label.slice(1)
})

function formatFriendlyDate(dateKey) {
  if (!dateKey) return ''
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  const date = new Date(y, m - 1, d)
  const fmt = new Intl.DateTimeFormat(locale.value, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  const label = fmt.format(date)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function formatTimeDisplay(timeValue) {
  const raw = String(timeValue ?? '').trim()
  if (!raw) return ''
  const [h, mi] = raw.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return raw
  const date = new Date()
  date.setHours(h, mi, 0, 0)
  return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function timeRangeLabel(start, end) {
  return t('socialSpaces.book.timeRange', {
    start: formatTimeDisplay(start),
    end: formatTimeDisplay(end),
  })
}

/** "Hoy" / "Mañana" / friendly date. */
function relativeDayLabel(dateKey) {
  if (dateKey === todayKey.value) return t('socialSpaces.statusToday')
  if (dateKey === tomorrowKey.value) return t('socialSpaces.book.tomorrow')
  return formatFriendlyDate(dateKey)
}

const selectedDateLabel = computed(() => formatFriendlyDate(reservationForm.date))
const busyHoursDateLabel = computed(() => formatFriendlyDate(busyHoursDate.value))

const busyHoursForDate = computed(() => {
  if (!busyHoursDate.value) return []
  return allSpaceReservations.value
    .filter((r) => r.date === busyHoursDate.value)
    .slice()
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
})

const busyHoursDayStatus = computed(() => dayStatusByDate.value.get(busyHoursDate.value) ?? 'free')

/** Client-side hint only: the server answers 409 RESERVATION_OVERLAP authoritatively. */
function overlapsChosenRange(r) {
  const start = toMinutes(reservationForm.startTime)
  const end = toMinutes(reservationForm.endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return false
  return toMinutes(r.startTime) < end && start < toMinutes(r.endTime)
}

const chosenRangeConflicts = computed(
  () => Boolean(reservationForm.date) && busyHoursForDate.value.some(overlapsChosenRange),
)

const isTimeStepDone = computed(() => {
  const start = toMinutes(reservationForm.startTime)
  const end = toMinutes(reservationForm.endTime)
  return Number.isFinite(start) && Number.isFinite(end) && start < end && !chosenRangeConflicts.value
})

const bookingSummary = computed(() => {
  if (!reservationForm.date || !isTimeStepDone.value) return ''
  return t('socialSpaces.book.summary', {
    date: selectedDateLabel.value,
    start: formatTimeDisplay(reservationForm.startTime),
    end: formatTimeDisplay(reservationForm.endTime),
  })
})

/** Guests a booking of this space can host: max 5 and capacity minus the holder. */
function maxGuestsFor(space) {
  const capacity = Number(space?.capacity)
  if (capacity > 0) return Math.max(0, Math.min(MAX_GUESTS, capacity - 1))
  return MAX_GUESTS
}

const selectedSpaceMaxGuests = computed(() => maxGuestsFor(selectedSpace.value))

const reserveDialogTitle = computed(() =>
  selectedSpace.value
    ? t('socialSpaces.book.dialogTitle', { name: selectedSpace.value.name })
    : t('app.reserveModalTitle'),
)

async function loadSpaces() {
  isLoadingSpaces.value = true
  spacesLoadError.value = ''
  try {
    spaces.value = await spacesApi.list()
  } catch {
    spacesLoadError.value = t('app.spacesLoadError')
  } finally {
    isLoadingSpaces.value = false
  }
}

async function loadMyReservations() {
  const residentId = String(profile.value.id ?? '').trim()
  if (!residentId) {
    myReservations.value = []
    return
  }
  try {
    myReservations.value = await reservationsApi.listByResident(residentId)
  } catch {
    // The next-booking card is a shortcut: "Mis reservas" keeps the full list and its errors.
    myReservations.value = []
  }
  nowMs.value = Date.now()
}

onMounted(() => {
  loadSpaces()
  loadMyReservations()
})

function reservationEndMs(r) {
  const [y, m, d] = String(r?.date ?? '').split('-').map(Number)
  const [h, mi] = String(r?.endTime ?? '').split(':').map(Number)
  if (![y, m, d, h, mi].every(Number.isFinite)) return null
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime()
}

const upcomingReservations = computed(() =>
  myReservations.value
    .filter((r) => r.status !== 'CANCELLED')
    .filter((r) => {
      const end = reservationEndMs(r)
      return end != null && end > nowMs.value
    })
    .slice()
    .sort((a, b) =>
      a.date !== b.date ? a.date.localeCompare(b.date) : String(a.startTime).localeCompare(String(b.startTime)),
    ),
)

const nextReservation = computed(() => upcomingReservations.value[0] ?? null)

function spaceNameOf(spaceId) {
  return spaces.value.find((s) => String(s.id) === String(spaceId))?.name ?? t('app.spaceFallbackName')
}

function goToMyReservations() {
  router.push({ name: AppRouteNames.APP_RESIDENT_GENERATION })
}

function askCancel(reservation) {
  cancelError.value = ''
  cancelNotice.value = ''
  cancelTarget.value = reservation
}

function closeCancelDialog() {
  if (isCancelling.value) return
  cancelTarget.value = null
}

async function confirmCancel() {
  if (!cancelTarget.value || isCancelling.value) return
  isCancelling.value = true
  cancelError.value = ''
  try {
    await reservationsApi.cancel(cancelTarget.value.id)
    myReservations.value = myReservations.value.filter((r) => r.id !== cancelTarget.value.id)
    cancelTarget.value = null
    cancelNotice.value = t('socialSpaces.book.cancelSuccess')
  } catch {
    cancelError.value = t('socialSpaces.cancelError')
  } finally {
    isCancelling.value = false
  }
}

async function loadSpaceReservations() {
  if (!selectedSpace.value) {
    allSpaceReservations.value = []
    return
  }
  isLoadingSpaceReservations.value = true
  spaceReservationsLoadError.value = false
  try {
    allSpaceReservations.value = await reservationsApi.listBySpace(
      selectedSpace.value.id,
    )
  } catch {
    allSpaceReservations.value = []
    spaceReservationsLoadError.value = true
  } finally {
    isLoadingSpaceReservations.value = false
  }
}

function openReserveModal(space) {
  if (isUnderMaintenance(space)) return
  selectedSpace.value = space
  reservationForm.date = ''
  reservationForm.startTime = ''
  reservationForm.endTime = ''
  reservationError.value = ''
  busyHoursDate.value = ''
  allSpaceReservations.value = []
  calendarMonth.value = startOfMonth(new Date())
  isReserveModalOpen.value = true
  loadSpaceReservations()
}

function closeReserveModal() {
  if (isSubmittingReservation.value) return
  isReserveModalOpen.value = false
  selectedSpace.value = null
}

function onReserveDialogVisible(visible) {
  if (!visible) closeReserveModal()
}

function selectCalendarDate(dateKey) {
  reservationError.value = ''
  if (dateKey < todayKey.value) {
    reservationError.value = t('socialSpaces.pastDayHint')
    return
  }
  busyHoursDate.value = dateKey
  if ((dayStatusByDate.value.get(dateKey) ?? 'free') !== 'full') {
    reservationForm.date = dateKey
  } else {
    reservationForm.date = ''
  }
}

async function onReserveSubmit(event) {
  if (isSubmittingReservation.value || !selectedSpace.value) return

  if (!profile.value.id) {
    reservationError.value = t('app.reservationProfileMissing')
    return
  }

  reservationError.value = ''
  isSubmittingReservation.value = true
  try {
    const space = selectedSpace.value
    const created = await reservationsApi.add({
      spaceId: space.id,
      residentId: profile.value.id,
      residentName: profile.value.name,
      residentCode: profile.value.code,
      date: reservationForm.date,
      startTime: reservationForm.startTime,
      endTime: reservationForm.endTime,
    })
    await confirmSuccess(event, t('feedback.booked'))
    confirmation.value = {
      reservationId: created?.id,
      space: space.name,
      date: formatFriendlyDate(created?.date ?? reservationForm.date),
      start: formatTimeDisplay(created?.startTime ?? reservationForm.startTime),
      end: formatTimeDisplay(created?.endTime ?? reservationForm.endTime),
      maxGuests: maxGuestsFor(space),
    }
    isReserveModalOpen.value = false
    selectedSpace.value = null
    void loadMyReservations()
  } catch (error) {
    if (error?.code === 'RESERVATION_FIELDS_REQUIRED') {
      reservationError.value = t('app.reservationRequired')
      return
    }
    if (error?.code === 'RESERVATION_TIME_INVALID') {
      reservationError.value = t('app.reservationTimeInvalid')
      return
    }
    const conflictMessages = {
      RESERVATION_OVERLAP: 'socialSpaces.errOverlap',
      RESERVATION_CAPACITY_EXCEEDED: 'socialSpaces.errCapacity',
      RESERVATION_DAY_FULL: 'socialSpaces.errDayFull',
      SPACE_UNDER_MAINTENANCE: 'socialSpaces.errMaintenance',
      RESERVATION_TOO_MANY_GUESTS: 'socialSpaces.errTooManyGuests',
      RESIDENT_DELINQUENT: 'socialSpaces.errDelinquent',
    }
    if (conflictMessages[error?.code] || error?.status === 409) {
      reservationError.value = t(conflictMessages[error?.code] ?? 'socialSpaces.errOverlap')
      await loadSpaceReservations()
      if (error?.code === 'SPACE_UNDER_MAINTENANCE') void loadSpaces()
      return
    }
    reservationError.value = t('auth.genericError')
  } finally {
    isSubmittingReservation.value = false
  }
}

function closeConfirmation() {
  // Al cerrar el resumen, "Tu próxima reserva" se marca en verde si es la que se acaba de hacer.
  markFresh('reservation', confirmation.value?.reservationId)
  confirmation.value = null
}

function goToGuests() {
  confirmation.value = null
  router.push({ name: AppRouteNames.APP_RESIDENT_GENERATION })
}
</script>

<template>
  <div class="app-view svc">
    <header class="svc-head">
      <h1 class="bf-sr-only">{{ t('socialSpaces.book.pageTitle') }}</h1>
      <div class="svc-head__actions">
        <button type="button" class="svc-btn" @click="goToMyReservations">
          <i class="pi pi-calendar" aria-hidden="true" />
          {{ t('socialSpaces.book.myReservations') }}
        </button>
      </div>
    </header>

    <p v-if="cancelNotice" class="svc-notice" role="status">
      <i class="pi pi-check-circle" aria-hidden="true" />
      {{ cancelNotice }}
    </p>

    <!-- Tu próxima reserva -->
    <section
      v-if="nextReservation"
      class="svc-next"
      :class="{ 'bf-fresh': isFresh('reservation', nextReservation.id) }"
      aria-labelledby="svc-next-heading"
    >
      <span class="svc-next__icon" aria-hidden="true"><i class="pi pi-calendar-clock" /></span>
      <div class="svc-next__body">
        <h2 id="svc-next-heading" class="svc-next__eyebrow">{{ t('socialSpaces.book.nextTitle') }}</h2>
        <p class="svc-next__space">{{ spaceNameOf(nextReservation.spaceId) }}</p>
        <p class="svc-next__meta">
          <span class="svc-next__meta-item">
            <i class="pi pi-calendar" aria-hidden="true" />
            {{ relativeDayLabel(nextReservation.date) }}
          </span>
          <span class="svc-next__meta-item">
            <i class="pi pi-clock" aria-hidden="true" />
            {{ timeRangeLabel(nextReservation.startTime, nextReservation.endTime) }}
          </span>
          <span class="svc-next__meta-item">
            <i class="pi pi-users" aria-hidden="true" />
            {{ t('socialSpaces.book.guestsCount', { n: nextReservation.guests?.length ?? 0 }, nextReservation.guests?.length ?? 0) }}
          </span>
        </p>
        <p v-if="upcomingReservations.length > 1" class="svc-next__more">
          {{ t('socialSpaces.book.moreUpcoming', { n: upcomingReservations.length - 1 }, upcomingReservations.length - 1) }}
          ·
          <button type="button" class="svc-link" @click="goToMyReservations">
            {{ t('socialSpaces.book.myReservations') }}
          </button>
        </p>
      </div>
      <div class="svc-next__actions">
        <button type="button" class="svc-btn svc-btn--primary" @click="goToMyReservations">
          <i class="pi pi-user-plus" aria-hidden="true" />
          {{ t('socialSpaces.confirmGoToGuests') }}
        </button>
        <button type="button" class="svc-btn" @click="askCancel(nextReservation)">
          {{ t('socialSpaces.book.cancelAction') }}
        </button>
      </div>
    </section>

    <!-- Catálogo de espacios -->
    <section class="svc-spaces" aria-labelledby="svc-spaces-heading">
      <h2 id="svc-spaces-heading" class="visually-hidden">{{ t('socialSpaces.book.spacesListAria') }}</h2>

      <div v-if="isLoadingSpaces" class="svc-empty" role="status">
        <i class="pi pi-spin pi-spinner svc-empty__icon" aria-hidden="true" />
        <p class="svc-empty__text">{{ t('app.spacesLoading') }}</p>
      </div>
      <LoadErrorRetry
        v-else-if="spacesLoadError"
        :message="spacesLoadError"
        :loading="isLoadingSpaces"
        @retry="loadSpaces"
      />
      <div v-else-if="!spaces.length" class="svc-empty">
        <span class="svc-empty__badge" aria-hidden="true"><i class="pi pi-building" /></span>
        <p class="svc-empty__text">{{ t('app.emptySpacesResident') }}</p>
      </div>
      <ul v-else class="space-grid" role="list">
        <li
          v-for="(space, index) in spaces"
          :key="space.id"
          class="space-card"
          :class="{ 'space-card--maintenance': isUnderMaintenance(space) }"
        >
          <div v-if="space.imageUrl" class="space-card__media">
            <img
              :src="space.imageUrl"
              :alt="t('app.spaceImageAlt', { name: space.name })"
              class="space-card__image"
              loading="lazy"
            />
          </div>
          <div
            v-else
            class="space-card__media space-card__placeholder"
            :class="`tone-${spaceVisual(space, index).tone}`"
            aria-hidden="true"
          >
            <i class="pi" :class="spaceVisual(space, index).icon" />
          </div>

          <div class="space-card__body">
            <div class="space-card__pills">
              <span
                class="status-pill"
                :class="isUnderMaintenance(space) ? 'status-pill--orange' : 'status-pill--green'"
              >
                <i
                  class="pi"
                  :class="isUnderMaintenance(space) ? 'pi-wrench' : 'pi-check-circle'"
                  aria-hidden="true"
                />
                {{ isUnderMaintenance(space) ? t('socialSpaces.maintenanceBadge') : t('socialSpaces.statusAvailable') }}
              </span>
              <span v-if="space.capacity" class="status-pill status-pill--neutral">
                <i class="pi pi-users" aria-hidden="true" />
                {{ t('socialSpaces.book.capacityUpTo', { n: space.capacity }, Number(space.capacity)) }}
              </span>
            </div>

            <h3 class="space-card__name">{{ space.name }}</h3>
            <p v-if="space.description" class="space-card__desc">{{ space.description }}</p>
            <p v-if="space.rules" class="space-card__rules">
              <i class="pi pi-book" aria-hidden="true" />
              <span><span class="visually-hidden">{{ t('socialSpaces.rulesLabel') }}: </span>{{ space.rules }}</span>
            </p>

            <div class="space-card__foot">
              <p
                v-if="isUnderMaintenance(space)"
                :id="`space-blocked-${space.id}`"
                class="space-card__blocked"
              >
                {{ t('socialSpaces.maintenanceBlocked') }}
              </p>
              <button
                type="button"
                class="svc-btn svc-btn--primary space-card__cta"
                :disabled="isUnderMaintenance(space)"
                :aria-label="t('socialSpaces.book.reserveSpaceAria', { name: space.name })"
                :aria-describedby="isUnderMaintenance(space) ? `space-blocked-${space.id}` : undefined"
                @click="openReserveModal(space)"
              >
                <i class="pi pi-calendar-plus" aria-hidden="true" />
                {{ t('app.reserveAction') }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- Reservar: día → horario → invitados -->
    <Dialog
      :visible="isReserveModalOpen"
      modal
      :header="reserveDialogTitle"
      class="svc-dialog svc-dialog--booking"
      :style="{ width: 'min(54rem, 96vw)' }"
      :draggable="false"
      :closable="!isSubmittingReservation"
      :dismissable-mask="!isSubmittingReservation"
      @update:visible="onReserveDialogVisible"
    >
      <form id="svc-booking-form" class="bk" novalidate @submit.prevent="onReserveSubmit">
        <div class="bk-grid">
          <!-- 1. Día -->
          <section class="bk-step" aria-labelledby="bk-step1-title">
            <h3 id="bk-step1-title" class="bk-step__head">
              <span class="bk-step__num" :class="{ 'is-done': reservationForm.date }" aria-hidden="true">
                <i v-if="reservationForm.date" class="pi pi-check" />
                <template v-else>1</template>
              </span>
              {{ t('socialSpaces.book.step1') }}
              <span v-if="reservationForm.date" class="visually-hidden">· {{ t('socialSpaces.book.stepDone') }}</span>
            </h3>

            <div class="cal" :aria-label="t('common.calendarAria')" role="group">
              <div class="cal__head">
                <button
                  type="button"
                  class="cal__nav"
                  :disabled="!canGoPrevMonth"
                  :aria-label="t('app.calendarPrevMonth')"
                  :title="t('app.calendarPrevMonth')"
                  @click="prevMonth"
                >
                  <i class="pi pi-chevron-left" aria-hidden="true" />
                </button>
                <span class="cal__month" aria-live="polite">{{ calendarMonthLabel }}</span>
                <button
                  type="button"
                  class="cal__nav"
                  :aria-label="t('app.calendarNextMonth')"
                  :title="t('app.calendarNextMonth')"
                  @click="nextMonth"
                >
                  <i class="pi pi-chevron-right" aria-hidden="true" />
                </button>
              </div>

              <div class="cal__weekdays" aria-hidden="true">
                <span v-for="(label, idx) in weekdayLabels" :key="idx">{{ label }}</span>
              </div>

              <p v-if="isLoadingSpaceReservations" class="cal__loading" role="status">
                <i class="pi pi-spin pi-spinner" aria-hidden="true" />
                {{ t('app.reservationsLoading') }}
              </p>
              <LoadErrorRetry
                v-else-if="spaceReservationsLoadError"
                compact
                :message="t('app.reservationsLoadError')"
                @retry="loadSpaceReservations"
              />

              <div
                class="cal__grid"
                role="group"
                :aria-label="t('socialSpaces.book.monthGridAria', { month: calendarMonthLabel })"
              >
                <button
                  v-for="day in calendarDays"
                  :key="day.key"
                  type="button"
                  class="cal__day"
                  :class="{
                    'is-out': !day.isCurrentMonth,
                    'is-partial': day.status === 'partial',
                    'is-full': day.status === 'full',
                    'is-selected': day.isSelected,
                    'is-focused': day.isFocused,
                    'is-today': day.isToday,
                    'is-past': day.isPast,
                  }"
                  :aria-label="`${formatFriendlyDate(day.key)} · ${dayStatusLabel(day.status)}${day.isToday ? ` · ${t('app.calendarTodayLabel')}` : ''}`"
                  :aria-pressed="day.isSelected"
                  :disabled="day.isPast"
                  @click="selectCalendarDate(day.key)"
                >
                  {{ day.label }}
                </button>
              </div>

              <ul class="cal__legend" role="list">
                <li><span class="cal__swatch cal__swatch--free" aria-hidden="true" />{{ t('socialSpaces.legendFree') }}</li>
                <li><span class="cal__swatch cal__swatch--partial" aria-hidden="true" />{{ t('socialSpaces.legendPartial') }}</li>
                <li><span class="cal__swatch cal__swatch--full" aria-hidden="true" />{{ t('socialSpaces.legendFull') }}</li>
                <li><span class="cal__swatch cal__swatch--today" aria-hidden="true" />{{ t('app.calendarTodayLabel') }}</li>
              </ul>
            </div>
          </section>

          <div class="bk-side">
            <!-- 2. Horario -->
            <section class="bk-step" aria-labelledby="bk-step2-title">
              <h3 id="bk-step2-title" class="bk-step__head">
                <span class="bk-step__num" :class="{ 'is-done': reservationForm.date && isTimeStepDone }" aria-hidden="true">
                  <i v-if="reservationForm.date && isTimeStepDone" class="pi pi-check" />
                  <template v-else>2</template>
                </span>
                {{ t('socialSpaces.book.step2') }}
              </h3>

              <p v-if="!busyHoursDate" class="bk-hint">
                <i class="pi pi-info-circle" aria-hidden="true" />
                {{ t('app.calendarSelectDateHint') }}
              </p>

              <template v-else>
                <p class="bk-date" aria-live="polite">
                  <i class="pi pi-calendar" aria-hidden="true" />
                  <span>
                    <span class="visually-hidden">{{ t('app.selectedDateLabel') }}: </span>{{ busyHoursDateLabel }}
                  </span>
                </p>

                <p v-if="busyHoursDayStatus === 'full'" class="bk-alert" role="alert">
                  <i class="pi pi-ban" aria-hidden="true" />
                  {{ t('socialSpaces.dayFullHint') }}
                </p>

                <div class="bk-busy">
                  <p class="bk-label">{{ t('socialSpaces.book.busyTitle') }}</p>
                  <p v-if="!busyHoursForDate.length" class="slot-pill slot-pill--free">
                    <i class="pi pi-check-circle" aria-hidden="true" />
                    {{ t('app.busyHoursEmptyHappy') }}
                  </p>
                  <ul v-else class="bk-busy__list" role="list">
                    <li
                      v-for="r in busyHoursForDate"
                      :key="r.id"
                      class="slot-pill"
                      :class="{ 'slot-pill--conflict': reservationForm.date && overlapsChosenRange(r) }"
                    >
                      <i class="pi pi-clock" aria-hidden="true" />
                      {{ timeRangeLabel(r.startTime, r.endTime) }}
                    </li>
                  </ul>
                </div>
              </template>

              <div class="bk-times">
                <label class="bk-field" for="reservation-start-time">
                  <span class="bk-label">{{ t('app.reservationStartLabel') }}</span>
                  <input
                    id="reservation-start-time"
                    v-model="reservationForm.startTime"
                    type="time"
                    step="900"
                    class="bk-input"
                    aria-required="true"
                    :disabled="!reservationForm.date"
                    :aria-invalid="chosenRangeConflicts ? 'true' : 'false'"
                    :aria-describedby="chosenRangeConflicts ? 'bk-conflict-hint' : undefined"
                    @input="reservationError = ''"
                  />
                </label>
                <label class="bk-field" for="reservation-end-time">
                  <span class="bk-label">{{ t('app.reservationEndLabel') }}</span>
                  <input
                    id="reservation-end-time"
                    v-model="reservationForm.endTime"
                    type="time"
                    step="900"
                    class="bk-input"
                    aria-required="true"
                    :disabled="!reservationForm.date"
                    :aria-invalid="chosenRangeConflicts ? 'true' : 'false'"
                    :aria-describedby="chosenRangeConflicts ? 'bk-conflict-hint' : undefined"
                    @input="reservationError = ''"
                  />
                </label>
              </div>
              <p v-if="chosenRangeConflicts" id="bk-conflict-hint" class="bk-warn" aria-live="polite">
                <i class="pi pi-exclamation-triangle" aria-hidden="true" />
                {{ t('socialSpaces.book.busyConflictHint') }}
              </p>
              <p v-else-if="bookingSummary" class="bk-summary" aria-live="polite">
                <i class="pi pi-check-circle" aria-hidden="true" />
                {{ bookingSummary }}
              </p>
            </section>

            <!-- 3. Invitados -->
            <section class="bk-step" aria-labelledby="bk-step3-title">
              <h3 id="bk-step3-title" class="bk-step__head">
                <span class="bk-step__num" aria-hidden="true">3</span>
                {{ t('socialSpaces.book.step3') }}
              </h3>
              <p class="bk-hint bk-hint--plain">
                <i class="pi pi-users" aria-hidden="true" />
                <span v-if="selectedSpaceMaxGuests > 0">
                  {{ t('socialSpaces.book.guestsInfo', { n: selectedSpaceMaxGuests }, selectedSpaceMaxGuests) }}
                </span>
                <span v-else>{{ t('socialSpaces.book.guestsNone') }}</span>
              </p>
            </section>

            <div v-if="selectedSpace?.rules" class="bk-rules">
              <p class="bk-label">
                <i class="pi pi-book" aria-hidden="true" />
                {{ t('socialSpaces.rulesLabel') }}
              </p>
              <p class="bk-rules__text">{{ selectedSpace.rules }}</p>
            </div>
          </div>
        </div>

        <p v-if="reservationError" class="bk-error" role="alert">
          <i class="pi pi-times-circle" aria-hidden="true" />
          <span>{{ reservationError }}</span>
        </p>

        <ConfirmActions
          class="bk-actions"
          :cancel-label="t('app.cancelAction')"
          :confirm-label="
            isSubmittingReservation ? t('app.reservingAction') : t('app.confirmReservationAction')
          "
          confirm-type="submit"
          :loading="isSubmittingReservation"
          :cancel-disabled="isSubmittingReservation"
          :stagger="false"
          @cancel="closeReserveModal"
        />
      </form>
    </Dialog>

    <!-- Confirmación -->
    <Dialog
      :visible="Boolean(confirmation)"
      modal
      :header="t('socialSpaces.confirmTitle')"
      class="svc-dialog svc-dialog--confirm"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
      @update:visible="(v) => { if (!v) closeConfirmation() }"
    >
      <div v-if="confirmation" class="ok">
        <span class="ok__icon" aria-hidden="true"><i class="pi pi-check" /></span>
        <p class="ok__lead">{{ t('socialSpaces.book.confirmLead') }}</p>
        <dl class="ok__details" aria-live="polite">
          <div>
            <dt>{{ t('socialSpaces.book.detailSpace') }}</dt>
            <dd>{{ confirmation.space }}</dd>
          </div>
          <div>
            <dt>{{ t('socialSpaces.book.detailDate') }}</dt>
            <dd>{{ confirmation.date }}</dd>
          </div>
          <div>
            <dt>{{ t('socialSpaces.book.detailTime') }}</dt>
            <dd>{{ t('socialSpaces.book.timeRange', { start: confirmation.start, end: confirmation.end }) }}</dd>
          </div>
        </dl>
        <p class="ok__hint">
          <i class="pi pi-users" aria-hidden="true" />
          {{ t('socialSpaces.confirmGuestsHint') }}
        </p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('socialSpaces.confirmClose')"
          :confirm-label="t('socialSpaces.confirmGoToGuests')"
          confirm-icon="pi pi-user-plus"
          :stagger="false"
          @cancel="closeConfirmation"
          @confirm="goToGuests"
        />
      </template>
    </Dialog>

    <!-- Cancelar próxima reserva -->
    <Dialog
      :visible="Boolean(cancelTarget)"
      modal
      :header="t('socialSpaces.cancelReservation')"
      class="svc-dialog"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
      :closable="!isCancelling"
      @update:visible="(v) => { if (!v) closeCancelDialog() }"
    >
      <template v-if="cancelTarget">
        <p class="cx__space">
          {{ spaceNameOf(cancelTarget.spaceId) }} ·
          {{ relativeDayLabel(cancelTarget.date) }},
          {{ timeRangeLabel(cancelTarget.startTime, cancelTarget.endTime) }}
        </p>
        <p class="cx__body">{{ t('socialSpaces.cancelConfirm') }}</p>
        <p v-if="cancelError" class="bk-error" role="alert">
          <i class="pi pi-times-circle" aria-hidden="true" />
          <span>{{ cancelError }}</span>
        </p>
      </template>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('socialSpaces.book.keepAction')"
          :confirm-label="t('socialSpaces.book.confirmCancelAction')"
          confirm-variant="danger"
          :loading="isCancelling"
          :stagger="false"
          @cancel="closeCancelDialog"
          @confirm="confirmCancel"
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

.svc {
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

/* ---------- Header ---------- */
.svc-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.svc-head__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ---------- Buttons ---------- */
.svc-btn {
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

.svc-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.svc-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.svc-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.svc-btn:disabled {
  background: #f1f2f4;
  border-color: transparent;
  color: #8a8f98;
  cursor: not-allowed;
}

.svc-btn:focus-visible,
.svc-link:focus-visible,
.cal__nav:focus-visible,
.cal__day:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.svc-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: #1e3a8a;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.svc-notice {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  align-self: flex-start;
  padding: 0.55rem 0.9rem;
  border-radius: 999px;
  background: #e3f4e8;
  color: #166534;
  font-size: 0.82rem;
  font-weight: 600;
}

/* ---------- Next booking ---------- */
.svc-next {
  display: flex;
  align-items: center;
  gap: 1rem 1.15rem;
  flex-wrap: wrap;
  padding: 1.1rem 1.25rem;
  border-radius: 18px;
  background: #e8eefc;
}

.svc-next__icon {
  flex: none;
  width: 3rem;
  height: 3rem;
  border-radius: 14px;
  background: #fff;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.25rem;
}

.svc-next__body {
  flex: 1 1 16rem;
  min-width: 0;
}

.svc-next__eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 650;
  color: #1e3a8a;
}

.svc-next__space {
  margin: 0.1rem 0 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.svc-next__meta {
  margin: 0.35rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  font-size: 0.84rem;
  color: #334155;
}

.svc-next__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.svc-next__meta-item .pi {
  font-size: 0.8rem;
  color: #1e3a8a;
}

.svc-next__more {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  color: #475569;
}

.svc-next__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ---------- Spaces ---------- */
.space-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 1rem;
}

.space-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.space-card:hover {
  border-color: rgba(30, 58, 138, 0.22);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.06);
}

.space-card__media {
  aspect-ratio: 16 / 9;
  width: 100%;
  overflow: hidden;
  background: #f1f2f4;
}

.space-card__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.space-card__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.space-card__placeholder .pi {
  width: 4rem;
  height: 4rem;
  border-radius: 50%;
  background: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.6rem;
}

.tone-blue { background: #e8eefc; color: #1e3a8a; }
.tone-green { background: #e3f4e8; color: #166534; }
.tone-orange { background: #fdeee2; color: #c2410c; }
.tone-amber { background: #fdf3dc; color: #a16207; }

.space-card--maintenance .space-card__media {
  filter: grayscale(0.6);
  opacity: 0.8;
}

.space-card__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 1rem 1.1rem 1.1rem;
}

.space-card__pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.status-pill .pi {
  font-size: 0.7rem;
}

.status-pill--green { background: #e3f4e8; color: #166534; }
.status-pill--orange { background: #fdeee2; color: #c2410c; }
.status-pill--neutral { background: #f1f5f9; color: #334155; }

.space-card__name {
  margin: 0.15rem 0 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.space-card__desc {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.45;
  color: #475569;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.space-card__rules {
  margin: 0;
  display: flex;
  gap: 0.45rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #64748b;
}

.space-card__rules .pi {
  margin-top: 0.15rem;
  font-size: 0.72rem;
}

.space-card__rules > span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-line;
}

.space-card__foot {
  margin-top: auto;
  padding-top: 0.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.space-card__blocked {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.4;
  color: #c2410c;
}

.space-card__cta {
  align-self: stretch;
}

/* ---------- Empty / loading ---------- */
.svc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 2.5rem 1rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  text-align: center;
}

.svc-empty__badge {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: #e8eefc;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
}

.svc-empty__icon {
  color: #1e3a8a;
  font-size: 1.3rem;
}

.svc-empty__text {
  margin: 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

/* ---------- Booking dialog ---------- */
.bk {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.bk-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 1rem 1.5rem;
  align-items: start;
}

.bk-side {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.bk-step {
  min-width: 0;
}

.bk-step__head {
  margin: 0 0 0.65rem;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.92rem;
  font-weight: 650;
  color: #0f172a;
}

.bk-step__num {
  flex: none;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  background: #e8eefc;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 700;
}

.bk-step__num.is-done {
  background: #e3f4e8;
  color: #166534;
}

.bk-step__num .pi {
  font-size: 0.7rem;
}

.bk-label {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.76rem;
  font-weight: 600;
  color: #475569;
}

.bk-hint {
  margin: 0 0 0.75rem;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.65rem 0.8rem;
  border-radius: 12px;
  background: #f5f6f8;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #475569;
}

.bk-hint .pi {
  margin-top: 0.12rem;
  font-size: 0.78rem;
  color: #1e3a8a;
}

.bk-hint--plain {
  margin: 0;
}

.bk-date {
  margin: 0 0 0.7rem;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.82rem;
  font-weight: 650;
}

.bk-alert,
.bk-error {
  margin: 0 0 0.7rem;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #b42318;
  font-size: 0.82rem;
  line-height: 1.4;
}

.bk-error {
  margin: 0;
}

.bk-alert .pi,
.bk-error .pi {
  margin-top: 0.12rem;
  font-size: 0.8rem;
}

.bk-busy {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.85rem;
}

.bk-busy__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.slot-pill {
  margin: 0;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  background: #fdeee2;
  color: #9a3412;
  font-size: 0.8rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.slot-pill .pi {
  font-size: 0.72rem;
}

.slot-pill--free {
  background: #e3f4e8;
  color: #166534;
  font-weight: 550;
  white-space: normal;
}

.slot-pill--conflict {
  background: #fde4e4;
  color: #b42318;
  box-shadow: inset 0 0 0 1px rgba(180, 35, 24, 0.35);
}

.bk-times {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.bk-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.bk-input {
  width: 100%;
  min-height: 2.75rem;
  box-sizing: border-box;
  padding: 0.5rem 0.7rem;
  border: 1px solid #d2d2d7;
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.92rem;
  color: #0f172a;
  color-scheme: light;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.bk-input::-webkit-datetime-edit,
.bk-input::-webkit-datetime-edit-fields-wrapper,
.bk-input::-webkit-datetime-edit-hour-field,
.bk-input::-webkit-datetime-edit-minute-field,
.bk-input::-webkit-datetime-edit-ampm-field,
.bk-input::-webkit-datetime-edit-text {
  color: #0f172a;
  -webkit-text-fill-color: #0f172a;
}

.bk-input::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 0.7;
}

.bk-input:hover:not(:disabled) {
  border-color: rgba(30, 58, 138, 0.4);
}

.bk-input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.15);
}

.bk-input[aria-invalid='true'] {
  border-color: #dc2626;
  background: #fff7f7;
}

.bk-input:disabled {
  background: #f5f6f8;
  cursor: not-allowed;
}

.bk-input:disabled::-webkit-datetime-edit-hour-field,
.bk-input:disabled::-webkit-datetime-edit-minute-field,
.bk-input:disabled::-webkit-datetime-edit-ampm-field,
.bk-input:disabled::-webkit-datetime-edit-text {
  color: #a1a1aa;
  -webkit-text-fill-color: #a1a1aa;
}

.bk-warn,
.bk-summary {
  margin: 0.6rem 0 0;
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  font-size: 0.8rem;
  line-height: 1.4;
}

.bk-warn {
  color: #b42318;
}

.bk-summary {
  color: #166534;
  font-weight: 600;
}

.bk-warn .pi,
.bk-summary .pi {
  margin-top: 0.12rem;
  font-size: 0.78rem;
}

.bk-rules {
  padding: 0.75rem 0.85rem;
  border-radius: 12px;
  background: #fdf3dc;
}

.bk-rules .bk-label {
  color: #854d0e;
}

.bk-rules__text {
  margin: 0.3rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #713f12;
  white-space: pre-line;
}

.bk-actions {
  padding-top: 0.25rem;
}

/* ---------- Calendar ---------- */
.cal {
  padding: 0.75rem 0.8rem 0.85rem;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  background: #fff;
}

.cal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.cal__nav {
  width: 2rem;
  height: 2rem;
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

.cal__nav:hover:not(:disabled) {
  background: #e8eefc;
}

.cal__nav:disabled {
  color: #c7c7cc;
  cursor: not-allowed;
}

.cal__month {
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
}

.cal__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 0.7rem;
  font-weight: 600;
  color: #8a8f98;
  margin-bottom: 0.3rem;
}

.cal__loading {
  margin: 0 0 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: #6e6e73;
}

.cal__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.25rem;
}

.cal__day {
  height: 2.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  background: #fff;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  color: #0f172a;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.cal__day:hover:not(:disabled):not(.is-selected) {
  background: #e8eefc;
  color: #1e3a8a;
}

.cal__day.is-out {
  color: #a1a1aa;
}

.cal__day.is-partial {
  background: #fdeee2;
  color: #9a3412;
}

.cal__day.is-partial:hover:not(:disabled):not(.is-selected) {
  background: #fbdcc4;
  color: #9a3412;
}

.cal__day.is-full {
  background: #fde4e4;
  color: #b42318;
}

.cal__day.is-full:hover:not(:disabled):not(.is-selected) {
  background: #fbcfcf;
  color: #b42318;
}

.cal__day.is-today {
  border-color: #1e3a8a;
  font-weight: 700;
}

.cal__day.is-focused {
  box-shadow: inset 0 0 0 2px #b42318;
}

.cal__day.is-past {
  background: transparent;
  color: #c7c7cc;
  cursor: not-allowed;
}

.cal__day.is-selected {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
  font-weight: 700;
}

.cal__legend {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.9rem;
  font-size: 0.74rem;
  color: #475569;
}

.cal__legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.cal__swatch {
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 4px;
  display: inline-block;
}

.cal__swatch--free {
  background: #fff;
  box-shadow: inset 0 0 0 1px #d2d2d7;
}

.cal__swatch--partial {
  background: #fdeee2;
  box-shadow: inset 0 0 0 1px #f5c39c;
}

.cal__swatch--full {
  background: #fde4e4;
  box-shadow: inset 0 0 0 1px #f3a6a6;
}

.cal__swatch--today {
  background: #fff;
  box-shadow: inset 0 0 0 1.5px #1e3a8a;
}

/* ---------- Confirmation / cancel ---------- */
.ok {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
}

.ok__icon {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
  background: #e3f4e8;
  color: #166534;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
}

.ok__lead {
  margin: 0;
  font-size: 0.86rem;
  color: #475569;
}

.ok__details {
  margin: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0.25rem 0.9rem;
  border-radius: 14px;
  background: #f5f6f8;
  text-align: left;
}

.ok__details > div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.55rem 0;
}

.ok__details > div + div {
  border-top: 1px solid rgba(15, 23, 42, 0.07);
}

.ok__details dt {
  font-size: 0.78rem;
  color: #64748b;
}

.ok__details dd {
  margin: 0;
  font-size: 0.84rem;
  font-weight: 650;
  color: #0f172a;
  text-align: right;
}

.ok__hint {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #475569;
  text-align: left;
}

.ok__hint .pi {
  margin-top: 0.12rem;
  color: #1e3a8a;
  font-size: 0.78rem;
}

.cx__space {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
}

.cx__body {
  margin: 0 0 0.75rem;
  font-size: 0.84rem;
  line-height: 1.45;
  color: #475569;
}

/* ---------- Responsive ---------- */
@media (max-width: 760px) {
  .bk-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .svc-head__actions,
  .svc-head__actions .svc-btn {
    width: 100%;
  }
  .svc-next {
    align-items: flex-start;
    padding: 1rem;
  }
  .svc-next__actions {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .space-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .space-card__media {
    aspect-ratio: 21 / 9;
  }
}

@media (max-width: 420px) {
  .bk-times {
    gap: 0.45rem;
  }
  .cal {
    padding: 0.6rem 0.5rem 0.75rem;
  }
  .cal__grid {
    gap: 0.18rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .svc-btn,
  .space-card,
  .cal__day,
  .bk-input {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.svc-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 92vh;
}

.svc-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.svc-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.svc-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 1.1rem;
}

.svc-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
}

@media (max-width: 480px) {
  .svc-dialog .p-dialog-header {
    padding: 1rem 1rem 0.5rem;
  }
  .svc-dialog .p-dialog-content {
    padding: 0.25rem 0.85rem 1rem;
  }
}
</style>
