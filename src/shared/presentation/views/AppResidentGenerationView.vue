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
  selectedId.value = id
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
  <div class="app-view app-view--ai">
    <div class="finance-page">
      <p v-if="loadError" class="app-view__subtitle support-session-hint" role="alert">
        {{ t('resident.generationLoadError') }}
      </p>
      <p v-else-if="!profile.id" class="app-view__subtitle support-session-hint" role="alert">
        {{ t('app.reservationProfileMissing') }}
      </p>
      <p v-if="guestsError" class="app-view__subtitle support-session-hint" role="alert">
        {{ t('resident.generationGuestsSaveError') }}
      </p>

      <div class="ai-shell">
        <aside class="ai-sidebar" :aria-label="t('resident.generationTitle')">
          <p class="ai-recents-label">{{ t('resident.generationTitle') }}</p>
          <p v-if="loading" class="ai-empty">{{ t('resident.generationLoading') }}</p>
          <p v-else-if="!myReservations.length" class="ai-empty">{{ t('resident.generationEmpty') }}</p>
          <ul v-else class="ai-recent-list" role="list">
            <li v-for="r in myReservations" :key="r.id">
              <button
                type="button"
                class="ai-recent"
                :class="{ 'is-active': String(r.id) === String(selectedId) }"
                @click="selectReservation(r.id)"
              >
                <span class="ai-recent__title">{{ spaceName(r.spaceId) }}</span>
                <span class="ai-recent__meta">{{ slotLabel(r) }}</span>
              </button>
            </li>
          </ul>
        </aside>

        <section class="ai-main" aria-labelledby="gen-prompt-heading">
          <template v-if="selected">
            <header class="ai-thread-head">
              <h2 id="gen-prompt-heading" class="ai-thread-head__name">
                {{ spaceName(selected.spaceId) }}
              </h2>
              <p class="ai-thread-head__meta">{{ slotLabel(selected) }}</p>
            </header>
            <div class="ai-thread">
              <p v-if="!selected.guests?.length" class="ai-thread__empty">
                {{ t('resident.generationGuestsEmpty') }}
              </p>
              <div
                v-for="g in selected.guests || []"
                :key="g.id"
                class="ai-msg"
                :class="g.checkedIn ? 'ai-msg--user' : 'ai-msg--ai'"
              >
                <div class="ai-msg__row">
                  <span class="ai-msg__who">
                    {{ g.checkedIn ? t('resident.generationGuestEntered') : t('resident.generationGuestNotEntered') }}
                  </span>
                  <button
                    v-if="!g.checkedIn"
                    type="button"
                    class="ai-msg__remove"
                    :aria-label="t('resident.generationGuestRemove')"
                    :disabled="savingGuests"
                    @click="removeGuest(g.id)"
                  >
                    <i class="pi pi-times" aria-hidden="true" />
                  </button>
                </div>
                <p>{{ g.name }}</p>
              </div>

              <div v-if="selected.guestInviteToken && selected.guests?.length" class="gen-invite">
                <p class="ai-msg__who">{{ t('resident.generationInviteTitle') }}</p>
                <p class="gen-invite__hint">{{ t('resident.generationInviteQrHelp') }}</p>
                <div class="gen-invite__row">
                  <input
                    readonly
                    class="gen-invite__url"
                    :value="buildGuestInviteUrl(selected.guestInviteToken)"
                  />
                  <button type="button" class="gen-invite__copy" @click="copyInviteLink(selected)">
                    {{ t('resident.generationInviteCopy') }}
                  </button>
                </div>
                <p v-if="copiedReservationId === selected.id" class="gen-invite__copied" role="status">
                  {{ t('resident.generationInviteCopied') }}
                </p>
                <template v-if="!inviteLinkExpired(selected)">
                  <div v-if="qrByReservationId[selected.id]" class="gen-invite__qr">
                    <img
                      :src="qrByReservationId[selected.id]"
                      width="200"
                      height="200"
                      alt=""
                      class="gen-invite__qr-img"
                    />
                  </div>
                </template>
                <p v-else class="gen-invite__expired" role="alert">
                  {{ t('resident.generationInviteExpired', { time: formatExpiryClockFromReservation(selected) }) }}
                </p>
              </div>
            </div>
            <div class="ai-dock">
              <p v-if="selectedGuestCount >= MAX_GUESTS" class="ai-dock__hint">
                {{ t('resident.generationGuestsFull') }}
              </p>
              <div class="ai-composer">
                <span class="ai-composer__plus" aria-hidden="true">
                  <i class="pi pi-plus" />
                </span>
                <input
                  v-model="draftGuest"
                  type="text"
                  :placeholder="t('resident.generationGuestPlaceholder')"
                  :disabled="savingGuests || selectedGuestCount >= MAX_GUESTS"
                  @keydown.enter.prevent="addGuest"
                />
                <button
                  type="button"
                  class="ai-composer__send"
                  :disabled="savingGuests || !draftGuest.trim() || selectedGuestCount >= MAX_GUESTS"
                  :aria-label="t('resident.generationAddGuest')"
                  @click="addGuest"
                >
                  <i class="pi pi-arrow-up" aria-hidden="true" />
                </button>
              </div>
            </div>
          </template>

          <div v-else class="ai-stage">
            <h2 id="gen-prompt-heading" class="ai-heading">{{ t('resident.generationEmptyHeading') }}</h2>
            <p class="ai-stage__sub">{{ t('resident.generationSelectPrompt') }}</p>
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
}

