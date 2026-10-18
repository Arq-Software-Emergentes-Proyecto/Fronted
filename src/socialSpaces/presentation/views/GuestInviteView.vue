<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { reservationInviteExpiresAtMs } from '@/shared/infrastructure/api/utils.js'
import LocaleSwitch from '@/shared/presentation/components/LocaleSwitch.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

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

function formatDateShort(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatClockFromMs(ms) {
  const d = new Date(ms)
  return d.toLocaleTimeString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatClockTime(timeStr) {
  const [h, mi] = String(timeStr ?? '').split(':').map(Number)
  if (!Number.isFinite(h)) return String(timeStr ?? '')
  const d = new Date(2000, 0, 1, h, mi || 0, 0, 0)
  return d.toLocaleTimeString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

const expiryMs = computed(() => {
  const b = bundle.value
  if (!b) return null
  return reservationInviteExpiresAtMs(b)
})

const isCancelled = computed(() => bundle.value?.status === 'CANCELLED')

/** Server status (VALID/EXPIRED) plus the live clock so the page flips without reloading. */
const isExpired = computed(() => {
  if (bundle.value?.status === 'EXPIRED') return true
  const exp = expiryMs.value
  if (exp == null) return false
  return nowMs.value >= exp
})

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
    qrSrc.value = await QRCode.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
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
    : new Date(exp).toLocaleString(locale.value === 'es' ? 'es-PE' : 'en-US', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
})

const slotSummary = computed(() => {
  const b = bundle.value
  if (!b) return ''
  return t('guestInvite.slotSummary', {
    date: formatDateShort(b.date),
    start: formatClockTime(b.startTime),
    end: formatClockTime(b.endTime),
  })
})
</script>

<template>
  <div class="invite-page">
    <div class="invite-card">
      <div class="invite-top">
        <p class="invite-brand">{{ t('brand') }}</p>
        <LocaleSwitch />
      </div>

      <template v-if="loading">
        <p class="invite-muted">{{ t('guestInvite.loading') }}</p>
      </template>

      <template v-else-if="loadUnavailable">
        <LoadErrorRetry :message="t('common.serviceUnavailable')" :loading="loading" @retry="loadInvite" />
      </template>

      <template v-else-if="loadError || !bundle">
        <h1 class="invite-title">{{ t('guestInvite.invalidTitle') }}</h1>
        <p class="invite-muted">{{ t('guestInvite.invalidBody') }}</p>
      </template>

      <template v-else-if="isCancelled">
        <h1 class="invite-title invite-title--warn">{{ t('socialSpaces.guestCancelledTitle') }}</h1>
        <p class="invite-body">{{ t('socialSpaces.guestCancelledBody') }}</p>
        <p class="invite-muted">{{ slotSummary }}</p>
      </template>

      <template v-else-if="isExpired">
        <h1 class="invite-title invite-title--warn">{{ t('socialSpaces.passExpired') }}</h1>
        <p class="invite-body">{{ t('socialSpaces.guestExpiredBody') }}</p>
        <p class="invite-muted">{{ slotSummary }}</p>
        <ul v-if="bundle.guests?.length" class="invite-names">
          <li v-for="g in bundle.guests" :key="g.id" class="invite-names__row">
            <span>{{ g.name }}</span>
            <span
              class="invite-pill"
              :class="g.checkedIn ? 'invite-pill--in' : 'invite-pill--out'"
            >
              {{ g.checkedIn ? t('guestInvite.guestEnteredBadge') : t('guestInvite.guestNotEnteredBadge') }}
            </span>
          </li>
        </ul>
      </template>

      <template v-else>
        <h1 class="invite-title">{{ t('guestInvite.validTitle') }}</h1>
        <p class="invite-space">{{ bundle.spaceName }}</p>
        <p class="invite-body">{{ slotSummary }}</p>
        <p class="invite-expiry">
          {{ t('guestInvite.qrValidUntil', { time: expiryClockLabel }) }}
        </p>
        <p v-if="bundle.residentName" class="invite-host">
          {{ t('guestInvite.hostLabel') }}: {{ bundle.residentName }}
        </p>

        <p class="invite-section-label">{{ t('guestInvite.guestListTitle') }}</p>
        <ul class="invite-names">
          <li v-for="g in bundle.guests" :key="g.id" class="invite-names__row">
            <span>{{ g.name }}</span>
            <span
              class="invite-pill"
              :class="g.checkedIn ? 'invite-pill--in' : 'invite-pill--out'"
            >
              {{ g.checkedIn ? t('guestInvite.guestEnteredBadge') : t('guestInvite.guestNotEnteredBadge') }}
            </span>
          </li>
        </ul>

        <div v-if="qrSrc" class="invite-qr-wrap">
          <p class="invite-qr-hint">{{ t('guestInvite.qrHint') }}</p>
          <img class="invite-qr" :src="qrSrc" width="260" height="260" alt="" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.invite-page {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2rem 1.25rem 3rem;
  background: linear-gradient(180deg, #f5f5f7 0%, #e8e8ed 100%);
}

.invite-card {
  width: 100%;
  max-width: 26rem;
  padding: 1.5rem 1.35rem 1.75rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
}

.invite-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1rem;
}

.invite-brand {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #86868b;
}

.invite-title {
  margin: 0 0 0.5rem;
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: #1d1d1f;
}

.invite-title--warn {
  color: #9a3412;
}

.invite-space {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: #1d1d1f;
}

.invite-body {
  margin: 0 0 0.65rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: #3c3c43;
}

.invite-expiry {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #2563eb;
}

.invite-host {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.invite-muted {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: #6e6e73;
}

.invite-section-label {
  margin: 1rem 0 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #86868b;
}

.invite-names {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: #1d1d1f;
}

.invite-names__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.75rem;
  margin: 0.35rem 0;
}

.invite-pill {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 0.2rem 0.45rem;
  border-radius: 6px;
}

.invite-pill--in {
  background: rgba(4, 120, 87, 0.12);
  color: #047857;
}

.invite-pill--out {
  background: rgba(0, 0, 0, 0.05);
  color: #6e6e73;
}

.invite-qr-wrap {
  margin-top: 1.25rem;
  padding-top: 1.1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  text-align: center;
}

.invite-qr-hint {
  margin: 0 0 0.65rem;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.invite-qr {
  display: inline-block;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
</style>
