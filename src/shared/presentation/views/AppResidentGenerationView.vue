<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import Dialog from 'primevue/dialog'
import { useSession } from '@/iam/application/sessionStore.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { buildGuestInviteUrl } from '@/socialSpaces/infrastructure/guestInviteUrl.js'
import { reservationInviteExpiresAtMs } from '@/shared/infrastructure/api/utils.js'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const MAX_GUESTS = 5
/** The server opens the pass on the booking date, 1 h before the start (NOT_YET_VALID before that). */
const PASS_OPENS_MINUTES_BEFORE_START = 60

const { t, locale } = useI18n()
const { state } = useSession()
const profile = computed(() => state.profile ?? {})

const reservations = ref([])
const spacesById = ref(new Map())
const loading = ref(false)
const loadError = ref(false)
const selectedId = ref(null)
const draftGuest = ref('')
const savingGuests = ref(false)
const guestsError = ref('')
const cancellingId = ref(null)
const cancelTarget = ref(null)

const nowMs = ref(Date.now())
const qrByReservationId = ref({})
const copiedReservationId = ref(null)
const rangeFilter = ref('all')

let inviteClock

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

function reservationStartMs(r) {
  const [y, m, d] = String(r.date ?? '').split('-').map(Number)
  const [h, mi] = String(r.startTime ?? '').split(':').map(Number)
  if (![y, m, d, h, mi].every(Number.isFinite)) return null
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime()
}

function reservationEndMs(r) {
  const [y, m, d] = String(r.date ?? '').split('-').map(Number)
  const [h, mi] = String(r.endTime ?? '').split(':').map(Number)
  if (![y, m, d, h, mi].every(Number.isFinite)) return null
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime()
}

const myReservations = computed(() => {
  const id = String(profile.value.id ?? '').trim()
  if (!id) return []
  const rows = reservations.value.filter((r) => String(r.residentId ?? '') === id)
  const now = nowMs.value
  const ended = (r) => {
    const end = reservationEndMs(r)
    return end != null && now >= end
  }
  const key = (r) => `${r.date} ${String(r.startTime)}`
  // Upcoming / in-progress first (soonest first), then past ones (most recent first).
  return rows.slice().sort((a, b) => {
    const ea = ended(a)
    const eb = ended(b)
    if (ea !== eb) return ea ? 1 : -1
    return ea ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b))
  })
})

const todayYmd = computed(() => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
})

const visibleReservations = computed(() => {
  if (rangeFilter.value !== 'today') return myReservations.value
  return myReservations.value.filter((row) => row.date === todayYmd.value)
})

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  { id: 'today', label: t('app.generationAdminToday') },
])

const selected = computed(
  () => myReservations.value.find((row) => String(row.id) === String(selectedId.value)) || null,
)

const selectedGuestCount = computed(() => selected.value?.guests?.length ?? 0)
const selectedEnteredCount = computed(
  () => (selected.value?.guests ?? []).filter((g) => g.checkedIn).length,
)
const guestsFull = computed(() => selectedGuestCount.value >= MAX_GUESTS)

/** Server-issued expiry (end of the event + 2 h, US027); local fallback only for the mock. */
function inviteExpiryMs(r) {
  return reservationInviteExpiresAtMs(r)
}

function inviteLinkExpired(r) {
  const exp = inviteExpiryMs(r)
  if (exp == null) return true
  return nowMs.value >= exp
}

/** Start of the validity window: 1 h before the start, but never before the booking date. */
function passOpensMs(r) {
  const start = reservationStartMs(r)
  if (start == null) return null
  const dayStart = new Date(start)
  dayStart.setHours(0, 0, 0, 0)
  return Math.max(dayStart.getTime(), start - PASS_OPENS_MINUTES_BEFORE_START * 60 * 1000)
}

/** 'active' | 'upcoming' (NOT_YET_VALID window) | 'expired'. */
function passState(r) {
  if (inviteLinkExpired(r)) return 'expired'
  const opens = passOpensMs(r)
  if (opens != null && nowMs.value < opens) return 'upcoming'
  return 'active'
}

const PASS_STATE_META = {
  active: { key: 'resident.guestsPassActive', tone: 'green', icon: 'pi-check-circle' },
  upcoming: { key: 'resident.guestsPassUpcoming', tone: 'amber', icon: 'pi-clock' },
  expired: { key: 'resident.guestsPassExpired', tone: 'red', icon: 'pi-times-circle' },
}

