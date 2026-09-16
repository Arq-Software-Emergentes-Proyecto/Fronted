<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'

const { t, locale } = useI18n()
const { state } = useSession()
const profile = computed(() => state.profile ?? {})

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

const calendarMonth = ref(startOfMonth(new Date()))

const isBusyHoursModalOpen = ref(false)
const busyHoursDate = ref('')

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

const busyDateKeys = computed(() => {
  const set = new Set()
  for (const reservation of allSpaceReservations.value) {
    if (reservation?.date) set.add(reservation.date)
  }
  return set
})

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
      isBusy: busyDateKeys.value.has(key),
      isSelected: key === reservationForm.date,
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
  return fmt.format(calendarMonth.value)
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
  return fmt.format(date)
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

const selectedDateLabel = computed(() => formatFriendlyDate(reservationForm.date))
const busyHoursDateLabel = computed(() => formatFriendlyDate(busyHoursDate.value))

const busyHoursForDate = computed(() => {
  if (!busyHoursDate.value) return []
  return allSpaceReservations.value
    .filter((r) => r.date === busyHoursDate.value)
    .slice()
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
})

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

onMounted(loadSpaces)

async function loadSpaceReservations() {
  if (!selectedSpace.value) {
    allSpaceReservations.value = []
    return
  }
  isLoadingSpaceReservations.value = true
  try {
    allSpaceReservations.value = await reservationsApi.listBySpace(
      selectedSpace.value.id,
    )
  } catch {
    allSpaceReservations.value = []
  } finally {
    isLoadingSpaceReservations.value = false
  }
}

function openReserveModal(space) {
  selectedSpace.value = space
  reservationForm.date = ''
  reservationForm.startTime = ''
  reservationForm.endTime = ''
  reservationError.value = ''
  allSpaceReservations.value = []
  calendarMonth.value = startOfMonth(new Date())
  isReserveModalOpen.value = true
  loadSpaceReservations()
}

function closeReserveModal() {
  if (isSubmittingReservation.value) return
  isReserveModalOpen.value = false
  selectedSpace.value = null
  isBusyHoursModalOpen.value = false
}

function selectCalendarDate(dateKey) {
  reservationForm.date = dateKey
  busyHoursDate.value = dateKey
  isBusyHoursModalOpen.value = true
}

function closeBusyHoursModal() {
  isBusyHoursModalOpen.value = false
}

function confirmDateFromBusyModal() {
  isBusyHoursModalOpen.value = false
}

async function onReserveSubmit() {
  if (isSubmittingReservation.value || !selectedSpace.value) return

  if (!profile.value.id) {
    reservationError.value = t('app.reservationProfileMissing')
    return
  }

  reservationError.value = ''
  isSubmittingReservation.value = true
  try {
    await reservationsApi.add({
      spaceId: selectedSpace.value.id,
      residentId: profile.value.id,
      residentName: profile.value.name,
      residentCode: profile.value.code,
      date: reservationForm.date,
      startTime: reservationForm.startTime,
      endTime: reservationForm.endTime,
    })
    isReserveModalOpen.value = false
    selectedSpace.value = null
  } catch (error) {
    if (error?.code === 'RESERVATION_FIELDS_REQUIRED') {
      reservationError.value = t('app.reservationRequired')
      return
    }
    if (error?.code === 'RESERVATION_TIME_INVALID') {
      reservationError.value = t('app.reservationTimeInvalid')
      return
    }
    if (error?.code === 'RESERVATION_OVERLAP') {
      reservationError.value = t('app.reservationOverlap')
      await loadSpaceReservations()
      return
    }
    reservationError.value = t('auth.genericError')
  } finally {
    isSubmittingReservation.value = false
  }
}
</script>

