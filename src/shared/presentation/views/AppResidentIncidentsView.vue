<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import IncidentDetailDialog from '@/incidents/presentation/components/IncidentDetailDialog.vue'
import {
  onIncidentRealtime,
  startIncidentRealtime,
} from '@/incidents/application/incidentRealtimeStore.js'
import { IncidentRealtimeEvent, INCIDENT_TITLE_MAX } from '@/incidents/domain/model/incidentConstants.js'

const { t, locale } = useI18n()
const { state } = useSession()
const profile = computed(() => state.profile ?? {})

const incidents = ref([])
const loading = ref(false)
const error = ref(null)
/** RNF012: the incidents list itself failed to load (retryable). */
const loadFailed = ref(false)
const composing = ref(false)
const sending = ref(false)
const draftTitle = ref('')
const draftDescription = ref('')
const submitAttempted = ref(false)
const titleTouched = ref(false)
const descriptionTouched = ref(false)
const statusFilter = ref('all')
const detailId = ref('')
const detailRefreshKey = ref(0)

// US024: campos vacíos en rojo con mensaje; el botón de envío queda bloqueado.
const titleInvalid = computed(
  () => (submitAttempted.value || titleTouched.value) && !draftTitle.value.trim(),
)
const descriptionInvalid = computed(
  () => (submitAttempted.value || descriptionTouched.value) && !draftDescription.value.trim(),
)
const canSubmit = computed(() => !!draftTitle.value.trim() && !!draftDescription.value.trim())

const statusOptions = computed(() => [
  { label: t('incidentStatusOpen'), value: 'open' },
  { label: t('incidentStatusInProgress'), value: 'in-progress' },
  { label: t('incidentStatusResolved'), value: 'resolved' },
])

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  ...statusOptions.value.map((opt) => ({ id: opt.value, label: opt.label })),
])

const visibleIncidents = computed(() => {
  if (statusFilter.value === 'all') return incidents.value
  return incidents.value.filter((row) => (row.status || 'open') === statusFilter.value)
})

function startCompose() {
  composing.value = true
  draftTitle.value = ''
  draftDescription.value = ''
  submitAttempted.value = false
  titleTouched.value = false
  descriptionTouched.value = false
}

function cancelCompose() {
  composing.value = false
  draftTitle.value = ''
  draftDescription.value = ''
  submitAttempted.value = false
  titleTouched.value = false
  descriptionTouched.value = false
}