.app-view__subtitle {
  margin: 0.5rem 0 0;
  max-width: 42rem;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: -0.015em;
  color: var(--apple-text-secondary, #6e6e73);
}

.support-session-hint {
  margin: 0 0 0.75rem;
  color: #b42318;
}

.finance-page {
  margin-top: 0;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.ai-shell {
  display: grid;
  grid-template-columns: 16.75rem minmax(0, 1fr);
  min-height: calc(100vh - 8.5rem);
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.ai-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.9rem 0.75rem 1rem;
  background: var(--apple-bg-secondary, #f5f5f7);
  border-right: 1px solid rgba(0, 0, 0, 0.06);
}

.ai-recents-label {
  margin: 0.35rem 0.35rem 0;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--apple-text-secondary, #86868b);
}

.ai-empty {
  margin: 0.35rem 0.35rem 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.ai-recent {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.12rem;
  text-align: left;
  padding: 0.52rem 0.7rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--apple-text, #1d1d1f);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.ai-recent:hover {
  background: rgba(255, 255, 255, 0.8);
}

.ai-recent.is-active {
  background: #fff;
  color: var(--apple-blue, #1e3a8a);
  font-weight: 600;
}

.ai-recent__title,
.ai-recent__meta {
  display: block;
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-recent__meta {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--apple-text-secondary, #86868b);
}

.ai-recent.is-active .ai-recent__meta {
  color: rgba(30, 58, 138, 0.72);
}

.ai-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.ai-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.5rem 2.25rem;
}

.ai-heading {
  margin: 0 0 0.65rem;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.04em;
  color: var(--apple-text, #1d1d1f);
  text-align: center;
}

.ai-stage__sub {
  margin: 0;
  max-width: 26rem;
  text-align: center;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-thread-head {
  flex-shrink: 0;
  padding: 0.95rem 1.5rem 0.8rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.ai-thread-head__name {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--apple-text, #1d1d1f);
}

.ai-thread-head__meta {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-thread {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  width: min(44rem, 100%);
  margin: 0 auto;
  padding: 1.5rem 1.5rem 0.75rem;
}

.ai-thread__empty {
  margin: 0 auto;
  max-width: 22rem;
  text-align: center;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-msg {
  max-width: 86%;
  padding: 0.8rem 1rem;
  border-radius: 16px;
}

.ai-msg p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-msg__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.ai-msg__who {
  display: block;
  margin-bottom: 0.3rem;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--apple-text-secondary, #86868b);
}

.ai-msg__remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  margin-top: -0.2rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--apple-text-secondary, #86868b);
  cursor: pointer;
}

.ai-msg__remove:hover {
  color: #b42318;
  background: rgba(180, 35, 24, 0.08);
}

.ai-msg--ai {
  align-self: flex-start;
  background: var(--apple-bg-secondary, #f5f5f7);
  color: var(--apple-text, #1d1d1f);
}

.ai-msg--user {
  align-self: flex-end;
  background: rgba(30, 58, 138, 0.1);
  color: var(--apple-blue, #1e3a8a);
}

.ai-dock {
  padding: 0.75rem 1.25rem 1.35rem;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.ai-dock__hint {
  margin: 0 0 0.55rem;
  font-size: 0.78rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-composer {
  width: min(40rem, 100%);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.4rem 0.4rem 0.85rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 980px;
  background: #fff;
  box-shadow: var(--apple-shadow-md, 0 4px 24px rgba(0, 0, 0, 0.06));
}

.ai-composer:focus-within {
  border-color: var(--apple-blue, #1e3a8a);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.16);
}

.ai-composer__plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  color: var(--apple-text-secondary, #86868b);
  font-size: 0.85rem;
}

.ai-composer input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.95rem;
  color: var(--apple-text, #1d1d1f);
}

.ai-composer__send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.35rem;
  height: 2.35rem;
  border: none;
  border-radius: 50%;
  background: var(--apple-blue, #1e3a8a);
  color: #fff;
  cursor: pointer;
}

.ai-composer__send:hover:not(:disabled) {
  background: var(--apple-blue-hover, #172554);
}

.ai-composer__send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.gen-invite {
  align-self: stretch;
  max-width: 86%;
  padding: 0.8rem 1rem 1rem;
  border-radius: 16px;
  background: var(--apple-bg-secondary, #f5f5f7);
}

.gen-invite__hint {
  margin: 0 0 0.65rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.gen-invite__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: stretch;
}

.gen-invite__url {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 10px;
  background: #fff;
  font: inherit;
  font-size: 0.75rem;
  color: var(--apple-text, #1d1d1f);
}

.gen-invite__copy {
  border: none;
  border-radius: 10px;
  padding: 0.45rem 0.8rem;
  background: #fff;
  color: var(--apple-text, #1d1d1f);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.gen-invite__copy:hover {
  color: var(--apple-blue, #1e3a8a);
}

.gen-invite__copied {
  margin: 0.45rem 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #047857;
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

@media (max-width: 860px) {
  .ai-shell {
    grid-template-columns: 1fr;
    min-height: auto;
  }

  .ai-sidebar {
    border-right: none;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  }

  .ai-recent-list {
    max-height: 8rem;
  }

  .ai-stage {
    min-height: 22rem;
  }
}
</style>
