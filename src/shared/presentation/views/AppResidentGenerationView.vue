<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { useSession } from '@/iam/application/sessionStore.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { buildGuestInviteUrl } from '@/socialSpaces/infrastructure/guestInviteUrl.js'
import { reservationInviteExpiresAtMs } from '@/shared/infrastructure/api/utils.js'

const MAX_GUESTS = 5

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
const guestsError = ref(false)

const nowMs = ref(Date.now())
const qrByReservationId = ref({})
const copiedReservationId = ref(null)
const rangeFilter = ref('all')

let inviteClock

const myReservations = computed(() => {
  const id = String(profile.value.id ?? '').trim()
  if (!id) return []
  return reservations.value
    .filter((r) => String(r.residentId ?? '') === id)
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date)
      return String(b.startTime).localeCompare(String(a.startTime))
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

function inviteExpiryMs(r) {
  return reservationInviteExpiresAtMs(r.date, r.startTime)
}

function inviteLinkExpired(r) {
  const exp = inviteExpiryMs(r)
  if (exp == null) return true
  return nowMs.value >= exp
}

function formatExpiryClockFromReservation(r) {
  const exp = inviteExpiryMs(r)
  if (exp == null) return ''
  const d = new Date(exp)
  return d.toLocaleTimeString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function spaceName(spaceId) {
  return spacesById.value.get(spaceId)?.name ?? t('app.spaceFallbackName')
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function slotLabel(r) {
  return `${formatDate(r.date)} · ${r.startTime} – ${r.endTime}`
}

function selectReservation(id) {
  selectedId.value = String(selectedId.value) === String(id) ? null : id
  draftGuest.value = ''
  guestsError.value = false
}

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
      next[r.id] = await QRCode.toDataURL(url, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
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
  guestsError.value = false
  try {
    const updated = await reservationsApi.updateGuests(res.id, nextGuests)
    const idx = reservations.value.findIndex((x) => x.id === updated.id)
    if (idx !== -1) {
      reservations.value[idx] = updated
    }
    void syncInviteQrs()
  } catch {
    guestsError.value = true
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
  <div class="app-view gen-page">
    <h1 class="visually-hidden">{{ t('resident.generationTitle') }}</h1>

    <p v-if="loadError" class="gen-alert" role="alert">{{ t('resident.generationLoadError') }}</p>
    <p v-else-if="!profile.id" class="gen-alert" role="alert">
      {{ t('app.reservationProfileMissing') }}
    </p>
    <p v-if="guestsError" class="gen-alert" role="alert">
      {{ t('resident.generationGuestsSaveError') }}
    </p>

    <div
      v-if="myReservations.length"
      class="gen-filters"
      role="group"
      :aria-label="t('resident.generationTitle')"
    >
      <button
        v-for="filter in filters"
        :key="filter.id"
        type="button"
        class="gen-filter"
        :class="{ 'is-active': rangeFilter === filter.id }"
        :aria-pressed="rangeFilter === filter.id"
        @click="rangeFilter = filter.id"
      >
        {{ filter.label }}
      </button>
    </div>

    <p v-if="loading" class="gen-status">{{ t('resident.generationLoading') }}</p>
    <p v-else-if="!visibleReservations.length" class="gen-status">
      {{ t('resident.generationEmpty') }}
    </p>

    <ul v-else class="gen-board" role="list">
      <li v-for="r in visibleReservations" :key="r.id">
        <article
          class="gen-card"
          :class="{ 'is-open': String(r.id) === String(selectedId) }"
        >
          <button type="button" class="gen-card__toggle" @click="selectReservation(r.id)">
            <div class="gen-card__head">
              <div>
                <h2 class="gen-card__title">{{ spaceName(r.spaceId) }}</h2>
                <p class="gen-card__meta">{{ slotLabel(r) }}</p>
              </div>
              <span class="gen-badge">
                {{
                  t('app.generationAdminEnteredSummary', {
                    in: (r.guests || []).filter((g) => g.checkedIn).length,
                    total: (r.guests || []).length,
                  })
                }}
              </span>
            </div>
          </button>

          <div v-if="String(r.id) === String(selectedId)" class="gen-card__body">
            <p v-if="!r.guests?.length" class="gen-empty">
              {{ t('resident.generationGuestsEmpty') }}
            </p>
            <ul v-else class="gen-guests" role="list">
              <li v-for="g in r.guests" :key="g.id" class="gen-guest">
                <div class="gen-guest__info">
                  <span class="gen-guest__name">{{ g.name }}</span>
                  <span
                    class="inc-badge"
                    :class="g.checkedIn ? 'inc-badge--resolved' : 'inc-badge--in-progress'"
                  >
                    {{
                      g.checkedIn
                        ? t('resident.generationGuestEntered')
                        : t('resident.generationGuestNotEntered')
                    }}
                  </span>
                </div>
                <button
                  v-if="!g.checkedIn"
                  type="button"
                  class="gen-guest__remove"
                  :aria-label="t('resident.generationGuestRemove')"
                  :disabled="savingGuests"
                  @click="removeGuest(g.id)"
                >
                  <i class="pi pi-trash" aria-hidden="true" />
                </button>
              </li>
            </ul>

            <div class="gen-add">
              <p v-if="selectedGuestCount >= MAX_GUESTS" class="gen-add__hint">
                {{ t('resident.generationGuestsFull') }}
              </p>
              <div class="gen-add__row">
                <input
                  v-model="draftGuest"
                  type="text"
                  class="gen-add__input"
                  :placeholder="t('resident.generationGuestPlaceholder')"
                  :disabled="savingGuests || selectedGuestCount >= MAX_GUESTS"
                  @keydown.enter.prevent="addGuest"
                />
                <button
                  type="button"
                  class="gen-add__btn"
                  :disabled="savingGuests || !draftGuest.trim() || selectedGuestCount >= MAX_GUESTS"
                  @click="addGuest"
                >
                  {{
                    savingGuests
                      ? t('resident.generationSavingGuests')
                      : t('resident.generationAddGuest')
                  }}
                </button>
              </div>
            </div>

            <div v-if="r.guestInviteToken && r.guests?.length" class="gen-invite">
              <h3 class="gen-invite__title">{{ t('resident.generationInviteTitle') }}</h3>
              <p class="gen-invite__hint">{{ t('resident.generationInviteQrHelp') }}</p>
              <div class="gen-invite__row">
                <input
                  readonly
                  class="gen-invite__url"
                  :value="buildGuestInviteUrl(r.guestInviteToken)"
                />
                <button type="button" class="gen-invite__copy" @click="copyInviteLink(r)">
                  {{
                    copiedReservationId === r.id
                      ? t('resident.generationInviteCopied')
                      : t('resident.generationInviteCopy')
                  }}
                </button>
              </div>
              <template v-if="!inviteLinkExpired(r)">
                <div v-if="qrByReservationId[r.id]" class="gen-invite__qr">
                  <img
                    :src="qrByReservationId[r.id]"
                    width="180"
                    height="180"
                    alt=""
                    class="gen-invite__qr-img"
                  />
                </div>
              </template>
              <p v-else class="gen-invite__expired" role="alert">
                {{
                  t('resident.generationInviteExpired', {
                    time: formatExpiryClockFromReservation(r),
                  })
                }}
              </p>
            </div>
          </div>
        </article>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.gen-page {
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

.gen-alert {
  margin: 0;
  font-size: 0.875rem;
  color: #b42318;
}

.gen-status {
  margin: 0;
  padding: 1.5rem 0.25rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.gen-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  width: fit-content;
  max-width: 100%;
  padding: 0.3rem;
  border-radius: 999px;
  background: #eef0f3;
}

.gen-filter {
  padding: 0.45rem 0.95rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #4b5563;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.gen-filter:hover:not(.is-active) {
  color: #1d1d1f;
}

.gen-filter.is-active {
  background: #fff;
  color: #1d1d1f;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.gen-board {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.gen-card {
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  overflow: hidden;
}

.gen-card.is-open {
  border-color: rgba(0, 113, 227, 0.22);
}

.gen-card__toggle {
  width: 100%;
  border: none;
  background: transparent;
  padding: 1.05rem 1.1rem;
  text-align: left;
  cursor: pointer;
}

.gen-card__toggle:hover {
  background: #fafafa;
}

.gen-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.gen-card__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--apple-text, #1d1d1f);
}

.gen-card__meta {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.gen-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0.22rem 0.6rem;
  border-radius: 980px;
  background: #f2f2f7;
  color: #4b5563;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.gen-card__body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0 1.1rem 1.15rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding-top: 1rem;
}

.gen-empty {
  margin: 0;
  font-size: 0.875rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.gen-guests {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  overflow: hidden;
}

.gen-guest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  background: #fff;
}

.gen-guest + .gen-guest {
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.gen-guest__info {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.gen-guest__name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.inc-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.inc-badge--in-progress {
  background: #fff3e0;
  color: #e65100;
}

.inc-badge--resolved {
  background: #e8f5e9;
  color: #1b7a3d;
}

.gen-guest__remove {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #ff3b30;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gen-guest__remove:hover:not(:disabled) {
  background: rgba(255, 59, 48, 0.08);
}

.gen-guest__remove:disabled {
  opacity: 0.45;
  cursor: default;
}

.gen-add__hint {
  margin: 0 0 0.5rem;
  font-size: 0.78rem;
  color: #6e6e73;
}

.gen-add__row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.gen-add__input {
  flex: 1;
  min-width: 12rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  background: #fff;
  font: inherit;
  font-size: 0.875rem;
  color: #1d1d1f;
}

.gen-add__input:focus {
  outline: none;
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.gen-add__btn {
  border: none;
  border-radius: 8px;
  padding: 0.65rem 1rem;
  background: #0071e3;
  color: #fff;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.gen-add__btn:hover:not(:disabled) {
  background: #0066cc;
}

.gen-add__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.gen-invite {
  padding: 0.95rem 1rem;
  border-radius: 12px;
  background: #f5f5f7;
}

.gen-invite__title {
  margin: 0 0 0.35rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: #1d1d1f;
}

.gen-invite__hint {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #6e6e73;
}

.gen-invite__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.gen-invite__url {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  background: #fff;
  font: inherit;
  font-size: 0.75rem;
  color: #1d1d1f;
}

.gen-invite__copy {
  border: none;
  border-radius: 8px;
  padding: 0.55rem 0.9rem;
  background: #fff;
  color: #1d1d1f;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.gen-invite__copy:hover {
  color: #0071e3;
}

.gen-invite__qr {
  margin-top: 0.85rem;
  text-align: center;
}

.gen-invite__qr-img {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.gen-invite__expired {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #9a3412;
  line-height: 1.4;
}
</style>
