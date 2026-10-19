<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { reservationInviteExpiresAtMs } from '@/shared/infrastructure/api/utils.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const { t, locale } = useI18n()

const reservations = ref([])
const spacesById = ref(new Map())
const loading = ref(false)
const loadError = ref(false)
const savingKey = ref('')
const actionError = ref('')

/** Day shown in the schedule (local yyyy-mm-dd) and guest-state filter of that day. */
const selectedDate = ref(ymdOf(new Date()))
const guestFilter = ref('all')

// Concierge QR validation (US027): VALID / NOT_YET_VALID / EXPIRED ("Invitación Expirada") / CANCELLED.
const passInput = ref('')
const passToken = ref('')
const pass = ref(null)
const passLoading = ref(false)
const passError = ref('')
const passSavingKey = ref('')
const passInputEl = ref(null)
const validatorEl = ref(null)

/** Concierge check-in opens on the booking date, 1 h before the start (server rule, mirrored for the pill). */
const CHECK_IN_OPENS_BEFORE_MS = 60 * 60 * 1000

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

function ymdOf(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseYmd(dateStr) {
  const [y, m, d] = String(dateStr ?? '').split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function addDays(dateStr, delta) {
  const d = parseYmd(dateStr) ?? new Date()
  d.setDate(d.getDate() + delta)
  return ymdOf(d)
}

const todayYmd = computed(() => ymdOf(new Date()))
const isToday = computed(() => selectedDate.value === todayYmd.value)

function formatDate(dateStr, opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) {
  const d = parseYmd(dateStr)
  if (!d) return dateStr || ''
  return d.toLocaleDateString(intlLocale.value, opts)
}

function formatDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(intlLocale.value, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(intlLocale.value, { hour: '2-digit', minute: '2-digit' })
}

function relativeDayLabel(dateStr) {
  if (dateStr === todayYmd.value) return t('app.generationAdminToday')
  if (dateStr === addDays(todayYmd.value, 1)) return t('app.generationDayTomorrow')
  if (dateStr === addDays(todayYmd.value, -1)) return t('app.generationDayYesterday')
  return ''
}

const selectedDayLabel = computed(() =>
  formatDate(selectedDate.value, { weekday: 'short', day: 'numeric', month: 'short' }),
)
const selectedDayLong = computed(() =>
  formatDate(selectedDate.value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
)

function shiftDay(delta) {
  selectedDate.value = addDays(selectedDate.value, delta)
}

function goToday() {
  selectedDate.value = todayYmd.value
}

watch(selectedDate, () => {
  guestFilter.value = 'all'
  actionError.value = ''
})

function spaceName(spaceId) {
  return spacesById.value.get(spaceId)?.name ?? t('app.spaceFallbackName')
}

function guestList(r) {
  return Array.isArray(r?.guests) ? r.guests : []
}

function enteredCount(r) {
  return guestList(r).filter((g) => g.checkedIn).length
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

function departmentLabel(r) {
  const code = String(r?.residentCode ?? '').trim()
  return code ? t('dashboard.deptLabel', { code }) : t('dashboard.deptUnknown')
}

/** Guest pass of a reservation is expired once the event ended more than 2 h ago (server value). */
function passExpired(r) {
  const exp = reservationInviteExpiresAtMs(r)
  return exp != null && Date.now() >= exp
}

function reservationStartMs(r) {
  const d = parseYmd(r?.date)
  const [h, mi] = String(r?.startTime ?? '').split(':').map(Number)
  if (!d || !Number.isFinite(h) || !Number.isFinite(mi)) return null
  d.setHours(h, mi, 0, 0)
  return d.getTime()
}

/** Pass state of a reservation row: 'expired' | 'upcoming' (not valid yet) | 'active'. */
function rowPassState(r) {
  if (passExpired(r)) return 'expired'
  const start = reservationStartMs(r)
  if (start != null && Date.now() < start - CHECK_IN_OPENS_BEFORE_MS) return 'upcoming'
  return 'active'
}

function rowPassLabel(r) {
  const state = rowPassState(r)
  if (state === 'expired') return t('app.generationPassExpired')
  if (state === 'upcoming') return t('app.generationPassUpcoming')
  return t('app.generationPassActive')
}

function rowPassIcon(r) {
  const state = rowPassState(r)
  if (state === 'expired') return 'pi-ban'
  if (state === 'upcoming') return 'pi-clock'
  return 'pi-check-circle'
}

const sortedReservations = computed(() =>
  reservations.value.slice().sort((a, b) => {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date))
    return String(a.startTime).localeCompare(String(b.startTime))
  }),
)

const dayReservations = computed(() =>
  sortedReservations.value.filter((row) => row.date === selectedDate.value),
)

function isPending(r) {
  return guestList(r).some((g) => !g.checkedIn) && !passExpired(r)
}

const filters = computed(() => {
  const rows = dayReservations.value
  return [
    { id: 'all', label: t('app.generationFilterAll'), count: rows.length },
    {
      id: 'guests',
      label: t('app.generationFilterWithGuests'),
      count: rows.filter((r) => guestList(r).length).length,
    },
    { id: 'pending', label: t('app.generationFilterPending'), count: rows.filter(isPending).length },
  ]
})

const visibleReservations = computed(() => {
  if (guestFilter.value === 'guests') return dayReservations.value.filter((r) => guestList(r).length)
  if (guestFilter.value === 'pending') return dayReservations.value.filter(isPending)
  return dayReservations.value
})

const summary = computed(() => {
  const rows = dayReservations.value
  const expected = rows.reduce((n, r) => n + guestList(r).length, 0)
  const entered = rows.reduce((n, r) => n + enteredCount(r), 0)
  return {
    reservations: rows.length,
    withGuests: rows.filter((r) => guestList(r).length).length,
    expected,
    entered,
    pending: expected - entered,
    expired: rows.filter((r) => guestList(r).length && passExpired(r)).length,
  }
})

/** Next days (from today) that have bookings — quick jump list. */
const upcomingDays = computed(() => {
  const byDate = new Map()
  for (const r of sortedReservations.value) {
    if (String(r.date) < todayYmd.value) continue
    const entry = byDate.get(r.date) ?? { date: r.date, count: 0, guests: 0 }
    entry.count += 1
    entry.guests += guestList(r).length
    byDate.set(r.date, entry)
  }
  return [...byDate.values()].slice(0, 6)
})

const nextBookingDate = computed(
  () => sortedReservations.value.find((r) => String(r.date) > selectedDate.value)?.date ?? '',
)

function checkInRefusalMessage(error) {
  if (error?.code === 'GUEST_PASS_EXPIRED') return t('socialSpaces.checkInRefusedExpired')
  if (error?.code === 'GUEST_PASS_NOT_YET_VALID') return t('socialSpaces.checkInRefusedNotYetValid')
  if (error?.code === 'GUEST_PASS_CANCELLED') return t('socialSpaces.checkInRefusedCancelled')
  return t('socialSpaces.checkInError')
}

/** Accepts a pasted invite URL (…/invite/<token>) or the bare token. */
function extractToken(raw) {
  const value = String(raw ?? '').trim()
  const match = value.match(/\/invite\/([^/?#\s]+)/)
  const token = match ? match[1] : value
  try {
    return decodeURIComponent(token)
  } catch {
    return token
  }
}

async function focusValidator() {
  validatorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  await nextTick()
  passInputEl.value?.focus({ preventScroll: true })
}

async function validatePass() {
  const token = extractToken(passInput.value)
  if (!token || passLoading.value) return
  passLoading.value = true
  passError.value = ''
  pass.value = null
  passToken.value = token
  try {
    pass.value = await reservationsApi.getGuestPass(token)
  } catch {
    passError.value = t('socialSpaces.passNotFound')
  } finally {
    passLoading.value = false
  }
}

function clearPass() {
  passInput.value = ''
  passToken.value = ''
  pass.value = null
  passError.value = ''
  passInputEl.value?.focus()
}

async function onPassCheckIn(guestId, checkedIn = true) {
  if (!passToken.value || passSavingKey.value) return
  passSavingKey.value = guestId || '*'
  passError.value = ''
  try {
    pass.value = await reservationsApi.checkInGuestPass(passToken.value, guestId, checkedIn)
    void load()
  } catch (error) {
    passError.value = checkInRefusalMessage(error)
    if (error?.status === 410 && pass.value) {
      pass.value = { ...pass.value, valid: false, status: error?.payload?.status ?? 'EXPIRED' }
    } else if (error?.code === 'GUEST_PASS_NOT_YET_VALID' && pass.value) {
      pass.value = { ...pass.value, valid: false, status: 'NOT_YET_VALID' }
    }
  } finally {
    passSavingKey.value = ''
  }
}

const passStatusKey = computed(() => {
  const status = String(pass.value?.status || 'EXPIRED').toUpperCase()
  return ['VALID', 'NOT_YET_VALID', 'CANCELLED'].includes(status) ? status : 'EXPIRED'
})

const passStatusLabel = computed(() => {
  const status = passStatusKey.value
  if (status === 'VALID') return t('socialSpaces.passValid')
  if (status === 'CANCELLED') return t('socialSpaces.passCancelled')
  if (status === 'NOT_YET_VALID') return t('socialSpaces.passNotYetValid')
  return t('socialSpaces.passExpired')
})

const passStatusIcon = computed(() => {
  const status = passStatusKey.value
  if (status === 'VALID') return 'pi-check-circle'
  if (status === 'NOT_YET_VALID') return 'pi-clock'
  if (status === 'CANCELLED') return 'pi-times-circle'
  return 'pi-ban'
})

const passStatusHint = computed(() => {
  const status = passStatusKey.value
  if (status === 'VALID') return t('app.generationPassValidHint')
  if (status === 'NOT_YET_VALID') return t('app.generationPassNotYetHint')
  return t('app.generationPassClosedHint')
})

/** "Valid until …" / "Expired on …" line from the server's pass expiry. */
const passExpiryLine = computed(() => {
  const status = passStatusKey.value
  const expires = pass.value?.expiresAt ? formatDateTime(pass.value.expiresAt) : ''
  if (!expires || status === 'CANCELLED') return ''
  if (status === 'EXPIRED') return t('app.generationPassExpiredOn', { date: expires })
  return t('app.generationPassUntil', { date: expires })
})

const passSpaceName = computed(() => {
  const res = pass.value?.reservation
  return (
    String(res?.spaceName ?? '').trim() ||
    spacesById.value.get(res?.spaceId)?.name ||
    t('app.spaceFallbackName')
  )
})

const passGuests = computed(() => (Array.isArray(pass.value?.guests) ? pass.value.guests : []))

function viewPassInSchedule() {
  const date = pass.value?.reservation?.date
  if (date) selectedDate.value = date
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const [resList, spaces] = await Promise.all([reservationsApi.listAllForAdmin(), spacesApi.list()])
    reservations.value = resList
    spacesById.value = new Map(spaces.map((s) => [s.id, s]))
  } catch {
    loadError.value = true
    reservations.value = []
  } finally {
    loading.value = false
  }
}

async function onGuestCheckedIn(r, guest, checkedIn) {
  const key = `${r.id}:${guest.id}`
  if (savingKey.value) return
  savingKey.value = key
  actionError.value = ''
  try {
    const updated = await reservationsApi.setGuestCheckedIn(r.id, guest.id, checkedIn)
    const idx = reservations.value.findIndex((x) => x.id === updated.id)
    if (idx !== -1) {
      reservations.value[idx] = updated
    }
  } catch (error) {
    if (
      error?.status === 410 ||
      error?.code === 'GUEST_PASS_EXPIRED' ||
      error?.code === 'GUEST_PASS_NOT_YET_VALID'
    ) {
      actionError.value = checkInRefusalMessage(error)
    }
    await load()
  } finally {
    savingKey.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="app-view gen">
    <header class="gen-head">
      <div class="gen-head__text">
        <h1 class="gen-head__title">{{ t('app.generationAdminPageTitle') }}</h1>
        <p class="gen-head__sub">{{ t('app.generationAdminSubtitle') }}</p>
      </div>
      <div class="gen-head__controls">
        <div class="gen-head__nav">
          <div class="gen-day" role="group" :aria-label="t('app.generationDayGroup')">
            <button
              type="button"
              class="gen-day__step"
              :aria-label="t('app.generationDayPrev')"
              :title="t('app.generationDayPrev')"
              @click="shiftDay(-1)"
            >
              <i class="pi pi-chevron-left" aria-hidden="true" />
            </button>
            <span class="gen-day__label" aria-live="polite" :title="selectedDayLong">
              <i class="pi pi-calendar" aria-hidden="true" />
              <template v-if="relativeDayLabel(selectedDate)">
                <strong>{{ relativeDayLabel(selectedDate) }}</strong>
                <span class="gen-dot">·</span>
              </template>
              <span>{{ selectedDayLabel }}</span>
            </span>
            <button
              type="button"
              class="gen-day__step"
              :aria-label="t('app.generationDayNext')"
              :title="t('app.generationDayNext')"
              @click="shiftDay(1)"
            >
              <i class="pi pi-chevron-right" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="gen-btn"
            :disabled="isToday"
            :aria-label="t('app.generationGoToday')"
            @click="goToday"
          >
            {{ t('app.generationAdminToday') }}
          </button>
          <button
            type="button"
            class="gen-icon-btn"
            :aria-label="t('app.generationRefresh')"
            :title="t('app.generationRefresh')"
            :disabled="loading"
            @click="load"
          >
            <i class="pi" :class="loading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
          </button>
        </div>
        <button type="button" class="gen-btn gen-btn--primary" @click="focusValidator">
          <i class="pi pi-qrcode" aria-hidden="true" />
          {{ t('app.generationValidateCta') }}
        </button>
      </div>
    </header>

    <LoadErrorRetry
      v-if="loadError"
      :message="t('app.generationAdminLoadError')"
      :loading="loading"
      @retry="load"
    />

    <!-- Summary of the selected day -->
    <section class="gen-stats" :aria-label="selectedDayLong" :aria-busy="loading ? 'true' : 'false'">
      <article class="gen-stat gen-stat--blue">
        <div class="gen-stat__head">
          <h2 class="gen-stat__label">{{ t('app.generationStatReservations') }}</h2>
          <span class="gen-stat__icon gen-stat__icon--blue"><i class="pi pi-calendar" aria-hidden="true" /></span>
        </div>
        <p class="gen-stat__value">{{ loading && !reservations.length ? '…' : summary.reservations }}</p>
        <p class="gen-stat__hint">
          {{ t('app.generationStatReservationsHint', { n: summary.withGuests }, summary.withGuests) }}
        </p>
      </article>
      <article class="gen-stat gen-stat--amber">
        <div class="gen-stat__head">
          <h2 class="gen-stat__label">{{ t('app.generationStatExpected') }}</h2>
          <span class="gen-stat__icon gen-stat__icon--amber"><i class="pi pi-users" aria-hidden="true" /></span>
        </div>
        <p class="gen-stat__value">{{ loading && !reservations.length ? '…' : summary.expected }}</p>
        <p class="gen-stat__hint">{{ t('app.generationStatExpectedHint') }}</p>
      </article>
      <article class="gen-stat gen-stat--green">
        <div class="gen-stat__head">
          <h2 class="gen-stat__label">{{ t('app.generationStatEntered') }}</h2>
          <span class="gen-stat__icon gen-stat__icon--green"><i class="pi pi-sign-in" aria-hidden="true" /></span>
        </div>
        <p class="gen-stat__value">
          {{ loading && !reservations.length ? '…' : summary.entered }}
          <small v-if="summary.expected">/ {{ summary.expected }}</small>
        </p>
        <p class="gen-stat__hint">
          {{ t('app.generationStatEnteredHint', { n: summary.pending }, summary.pending) }}
        </p>
      </article>
      <article class="gen-stat gen-stat--red">
        <div class="gen-stat__head">
          <h2 class="gen-stat__label">{{ t('app.generationStatExpired') }}</h2>
          <span class="gen-stat__icon gen-stat__icon--red"><i class="pi pi-ban" aria-hidden="true" /></span>
        </div>
        <p class="gen-stat__value">{{ loading && !reservations.length ? '…' : summary.expired }}</p>
        <p class="gen-stat__hint">{{ t('app.generationStatExpiredHint') }}</p>
      </article>
    </section>

    <div class="gen-layout">
      <!-- Validate invitation (QR) -->
      <section
        ref="validatorEl"
        class="gen-card gen-validator"
        aria-labelledby="gen-validator-title"
      >
        <div class="gen-card__head">
          <span class="gen-card__icon"><i class="pi pi-qrcode" aria-hidden="true" /></span>
          <div class="gen-card__heading">
            <h2 id="gen-validator-title" class="gen-card__title">{{ t('socialSpaces.validatorTitle') }}</h2>
            <p class="gen-card__hint">{{ t('socialSpaces.validatorHint') }}</p>
          </div>
        </div>

        <form class="gen-validator__form" @submit.prevent="validatePass">
          <label class="gen-input">
            <i class="pi pi-link" aria-hidden="true" />
            <input
              ref="passInputEl"
              v-model="passInput"
              type="text"
              class="gen-input__field"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('socialSpaces.validatorPlaceholder')"
              :aria-label="t('socialSpaces.validatorPlaceholder')"
            />
          </label>
          <button type="submit" class="gen-btn gen-btn--primary" :disabled="passLoading || !passInput.trim()">
            <i class="pi" :class="passLoading ? 'pi-spin pi-spinner' : 'pi-search'" aria-hidden="true" />
            {{ t('socialSpaces.validatorAction') }}
          </button>
        </form>

        <p v-if="passError" class="gen-alert" role="alert">
          <i class="pi pi-exclamation-circle" aria-hidden="true" />
          {{ passError }}
        </p>

        <div aria-live="polite">
          <div v-if="pass" class="gen-result" :class="`gen-result--${passStatusKey.toLowerCase()}`">
            <div class="gen-result__status">
              <span class="gen-result__icon"><i class="pi" :class="passStatusIcon" aria-hidden="true" /></span>
              <div class="gen-result__text">
                <p class="gen-result__label">{{ passStatusLabel }}</p>
                <p class="gen-result__hint">{{ passStatusHint }}</p>
                <p v-if="passExpiryLine" class="gen-result__expiry">
                  <i class="pi pi-clock" aria-hidden="true" />
                  {{ passExpiryLine }}
                </p>
              </div>
            </div>

            <dl class="gen-result__facts">
              <div>
                <dt>{{ t('app.generationAdminSpace') }}</dt>
                <dd>{{ passSpaceName }}</dd>
              </div>
              <div>
                <dt>{{ t('app.generationAdminSlot') }}</dt>
                <dd>
                  {{ formatDate(pass.reservation?.date) }} · {{ pass.reservation?.startTime }} –
                  {{ pass.reservation?.endTime }}
                </dd>
              </div>
              <div v-if="pass.reservation?.hostName">
                <dt>{{ t('socialSpaces.validatorHost') }}</dt>
                <dd>{{ pass.reservation.hostName }}</dd>
              </div>
            </dl>

            <ul v-if="passGuests.length" class="gen-guests" role="list">
              <li v-for="g in passGuests" :key="g.id" class="gen-guest">
                <span class="gen-avatar gen-avatar--sm" aria-hidden="true">{{ initials(g.name) }}</span>
                <span class="gen-guest__text">
                  <span class="gen-guest__name">{{ g.name }}</span>
                  <small v-if="g.checkedIn && g.checkedInAt" class="gen-guest__meta">
                    {{ t('app.generationEnteredAt', { time: formatTime(g.checkedInAt) }) }}
                  </small>
                </span>
                <button
                  type="button"
                  class="gen-check"
                  :class="{ 'is-in': g.checkedIn }"
                  :disabled="pass.status !== 'VALID' || passSavingKey === g.id"
                  :aria-pressed="Boolean(g.checkedIn)"
                  :aria-label="t('app.generationGuestEntryAria', { name: g.name })"
                  @click="onPassCheckIn(g.id, !g.checkedIn)"
                >
                  <i
                    class="pi"
                    :class="passSavingKey === g.id ? 'pi-spin pi-spinner' : g.checkedIn ? 'pi-check-circle' : 'pi-sign-in'"
                    aria-hidden="true"
                  />
                  {{ g.checkedIn ? t('app.generationAdminEntered') : t('app.generationMarkEntry') }}
                </button>
              </li>
            </ul>
            <p v-else class="gen-result__note">{{ t('app.generationPassNoGuests') }}</p>

            <p
              v-if="pass.status === 'VALID' && passGuests.length && passGuests.every((g) => g.checkedIn)"
              class="gen-result__note"
            >
              <i class="pi pi-check" aria-hidden="true" />
              {{ t('app.generationPassAllIn') }}
            </p>

            <div class="gen-result__actions">
              <button type="button" class="gen-btn" @click="clearPass">
                {{ t('app.generationValidatorClear') }}
              </button>
              <button
                v-if="pass.reservation?.date && pass.reservation.date !== selectedDate"
                type="button"
                class="gen-btn"
                @click="viewPassInSchedule"
              >
                <i class="pi pi-calendar" aria-hidden="true" />
                {{ t('app.generationViewInSchedule') }}
              </button>
              <button
                v-if="pass.status === 'VALID' && passGuests.some((g) => !g.checkedIn)"
                type="button"
                class="gen-btn gen-btn--primary"
                :disabled="Boolean(passSavingKey)"
                @click="onPassCheckIn(null, true)"
              >
                <i class="pi" :class="passSavingKey === '*' ? 'pi-spin pi-spinner' : 'pi-check'" aria-hidden="true" />
                {{ t('socialSpaces.validatorCheckInAll') }}
              </button>
            </div>
          </div>
          <div v-else-if="!passError" class="gen-idle">
            <i class="pi pi-shield" aria-hidden="true" />
            <span>{{ t('app.generationValidatorIdle') }}</span>
          </div>
        </div>
      </section>

      <!-- Schedule of the selected day -->
      <section class="gen-card gen-schedule" aria-labelledby="gen-schedule-title">
        <div class="gen-schedule__bar">
          <div class="gen-card__heading">
            <h2 id="gen-schedule-title" class="gen-card__title">{{ t('app.generationTimelineTitle') }}</h2>
            <p class="gen-card__hint">{{ selectedDayLong }}</p>
          </div>
          <div
            v-if="dayReservations.length"
            class="gen-filters"
            role="group"
            :aria-label="t('app.generationFiltersLabel')"
          >
            <button
              v-for="filter in filters"
              :key="filter.id"
              type="button"
              class="gen-filter"
              :class="{ 'is-active': guestFilter === filter.id }"
              :aria-pressed="guestFilter === filter.id ? 'true' : 'false'"
              @click="guestFilter = filter.id"
            >
              {{ filter.label }}
              <span class="gen-filter__count">{{ filter.count }}</span>
            </button>
          </div>
        </div>

        <p v-if="actionError" class="gen-alert gen-alert--box" role="alert">
          <i class="pi pi-exclamation-circle" aria-hidden="true" />
          <span>{{ actionError }}</span>
          <button
            type="button"
            class="gen-alert__close"
            :aria-label="t('app.generationDismiss')"
            @click="actionError = ''"
          >
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </p>

        <p v-if="loading && !reservations.length" class="gen-status" role="status">
          {{ t('app.generationAdminLoading') }}
        </p>

        <div v-else-if="!visibleReservations.length" class="gen-empty">
          <span class="gen-empty__icon"><i class="pi pi-calendar" aria-hidden="true" /></span>
          <p class="gen-empty__text">
            {{
              dayReservations.length
                ? t('app.generationEmptyFilter')
                : reservations.length
                  ? t('app.generationEmptyDay')
                  : t('app.generationAdminEmpty')
            }}
          </p>
          <div class="gen-empty__actions">
            <button v-if="dayReservations.length" type="button" class="gen-btn" @click="guestFilter = 'all'">
              {{ t('app.generationShowAll') }}
            </button>
            <template v-else>
              <button v-if="!isToday" type="button" class="gen-btn" @click="goToday">
                {{ t('app.generationGoToday') }}
              </button>
              <button
                v-if="nextBookingDate"
                type="button"
                class="gen-btn gen-btn--primary"
                @click="selectedDate = nextBookingDate"
              >
                {{ t('app.generationGoNext') }}
                <i class="pi pi-arrow-right" aria-hidden="true" />
              </button>
            </template>
          </div>
        </div>

        <ul v-else class="gen-timeline" role="list">
          <li v-for="r in visibleReservations" :key="r.id" class="gen-res">
            <span class="gen-res__time">
              <strong>{{ r.startTime || '—' }}</strong>
              <small>{{ r.endTime || '' }}</small>
            </span>
            <div class="gen-res__main">
              <div class="gen-res__top">
                <div class="gen-res__info">
                  <h3 class="gen-res__space">{{ spaceName(r.spaceId) }}</h3>
                  <div class="gen-res__resident">
                    <span class="gen-avatar gen-avatar--sm" aria-hidden="true">{{ initials(r.residentName) }}</span>
                    <span>{{ r.residentName || '—' }}</span>
                    <span class="gen-dot" aria-hidden="true">·</span>
                    <span class="gen-res__dept">{{ departmentLabel(r) }}</span>
                  </div>
                </div>
                <div class="gen-res__badges">
                  <span
                    v-if="guestList(r).length"
                    class="gen-pill"
                    :class="`gen-pill--${rowPassState(r)}`"
                  >
                    <i class="pi" :class="rowPassIcon(r)" aria-hidden="true" />
                    {{ rowPassLabel(r) }}
                  </span>
                  <span v-if="guestList(r).length" class="gen-pill gen-pill--soft">
                    {{
                      t('app.generationAdminEnteredSummary', {
                        in: enteredCount(r),
                        total: guestList(r).length,
                      })
                    }}
                  </span>
                </div>
              </div>

              <p v-if="!guestList(r).length" class="gen-res__none">
                <i class="pi pi-user-minus" aria-hidden="true" />
                {{ t('app.generationAdminNoGuests') }}
              </p>
              <ul v-else class="gen-guests" role="list">
                <li v-for="g in guestList(r)" :key="g.id" class="gen-guest">
                  <span class="gen-avatar gen-avatar--sm gen-avatar--soft" aria-hidden="true">{{ initials(g.name) }}</span>
                  <span class="gen-guest__text">
                    <span class="gen-guest__name">{{ g.name }}</span>
                    <small v-if="g.checkedIn && g.checkedInAt" class="gen-guest__meta">
                      {{ t('app.generationEnteredAt', { time: formatTime(g.checkedInAt) }) }}
                    </small>
                  </span>
                  <button
                    type="button"
                    class="gen-check"
                    :class="{ 'is-in': g.checkedIn }"
                    :disabled="savingKey === `${r.id}:${g.id}` || (!g.checkedIn && passExpired(r))"
                    :aria-pressed="Boolean(g.checkedIn)"
                    :aria-label="t('app.generationGuestEntryAria', { name: g.name })"
                    @click="onGuestCheckedIn(r, g, !g.checkedIn)"
                  >
                    <i
                      class="pi"
                      :class="
                        savingKey === `${r.id}:${g.id}`
                          ? 'pi-spin pi-spinner'
                          : g.checkedIn
                            ? 'pi-check-circle'
                            : 'pi-sign-in'
                      "
                      aria-hidden="true"
                    />
                    {{ g.checkedIn ? t('app.generationAdminEntered') : t('app.generationMarkEntry') }}
                  </button>
                </li>
              </ul>
            </div>
          </li>
        </ul>
      </section>

      <!-- Upcoming days with bookings -->
      <section class="gen-card gen-upcoming" aria-labelledby="gen-upcoming-title">
        <div class="gen-card__heading">
          <h2 id="gen-upcoming-title" class="gen-card__title">{{ t('app.generationUpcomingTitle') }}</h2>
          <p class="gen-card__hint">{{ t('app.generationUpcomingHint') }}</p>
        </div>
        <ul v-if="upcomingDays.length" class="gen-days" role="list">
          <li v-for="day in upcomingDays" :key="day.date">
            <button
              type="button"
              class="gen-dayrow"
              :class="{ 'is-active': day.date === selectedDate }"
              :aria-pressed="day.date === selectedDate ? 'true' : 'false'"
              @click="selectedDate = day.date"
            >
              <span class="gen-dayrow__date">
                <strong>{{ formatDate(day.date, { day: 'numeric' }) }}</strong>
                <small>{{ formatDate(day.date, { month: 'short' }) }}</small>
              </span>
              <span class="gen-dayrow__text">
                <strong>{{ relativeDayLabel(day.date) || formatDate(day.date, { weekday: 'long' }) }}</strong>
                <small>
                  {{ t('app.generationUpcomingCount', { n: day.count }, day.count) }} ·
                  {{ t('app.generationGuestsCount', { n: day.guests }, day.guests) }}
                </small>
              </span>
              <i class="pi pi-chevron-right" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else class="gen-status">{{ t('app.generationUpcomingEmpty') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.gen {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.gen *,
.gen *::before,
.gen *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.gen-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.gen-head__text {
  min-width: 0;
}

.gen-head__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.gen-head__sub {
  margin: 0.25rem 0 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

.gen-head__controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.gen-head__nav {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.gen-day {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.2rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
}

.gen-day__step,
.gen-icon-btn {
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
  flex-shrink: 0;
}

.gen-icon-btn {
  width: 2.45rem;
  height: 2.45rem;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
  font-size: 0.85rem;
}

.gen-day__step:hover,
.gen-icon-btn:hover:not(:disabled) {
  background: #e8eefc;
}

.gen-icon-btn:disabled {
  cursor: progress;
  opacity: 0.75;
}

.gen-day__label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-width: 11rem;
  padding: 0 0.35rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: #475569;
  white-space: nowrap;
}

.gen-day__label strong {
  font-weight: 650;
  color: #0f172a;
}

.gen-day__label .pi {
  font-size: 0.8rem;
  color: #1e3a8a;
}

.gen-btn {
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

.gen-btn .pi {
  font-size: 0.78rem;
}

.gen-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.gen-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.gen-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.gen-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.gen-btn:focus-visible,
.gen-day__step:focus-visible,
.gen-icon-btn:focus-visible,
.gen-filter:focus-visible,
.gen-check:focus-visible,
.gen-dayrow:focus-visible,
.gen-alert__close:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.gen-status {
  margin: 0;
  padding: 0.5rem 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

.gen-alert {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  font-size: 0.82rem;
  line-height: 1.4;
  color: #b42318;
}

.gen-alert .pi {
  margin-top: 0.15rem;
  font-size: 0.85rem;
}

.gen-alert--box {
  padding: 0.65rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  margin-bottom: 0.85rem;
}

.gen-alert--box span {
  flex: 1;
}

.gen-alert__close {
  flex-shrink: 0;
  width: 1.6rem;
  height: 1.6rem;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #b42318;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gen-alert__close:hover {
  background: #fff;
}

/* ---------- Summary cards ---------- */
.gen-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}

.gen-stat {
  background: var(--stat-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.gen-stat--blue { --stat-bg: #e8eefc; }
.gen-stat--amber { --stat-bg: #fdf3dc; }
.gen-stat--green { --stat-bg: #e3f4e8; }
.gen-stat--red { --stat-bg: #fde4e4; }

.gen-stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}

.gen-stat__label {
  margin: 0;
  color: #475569;
  font-weight: 600;
  font-size: 0.8rem;
}

.gen-stat__icon {
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.85rem;
  background: #fff;
}

.gen-stat__icon--blue { color: #1e3a8a; }
.gen-stat__icon--amber { color: #b45309; }
.gen-stat__icon--green { color: #15803d; }
.gen-stat__icon--red { color: #b42318; }

.gen-stat__value {
  margin: 0 0 0.4rem;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.65rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.gen-stat__value small {
  font-size: 1rem;
  font-weight: 600;
  color: #64748b;
  letter-spacing: 0;
}

.gen-stat__hint {
  margin: auto 0 0;
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
}

/* ---------- Layout ---------- */
.gen-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(19rem, 1fr);
  grid-template-areas:
    'schedule validator'
    'schedule upcoming';
  grid-template-rows: auto 1fr;
  gap: 1rem;
  align-items: start;
}

.gen-validator { grid-area: validator; }
.gen-schedule { grid-area: schedule; }
.gen-upcoming { grid-area: upcoming; }

.gen-card {
  padding: 1.1rem 1.25rem 1.15rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.gen-card__head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 0.9rem;
}

.gen-card__icon {
  width: 2.3rem;
  height: 2.3rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.95rem;
}

.gen-card__heading {
  min-width: 0;
}

.gen-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.gen-card__hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
}

/* ---------- Validator ---------- */
.gen-validator__form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.gen-input {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.45rem;
  padding: 0 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.14);
  background: #fff;
  color: #94a3b8;
  font-size: 0.82rem;
  cursor: text;
}

.gen-input:focus-within {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.15);
}

.gen-input__field {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.86rem;
  color: #0f172a;
}

.gen-input__field::placeholder {
  color: #94a3b8;
}

.gen-idle {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px dashed rgba(15, 23, 42, 0.12);
  font-size: 0.8rem;
  color: #64748b;
}

.gen-idle .pi {
  color: #94a3b8;
}

.gen-result {
  --res-bg: #f1f5f9;
  --res-ink: #334155;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.9rem;
  border-radius: 16px;
  background: var(--res-bg);
}

.gen-result--valid { --res-bg: #e3f4e8; --res-ink: #15803d; }
.gen-result--not_yet_valid { --res-bg: #fdf3dc; --res-ink: #b45309; }
.gen-result--expired { --res-bg: #fde4e4; --res-ink: #b42318; }
.gen-result--cancelled { --res-bg: #eef0f3; --res-ink: #475569; }

.gen-result__status {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
}

.gen-result__icon {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  background: #fff;
  color: var(--res-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 1.05rem;
}

.gen-result__text {
  min-width: 0;
}

.gen-result__label {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--res-ink);
}

.gen-result__hint {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #475569;
}

.gen-result__expiry {
  margin: 0.3rem 0 0;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--res-ink);
}

.gen-result__expiry .pi {
  font-size: 0.72rem;
}

.gen-result__facts {
  margin: 0;
  display: grid;
  gap: 0.45rem;
  padding: 0.7rem 0.8rem;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.7);
}

.gen-result__facts div {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.8rem;
}

.gen-result__facts dt {
  color: #64748b;
  font-weight: 500;
  flex-shrink: 0;
}

.gen-result__facts dd {
  margin: 0;
  color: #0f172a;
  font-weight: 600;
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}

.gen-result__note {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: #475569;
}

.gen-result__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
}

.gen-result .gen-guests {
  background: #fff;
}

/* ---------- Schedule ---------- */
.gen-schedule__bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.gen-filters {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.gen-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.45rem 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.gen-filter:hover:not(.is-active) {
  background: #f1f5f9;
}

.gen-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.gen-filter.is-active {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.gen-filter.is-active .gen-filter__count {
  background: #fff;
  color: #1e3a8a;
}

.gen-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.gen-res {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 0.8rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.05);
}

.gen-res__time {
  flex-shrink: 0;
  min-width: 3.6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 0.45rem;
  border-radius: 10px;
  background: #e8eefc;
  color: #1e3a8a;
  font-variant-numeric: tabular-nums;
}

.gen-res__time strong {
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.gen-res__time small {
  font-size: 0.68rem;
  font-weight: 500;
  opacity: 0.75;
}

.gen-res__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.gen-res__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem 0.75rem;
  flex-wrap: wrap;
}

.gen-res__info {
  min-width: 0;
}

.gen-res__space {
  margin: 0 0 0.3rem;
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: #0f172a;
}

.gen-res__resident {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.2rem 0.4rem;
  font-size: 0.8rem;
  color: #334155;
}

.gen-res__dept {
  color: #64748b;
}

.gen-dot {
  color: #94a3b8;
}

.gen-res__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.gen-res__none {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: #94a3b8;
}

.gen-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.gen-pill .pi {
  font-size: 0.7rem;
}

.gen-pill--active { background: #e3f4e8; color: #15803d; }
.gen-pill--upcoming { background: #fdf3dc; color: #b45309; }
.gen-pill--expired { background: #fde4e4; color: #b42318; }
.gen-pill--soft { background: #fff; color: #334155; border: 1px solid rgba(15, 23, 42, 0.08); }

.gen-avatar {
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.gen-avatar--sm {
  width: 1.65rem;
  height: 1.65rem;
  font-size: 0.62rem;
}

.gen-avatar--soft {
  background: #f1f5f9;
  color: #475569;
}

.gen-guests {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  overflow: hidden;
}

.gen-guest {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.65rem;
}

.gen-guest + .gen-guest {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.gen-guest__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.gen-guest__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.gen-guest__meta {
  font-size: 0.72rem;
  color: #15803d;
}

.gen-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 2rem;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease;
}

.gen-check .pi {
  font-size: 0.75rem;
}

.gen-check:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.gen-check.is-in {
  background: #e3f4e8;
  border-color: transparent;
  color: #15803d;
}

.gen-check.is-in:hover:not(:disabled) {
  background: #d3eedb;
}

.gen-check:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Empty state */
.gen-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 1.75rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.gen-empty__icon {
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  background: #fff;
  color: #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05rem;
}

.gen-empty__text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.gen-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* ---------- Upcoming days ---------- */
.gen-days {
  list-style: none;
  margin: 0.8rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.gen-dayrow {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  background: #fff;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: #94a3b8;
}

.gen-dayrow:hover:not(.is-active) {
  background: #f8fafc;
}

.gen-dayrow.is-active {
  border-color: #1e3a8a;
  background: #e8eefc;
}

.gen-dayrow__date {
  flex-shrink: 0;
  width: 2.75rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.3rem 0;
  border-radius: 10px;
  background: #f1f5f9;
  color: #1e3a8a;
  line-height: 1.1;
}

.gen-dayrow.is-active .gen-dayrow__date {
  background: #fff;
}

.gen-dayrow__date strong {
  font-size: 0.95rem;
  font-weight: 700;
}

.gen-dayrow__date small {
  font-size: 0.65rem;
  font-weight: 600;
  color: #64748b;
}

.gen-dayrow__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.gen-dayrow__text strong {
  font-size: 0.84rem;
  font-weight: 650;
  color: #0f172a;
}

.gen-dayrow__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.gen-dayrow .pi {
  font-size: 0.7rem;
}

/* ---------- Responsive ---------- */
@media (max-width: 1180px) {
  .gen-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1000px) {
  .gen-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'validator'
      'schedule'
      'upcoming';
    grid-template-rows: auto;
  }
  .gen-head__controls {
    justify-content: flex-start;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .gen-head__title {
    font-size: 1.35rem;
  }
  .gen-head,
  .gen-head__controls,
  .gen-head__nav {
    width: 100%;
  }
  .gen-day {
    flex: 1;
    min-width: 0;
    justify-content: space-between;
  }
  .gen-day__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gen-head__controls > .gen-btn--primary {
    width: 100%;
    order: -1;
  }
  .gen-stats {
    gap: 0.6rem;
  }
  .gen-stat {
    padding: 0.85rem 0.9rem 0.9rem;
  }
  .gen-stat__value {
    font-size: 1.4rem;
  }
  .gen-card {
    padding: 1rem;
  }
  .gen-validator__form {
    flex-direction: column;
  }
  .gen-validator__form .gen-btn {
    width: 100%;
  }
  .gen-res {
    flex-direction: column;
    gap: 0.6rem;
  }
  .gen-res__time {
    flex-direction: row;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    min-width: 0;
  }
  .gen-res__time small::before {
    content: '– ';
  }
  .gen-res__main {
    width: 100%;
  }
  .gen-result__facts div {
    flex-direction: column;
    gap: 0.1rem;
  }
  .gen-result__facts dd {
    text-align: left;
  }
  .gen-result__actions .gen-btn {
    flex: 1 1 auto;
  }
}

@media (max-width: 420px) {
  .gen-guest {
    flex-wrap: wrap;
  }
  .gen-guest .gen-check {
    margin-left: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gen-btn,
  .gen-check {
    transition: none;
  }
}
</style>