<template>
  <div class="app-view app-view--ai">
    <h1 class="visually-hidden">{{ t('resident.servicesTitle') }}</h1>

    <div class="finance-page">
      <section class="finance-panel" aria-labelledby="services-spaces-heading">
        <h2 id="services-spaces-heading" class="visually-hidden">
          {{ t('resident.servicesTitle') }}
        </h2>

        <p v-if="isLoadingSpaces" class="dash-empty">
          {{ t('app.spacesLoading') }}
        </p>
        <p v-else-if="spacesLoadError" class="dash-empty dash-empty--error">
          {{ spacesLoadError }}
        </p>
        <p v-else-if="!spaces.length" class="dash-empty">
          {{ t('app.emptySpacesResident') }}
        </p>
        <ul v-else class="resident-spaces" role="list">
          <li
            v-for="space in spaces"
            :key="space.id"
            class="resident-space"
            tabindex="0"
            role="button"
            @click="openReserveModal(space)"
            @keyup.enter="openReserveModal(space)"
            @keyup.space.prevent="openReserveModal(space)"
          >
            <div v-if="space.imageUrl" class="resident-space__image-wrapper">
              <img
                :src="space.imageUrl"
                :alt="t('app.spaceImageAlt', { name: space.name })"
                class="resident-space__image"
              />
            </div>
            <div v-else class="resident-space__image-placeholder" aria-hidden="true">
              <i class="pi pi-image" />
            </div>
            <h3 class="resident-space__name">{{ space.name }}</h3>
            <p v-if="space.description" class="resident-space__description">
              {{ space.description }}
            </p>
            <p v-if="space.capacity" class="resident-space__capacity">
              {{ t('app.spaceCapacityLabel') }}: {{ space.capacity }}
            </p>
            <span class="resident-space__cta">{{ t('app.reserveAction') }}</span>
          </li>
        </ul>
      </section>
    </div>

    <div
      v-if="isReserveModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeReserveModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.reserveModalTitle')"
      >
        <h3 class="resident-modal__title">
          {{ t('app.reserveModalTitle') }}
          <span v-if="selectedSpace" class="resident-modal__title-suffix">— {{ selectedSpace.name }}</span>
        </h3>

        <form class="resident-modal__form" @submit.prevent="onReserveSubmit">
          <div class="calendar" aria-label="Calendar">
            <div class="calendar__header">
              <button
                type="button"
                class="calendar__nav-btn"
                :aria-label="t('app.calendarPrevMonth')"
                :title="t('app.calendarPrevMonth')"
                @click="prevMonth"
              >
                <i class="pi pi-chevron-left" aria-hidden="true" />
              </button>
              <span class="calendar__month-label">{{ calendarMonthLabel }}</span>
              <button
                type="button"
                class="calendar__nav-btn"
                :aria-label="t('app.calendarNextMonth')"
                :title="t('app.calendarNextMonth')"
                @click="nextMonth"
              >
                <i class="pi pi-chevron-right" aria-hidden="true" />
              </button>
            </div>

            <div class="calendar__weekdays" aria-hidden="true">
              <span v-for="(label, idx) in weekdayLabels" :key="idx">{{ label }}</span>
            </div>

            <div
              v-if="isLoadingSpaceReservations"
              class="calendar__loading"
              role="status"
            >
              {{ t('app.reservationsLoading') }}
            </div>

            <div class="calendar__grid" role="grid">
              <button
                v-for="day in calendarDays"
                :key="day.key"
                type="button"
                class="calendar__day"
                :class="{
                  'calendar__day--out': !day.isCurrentMonth,
                  'calendar__day--busy': day.isBusy,
                  'calendar__day--selected': day.isSelected,
                  'calendar__day--today': day.isToday,
                  'calendar__day--past': day.isPast,
                }"
                :aria-label="day.key"
                :aria-pressed="day.isSelected"
                @click="selectCalendarDate(day.key)"
              >
                <span class="calendar__day-number">{{ day.label }}</span>
                <span
                  v-if="day.isBusy"
                  class="calendar__day-dot"
                  :title="t('app.calendarBusyLegend')"
                  aria-hidden="true"
                />
              </button>
            </div>

            <div class="calendar__legend">
              <span class="calendar__legend-item">
                <span class="calendar__legend-dot calendar__legend-dot--busy" />
                {{ t('app.calendarBusyLegend') }}
              </span>
              <span class="calendar__legend-item">
                <span class="calendar__legend-dot calendar__legend-dot--today" />
                {{ t('app.calendarTodayLabel') }}
              </span>
            </div>

            <p v-if="!reservationForm.date" class="calendar__hint">
              {{ t('app.calendarSelectDateHint') }}
            </p>
            <p v-else class="calendar__selected">
              <i class="pi pi-check-circle" aria-hidden="true" />
              <span>
                <strong>{{ t('app.selectedDateLabel') }}:</strong>
                {{ selectedDateLabel }}
              </span>
            </p>
          </div>

          <div class="resident-modal__row">
            <label class="resident-modal__field">
              <span class="resident-modal__field-label">
                <i class="pi pi-clock" aria-hidden="true" />
                {{ t('app.reservationStartLabel') }}
              </span>
              <input
                id="reservation-start-time"
                v-model="reservationForm.startTime"
                type="time"
                class="resident-modal__time-input"
                required
              />
              <span
                v-if="reservationForm.startTime"
                class="resident-modal__time-preview"
                aria-live="polite"
              >
                {{ formatTimeDisplay(reservationForm.startTime) }}
              </span>
            </label>
            <label class="resident-modal__field">
              <span class="resident-modal__field-label">
                <i class="pi pi-clock" aria-hidden="true" />
                {{ t('app.reservationEndLabel') }}
              </span>
              <input
                id="reservation-end-time"
                v-model="reservationForm.endTime"
                type="time"
                class="resident-modal__time-input"
                required
              />
              <span
                v-if="reservationForm.endTime"
                class="resident-modal__time-preview"
                aria-live="polite"
              >
                {{ formatTimeDisplay(reservationForm.endTime) }}
              </span>
            </label>
          </div>

          <p v-if="reservationError" class="resident-modal__error">{{ reservationError }}</p>

          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="
              isSubmittingReservation ? t('app.reservingAction') : t('app.confirmReservationAction')
            "
            confirm-type="submit"
            :loading="isSubmittingReservation"
            :cancel-disabled="isSubmittingReservation"
            @cancel="closeReserveModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="isBusyHoursModalOpen"
      class="resident-modal-backdrop resident-modal-backdrop--top bf-modal-backdrop"
      role="presentation"
      @click.self="closeBusyHoursModal"
    >
      <section
        class="resident-modal resident-modal--small bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.busyHoursModalTitle')"
      >
        <h3 class="resident-modal__title">
          <i class="pi pi-calendar-times" aria-hidden="true" />
          {{ t('app.busyHoursModalTitle') }}
        </h3>
        <p class="resident-modal__title-suffix resident-modal__title-suffix--block">
          {{ busyHoursDateLabel }}
        </p>

        <p
          v-if="!busyHoursForDate.length"
          class="resident-modal__day-empty resident-modal__day-empty--happy"
        >
          <i class="pi pi-check-circle" aria-hidden="true" />
          {{ t('app.busyHoursEmptyHappy') }}
        </p>
        <div v-else class="resident-modal__day-chips" role="list">
          <span
            v-for="r in busyHoursForDate"
            :key="r.id"
            class="resident-modal__day-chip"
            role="listitem"
          >
            <i class="pi pi-clock" aria-hidden="true" />
            {{ r.startTime }} – {{ r.endTime }}
          </span>
        </div>

        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.busyHoursContinueAction')"
          align="center"
          @confirm="confirmDateFromBusyModal"
        />
      </section>
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

