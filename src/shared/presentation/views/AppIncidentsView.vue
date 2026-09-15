<script setup>
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { serviceProvidersApi } from '@/incidents/infrastructure/serviceProvidersApi.js'

const { t, locale } = useI18n()

const incidents = ref([])
const serviceProviders = ref([])
const loading = ref(false)
const error = ref(null)
const composing = ref(false)
const sending = ref(false)
const savingId = ref('')
const draftDescription = ref('')
const draftProvider = ref('')
const statusFilter = ref('all')

const statusOptions = computed(() => [
  { label: t('incidentStatusOpen'), value: 'open' },
  { label: t('incidentStatusInProgress'), value: 'in-progress' },
  { label: t('incidentStatusResolved'), value: 'resolved' },
])

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  ...statusOptions.value.map((opt) => ({ id: opt.value, label: opt.label })),
])

const providerOptions = computed(() => {
  const names = serviceProviders.value
    .map((row) => String(row?.name ?? '').trim())
    .filter(Boolean)
  const unique = [...new Set(names)]
  unique.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const draft = String(draftProvider.value ?? '').trim()
  if (draft && !unique.includes(draft)) unique.unshift(draft)
  return unique
})

const visibleIncidents = computed(() => {
  if (statusFilter.value === 'all') return incidents.value
  return incidents.value.filter((row) => (row.status || 'open') === statusFilter.value)
})

function startCompose() {
  composing.value = true
  draftDescription.value = ''
  draftProvider.value = ''
}

function cancelCompose() {
  composing.value = false
  draftDescription.value = ''
  draftProvider.value = ''
}

function statusLabel(status) {
  const match = statusOptions.value.find((row) => row.value === status)
  return match?.label ?? String(status ?? '—')
}

