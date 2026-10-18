<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { serviceProvidersApi } from '@/incidents/infrastructure/serviceProvidersApi.js'
import IncidentResolveDialog from '@/incidents/presentation/components/IncidentResolveDialog.vue'
import {
  IncidentRealtimeEvent,
  IncidentStatus,
  INCIDENT_TITLE_MAX,
} from '@/incidents/domain/model/incidentConstants.js'
import { incidentPriorityLabel, incidentPriorityOptions } from '@/incidents/presentation/incidentLabels.js'
import {
  markIncidentsSeen,
  onIncidentRealtime,
} from '@/incidents/application/incidentRealtimeStore.js'
import { teamWorkersApi } from '@/team/infrastructure/teamWorkersApi.js'
import { teamTasksApi } from '@/team/infrastructure/teamTasksApi.js'

const { t, locale } = useI18n()

/** Team: "Crear tarea de mantenimiento" desde una incidencia (MaintenanceTask.incidentId). */
const activeWorkers = ref([])
const taskBusyId = ref('')
const taskNotice = ref({ id: '', text: '', error: false })

async function loadActiveWorkers() {
  try {
    const list = await teamWorkersApi.list()
    activeWorkers.value = list.filter((w) => w?.id && w.status !== 'INACTIVE')
  } catch {
    activeWorkers.value = []
  }
}

async function createTaskFromIncident(row, event) {
  const staffId = event.target.value
  event.target.value = ''
  if (!staffId || taskBusyId.value) return
  taskBusyId.value = row.id
  taskNotice.value = { id: '', text: '', error: false }
  try {
    const description = [row.title, row.description].filter(Boolean).join(' — ').slice(0, 2000)
    await teamTasksApi.create({ staffId, incidentId: row.id, description: description || row.id })
    taskNotice.value = { id: row.id, text: t('teamMgmt.tasks.createdFromIncident'), error: false }
  } catch (err) {
    const text =
      err?.code === 'WORKLOAD_EXCEEDED'
        ? t('teamMgmt.tasks.workloadExceeded')
        : err?.code === 'WORKER_INACTIVE'
          ? t('teamMgmt.tasks.workerInactive')
          : t('teamMgmt.tasks.saveError')
    taskNotice.value = { id: row.id, text, error: true }
  } finally {
    taskBusyId.value = ''
  }
}

const LEGACY_PROVIDER = '__legacy__'

const incidents = ref([])
const serviceProviders = ref([])
const loading = ref(false)
const error = ref(null)
/** RNF012: the incidents list itself failed to load (retryable). */
const loadFailed = ref(false)
const composing = ref(false)
const sending = ref(false)
const savingId = ref('')
const draftTitle = ref('')
const draftDescription = ref('')
const draftProviderId = ref('')
const draftPriority = ref('')
const draftCategory = ref('')
const titleTouched = ref(false)
const descriptionTouched = ref(false)
const statusFilter = ref('all')
const resolving = ref(null)
const resolveError = ref('')

const statusOptions = computed(() => [
  { label: t('incidentStatusOpen'), value: IncidentStatus.OPEN },
  { label: t('incidentStatusInProgress'), value: IncidentStatus.IN_PROGRESS },
  { label: t('incidentStatusResolved'), value: IncidentStatus.RESOLVED },
])

const priorityOptions = computed(() => incidentPriorityOptions(t))

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  ...statusOptions.value.map((opt) => ({ id: opt.value, label: opt.label })),
])