.dash-empty {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #6e6e73;
}

.dash-empty--error {
  color: #b42318;
}

.resident-spaces {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: 0.75rem;
}

.resident-space {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 14px;
  padding: 0.95rem;
  background: #f5f5f7;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.resident-space:hover,
.resident-space:focus-visible {
  border-color: rgba(0, 113, 227, 0.28);
  background: #fff;
  outline: none;
}

.resident-space__image-wrapper {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  overflow: hidden;
  background: #eeeef0;
  margin-bottom: 0.1rem;
}

.resident-space__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.resident-space__image-placeholder {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #eeeef0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c7c7cc;
  font-size: 1.6rem;
  margin-bottom: 0.1rem;
}

.resident-space__name {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.resident-space__description {
  margin: 0;
  color: #6e6e73;
  font-size: 0.8125rem;
  line-height: 1.4;
}

.resident-space__capacity {
  margin: 0;
  color: #86868b;
  font-size: 0.78rem;
}

.resident-space__cta {
  margin-top: 0.35rem;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  background: #0071e3;
  color: #fff;
  font-weight: 600;
  font-size: 0.8125rem;
}

.resident-space:hover .resident-space__cta {
  background: #0066cc;
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

.resident-modal-backdrop--top {
  background: rgba(0, 0, 0, 0.28);
  z-index: 1100;
}

.resident-modal {
  width: min(100%, 30rem);
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  padding: 1.15rem 1.2rem 1.25rem;
  max-height: 90vh;
  overflow-y: auto;
}

.resident-modal--small {
  width: min(100%, 24rem);
}

.resident-modal__title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1d1d1f;
}

.resident-modal__title-suffix {
  font-weight: 500;
  color: #6e6e73;
  margin-left: 0.25rem;
}

.resident-modal__title-suffix--block {
  display: block;
  margin: 0.15rem 0 0.7rem;
  text-transform: capitalize;
}

.resident-modal__form {
  margin-top: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.resident-modal__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.9rem;
}

.resident-modal__field-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: #1d1d1f;
  font-weight: 500;
  font-size: 0.8125rem;
}

.resident-modal__field-label .pi {
  color: #0071e3;
  font-size: 0.85rem;
}

.resident-modal__field input {
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  padding: 0.55rem 0.65rem;
  font: inherit;
  color: var(--apple-text, #1d1d1f);
  background: #ffffff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.resident-modal__time-input {
  width: 100%;
  min-height: 2.75rem;
  color-scheme: light;
  font-variant-numeric: tabular-nums;
}

.resident-modal__time-input::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 0.75;
}

.resident-modal__time-input::-webkit-datetime-edit,
.resident-modal__time-input::-webkit-datetime-edit-fields-wrapper,
.resident-modal__time-input::-webkit-datetime-edit-hour-field,
.resident-modal__time-input::-webkit-datetime-edit-minute-field,
.resident-modal__time-input::-webkit-datetime-edit-second-field,
.resident-modal__time-input::-webkit-datetime-edit-ampm-field,
.resident-modal__time-input::-webkit-datetime-edit-text {
  color: var(--apple-text, #1d1d1f);
  -webkit-text-fill-color: var(--apple-text, #1d1d1f);
}

.resident-modal__time-preview {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #0071e3;
  font-variant-numeric: tabular-nums;
}

.resident-modal__field input:hover {
  border-color: rgba(0, 113, 227, 0.35);
}

.resident-modal__field input:focus {
  border-color: #0071e3;
  outline: none;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.resident-modal__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.resident-modal__day-empty {
  margin: 0;
  color: #6e6e73;
  font-size: 0.825rem;
}

.resident-modal__day-empty--happy {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: #1b7a3d;
  background: #e8f5e9;
  padding: 0.35rem 0.65rem;
  border-radius: 980px;
  font-weight: 500;
}

.resident-modal__day-empty--happy .pi {
  color: #34c759;
}

.resident-modal__day-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.resident-modal__day-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: #f5f5f7;
  color: #4b5563;
  padding: 0.28rem 0.6rem;
  border-radius: 980px;
  font-size: 0.8125rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.resident-modal__day-chip .pi {
  color: #86868b;
  font-size: 0.78rem;
}

.resident-modal__error {
  margin: 0;
  color: #b42318;
  background: #fff7f7;
  border: 1px solid rgba(180, 35, 24, 0.15);
  padding: 0.4rem 0.6rem;
  border-radius: 8px;
  font-size: 0.825rem;
}

.resident-modal__form .bf-actions {
  margin-top: 0.35rem;
}

.calendar {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  padding: 0.75rem 0.85rem 0.85rem;
  background: #f5f5f7;
}

.calendar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.calendar__nav-btn {
  border: none;
  background: #fff;
  color: #1d1d1f;
  width: 1.85rem;
  height: 1.85rem;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.calendar__nav-btn:hover {
  color: #0071e3;
}

.calendar__month-label {
  font-weight: 600;
  font-size: 0.95rem;
  color: #1d1d1f;
  text-transform: capitalize;
  letter-spacing: -0.01em;
}

.calendar__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #86868b;
  margin-bottom: 0.25rem;
}

.calendar__loading {
  font-size: 0.825rem;
  color: #6e6e73;
  padding: 0.4rem 0;
}

.calendar__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.18rem;
}

.calendar__day {
  position: relative;
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 8px;
  font: inherit;
  font-size: 0.85rem;
  color: #1d1d1f;
  cursor: pointer;
  padding: 0;
}

.calendar__day-number {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.calendar__day:hover {
  background: #fff;
  color: #0071e3;
}

.calendar__day:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.2);
}

.calendar__day--out {
  color: #c7c7cc;
}

.calendar__day--past:not(.calendar__day--selected):not(.calendar__day--today) {
  color: #b0b0b6;
}

.calendar__day--today:not(.calendar__day--selected) {
  border-color: #0071e3;
  color: #0071e3;
  font-weight: 600;
}

.calendar__day--busy:not(.calendar__day--selected) {
  background: #fff3e0;
  color: #e65100;
}

.calendar__day--busy:hover:not(.calendar__day--selected) {
  background: #ffe8cc;
  color: #e65100;
}

.calendar__day--selected {
  background: #0071e3;
  color: #ffffff;
  border-color: #0071e3;
  font-weight: 600;
}

.calendar__day--selected:hover {
  background: #0071e3;
  color: #ffffff;
  border-color: #0071e3;
}

.calendar__day-dot {
  position: absolute;
  bottom: 4px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: #e65100;
}

.calendar__day--selected .calendar__day-dot {
  background: #ffffff;
}

.calendar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-top: 0.6rem;
  font-size: 0.75rem;
  color: #6e6e73;
}

.calendar__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.calendar__legend-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 999px;
  display: inline-block;
}

.calendar__legend-dot--busy {
  background: #e65100;
}

.calendar__legend-dot--today {
  background: transparent;
  border: 1.5px solid #0071e3;
}

.calendar__hint {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: #6e6e73;
}

.calendar__selected {
  margin: 0.6rem 0 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border-radius: 980px;
  background: #e8f5e9;
  color: #1b7a3d;
  font-size: 0.825rem;
  text-transform: capitalize;
}

.calendar__selected .pi {
  color: #34c759;
}
</style>