function openDetail(row) {
  detailId.value = row?.id ? String(row.id) : ''
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

async function loadIncidents() {
  const residentId = profile.value.id
  if (!residentId) {
    incidents.value = []
    return
  }
  try {
    loading.value = true
    error.value = null
    loadFailed.value = false
    // RF018: filtrado server-side (el backend solo devuelve las del residente autenticado).
    const own = await incidentsApi.listByResident(residentId)
    incidents.value = own
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch {
    error.value = t('app.incidentsLoadError')
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function reportIncident() {
  submitAttempted.value = true
  const title = draftTitle.value.trim()
  const text = draftDescription.value.trim()
  const residentId = profile.value.id
  const residentName = profile.value.name || ''
  if (!title || !text || !residentId || sending.value) return

  sending.value = true
  try {
    error.value = null
    let ownerAdminId = profile.value.ownerAdminId ?? null
    if (!ownerAdminId) {
      const row = await authApi.getProfileById(residentId)
      ownerAdminId = row?.ownerAdminId ?? null
    }

    await incidentsApi.add({
      id: `incident-${Date.now()}`,
      residentId,
      residentName,
      title,
      description: text,
      status: 'open',
      createdAt: new Date().toISOString(),
      provider: '',
      ...(ownerAdminId ? { ownerAdminId } : {}),
    })
    cancelCompose()
    await loadIncidents()
  } catch (err) {
    error.value = err?.payload?.message || t('app.incidentsSaveError')
  } finally {
    sending.value = false
  }
}

// Tiempo real: cuando el admin asigna / cambia estado / resuelve, se refresca la vista.
let stopRealtime = () => {}

onMounted(async () => {
  await loadIncidents()
  stopRealtime = onIncidentRealtime((type, payload) => {
    if (type !== IncidentRealtimeEvent.UPDATED) return
    if (payload?.residentId && payload.residentId !== profile.value.id) return
    loadIncidents()
    if (detailId.value && payload?.id === detailId.value) detailRefreshKey.value++
  })
  startIncidentRealtime(profile.value.ownerAdminId)
})

onBeforeUnmount(() => stopRealtime())
</script>

<template>
  <div class="app-view inc-page">
    <header class="inc-head">
      <h1 class="visually-hidden">{{ t('resident.incidentsTitle') }}</h1>
    </header>

    <LoadErrorRetry v-if="loadFailed" :message="error" :loading="loading" @retry="loadIncidents" />
    <p v-else-if="error" class="inc-alert" role="alert">{{ error }}</p>

    <section v-if="composing" class="inc-form" aria-labelledby="inc-form-heading">
      <h2 id="inc-form-heading" class="inc-form__title">
        {{ t('app.residentIncidentsFormTitle') }}
      </h2>
      <label class="inc-form__field" for="inc-resident-title">
        <span>{{ t('incidentFlow.titleLabel') }} *</span>
        <input
          id="inc-resident-title"
          v-model="draftTitle"
          type="text"
          :maxlength="INCIDENT_TITLE_MAX"
          :class="{ 'is-invalid': titleInvalid }"
          :aria-invalid="titleInvalid"
          aria-describedby="inc-resident-title-error"
          :placeholder="t('incidentFlow.titlePlaceholder')"
          :disabled="sending"
          @blur="titleTouched = true"
        />
      </label>
      <p v-if="titleInvalid" id="inc-resident-title-error" class="inc-form__error" role="alert">
        {{ t('incidentFlow.fieldRequired') }}
      </p>
      <label class="inc-form__field" for="inc-resident-description">
        <span>{{ t('app.residentIncidentsDescriptionLabel') }} *</span>
        <textarea
          id="inc-resident-description"
          v-model="draftDescription"
          rows="5"
          :class="{ 'is-invalid': descriptionInvalid }"
          :aria-invalid="descriptionInvalid"
          aria-describedby="inc-resident-description-error"
          :placeholder="t('app.residentIncidentsDescriptionPlaceholder')"
          :disabled="sending"
          @blur="descriptionTouched = true"
        />
      </label>
      <p v-if="descriptionInvalid" id="inc-resident-description-error" class="inc-form__error" role="alert">
        {{ t('incidentFlow.fieldRequired') }}
      </p>
      <div class="bf-actions">
        <button type="button" class="bf-btn bf-btn--cancel" :disabled="sending" @click="cancelCompose">
          {{ t('app.cancelAction') }}
        </button>
        <button
          type="button"
          class="bf-btn bf-btn--confirm"
          :disabled="sending || !canSubmit"
          @click="reportIncident"
        >
          {{ t('app.residentIncidentsSubmit') }}
        </button>
      </div>
    </section>

    <div class="inc-toolbar">
      <div
        v-if="incidents.length"
        class="inc-filters"
        role="group"
        :aria-label="t('app.residentIncidentsListTitle')"
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
        {{ t('app.residentIncidentsSubmit') }}
      </button>
    </div>

    <p v-if="loading" class="inc-status">{{ t('app.incidentsLoading') }}</p>
    <p v-else-if="!visibleIncidents.length" class="inc-status">
      {{ t('resident.incidentsEmpty') }}
    </p>

    <ul v-else class="inc-board" role="list">
      <li v-for="row in visibleIncidents" :key="row.id">
        <article class="inc-card">
          <header class="inc-card__head">
            <span class="inc-badge" :class="`inc-badge--${row.status || 'open'}`">
              {{ statusLabel(row.status) }}
            </span>
          </header>
          <h3 v-if="row.title" class="inc-card__title">{{ row.title }}</h3>
          <p class="inc-card__body">{{ row.description }}</p>
          <p v-if="row.resolutionComment" class="inc-card__resolution">
            <i class="pi pi-check-circle" aria-hidden="true" />
            {{ row.resolutionComment }}
          </p>
          <footer class="inc-card__meta">
            <span>
              <i class="pi pi-wrench" aria-hidden="true" />
              {{ row.provider || t('app.noProviderAssigned') }}
            </span>
            <span v-if="row.provider && row.providerPhone">
              <i class="pi pi-phone" aria-hidden="true" />
              <a :href="`tel:${row.providerPhone}`">{{ row.providerPhone }}</a>
            </span>
            <span v-if="row.provider && row.providerSpecialty">{{ row.providerSpecialty }}</span>
            <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatWhen(row.createdAt) }}</time>
          </footer>
          <button type="button" class="inc-card__detail" @click="openDetail(row)">
            {{ t('incidentFlow.viewDetail') }}
            <i class="pi pi-angle-right" aria-hidden="true" />
          </button>
        </article>
      </li>
    </ul>

    <IncidentDetailDialog
      :open="!!detailId"
      :incident-id="detailId"
      :refresh-key="detailRefreshKey"
      @close="detailId = ''"
      @updated="loadIncidents"
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

.inc-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.inc-form__field textarea {
  width: 100%;
  min-height: 7rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 400;
  line-height: 1.5;
  color: var(--apple-text, #1d1d1f);
  resize: vertical;
  outline: none;
}

.inc-form__field textarea:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
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

.inc-card__detail {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0;
  border: none;
  background: transparent;
  color: #0071e3;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.inc-card__detail:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
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