/** 'live' | 'today' | 'upcoming' | 'ended' — label of each reservation in the picker. */
function reservationPhase(r) {
  const start = reservationStartMs(r)
  const end = reservationEndMs(r)
  const now = nowMs.value
  if (end != null && now >= end) return 'ended'
  if (start != null && now >= start) return 'live'
  if (r.date === todayYmd.value) return 'today'
  return 'upcoming'
}

const PHASE_META = {
  live: { key: 'resident.guestsPhaseLive', tone: 'green' },
  today: { key: 'resident.guestsPhaseToday', tone: 'blue' },
  upcoming: { key: 'resident.guestsPhaseUpcoming', tone: 'blue' },
  ended: { key: 'resident.guestsPhaseEnded', tone: 'gray' },
}

function formatDateTimeMs(ms, withDate = true) {
  const opts = withDate
    ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(intlLocale.value, opts).format(new Date(ms))
}

function passWindowLabel(r) {
  const from = passOpensMs(r)
  const to = inviteExpiryMs(r)
  if (from == null || to == null) return ''
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString()
  return t('resident.guestsPassWindow', {
    from: formatDateTimeMs(from),
    to: formatDateTimeMs(to, !sameDay),
  })
}

function formatExpiryClockFromReservation(r) {
  const exp = inviteExpiryMs(r)
  if (exp == null) return ''
  const d = new Date(exp)
  return d.toLocaleString(intlLocale.value, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function whatsAppShareUrl(r) {
  const url = buildGuestInviteUrl(r.guestInviteToken)
  if (!url) return ''
  const text = t('socialSpaces.whatsAppMessage', {
    space: spaceName(r.spaceId),
    date: formatDate(r.date),
    start: r.startTime,
    end: r.endTime,
    url,
  })
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}

function qrDownloadName(r) {
  const slug = String(spaceName(r.spaceId))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${t('resident.guestsQrFileName')}-${slug || 'space'}-${r.date}.png`
}

function canCancel(r) {
  const end = reservationEndMs(r)
  return end != null && nowMs.value < end
}

function openCancel(r) {
  if (cancellingId.value) return
  cancelTarget.value = r
}

function closeCancel() {
  if (cancellingId.value) return
  cancelTarget.value = null
}

const cancelDialogOpen = computed({
  get: () => Boolean(cancelTarget.value),
  set: (open) => {
    if (!open) closeCancel()
  },
})

async function cancelReservation() {
  const r = cancelTarget.value
  if (!r || cancellingId.value) return
  cancellingId.value = r.id
  guestsError.value = ''
  try {
    await reservationsApi.cancel(r.id)
    reservations.value = reservations.value.filter((x) => x.id !== r.id)
    if (String(selectedId.value) === String(r.id)) selectedId.value = null
  } catch {
    guestsError.value = t('socialSpaces.cancelError')
  } finally {
    cancellingId.value = null
    cancelTarget.value = null
  }
}

function spaceName(spaceId) {
  return spacesById.value.get(spaceId)?.name ?? t('app.spaceFallbackName')
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString(intlLocale.value, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatPickerDate(dateStr) {
  const [y, m, d] = String(dateStr ?? '').split('-').map(Number)
  if (!y || !m || !d) return String(dateStr ?? '')
  return new Date(y, m - 1, d).toLocaleDateString(intlLocale.value, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return `${first}${last}`.toUpperCase()
}

function selectReservation(id) {
  if (String(selectedId.value) === String(id)) return
  selectedId.value = id
  draftGuest.value = ''
  guestsError.value = ''
}

// Keep a reservation selected: the first visible one when nothing (or a hidden one) is selected.
watch(
  visibleReservations,
  (rows) => {
    if (!rows.length) return
    if (!rows.some((r) => String(r.id) === String(selectedId.value))) {
      selectedId.value = rows[0].id
      draftGuest.value = ''
    }
  },
  { immediate: true },
)

const detail = computed(() => {
  const r = selected.value
  if (!r) return null
  return visibleReservations.value.some((row) => String(row.id) === String(r.id)) ? r : null
})

async function syncInviteQrs() {
  const next = { ...qrByReservationId.value }
  for (const r of myReservations.value) {
    if (!r.guestInviteToken || !r.guests?.length) {
      delete next[r.id]
      continue
    }
    const exp = inviteExpiryMs(r)
    if (exp == null || nowMs.value >= exp) {
      delete next[r.id]
      continue
    }
    const url = buildGuestInviteUrl(r.guestInviteToken)
    try {
      next[r.id] = await QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
    } catch {
      delete next[r.id]
    }
  }
  qrByReservationId.value = next
}

async function copyInviteLink(r) {
  const url = buildGuestInviteUrl(r.guestInviteToken)
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    copiedReservationId.value = r.id
    window.setTimeout(() => {
      if (copiedReservationId.value === r.id) copiedReservationId.value = null
    }, 2200)
  } catch {
    copiedReservationId.value = null
  }
}

async function persistGuests(nextGuests) {
  const res = selected.value
  if (!res?.id) return
  savingGuests.value = true
  guestsError.value = ''
  try {
    const updated = await reservationsApi.updateGuests(res.id, nextGuests)
    const idx = reservations.value.findIndex((x) => x.id === updated.id)
    if (idx !== -1) {
      reservations.value[idx] = updated
    }
    void syncInviteQrs()
  } catch (error) {
    const messages = {
      RESERVATION_CAPACITY_EXCEEDED: 'socialSpaces.errCapacity',
      RESERVATION_TOO_MANY_GUESTS: 'socialSpaces.errTooManyGuests',
      RESERVATION_CANCELLED: 'socialSpaces.errCancelled',
    }
    guestsError.value = t(messages[error?.code] ?? 'resident.generationGuestsSaveError')
  } finally {
    savingGuests.value = false
  }
}

async function addGuest() {
  const name = draftGuest.value.trim()
  const current = Array.isArray(selected.value?.guests) ? selected.value.guests : []
  if (!name || savingGuests.value || current.length >= MAX_GUESTS) return
  draftGuest.value = ''
  await persistGuests([...current, { name }])
}

async function removeGuest(guestId) {
  const current = Array.isArray(selected.value?.guests) ? selected.value.guests : []
  await persistGuests(current.filter((g) => String(g.id) !== String(guestId)))
}

async function load() {
  const rid = String(profile.value.id ?? '').trim()
  if (!rid) {
    reservations.value = []
    return
  }
  loading.value = true
  loadError.value = false
  try {
    const [resList, spaces] = await Promise.all([
      reservationsApi.listByResident(rid),
      spacesApi.list(),
    ])
    reservations.value = resList
    spacesById.value = new Map(spaces.map((s) => [s.id, s]))
    if (selectedId.value && !resList.some((row) => String(row.id) === String(selectedId.value))) {
      selectedId.value = null
    }
  } catch {
    loadError.value = true
    reservations.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void syncInviteQrs()
  inviteClock = window.setInterval(() => {
    nowMs.value = Date.now()
    void syncInviteQrs()
  }, 5000)
})

watch(
  () => profile.value.id,
  (newId, oldId) => {
    if (newId && newId !== oldId) {
      void load()
    }
  },
)

watch(
  () =>
    reservations.value
      .map(
        (r) =>
          `${r.id}:${r.guestInviteToken ?? ''}:${r.guests?.length ?? 0}:${r.date}:${r.startTime}:${(r.guests ?? []).map((g) => `${g.id}:${g.checkedIn ? 1 : 0}`).join(',')}`,
      )
      .join('|'),
  () => {
    void syncInviteQrs()
  },
)

onUnmounted(() => {
  if (inviteClock) window.clearInterval(inviteClock)
})
</script>

<template>
  <div class="app-view gen">
    <header class="gen-head">
      <div class="gen-head__text">
        <h1 class="gen-head__title">{{ t('resident.guestsPageTitle') }}</h1>
        <p class="gen-head__sub">{{ t('resident.guestsPageSubtitle', { max: MAX_GUESTS }) }}</p>
      </div>
      <div class="gen-head__actions">
        <div
          v-if="myReservations.length"
          v-bf-seg
          class="gen-seg"
          role="group"
          :aria-label="t('resident.guestsFilterAria')"
        >
          <button
            v-for="filter in filters"
            :key="filter.id"
            type="button"
            class="gen-seg__btn"
            :class="{ 'is-active': rangeFilter === filter.id }"
            :aria-pressed="rangeFilter === filter.id"
            @click="rangeFilter = filter.id"
          >
            {{ filter.label }}
          </button>
        </div>
        <router-link
          :to="{ name: AppRouteNames.APP_RESIDENT_SERVICES }"
          class="gen-btn gen-btn--primary"
        >
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('resident.guestsNewReservation') }}
        </router-link>
      </div>
    </header>

    <LoadErrorRetry
      v-if="loadError"
      :message="t('resident.generationLoadError')"
      :loading="loading"
      @retry="load"
    />
    <p v-else-if="!profile.id" class="gen-notice gen-notice--error" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      <span>{{ t('app.reservationProfileMissing') }}</span>
    </p>
    <div v-if="guestsError" class="gen-notice gen-notice--error" role="alert">
      <i class="pi pi-times-circle" aria-hidden="true" />
      <span class="gen-notice__text">{{ guestsError }}</span>
      <button
        type="button"
        class="gen-notice__close"
        :aria-label="t('resident.guestsDismiss')"
        @click="guestsError = ''"
      >
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>

    <div v-if="loading && !myReservations.length" class="gen-skeleton" role="status">
      <span class="sr-only">{{ t('resident.generationLoading') }}</span>
      <span v-for="n in 3" :key="n" class="gen-skeleton__item" aria-hidden="true" />
    </div>

    <section
      v-else-if="!visibleReservations.length && !loadError"
      class="gen-card gen-empty"
      role="status"
    >
      <span class="gen-empty__icon" aria-hidden="true"><i class="pi pi-calendar-plus" /></span>
      <h2 class="gen-empty__title">
        {{ myReservations.length ? t('resident.guestsTodayEmptyTitle') : t('resident.guestsEmptyTitle') }}
      </h2>
      <p class="gen-empty__body">
        {{ myReservations.length ? t('resident.guestsTodayEmptyBody') : t('resident.generationEmpty') }}
      </p>
      <div class="gen-empty__actions">
        <button
          v-if="myReservations.length"
          type="button"
          class="gen-btn"
          @click="rangeFilter = 'all'"
        >
          {{ t('resident.guestsShowAll') }}
        </button>
        <router-link
          v-else
          :to="{ name: AppRouteNames.APP_RESIDENT_SERVICES }"
          class="gen-btn gen-btn--primary"
        >
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('resident.guestsNewReservation') }}
        </router-link>
      </div>
    </section>

    <template v-else-if="visibleReservations.length">
      <section class="gen-picker" aria-labelledby="gen-picker-heading">
        <h2 id="gen-picker-heading" class="gen-section-label">{{ t('resident.guestsPickerLabel') }}</h2>
        <ul class="gen-picker__list" role="list">
          <li v-for="r in visibleReservations" :key="r.id" class="gen-picker__item">
            <button
              type="button"
              class="gen-res"
              :class="[
                { 'is-active': String(r.id) === String(selectedId) },
                `gen-res--${reservationPhase(r)}`,
              ]"
              :aria-pressed="String(r.id) === String(selectedId)"
              @click="selectReservation(r.id)"
            >
              <span class="gen-res__icon" aria-hidden="true"><i class="pi pi-calendar" /></span>
              <span class="gen-res__body">
                <span class="gen-res__top">
                  <span class="gen-res__name">{{ spaceName(r.spaceId) }}</span>
                  <span class="gen-pill" :class="`gen-pill--${PHASE_META[reservationPhase(r)].tone}`">
                    {{ t(PHASE_META[reservationPhase(r)].key) }}
                  </span>
                </span>
                <span class="gen-res__meta">
                  {{ formatPickerDate(r.date) }} · {{ r.startTime }} – {{ r.endTime }}
                </span>
                <span class="gen-res__guests">
                  <i class="pi pi-users" aria-hidden="true" />
                  {{ t('resident.guestsCount', { n: r.guests?.length ?? 0 }, r.guests?.length ?? 0) }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <div v-if="detail" class="gen-grid">
        <!-- Lista de invitados -->
        <section class="gen-card gen-guests" aria-labelledby="gen-guests-heading">
          <div class="gen-card__head">
            <div class="gen-card__head-text">
              <h2 id="gen-guests-heading" class="gen-card__title">
                {{ t('resident.generationGuestsSection') }}
              </h2>
              <p class="gen-card__hint">
                {{ spaceName(detail.spaceId) }} · {{ formatDate(detail.date) }} ·
                {{ detail.startTime }} – {{ detail.endTime }}
              </p>
            </div>
            <span
              class="gen-counter"
              :class="{ 'is-full': guestsFull }"
              :aria-label="t('resident.guestsCapacityAria', { n: selectedGuestCount, max: MAX_GUESTS })"
            >
              {{ t('resident.guestsCounter', { n: selectedGuestCount, max: MAX_GUESTS }) }}
            </span>
          </div>

          <div class="gen-meter" aria-hidden="true">
            <span
              v-for="n in MAX_GUESTS"
              :key="n"
              class="gen-meter__seg"
              :class="{ 'is-on': n <= selectedGuestCount }"
            />
          </div>

          <p v-if="selectedGuestCount" class="gen-entered">
            <i class="pi pi-sign-in" aria-hidden="true" />
            {{ t('app.generationAdminEnteredSummary', { in: selectedEnteredCount, total: selectedGuestCount }) }}
          </p>

          <div v-if="!detail.guests?.length" class="gen-guests__empty">
            <span class="gen-guests__empty-icon" aria-hidden="true"><i class="pi pi-user-plus" /></span>
            <p>{{ t('resident.generationGuestsEmpty') }}</p>
          </div>
          <ul v-else class="gen-guest-list" role="list">
            <li v-for="g in detail.guests" :key="g.id" class="gen-guest">
              <span
                class="gen-avatar"
                :class="{ 'gen-avatar--in': g.checkedIn }"
                aria-hidden="true"
              >{{ initials(g.name) }}</span>
              <span class="gen-guest__info">
                <span class="gen-guest__name">{{ g.name }}</span>
                <span class="gen-pill" :class="g.checkedIn ? 'gen-pill--green' : 'gen-pill--amber'">
                  {{
                    g.checkedIn
                      ? t('resident.generationGuestEntered')
                      : t('resident.generationGuestNotEntered')
                  }}
                </span>
              </span>
              <button
                v-if="!g.checkedIn"
                type="button"
                class="gen-icon-btn gen-icon-btn--danger"
                :aria-label="t('resident.guestsRemoveNamed', { name: g.name })"
                :title="t('resident.generationGuestRemove')"
                :disabled="savingGuests"
                @click="removeGuest(g.id)"
              >
                <i class="pi pi-trash" aria-hidden="true" />
              </button>
            </li>
          </ul>

          <form class="gen-add" @submit.prevent="addGuest">
            <label class="sr-only" for="gen-add-input">{{ t('resident.generationGuestPlaceholder') }}</label>
            <div class="gen-add__field">
              <i class="pi pi-user" aria-hidden="true" />
              <input
                id="gen-add-input"
                v-model="draftGuest"
                type="text"
                class="gen-add__input"
                autocomplete="off"
                maxlength="80"
                :placeholder="t('resident.generationGuestPlaceholder')"
                :disabled="savingGuests || guestsFull"
              />
            </div>
            <button
              type="submit"
              class="gen-btn gen-btn--primary"
              :disabled="savingGuests || !draftGuest.trim() || guestsFull"
            >
              <i
                class="pi"
                :class="savingGuests ? 'pi-spin pi-spinner' : 'pi-plus'"
                aria-hidden="true"
              />
              {{ savingGuests ? t('resident.generationSavingGuests') : t('resident.generationAddGuest') }}
            </button>
          </form>
          <p v-if="guestsFull" class="gen-add__hint" role="status">
            <i class="pi pi-info-circle" aria-hidden="true" />
            {{ t('resident.generationGuestsFull') }}
          </p>

          <div v-if="canCancel(detail)" class="gen-guests__foot">
            <button
              type="button"
              class="gen-link-danger"
              :disabled="cancellingId === detail.id"
              @click="openCancel(detail)"
            >
              <i class="pi pi-times-circle" aria-hidden="true" />
              {{ t('socialSpaces.cancelReservation') }}
            </button>
          </div>
        </section>

        <!-- Pase de invitados -->
        <section class="gen-card gen-pass" aria-labelledby="gen-pass-heading">
          <div class="gen-card__head">
            <div class="gen-card__head-text">
              <h2 id="gen-pass-heading" class="gen-card__title">{{ t('resident.guestsPassTitle') }}</h2>
              <p class="gen-card__hint">{{ t('socialSpaces.inviteHelp') }}</p>
            </div>
            <span
              v-if="detail.guestInviteToken && detail.guests?.length"
              class="gen-pill gen-pill--lg"
              :class="`gen-pill--${PASS_STATE_META[passState(detail)].tone}`"
            >
              <i class="pi" :class="PASS_STATE_META[passState(detail)].icon" aria-hidden="true" />
              {{ t(PASS_STATE_META[passState(detail)].key) }}
            </span>
          </div>

          <div v-if="!detail.guestInviteToken || !detail.guests?.length" class="gen-pass__empty">
            <span class="gen-pass__empty-icon" aria-hidden="true"><i class="pi pi-qrcode" /></span>
            <p class="gen-pass__empty-title">{{ t('resident.guestsPassEmptyTitle') }}</p>
            <p class="gen-pass__empty-body">{{ t('resident.guestsPassEmptyBody') }}</p>
          </div>

          <template v-else>
            <div v-if="!inviteLinkExpired(detail)" class="gen-pass__qr">
              <img
                v-if="qrByReservationId[detail.id]"
                :src="qrByReservationId[detail.id]"
                width="240"
                height="240"
                :alt="t('resident.guestsQrAlt')"
                class="gen-pass__qr-img"
              />
              <span v-else class="gen-pass__qr-placeholder" aria-hidden="true">
                <i class="pi pi-spin pi-spinner" />
              </span>
            </div>
            <p v-else class="gen-pass__expired" role="alert">
              <i class="pi pi-times-circle" aria-hidden="true" />
              {{ t('socialSpaces.inviteExpired', { time: formatExpiryClockFromReservation(detail) }) }}
            </p>

            <p class="gen-pass__window" :class="`gen-pass__window--${PASS_STATE_META[passState(detail)].tone}`">
              <i class="pi pi-clock" aria-hidden="true" />
              <span>{{ passWindowLabel(detail) }}</span>
            </p>

            <div class="gen-pass__link">
              <label class="gen-pass__link-label" for="gen-pass-url">{{ t('resident.guestsLinkLabel') }}</label>
              <input
                id="gen-pass-url"
                readonly
                class="gen-pass__url"
                :value="buildGuestInviteUrl(detail.guestInviteToken)"
                @focus="$event.target.select()"
              />
            </div>

            <div class="gen-pass__actions">
              <button
                type="button"
                class="gen-btn"
                :class="{ 'is-done': copiedReservationId === detail.id }"
                @click="copyInviteLink(detail)"
              >
                <i
                  class="pi"
                  :class="copiedReservationId === detail.id ? 'pi-check' : 'pi-copy'"
                  aria-hidden="true"
                />
                <span aria-live="polite">
                  {{
                    copiedReservationId === detail.id
                      ? t('resident.generationInviteCopied')
                      : t('resident.generationInviteCopy')
                  }}
                </span>
              </button>
              <template v-if="!inviteLinkExpired(detail)">
                <a
                  class="gen-btn gen-btn--whatsapp"
                  :href="whatsAppShareUrl(detail)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <i class="pi pi-whatsapp" aria-hidden="true" />
                  {{ t('socialSpaces.shareWhatsApp') }}
                </a>
                <a
                  v-if="qrByReservationId[detail.id]"
                  class="gen-btn"
                  :href="qrByReservationId[detail.id]"
                  :download="qrDownloadName(detail)"
                >
                  <i class="pi pi-download" aria-hidden="true" />
                  {{ t('resident.guestsDownloadQr') }}
                </a>
              </template>
            </div>
          </template>
        </section>
      </div>
    </template>

    <Dialog
      v-model:visible="cancelDialogOpen"
      modal
      :header="t('socialSpaces.cancelReservation')"
      class="gen-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!cancellingId"
    >
      <div v-if="cancelTarget" class="gen-dialog__body">
        <div class="gen-dialog__res">
          <span class="gen-res__icon" aria-hidden="true"><i class="pi pi-calendar" /></span>
          <div>
            <p class="gen-dialog__res-name">{{ spaceName(cancelTarget.spaceId) }}</p>
            <p class="gen-dialog__res-meta">
              {{ formatDate(cancelTarget.date) }} · {{ cancelTarget.startTime }} – {{ cancelTarget.endTime }}
            </p>
          </div>
        </div>
        <p class="gen-dialog__text">{{ t('socialSpaces.cancelConfirm') }}</p>
        <p v-if="cancelTarget.guests?.length" class="gen-dialog__warn">
          <i class="pi pi-exclamation-triangle" aria-hidden="true" />
          {{ t('resident.guestsCancelGuestsWarn', { n: cancelTarget.guests.length }, cancelTarget.guests.length) }}
        </p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('resident.guestsKeepReservation')"
          :confirm-label="t('socialSpaces.cancelReservation')"
          confirm-variant="danger"
          :loading="Boolean(cancellingId)"
          :stagger="false"
          @cancel="closeCancel"
          @confirm="cancelReservation"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 80rem;
  box-sizing: border-box;
}

.gen {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sr-only {
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

.gen-head__actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.gen-seg {
  display: inline-flex;
  gap: 0.15rem;
  padding: 0.2rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
}

.gen-seg__btn {
  padding: 0.42rem 0.95rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.gen-seg__btn:hover:not(.is-active) {
  color: #0f172a;
}

.gen-seg__btn.is-active {
  background: transparent;
  color: #0f172a;
}

/* ---------- Buttons ---------- */
.gen-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
  box-sizing: border-box;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.gen-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
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

.gen-btn--whatsapp {
  background: #15803d;
  border-color: #15803d;
  color: #fff;
}

.gen-btn--whatsapp:hover:not(:disabled) {
  background: #166534;
  border-color: #166534;
}

.gen-btn.is-done {
  background: #e3f4e8;
  border-color: transparent;
  color: #15803d;
}

.gen-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.gen-btn:focus-visible,
.gen-seg__btn:focus-visible,
.gen-res:focus-visible,
.gen-icon-btn:focus-visible,
.gen-link-danger:focus-visible,
.gen-notice__close:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

/* ---------- Notices ---------- */
.gen-notice {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0;
  padding: 0.5rem 0.55rem 0.5rem 0.95rem;
  border-radius: 999px;
  font-size: 0.8rem;
  line-height: 1.35;
}

.gen-notice--error {
  background: #fde4e4;
  color: #7f1d1d;
}

.gen-notice--error > .pi {
  color: #b42318;
}

.gen-notice__text {
  flex: 1;
  min-width: 0;
}

.gen-notice__close {
  flex-shrink: 0;
  width: 1.8rem;
  height: 1.8rem;
  border: none;
  border-radius: 50%;
  background: #fff;
  color: inherit;
  cursor: pointer;
  font-size: 0.7rem;
}

/* ---------- Cards ---------- */
.gen-card {
  padding: 1.2rem 1.25rem 1.2rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
  box-sizing: border-box;
}

.gen-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.gen-card__head-text {
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
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #6e6e73;
}

.gen-section-label {
  margin: 0 0 0.55rem;
  font-size: 0.8rem;
  font-weight: 650;
  color: #475569;
}

/* ---------- Pills ---------- */
.gen-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
  flex-shrink: 0;
}

.gen-pill--lg {
  padding: 0.32rem 0.75rem;
  font-size: 0.76rem;
}

.gen-pill--lg .pi {
  font-size: 0.75rem;
}

.gen-pill--blue { background: #e8eefc; color: #1e3a8a; }
.gen-pill--green { background: #e3f4e8; color: #15803d; }
.gen-pill--amber { background: #fdf3dc; color: #92400e; }
.gen-pill--red { background: #fde4e4; color: #b42318; }
.gen-pill--gray { background: #f1f5f9; color: #64748b; }

/* ---------- Reservation picker ---------- */
.gen-picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.75rem;
}

.gen-picker__item {
  min-width: 0;
}

.gen-res {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 0.95rem;
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  background: #fff;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.gen-res:hover:not(.is-active) {
  border-color: rgba(30, 58, 138, 0.25);
}

.gen-res.is-active {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 1px #1e3a8a;
}

.gen-res__icon {
  flex-shrink: 0;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.95rem;
}

.gen-res--live .gen-res__icon { background: #e3f4e8; color: #15803d; }
.gen-res--ended .gen-res__icon { background: #f1f5f9; color: #64748b; }

.gen-res__body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.gen-res__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.gen-res__name {
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.3;
  font-size: 0.92rem;
  font-weight: 650;
  color: #0f172a;
}

.gen-res__meta {
  font-size: 0.78rem;
  color: #475569;
}

.gen-res__guests {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.74rem;
  color: #6e6e73;
}

.gen-res__guests .pi {
  font-size: 0.72rem;
}

/* ---------- Detail grid ---------- */
.gen-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

/* Guests */
.gen-guests {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.gen-counter {
  flex-shrink: 0;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 700;
  white-space: nowrap;
}

.gen-counter.is-full {
  background: #fdf3dc;
  color: #92400e;
}

.gen-meter {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0.3rem;
}

.gen-meter__seg {
  height: 0.35rem;
  border-radius: 999px;
  background: #eef2f7;
}

.gen-meter__seg.is-on {
  background: #1e3a8a;
}

.gen-entered {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  font-size: 0.78rem;
  color: #475569;
}

.gen-entered .pi {
  font-size: 0.75rem;
  color: #15803d;
}

.gen-guests__empty {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.9rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px dashed rgba(15, 23, 42, 0.12);
}

.gen-guests__empty p {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #475569;
}

.gen-guests__empty-icon {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
}

.gen-guest-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.gen-guest {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.15rem;
}

.gen-guest + .gen-guest {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.gen-avatar {
  flex-shrink: 0;
  width: 2.3rem;
  height: 2.3rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.76rem;
  font-weight: 700;
}

.gen-avatar--in {
  background: #e3f4e8;
  color: #15803d;
}

.gen-guest__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.55rem;
}

.gen-guest__name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.9rem;
  font-weight: 600;
  color: #0f172a;
}

.gen-icon-btn {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border: none;
  border-radius: 50%;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
}

.gen-icon-btn--danger {
  color: #b42318;
}

.gen-icon-btn--danger:hover:not(:disabled) {
  background: #fde4e4;
}

.gen-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.gen-add {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.gen-add__field {
  flex: 1 1 12rem;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.95rem;
  min-height: 2.45rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.14);
  background: #fff;
  box-sizing: border-box;
}

.gen-add__field .pi {
  font-size: 0.8rem;
  color: #94a3b8;
}

.gen-add__field:focus-within {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.gen-add__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.86rem;
  color: #0f172a;
}

.gen-add__input:disabled {
  cursor: not-allowed;
}

.gen-add__hint {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: -0.35rem 0 0;
  font-size: 0.76rem;
  color: #92400e;
}

.gen-guests__foot {
  display: flex;
  justify-content: flex-start;
  padding-top: 0.8rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.gen-link-danger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.7rem;
  margin-left: -0.7rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #b42318;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.gen-link-danger:hover:not(:disabled) {
  background: #fde4e4;
}

.gen-link-danger:disabled {
  opacity: 0.6;
  cursor: progress;
}

/* Pass */
.gen-pass {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.gen-pass__qr {
  display: flex;
  justify-content: center;
  padding: 1rem;
  border-radius: 16px;
  background: #f8fafc;
}

.gen-pass__qr-img {
  display: block;
  width: min(240px, 100%);
  height: auto;
  padding: 0.6rem;
  border-radius: 14px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-sizing: border-box;
}

.gen-pass__qr-placeholder {
  width: 240px;
  max-width: 100%;
  aspect-ratio: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
}

.gen-pass__expired {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.82rem;
  line-height: 1.45;
}

.gen-pass__expired .pi {
  margin-top: 0.15rem;
  color: #b42318;
}

.gen-pass__window {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 12px;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.4;
}

.gen-pass__window .pi {
  margin-top: 0.12rem;
  font-size: 0.78rem;
}

.gen-pass__window--green { background: #e3f4e8; color: #14532d; }
.gen-pass__window--amber { background: #fdf3dc; color: #78350f; }
.gen-pass__window--red { background: #f1f5f9; color: #475569; }

.gen-pass__link {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.gen-pass__link-label {
  font-size: 0.74rem;
  font-weight: 600;
  color: #64748b;
}

.gen-pass__url {
  width: 100%;
  min-width: 0;
  padding: 0.55rem 0.85rem;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #f8fafc;
  font: inherit;
  font-size: 0.76rem;
  color: #334155;
  box-sizing: border-box;
  text-overflow: ellipsis;
}

.gen-pass__url:focus {
  outline: none;
  border-color: #1e3a8a;
}

.gen-pass__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.gen-pass__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 1.75rem 1rem;
  border-radius: 16px;
  background: #f8fafc;
}

.gen-pass__empty-icon {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.65rem;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 1.2rem;
}

.gen-pass__empty-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 650;
  color: #0f172a;
}

.gen-pass__empty-body {
  margin: 0.3rem 0 0;
  max-width: 22rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #6e6e73;
}

/* ---------- Empty / loading ---------- */
.gen-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 2.5rem 1.25rem;
}

.gen-empty__icon {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.75rem;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 1.25rem;
}

.gen-empty__title {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 650;
  color: #0f172a;
}

.gen-empty__body {
  margin: 0.35rem 0 0;
  max-width: 28rem;
  font-size: 0.85rem;
  line-height: 1.5;
  color: #6e6e73;
}

.gen-empty__actions {
  margin-top: 1rem;
}

.gen-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.75rem;
}

.gen-skeleton__item {
  height: 5.25rem;
  border-radius: 18px;
  background: #eef2f7;
  animation: gen-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes gen-pulse {
  from { opacity: 1; }
  to { opacity: 0.55; }
}

@media (prefers-reduced-motion: reduce) {
  .gen-skeleton__item { animation: none; }
}

/* ---------- Dialog body ---------- */
.gen-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.gen-dialog__res {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.8rem;
  border-radius: 14px;
  background: #f1f5f9;
}

.gen-dialog__res-name {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
}

.gen-dialog__res-meta {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: #475569;
}

.gen-dialog__text {
  margin: 0;
  font-size: 0.86rem;
  line-height: 1.5;
  color: #334155;
}

.gen-dialog__warn {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 12px;
  background: #fdf3dc;
  color: #78350f;
  font-size: 0.8rem;
  line-height: 1.4;
}

.gen-dialog__warn .pi {
  margin-top: 0.12rem;
  color: #b45309;
}

/* ---------- Responsive ---------- */
@media (max-width: 960px) {
  .gen-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }

  .gen-head {
    align-items: stretch;
  }

  .gen-head__title {
    font-size: 1.4rem;
  }

  .gen-head__actions {
    justify-content: space-between;
    width: 100%;
  }

  .gen-picker__list {
    grid-template-columns: minmax(0, 1fr);
  }

  .gen-card {
    padding: 1rem;
  }

  .gen-add .gen-btn {
    flex: 1 1 100%;
  }

  .gen-pass__actions .gen-btn {
    flex: 1 1 100%;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.gen-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.gen-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.gen-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.gen-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.gen-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
}
</style>
