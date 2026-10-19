<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { reservationInviteExpiresAtMs } from '@/shared/infrastructure/api/utils.js'
import LocaleSwitch from '@/shared/presentation/components/LocaleSwitch.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

/** The server opens the pass on the booking date, 1 h before the start (NOT_YET_VALID before that). */
const PASS_OPENS_MINUTES_BEFORE_START = 60

const route = useRoute()
const { t, locale } = useI18n()

const loading = ref(true)
const loadError = ref(false)
/** RNF012: the server could not be reached (retryable), as opposed to an invalid / unknown pass. */
const loadUnavailable = ref(false)
const bundle = ref(null)
const nowMs = ref(Date.now())
const qrSrc = ref('')

let tick

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

function formatDateLong(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString(intlLocale.value, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function formatClockFromMs(ms) {
  const d = new Date(ms)
  return d.toLocaleTimeString(intlLocale.value, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatClockTime(timeStr) {
  const [h, mi] = String(timeStr ?? '').split(':').map(Number)
  if (!Number.isFinite(h)) return String(timeStr ?? '')
  const d = new Date(2000, 0, 1, h, mi || 0, 0, 0)
  return d.toLocaleTimeString(intlLocale.value, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return `${first}${last}`.toUpperCase()
}

const expiryMs = computed(() => {
  const b = bundle.value
  if (!b) return null
  return reservationInviteExpiresAtMs(b)
})

const isCancelled = computed(() => bundle.value?.status === 'CANCELLED')

/** Server says the pass only opens on the booking date, 1 h before the start (the QR is still shown). */
const isNotYetValid = computed(() => bundle.value?.status === 'NOT_YET_VALID')

/** Server status (VALID/EXPIRED) plus the live clock so the page flips without reloading. */
const isExpired = computed(() => {
  if (bundle.value?.status === 'EXPIRED') return true
  const exp = expiryMs.value
  if (exp == null) return false
  return nowMs.value >= exp
})

/** 'valid' | 'notYet' | 'expired' | 'cancelled' — drives the big status block. */
const passState = computed(() => {
  if (isCancelled.value) return 'cancelled'
  if (isExpired.value) return 'expired'
  if (isNotYetValid.value) return 'notYet'
  return 'valid'
})

const STATE_META = {
  valid: { icon: 'pi-check-circle', title: 'guestInvite.statusValidTitle' },
  notYet: { icon: 'pi-clock', title: 'socialSpaces.passNotYetValid' },
  expired: { icon: 'pi-times-circle', title: 'guestInvite.statusExpiredTitle' },
  cancelled: { icon: 'pi-ban', title: 'socialSpaces.guestCancelledTitle' },
}

async function loadInvite() {
  const token = String(route.params.token ?? '').trim()
  if (!token) {
    loadError.value = true
    bundle.value = null
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = false
  loadUnavailable.value = false
  bundle.value = null
  try {
    bundle.value = await reservationsApi.getPublicInviteByToken(token)
  } catch (error) {
    loadError.value = true
    loadUnavailable.value =
      error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT' || Number(error?.status) >= 500
    bundle.value = null
  } finally {
    loading.value = false
  }
}

async function refreshQr() {
  const b = bundle.value
  if (!b || loadError.value) {
    qrSrc.value = ''
    return
  }
  const exp = expiryMs.value
  if (isCancelled.value || exp == null || nowMs.value >= exp) {
    qrSrc.value = ''
    return
  }
  const url = typeof window !== 'undefined' ? window.location.href : ''
  if (!url) {
    qrSrc.value = ''
    return
  }
  try {
    qrSrc.value = await QRCode.toDataURL(url, { width: 520, margin: 1, errorCorrectionLevel: 'M' })
  } catch {
    qrSrc.value = ''
  }
}

onMounted(() => {
  tick = setInterval(() => {
    nowMs.value = Date.now()
  }, 4000)
})

watch(
  () => route.params.token,
  () => {
    void loadInvite()
  },
  { immediate: true },
)

watch([bundle, nowMs], () => {
  void refreshQr()
}, { immediate: true })

onUnmounted(() => {
  if (tick) clearInterval(tick)
})

const expiryClockLabel = computed(() => {
  const exp = expiryMs.value
  if (exp == null) return ''
  const sameDay = new Date(exp).toDateString() === new Date(`${bundle.value?.date}T00:00:00`).toDateString()
  return sameDay
    ? formatClockFromMs(exp)
    : new Date(exp).toLocaleString(intlLocale.value, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
})

/** When the pass opens: booking date, 1 h before the start (never before that day). */
const opensLabel = computed(() => {
  const b = bundle.value
  if (!b) return ''
  const [y, m, d] = String(b.date ?? '').split('-').map(Number)
  const [h, mi] = String(b.startTime ?? '').split(':').map(Number)
  if (![y, m, d, h].every(Number.isFinite)) return ''
  const start = new Date(y, m - 1, d, h, mi || 0, 0, 0).getTime()
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const opens = Math.max(dayStart, start - PASS_OPENS_MINUTES_BEFORE_START * 60 * 1000)
  return new Date(opens).toLocaleString(intlLocale.value, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
})

const dateLabel = computed(() => formatDateLong(bundle.value?.date))
const startLabel = computed(() => formatClockTime(bundle.value?.startTime))
const endLabel = computed(() => formatClockTime(bundle.value?.endTime))

const guests = computed(() => (Array.isArray(bundle.value?.guests) ? bundle.value.guests : []))
</script>

<template>
  <div class="invite-page">
    <main class="invite-shell">
      <div class="invite-top">
        <p class="invite-brand">
          <span class="invite-brand__mark" aria-hidden="true"><i class="pi pi-building" /></span>
          {{ t('brand') }}
        </p>
        <LocaleSwitch />
      </div>

      <div class="invite-card">
        <div v-if="loading" class="invite-loading" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          <span>{{ t('guestInvite.loading') }}</span>
        </div>

        <template v-else-if="loadUnavailable">
          <LoadErrorRetry :message="t('common.serviceUnavailable')" :loading="loading" @retry="loadInvite" />
        </template>

        <div v-else-if="loadError || !bundle" class="invite-invalid">
          <span class="invite-invalid__icon" aria-hidden="true"><i class="pi pi-link" /></span>
          <h1 class="invite-invalid__title">{{ t('guestInvite.invalidTitle') }}</h1>
          <p class="invite-invalid__body">{{ t('guestInvite.invalidBody') }}</p>
        </div>

        <template v-else>
          <header class="invite-head">
            <p class="invite-eyebrow">{{ t('guestInvite.eyebrow') }}</p>
            <h1 class="invite-space">{{ bundle.spaceName }}</h1>
            <p v-if="bundle.residentName" class="invite-host">
              <span class="invite-avatar invite-avatar--host" aria-hidden="true">
                {{ initials(bundle.residentName) }}
              </span>
              <span>{{ t('guestInvite.invitedBy', { name: bundle.residentName }) }}</span>
            </p>
          </header>

          <dl class="invite-facts">
            <div class="invite-fact">
              <dt><i class="pi pi-calendar" aria-hidden="true" />{{ t('guestInvite.dateLabel') }}</dt>
              <dd class="invite-fact__date">{{ dateLabel }}</dd>
            </div>
            <div class="invite-fact">
              <dt><i class="pi pi-clock" aria-hidden="true" />{{ t('guestInvite.timeLabel') }}</dt>
              <dd>
                <span class="invite-nowrap">{{ startLabel }}</span> –
                <span class="invite-nowrap">{{ endLabel }}</span>
              </dd>
            </div>
          </dl>

          <section
            class="invite-status"
            :class="`invite-status--${passState}`"
            :role="passState === 'valid' ? 'status' : 'alert'"
          >
            <div class="invite-status__head">
              <span class="invite-status__icon" aria-hidden="true">
                <i class="pi" :class="STATE_META[passState].icon" />
              </span>
              <div class="invite-status__text">
                <h2 class="invite-status__title">{{ t(STATE_META[passState].title) }}</h2>
                <p v-if="passState === 'valid'" class="invite-status__body">
                  {{ t('guestInvite.statusValidBody') }}
                </p>
                <p v-else-if="passState === 'notYet'" class="invite-status__body">
                  <template v-if="opensLabel">
                    <strong class="invite-status__opens">{{ t('guestInvite.opensAt', { when: opensLabel }) }}</strong>
                    {{ t('guestInvite.notYetKeep') }}
                  </template>
                  <template v-else>{{ t('socialSpaces.guestNotYetValidBody') }}</template>
                </p>
                <p v-else-if="passState === 'expired'" class="invite-status__body">
                  {{ t('socialSpaces.guestExpiredBody') }}
                </p>
                <p v-else class="invite-status__body">{{ t('socialSpaces.guestCancelledBody') }}</p>
              </div>
            </div>

            <div v-if="qrSrc && (passState === 'valid' || passState === 'notYet')" class="invite-qr">
              <img class="invite-qr__img" :src="qrSrc" width="260" height="260" :alt="t('guestInvite.qrAlt')" />
              <p class="invite-qr__hint">{{ t('guestInvite.qrHint') }}</p>
            </div>

            <p v-if="passState === 'valid' || passState === 'notYet'" class="invite-status__until">
              <i class="pi pi-stopwatch" aria-hidden="true" />
              {{ t('guestInvite.qrValidUntil', { time: expiryClockLabel }) }}
            </p>
          </section>

          <section v-if="guests.length" class="invite-guests" aria-labelledby="invite-guests-heading">
            <div class="invite-guests__head">
              <h2 id="invite-guests-heading" class="invite-guests__title">
                {{ t('guestInvite.guestListTitle') }}
              </h2>
              <span class="invite-pill invite-pill--neutral">
                {{ t('guestInvite.guestCount', { n: guests.length }, guests.length) }}
              </span>
            </div>
            <ul class="invite-names" role="list">
              <li v-for="g in guests" :key="g.id" class="invite-names__row">
                <span class="invite-avatar" :class="{ 'invite-avatar--in': g.checkedIn }" aria-hidden="true">
                  {{ initials(g.name) }}
                </span>
                <span class="invite-names__name">{{ g.name }}</span>
                <span class="invite-pill" :class="g.checkedIn ? 'invite-pill--in' : 'invite-pill--out'">
                  {{ g.checkedIn ? t('guestInvite.guestEnteredBadge') : t('guestInvite.guestNotEnteredBadge') }}
                </span>
              </li>
            </ul>
          </section>
        </template>
      </div>

      <p class="invite-foot">{{ t('guestInvite.footer') }}</p>
    </main>
  </div>
</template>

<style scoped>
.invite-page {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 1.5rem 1rem 2.5rem;
  background: #f4f6fb;
  box-sizing: border-box;
}

.invite-shell {
  width: 100%;
  max-width: 28rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.invite-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.invite-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: #1e3a8a;
}

.invite-brand__mark {
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #1e3a8a;
  color: #fff;
  font-size: 0.85rem;
}

.invite-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.35rem 1.25rem 1.4rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  box-sizing: border-box;
}

.invite-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 2.5rem 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

/* Invalid / unknown */
.invite-invalid {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 1.5rem 0.5rem;
}

.invite-invalid__icon {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.8rem;
  background: #f1f5f9;
  color: #64748b;
  font-size: 1.25rem;
}

.invite-invalid__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.invite-invalid__body {
  margin: 0.4rem 0 0;
  font-size: 0.88rem;
  line-height: 1.5;
  color: #6e6e73;
}

/* Header */
.invite-head {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.invite-eyebrow {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #64748b;
}

.invite-space {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.55rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.invite-host {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0 0;
  font-size: 0.86rem;
  color: #334155;
}

/* Facts */
.invite-facts {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 0.6rem;
  margin: 0;
}

.invite-fact {
  min-width: 0;
  padding: 0.7rem 0.85rem;
  border-radius: 14px;
  background: #f1f5f9;
}

.invite-fact dt {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: #64748b;
}

.invite-fact dt .pi {
  font-size: 0.72rem;
}

.invite-fact dd {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
  line-height: 1.35;
}

.invite-nowrap {
  white-space: nowrap;
}

.invite-fact__date::first-letter {
  text-transform: uppercase;
}

/* Status */
.invite-status {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem;
  border-radius: 16px;
}

.invite-status--valid { background: #e3f4e8; color: #14532d; }
.invite-status--notYet { background: #fdf3dc; color: #78350f; }
.invite-status--expired { background: #fde4e4; color: #7f1d1d; }
.invite-status--cancelled { background: #f1f5f9; color: #334155; }

.invite-status__head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.invite-status__icon {
  flex-shrink: 0;
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  font-size: 1.15rem;
}

.invite-status--valid .invite-status__icon { color: #15803d; }
.invite-status--notYet .invite-status__icon { color: #b45309; }
.invite-status--expired .invite-status__icon { color: #b42318; }
.invite-status--cancelled .invite-status__icon { color: #64748b; }

.invite-status__text {
  min-width: 0;
}

.invite-status__title {
  margin: 0.1rem 0 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.12rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.3;
}

.invite-status__body {
  margin: 0.3rem 0 0;
  font-size: 0.84rem;
  line-height: 1.5;
}

.invite-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 1rem 0.75rem 0.85rem;
  border-radius: 14px;
  background: #fff;
}

.invite-qr__img {
  display: block;
  width: min(260px, 100%);
  height: auto;
}

.invite-qr__hint {
  margin: 0;
  font-size: 0.76rem;
  color: #64748b;
  text-align: center;
}

.invite-status__opens {
  display: block;
  margin-bottom: 0.2rem;
  font-size: 0.9rem;
}

.invite-status__opens::first-letter {
  text-transform: uppercase;
}

.invite-status__until {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
}

/* Guests */
.invite-guests__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.35rem;
}

.invite-guests__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.invite-names {
  margin: 0;
  padding: 0;
  list-style: none;
}

.invite-names__row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0;
}

.invite-names__row + .invite-names__row {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.invite-names__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.9rem;
  font-weight: 600;
  color: #0f172a;
}

.invite-avatar {
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.72rem;
  font-weight: 700;
}

.invite-avatar--host {
  width: 1.8rem;
  height: 1.8rem;
  font-size: 0.66rem;
}

.invite-avatar--in {
  background: #e3f4e8;
  color: #15803d;
}

.invite-pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
}

.invite-pill--in { background: #e3f4e8; color: #15803d; }
.invite-pill--out { background: #fdf3dc; color: #92400e; }
.invite-pill--neutral { background: #f1f5f9; color: #475569; }

.invite-foot {
  margin: 0;
  text-align: center;
  font-size: 0.74rem;
  line-height: 1.45;
  color: #94a3b8;
}

@media (min-width: 720px) {
  .invite-page {
    padding-top: 3rem;
  }

  .invite-card {
    padding: 1.6rem 1.6rem 1.7rem;
  }
}

@media (max-width: 360px) {
  .invite-facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