const providerOptions = computed(() =>
  serviceProviders.value
    .filter((row) => row?.id && String(row?.name ?? '').trim())
    .map((row) => ({ id: String(row.id), name: String(row.name).trim(), specialty: row.specialty || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)

const visibleIncidents = computed(() => {
  if (statusFilter.value === 'all') return incidents.value
  return incidents.value.filter((row) => (row.status || IncidentStatus.OPEN) === statusFilter.value)
})

// US024: campos obligatorios marcados en rojo; envío bloqueado mientras falten.
const titleInvalid = computed(() => titleTouched.value && !draftTitle.value.trim())
const descriptionInvalid = computed(() => descriptionTouched.value && !draftDescription.value.trim())
const canSubmit = computed(() => !!draftTitle.value.trim() && !!draftDescription.value.trim())

function resetDraft() {
  draftTitle.value = ''
  draftDescription.value = ''
  draftProviderId.value = ''
  draftPriority.value = ''
  draftCategory.value = ''
  titleTouched.value = false
  descriptionTouched.value = false
}

function startCompose() {
  composing.value = true
  resetDraft()
}

function cancelCompose() {
  composing.value = false
  resetDraft()
}

function statusLabel(status) {
  const match = statusOptions.value.find((row) => row.value === status)
  return match?.label ?? String(status ?? '—')
}

/** Valor del select de proveedor: assigneeId, o match por nombre para incidencias antiguas. */
function providerValue(row) {
  if (row.providerId) return String(row.providerId)
  if (!row.provider) return ''
  const byName = providerOptions.value.find(
    (p) => p.name.localeCompare(String(row.provider).trim(), undefined, { sensitivity: 'base' }) === 0,
  )
  return byName ? byName.id : LEGACY_PROVIDER
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
  if (payload?.code === 'RESOLUTION_COMMENT_REQUIRED') return t('incidentFlow.resolutionCommentRequired')
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

async function loadIncidents({ silent = false } = {}) {
  try {
    if (!silent) loading.value = true
    error.value = null
    loadFailed.value = false
    const list = await incidentsApi.list()
    incidents.value = list
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch (err) {
    error.value = resolveErrorMessage(err, 'app.incidentsLoadError')
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function createIncident() {
  titleTouched.value = true
  descriptionTouched.value = true
  const title = draftTitle.value.trim()
  const description = draftDescription.value.trim()
  if (!title || !description || sending.value) return
  sending.value = true
  try {
    error.value = null
    await incidentsApi.add({
      id: `incident-${Date.now()}`,
      title,
      description,
      status: IncidentStatus.OPEN,
      providerId: draftProviderId.value || null,
      priority: draftPriority.value || null,
      category: draftCategory.value.trim() || null,
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

async function runSave(row, action) {
  if (!row?.id || savingId.value) return
  savingId.value = row.id
  try {
    error.value = null
    await action()
    await loadIncidents({ silent: true })
  } catch (err) {
    error.value = resolveErrorMessage(err)
  } finally {
    savingId.value = ''
  }
}

/** Estado: "Resuelto" abre el modal que exige comentario de resolución (US031). */
function onStatusChange(row, event) {
  const next = event.target.value
  if (next === IncidentStatus.RESOLVED) {
    event.target.value = row.status || IncidentStatus.OPEN
    resolveError.value = ''
    resolving.value = row
    return
  }
  runSave(row, () => incidentsApi.update(row.id, { ...row, status: next }))
}

/** PATCH /assign: asignar un proveedor pasa la incidencia abierta a "en proceso". */
function onProviderChange(row, event) {
  const providerId = event.target.value
  if (providerId === LEGACY_PROVIDER) return
  runSave(row, () => incidentsApi.assign(row.id, providerId))
}

async function confirmResolve(comment) {
  const row = resolving.value
  if (!row) return
  savingId.value = row.id
  resolveError.value = ''
  try {
    await incidentsApi.resolve(row.id, comment)
    resolving.value = null
    await loadIncidents({ silent: true })
  } catch (err) {
    resolveError.value = resolveErrorMessage(err)
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

// RF024: nuevas incidencias / cambios en tiempo real (conexión iniciada por el shell del admin).
let stopRealtime = () => {}

onMounted(async () => {
  markIncidentsSeen()
  stopRealtime = onIncidentRealtime((type) => {
    if (type === IncidentRealtimeEvent.CREATED) markIncidentsSeen()
    if (type === IncidentRealtimeEvent.CREATED || type === IncidentRealtimeEvent.UPDATED) {
      loadIncidents({ silent: true })
    }
  })
  await Promise.all([loadIncidents(), loadServiceProviders(), loadActiveWorkers()])
})

onBeforeUnmount(() => stopRealtime())
</script>

<template>
  <div class="app-view inc-page">
    <header class="inc-head">
      <h1 class="visually-hidden">{{ t('app.pageIncidents') }}</h1>
    </header>

    <LoadErrorRetry v-if="loadFailed" :message="error" :loading="loading" @retry="loadIncidents()" />
    <p v-else-if="error" class="inc-alert" role="alert">{{ error }}</p>

    <section v-if="composing" class="inc-form" aria-labelledby="inc-form-heading">
      <h2 id="inc-form-heading" class="inc-form__title">{{ t('app.newIncident') }}</h2>

      <label class="inc-form__field" for="inc-draft-title">
        <span>{{ t('incidentFlow.titleLabel') }} *</span>
        <input
          id="inc-draft-title"
          v-model="draftTitle"
          type="text"
          :maxlength="INCIDENT_TITLE_MAX"
          :class="{ 'is-invalid': titleInvalid }"
          :aria-invalid="titleInvalid"
          :placeholder="t('incidentFlow.titlePlaceholder')"
          :disabled="sending"
          @blur="titleTouched = true"
        />
      </label>
      <p v-if="titleInvalid" class="inc-form__error" role="alert">{{ t('incidentFlow.fieldRequired') }}</p>

      <label class="inc-form__field" for="inc-draft-description">
        <span>{{ t('app.incidentDescription') }} *</span>
        <textarea
          id="inc-draft-description"
          v-model="draftDescription"
          rows="5"
          :class="{ 'is-invalid': descriptionInvalid }"
          :aria-invalid="descriptionInvalid"
          :placeholder="t('app.incidentDescription')"
          :disabled="sending"
          @blur="descriptionTouched = true"
        />
      </label>
      <p v-if="descriptionInvalid" class="inc-form__error" role="alert">{{ t('incidentFlow.fieldRequired') }}</p>

      <div class="inc-form__row">
        <label class="inc-form__field" for="inc-draft-provider">
          <span>{{ t('app.incidentProvider') }}</span>
          <select id="inc-draft-provider" v-model="draftProviderId" :disabled="sending">
            <option value="">{{ t('app.incidentUnassignProvider') }}</option>
            <option v-for="p in providerOptions" :key="`draft-${p.id}`" :value="p.id">
              {{ p.name }}<template v-if="p.specialty"> · {{ p.specialty }}</template>
            </option>
          </select>
        </label>
        <label class="inc-form__field" for="inc-draft-priority">
          <span>{{ t('incidentFlow.priorityLabel') }}</span>
          <select id="inc-draft-priority" v-model="draftPriority" :disabled="sending">
            <option value="">{{ t('incidentFlow.priorityNone') }}</option>
            <option v-for="opt in priorityOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <label class="inc-form__field" for="inc-draft-category">
          <span>{{ t('incidentFlow.categoryLabel') }}</span>
          <input
            id="inc-draft-category"
            v-model="draftCategory"
            type="text"
            maxlength="50"
            :placeholder="t('incidentFlow.categoryPlaceholder')"
            :disabled="sending"
          />
        </label>
      </div>
      <p v-if="!serviceProviders.length" class="inc-form__hint">
        {{ t('app.incidentProvidersEmptyHint') }}
      </p>

      <div class="bf-actions">
        <button type="button" class="bf-btn bf-btn--cancel" :disabled="sending" @click="cancelCompose">
          {{ t('app.cancelAction') }}
        </button>
        <button
          type="button"
          class="bf-btn bf-btn--confirm"
          :disabled="sending || !canSubmit"
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
              <span v-if="row.priority" class="inc-chip" :class="`inc-chip--${row.priority}`">
                {{ incidentPriorityLabel(t, row.priority) }}
              </span>
              <span v-if="row.category" class="inc-chip">{{ row.category }}</span>
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

          <h3 v-if="row.title" class="inc-card__title">{{ row.title }}</h3>
          <p class="inc-card__body">{{ row.description }}</p>
          <p v-if="row.resolutionComment" class="inc-card__resolution">
            <i class="pi pi-check-circle" aria-hidden="true" />
            {{ row.resolutionComment }}
          </p>

          <footer class="inc-card__meta">
            <span v-if="row.residentName">
              <i class="pi pi-user" aria-hidden="true" />
              {{ row.residentName }}
            </span>
            <span>
              <i class="pi pi-wrench" aria-hidden="true" />
              {{ row.provider || t('app.noProviderAssigned') }}
              <template v-if="row.provider && row.providerPhone"> · {{ row.providerPhone }}</template>
            </span>
            <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatWhen(row.createdAt) }}</time>
          </footer>

          <div class="inc-card__controls">
            <label class="inc-card__field">
              <span>{{ t('app.incidentStatus') }}</span>
              <select
                :value="row.status || 'open'"
                :disabled="savingId === row.id"
                @change="onStatusChange(row, $event)"
              >
                <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </label>
            <label class="inc-card__field">
              <span>{{ t('app.incidentProvider') }}</span>
              <select
                :value="providerValue(row)"
                :disabled="savingId === row.id"
                @change="onProviderChange(row, $event)"
              >
                <option value="">{{ t('app.incidentUnassignProvider') }}</option>
                <option v-if="providerValue(row) === LEGACY_PROVIDER" :value="LEGACY_PROVIDER" disabled>
                  {{ row.provider }}
                </option>
                <option v-for="p in providerOptions" :key="`${row.id}-${p.id}`" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
            </label>
            <label v-if="activeWorkers.length" class="inc-card__field">
              <span>{{ t('teamMgmt.tasks.createFromIncident') }}</span>
              <select
                value=""
                :disabled="taskBusyId === row.id"
                @change="createTaskFromIncident(row, $event)"
              >
                <option value="">{{ t('teamMgmt.tasks.workerPlaceholder') }}</option>
                <option v-for="w in activeWorkers" :key="`${row.id}-w-${w.id}`" :value="w.id">
                  {{ w.name }}
                </option>
              </select>
            </label>
          </div>
          <p
            v-if="taskNotice.id === row.id && taskNotice.text"
            class="inc-card__task-notice"
            :class="{ 'inc-card__task-notice--error': taskNotice.error }"
            role="status"
          >
            {{ taskNotice.text }}
          </p>
        </article>
      </li>
    </ul>

    <IncidentResolveDialog
      :open="!!resolving"
      :incident-title="resolving?.title || ''"
      :busy="!!resolving && savingId === resolving.id"
      :server-error="resolveError"
      @cancel="resolving = null"
      @confirm="confirmResolve"
    />
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

.inc-card__task-notice {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  color: #1a7f37;
}

.inc-card__task-notice--error {
  color: #b42318;
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

.inc-form__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
}

.inc-form__field input {
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 400;
  color: var(--apple-text, #1d1d1f);
  outline: none;
}

.inc-form__field input:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.inc-form__field input.is-invalid,
.inc-form__field textarea.is-invalid {
  border-color: #d92d20;
  box-shadow: 0 0 0 3px rgba(217, 45, 32, 0.14);
}

.inc-form__error {
  margin: -0.65rem 0 0;
  font-size: 0.78rem;
  color: #b42318;
}

.inc-card__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--apple-text, #1d1d1f);
  word-break: break-word;
}

.inc-card__resolution {
  margin: 0;
  padding: 0.5rem 0.65rem;
  border-radius: 10px;
  background: #f1f8f2;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #1b5e33;
  white-space: pre-wrap;
}

.inc-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  background: #f2f2f7;
  color: #3a3a3c;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.inc-chip--high {
  background: #fff1e6;
  color: #c2410c;
}

.inc-chip--critical {
  background: #fdecee;
  color: #b42318;
}
</style>