function formatWhen(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(locale.value === 'es' ? 'es-PE' : 'en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

function resolveErrorMessage(err, fallbackKey = 'app.incidentsSaveError') {
  const payload = err?.payload
  if (payload && typeof payload === 'object' && typeof payload.message === 'string') {
    return payload.message
  }
  if (err?.code === 'NETWORK_ERROR') return t('app.networkError')
  if (err?.code === 'TIMEOUT') return t('app.timeoutError')
  return t(fallbackKey)
}

async function loadServiceProviders() {
  try {
    const list = await serviceProvidersApi.list()
    serviceProviders.value = Array.isArray(list) ? list : []
  } catch {
    serviceProviders.value = []
  }
}

async function loadIncidents() {
  try {
    loading.value = true
    error.value = null
    const list = await incidentsApi.list()
    incidents.value = list
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch (err) {
    error.value = resolveErrorMessage(err, 'app.incidentsLoadError')
  } finally {
    loading.value = false
  }
}

async function createIncident() {
  const description = draftDescription.value.trim()
  if (!description || sending.value) return
  sending.value = true
  try {
    error.value = null
    await incidentsApi.add({
      id: `incident-${Date.now()}`,
      description,
      status: 'open',
      provider: draftProvider.value.trim(),
      residentId: null,
      residentName: '',
      createdAt: new Date().toISOString(),
    })
    cancelCompose()
    await loadIncidents()
  } catch (err) {
    error.value = resolveErrorMessage(err)
  } finally {
    sending.value = false
  }
}

async function updateIncident(row, patch) {
  if (!row?.id || savingId.value) return
  savingId.value = row.id
  try {
    error.value = null
    await incidentsApi.update(row.id, {
      ...row,
      ...patch,
    })
    await loadIncidents()
  } catch (err) {
    error.value = resolveErrorMessage(err)
  } finally {
    savingId.value = ''
  }
}

async function deleteIncident(id) {
  if (!window.confirm(t('app.incidentsDeleteConfirm'))) return
  try {
    error.value = null
    await incidentsApi.remove(id)
    await loadIncidents()
  } catch (err) {
    error.value = resolveErrorMessage(err)
  }
}

onMounted(async () => {
  await Promise.all([loadIncidents(), loadServiceProviders()])
})
</script>

<template>
  <div class="app-view inc-page">
    <header class="inc-head">
      <h1 class="visually-hidden">{{ t('app.pageIncidents') }}</h1>
    </header>

    <p v-if="error" class="inc-alert" role="alert">{{ error }}</p>

    <section v-if="composing" class="inc-form" aria-labelledby="inc-form-heading">
      <h2 id="inc-form-heading" class="inc-form__title">{{ t('app.newIncident') }}</h2>

      <label class="inc-form__field" for="inc-draft-provider">
        <span>{{ t('app.incidentProvider') }}</span>
        <select id="inc-draft-provider" v-model="draftProvider" :disabled="sending">
          <option value="">{{ t('app.incidentUnassignProvider') }}</option>
          <option v-for="name in providerOptions" :key="`draft-${name}`" :value="name">
            {{ name }}
          </option>
        </select>
      </label>
      <p v-if="!serviceProviders.length" class="inc-form__hint">
        {{ t('app.incidentProvidersEmptyHint') }}
      </p>

      <label class="inc-form__field" for="inc-draft-description">
        <span>{{ t('app.incidentDescription') }}</span>
        <textarea
          id="inc-draft-description"
          v-model="draftDescription"
          rows="5"
          :placeholder="t('app.incidentDescription')"
          :disabled="sending"
        />
      </label>

      <div class="bf-actions">
        <button type="button" class="bf-btn bf-btn--cancel" :disabled="sending" @click="cancelCompose">
          {{ t('app.cancelAction') }}
        </button>
        <button
          type="button"
          class="bf-btn bf-btn--confirm"
          :disabled="sending || !draftDescription.trim()"
          @click="createIncident"
        >
          {{ t('app.newIncident') }}
        </button>
      </div>
    </section>

    <div class="inc-toolbar">
      <div
        v-if="incidents.length"
        class="inc-filters"
        role="group"
        :aria-label="t('app.incidentsAdminListTitle')"
      >
        <button
          v-for="filter in filters"
          :key="filter.id"
          type="button"
          class="inc-filter"
          :class="{ 'is-active': statusFilter === filter.id }"
          :aria-pressed="statusFilter === filter.id"
          @click="statusFilter = filter.id"
        >
          {{ filter.label }}
        </button>
      </div>
      <button
        v-if="!composing"
        type="button"
        class="inc-new"
        @click="startCompose"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        {{ t('app.newIncident') }}
      </button>
    </div>

    <p v-if="loading" class="inc-status">{{ t('app.incidentsLoading') }}</p>
    <p v-else-if="!visibleIncidents.length" class="inc-status">
      {{ t('app.incidentsEmptyList') }}
    </p>

    <ul v-else class="inc-board" role="list">
      <li v-for="row in visibleIncidents" :key="row.id">
        <article class="inc-card">
          <header class="inc-card__head">
            <div class="inc-card__badges">
              <span class="inc-badge" :class="`inc-badge--${row.status || 'open'}`">
                {{ statusLabel(row.status) }}
              </span>
            </div>
            <button
              type="button"
              class="inc-card__delete"
              :aria-label="t('app.deleteAction')"
              @click="deleteIncident(row.id)"
            >
              <i class="pi pi-trash" aria-hidden="true" />
            </button>
          </header>

          <p class="inc-card__body">{{ row.description }}</p>

          <footer class="inc-card__meta">
            <span v-if="row.residentName">
              <i class="pi pi-user" aria-hidden="true" />
              {{ row.residentName }}
            </span>
            <span>
              <i class="pi pi-wrench" aria-hidden="true" />
              {{ row.provider || t('app.noProviderAssigned') }}
            </span>
            <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatWhen(row.createdAt) }}</time>
          </footer>

          <div class="inc-card__controls">
            <label class="inc-card__field">
              <span>{{ t('app.incidentStatus') }}</span>
              <select
                :value="row.status || 'open'"
                :disabled="savingId === row.id"
                @change="updateIncident(row, { status: $event.target.value })"
              >
                <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </label>
            <label class="inc-card__field">
              <span>{{ t('app.incidentProvider') }}</span>
              <select
                :value="row.provider || ''"
                :disabled="savingId === row.id"
                @change="updateIncident(row, { provider: $event.target.value })"
              >
                <option value="">{{ t('app.incidentUnassignProvider') }}</option>
                <option
                  v-for="name in providerOptions"
                  :key="`${row.id}-${name}`"
                  :value="name"
                >
                  {{ name }}
                </option>
              </select>
            </label>
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

.inc-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.inc-head {
  display: contents;
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

.inc-new {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border: none;
  border-radius: 8px;
  background: #0071e3;
  color: #fff;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  box-shadow: none;
}

.inc-new:hover {
  background: #0066cc;
}

.inc-new:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
}

.inc-alert {
  margin: 0;
  font-size: 0.875rem;
  color: #b42318;
}

.inc-status {
  margin: 0;
  padding: 1.5rem 0.25rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.inc-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.inc-form__title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.inc-form__field,
.inc-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.inc-form__field select,
.inc-form__field textarea,
.inc-card__field select {
  width: 100%;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 400;
  color: var(--apple-text, #1d1d1f);
  outline: none;
}

.inc-form__field textarea {
  min-height: 7rem;
  resize: vertical;
  line-height: 1.5;
}

.inc-form__field select:focus,
.inc-form__field textarea:focus,
.inc-card__field select:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.inc-form__hint {
  margin: -0.35rem 0 0;
  font-size: 0.78rem;
  font-weight: 400;
  color: var(--apple-text-secondary, #6e6e73);
}

.inc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.inc-toolbar .inc-new {
  margin-left: auto;
}

.inc-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  width: fit-content;
  max-width: 100%;
  padding: 0.3rem;
  border-radius: 999px;
  background: #eef0f3;
}

.inc-filter {
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

.inc-filter:hover:not(.is-active) {
  color: #1d1d1f;
}

.inc-filter.is-active {
  background: #fff;
  color: #1d1d1f;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.inc-filter:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
}

.inc-board {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18.5rem, 1fr));
  gap: 0.9rem;
}

.inc-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1.05rem 1.1rem 1.1rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.inc-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.65rem;
}

.inc-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.inc-card__delete {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  margin: -0.25rem -0.25rem 0 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #ff3b30;
  cursor: pointer;
}

.inc-card__delete:hover {
  color: #e0352b;
  background: rgba(255, 59, 48, 0.1);
}

.inc-card__body {
  margin: 0;
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--apple-text, #1d1d1f);
}

.inc-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.85rem;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.inc-card__meta i {
  margin-right: 0.25rem;
  font-size: 0.7rem;
}

.inc-card__controls {
  display: grid;
  gap: 0.55rem;
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

.inc-badge--open {
  background: #fff3e0;
  color: #e65100;
}

.inc-badge--in-progress {
  background: #e8f1fc;
  color: #0071e3;
}

.inc-badge--resolved {
  background: #e8f5e9;
  color: #1b7a3d;
}

.app-view :deep(.bf-btn) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  box-shadow: none;
  transform: none;
}

.app-view :deep(.bf-btn--confirm) {
  background: #0071e3;
  color: #ffffff;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):hover) {
  background: #0066cc;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):focus-visible) {
  animation: none;
  box-shadow: none;
}
</style>
