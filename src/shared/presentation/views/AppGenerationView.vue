<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'

const { t, locale } = useI18n()

const reservations = ref([])
const spacesById = ref(new Map())
const loading = ref(false)
const loadError = ref(false)
const savingKey = ref('')
const rangeFilter = ref('all')

const todayYmd = computed(() => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
})

const sortedReservations = computed(() => {
  return reservations.value.slice().sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return String(b.startTime).localeCompare(String(a.startTime))
  })
})

const visibleReservations = computed(() => {
  if (rangeFilter.value !== 'today') return sortedReservations.value
  return sortedReservations.value.filter((row) => row.date === todayYmd.value)
})

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  { id: 'today', label: t('app.generationAdminToday') },
])

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

function guestList(r) {
  return Array.isArray(r?.guests) ? r.guests : []
}

function enteredCount(r) {
  return guestList(r).filter((g) => g.checkedIn).length
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
  try {
    const updated = await reservationsApi.setGuestCheckedIn(r.id, guest.id, checkedIn)
    const idx = reservations.value.findIndex((x) => x.id === updated.id)
    if (idx !== -1) {
      reservations.value[idx] = updated
    }
  } catch {
    await load()
  } finally {
    savingKey.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="app-view gen-page">
    <h1 class="visually-hidden">{{ t('app.pageGeneration') }}</h1>

    <p v-if="loadError" class="gen-alert" role="alert">{{ t('app.generationAdminLoadError') }}</p>

    <div
      v-if="sortedReservations.length"
      class="gen-filters"
      role="group"
      :aria-label="t('app.generationAdminSectionTitle')"
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

    <p v-if="loading" class="gen-status">{{ t('app.generationAdminLoading') }}</p>
    <p v-else-if="!visibleReservations.length" class="gen-status">
      {{ t('app.generationAdminEmpty') }}
    </p>

    <ul v-else class="gen-board" role="list">
      <li v-for="r in visibleReservations" :key="r.id">
        <article class="gen-card">
          <header class="gen-card__head">
            <div>
              <h2 class="gen-card__title">{{ spaceName(r.spaceId) }}</h2>
              <p class="gen-card__meta">
                {{ r.residentName || '—' }}
                <span v-if="r.residentCode">({{ r.residentCode }})</span>
                · {{ slotLabel(r) }}
              </p>
            </div>
            <span v-if="guestList(r).length" class="gen-badge">
              {{
                t('app.generationAdminEnteredSummary', {
                  in: enteredCount(r),
                  total: guestList(r).length,
                })
              }}
            </span>
          </header>

          <p v-if="!guestList(r).length" class="gen-empty">
            {{ t('app.generationAdminNoGuests') }}
          </p>
          <ul v-else class="gen-guests" role="list">
            <li v-for="g in guestList(r)" :key="g.id" class="gen-guest">
              <span class="gen-guest__name">{{ g.name }}</span>
              <button
                type="button"
                class="gen-pass"
                :class="{ 'is-in': g.checkedIn }"
                :disabled="savingKey === `${r.id}:${g.id}`"
                :aria-pressed="Boolean(g.checkedIn)"
                :aria-label="t('app.generationAdminCheckInAria')"
                @click="onGuestCheckedIn(r, g, !g.checkedIn)"
              >
                <i
                  :class="g.checkedIn ? 'pi pi-check-circle' : 'pi pi-circle'"
                  aria-hidden="true"
                />
                {{ g.checkedIn ? t('app.generationAdminEntered') : t('app.generationAdminNotEntered') }}
              </button>
            </li>
          </ul>
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

.gen-filter:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
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
  gap: 0.85rem;
  padding: 1.05rem 1.1rem 1.1rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
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

.gen-guest__name {
  min-width: 0;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.gen-pass {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border: none;
  border-radius: 8px;
  background: #f5f5f7;
  color: #4b5563;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  box-shadow: none;
}

.gen-pass:hover:not(:disabled) {
  background: #e8e8ed;
}

.gen-pass.is-in {
  background: #0071e3;
  border: none;
  color: #fff;
}

.gen-pass.is-in:hover:not(:disabled) {
  background: #0066cc;
  color: #fff;
}

.gen-pass:disabled {
  opacity: 0.55;
  cursor: wait;
}

.gen-pass:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
}
</style>
