<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import IncidentDetailDialog from '@/incidents/presentation/components/IncidentDetailDialog.vue'
import {
  onIncidentRealtime,
  startIncidentRealtime,
} from '@/incidents/application/incidentRealtimeStore.js'
import {
  IncidentRealtimeEvent,
  INCIDENT_TITLE_MAX,
  INCIDENT_DESCRIPTION_MAX,
} from '@/incidents/domain/model/incidentConstants.js'
import {
  formatIncidentRelative,
  formatIncidentWhen,
  incidentEventLabel,
  incidentPriorityLabel,
  incidentStatusLabel,
  lastIncidentEvent,
} from '@/incidents/presentation/incidentLabels.js'
import '@/incidents/presentation/incidentDialog.css'

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
const composeError = ref('')
const draftTitle = ref('')
const draftDescription = ref('')
const submitAttempted = ref(false)
const titleTouched = ref(false)
const descriptionTouched = ref(false)
const statusFilter = ref('all')
const detailId = ref('')
const detailRefreshKey = ref(0)
/** Botones del diálogo de reporte: el Enter del formulario también confirma en el botón "Enviar". */
const composeActionsRef = ref(null)

// US024: campos vacíos en rojo con mensaje; el botón de envío queda bloqueado.
const titleInvalid = computed(
  () => (submitAttempted.value || titleTouched.value) && !draftTitle.value.trim(),
)
const descriptionInvalid = computed(
  () => (submitAttempted.value || descriptionTouched.value) && !draftDescription.value.trim(),
)
const canSubmit = computed(() => !!draftTitle.value.trim() && !!draftDescription.value.trim())

const statusOptions = computed(() => [
  { label: incidentStatusLabel(t, 'open'), value: 'open' },
  { label: incidentStatusLabel(t, 'in-progress'), value: 'in-progress' },
  { label: incidentStatusLabel(t, 'resolved'), value: 'resolved' },
])

const counts = computed(() => {
  const out = { all: incidents.value.length, open: 0, 'in-progress': 0, resolved: 0 }
  for (const row of incidents.value) {
    const status = row.status || 'open'
    out[status] = (out[status] ?? 0) + 1
  }
  return out
})

const filters = computed(() => [
  { id: 'all', label: t('incidentFlow.filterAll'), count: counts.value.all },
  ...statusOptions.value.map((opt) => ({ id: opt.value, label: opt.label, count: counts.value[opt.value] ?? 0 })),
])

const summaryCards = computed(() => [
  { id: 'open', tone: 'orange', icon: 'pi-exclamation-circle', label: t('resident.incidentsOpen'), value: counts.value.open },
  { id: 'in-progress', tone: 'blue', icon: 'pi-sync', label: t('resident.incidentsInProgress'), value: counts.value['in-progress'] },
  { id: 'resolved', tone: 'green', icon: 'pi-check-circle', label: t('resident.incidentsResolved'), value: counts.value.resolved },
])

const visibleIncidents = computed(() => {
  if (statusFilter.value === 'all') return incidents.value
  return incidents.value.filter((row) => (row.status || 'open') === statusFilter.value)
})

function resetDraft() {
  draftTitle.value = ''
  draftDescription.value = ''
  submitAttempted.value = false
  titleTouched.value = false
  descriptionTouched.value = false
  composeError.value = ''
}

function startCompose() {
  composing.value = true
  resetDraft()
}

function cancelCompose() {
  composing.value = false
  resetDraft()
}

function onComposeVisible(open) {
  if (!open && !sending.value) cancelCompose()
}

function openDetail(row) {
  detailId.value = row?.id ? String(row.id) : ''
}

function statusLabel(status) {
  return incidentStatusLabel(t, status || 'open')
}

function formatWhen(iso) {
  return formatIncidentWhen(locale.value, iso)
}

function lastEventText(row) {
  const ev = lastIncidentEvent(row)
  if (!ev) return null
  return {
    label: incidentEventLabel(t, ev),
    when: formatIncidentRelative(locale.value, ev.createdAt),
    iso: ev.createdAt,
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

async function reportIncident(event) {
  submitAttempted.value = true
  const title = draftTitle.value.trim()
  const text = draftDescription.value.trim()
  const residentId = profile.value.id
  const residentName = profile.value.name || ''
  if (!title || !text || !residentId || sending.value) return

  sending.value = true
  try {
    error.value = null
    composeError.value = ''
    let ownerAdminId = profile.value.ownerAdminId ?? null
    if (!ownerAdminId) {
      const row = await authApi.getProfileById(residentId)
      ownerAdminId = row?.ownerAdminId ?? null
    }

    const draftId = `incident-${Date.now()}`
    const created = await incidentsApi.add({
      id: draftId,
      residentId,
      residentName,
      title,
      description: text,
      status: 'open',
      createdAt: new Date().toISOString(),
      provider: '',
      ...(ownerAdminId ? { ownerAdminId } : {}),
    })
    const sendButton =
      event?.type === 'click' ? event : composeActionsRef.value?.$el?.querySelector('.bf-btn--confirm')
    await confirmSuccess(sendButton, t('feedback.incidentReported'))
    sending.value = false
    cancelCompose()
    statusFilter.value = 'all'
    await loadIncidents()
    markFresh('incident', created?.id ?? draftId)
  } catch (err) {
    composeError.value = err?.payload?.message || t('app.incidentsSaveError')
  } finally {
    sending.value = false
  }
}

// Tiempo real: cuando el admin asigna / cambia estado / resuelve, se refresca la vista.
let stopRealtime = () => {}

onMounted(() => {
  // Register synchronously so an unmount before the first load finishes still cleans up.
  stopRealtime = onIncidentRealtime((type, payload) => {
    if (type !== IncidentRealtimeEvent.UPDATED) return
    if (payload?.residentId && payload.residentId !== profile.value.id) return
    loadIncidents()
    if (detailId.value && payload?.id === detailId.value) detailRefreshKey.value++
  })
  void loadIncidents()
  startIncidentRealtime(profile.value.ownerAdminId)
})

onBeforeUnmount(() => stopRealtime())
</script>

<template>
  <div class="app-view rinc">
    <header class="rinc-head">
      <h1 class="bf-sr-only">{{ t('incidentFlow.myIncidentsTitle') }}</h1>
      <button type="button" class="rinc-btn rinc-btn--primary" @click="startCompose">
        <i class="pi pi-plus" aria-hidden="true" />
        {{ t('incidentFlow.reportIncident') }}
      </button>
    </header>

    <LoadErrorRetry v-if="loadFailed" :message="error" :loading="loading" @retry="loadIncidents" />

    <template v-else>
      <p v-if="error" class="rinc-alert" role="alert">{{ error }}</p>

      <section class="rinc-summary" :aria-label="t('incidentFlow.summaryAria')">
        <article v-for="card in summaryCards" :key="card.id" class="rinc-stat" :class="`rinc-stat--${card.tone}`">
          <span class="rinc-stat__icon" :class="`rinc-stat__icon--${card.tone}`" aria-hidden="true">
            <i class="pi" :class="card.icon" />
          </span>
          <div class="rinc-stat__text">
            <p class="rinc-stat__value">{{ loading && !incidents.length ? '…' : card.value }}</p>
            <h2 class="rinc-stat__label">{{ card.label }}</h2>
          </div>
        </article>
      </section>

      <section class="rinc-card" aria-labelledby="rinc-list-title">
        <div class="rinc-card__head">
          <h2 id="rinc-list-title" class="rinc-card__title">{{ t('incidentFlow.residentListTitle') }}</h2>
          <div
            v-if="incidents.length"
            class="rinc-filters" v-bf-seg
            role="group"
            :aria-label="t('incidentFlow.filterAria')"
          >
            <button
              v-for="filter in filters"
              :key="filter.id"
              type="button"
              class="rinc-filter"
              :class="[`rinc-filter--${filter.id}`, { 'is-active': statusFilter === filter.id }]"
              :aria-pressed="statusFilter === filter.id ? 'true' : 'false'"
              @click="statusFilter = filter.id"
            >
              {{ filter.label }}
              <span class="rinc-filter__count">{{ filter.count }}</span>
            </button>
          </div>
        </div>

        <p v-if="loading && !incidents.length" class="rinc-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('app.incidentsLoading') }}
        </p>

        <div v-else-if="!visibleIncidents.length" class="rinc-empty">
          <span class="rinc-empty__icon"><i class="pi" :class="incidents.length ? 'pi-filter-slash' : 'pi-flag'" aria-hidden="true" /></span>
          <p class="rinc-empty__text">
            {{ incidents.length ? t('incidentFlow.emptyFiltered') : t('resident.incidentsEmpty') }}
          </p>
          <p v-if="!incidents.length" class="rinc-empty__hint">{{ t('incidentFlow.residentEmptyHint') }}</p>
          <button v-if="incidents.length" type="button" class="rinc-btn" @click="statusFilter = 'all'">
            {{ t('incidentFlow.clearFilters') }}
          </button>
          <button v-else type="button" class="rinc-btn rinc-btn--primary" @click="startCompose">
            <i class="pi pi-plus" aria-hidden="true" />
            {{ t('incidentFlow.reportIncident') }}
          </button>
        </div>

        <ul v-else class="rinc-list" role="list">
          <li v-for="row in visibleIncidents" :key="row.id">
            <article
              class="rinc-item"
              :class="{ 'bf-fresh': isFresh('incident', row.id) }"
              :aria-labelledby="`rinc-item-${row.id}`"
            >
              <div class="rinc-item__top">
                <span class="inc-pill" :class="`inc-pill--${row.status || 'open'}`">
                  <span class="inc-pill__dot" aria-hidden="true" />
                  {{ statusLabel(row.status) }}
                </span>
                <span v-if="row.priority" class="inc-pill" :class="`inc-pill--${row.priority}`">
                  {{ incidentPriorityLabel(t, row.priority) }}
                </span>
                <time v-if="row.createdAt" class="rinc-item__date" :datetime="row.createdAt">
                  {{ formatWhen(row.createdAt) }}
                </time>
              </div>

              <h3 :id="`rinc-item-${row.id}`" class="rinc-item__title">{{ row.title || row.description }}</h3>
              <p v-if="row.title && row.description" class="rinc-item__desc">{{ row.description }}</p>

              <div class="rinc-provider" :class="{ 'is-empty': !row.provider }">
                <span class="rinc-provider__icon" aria-hidden="true">
                  <i class="pi" :class="row.provider ? 'pi-wrench' : 'pi-clock'" />
                </span>
                <div class="rinc-provider__text">
                  <template v-if="row.provider">
                    <strong>{{ row.provider }}</strong>
                    <small>
                      <template v-if="row.providerSpecialty">{{ row.providerSpecialty }}</template>
                      <template v-if="row.providerSpecialty && row.providerPhone"> · </template>
                      <a
                        v-if="row.providerPhone"
                        :href="`tel:${row.providerPhone}`"
                        :aria-label="t('incidentFlow.callProvider', { name: row.provider })"
                      >
                        <i class="pi pi-phone" aria-hidden="true" />
                        {{ row.providerPhone }}
                      </a>
                      <template v-if="!row.providerSpecialty && !row.providerPhone">{{ t('incidentFlow.assignedTech') }}</template>
                    </small>
                  </template>
                  <template v-else>
                    <strong>{{ t('incidentFlow.techPending') }}</strong>
                  </template>
                </div>
              </div>

              <p v-if="row.resolutionComment" class="rinc-item__resolution">
                <i class="pi pi-check-circle" aria-hidden="true" />
                <span>{{ row.resolutionComment }}</span>
              </p>

              <div class="rinc-item__foot">
                <p v-if="lastEventText(row)" class="rinc-item__last">
                  <span class="rinc-item__last-label">{{ t('incidentFlow.lastUpdate') }}:</span>
                  {{ lastEventText(row).label }}
                  <time :datetime="lastEventText(row).iso">· {{ lastEventText(row).when }}</time>
                </p>
                <span v-else />
                <button
                  type="button"
                  class="rinc-btn rinc-btn--sm"
                  :aria-label="t('incidentFlow.detailFor', { title: row.title || row.description })"
                  @click="openDetail(row)"
                >
                  {{ t('incidentFlow.viewDetail') }}
                  <i class="pi pi-angle-right" aria-hidden="true" />
                </button>
              </div>
            </article>
          </li>
        </ul>
      </section>
    </template>

    <!-- Reportar incidencia -->
    <Dialog
      :visible="composing"
      modal
      :header="t('app.residentIncidentsFormTitle')"
      class="inc-dialog"
      :style="{ width: 'min(32rem, 94vw)' }"
      :draggable="false"
      :closable="!sending"
      @update:visible="onComposeVisible"
    >
      <form class="incd-form" novalidate @submit.prevent="reportIncident">
        <p class="incd-note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          <span>{{ t('incidentFlow.reportHint') }}</span>
        </p>
        <div class="incd-field">
          <label for="inc-resident-title">{{ t('incidentFlow.titleLabel') }} *</label>
          <InputText
            id="inc-resident-title"
            v-model="draftTitle"
            :maxlength="INCIDENT_TITLE_MAX"
            :invalid="titleInvalid"
            :aria-invalid="titleInvalid"
            aria-describedby="inc-resident-title-error"
            :placeholder="t('incidentFlow.titlePlaceholder')"
            :disabled="sending"
            autocomplete="off"
            autofocus
            fluid
            @blur="titleTouched = true"
          />
          <p v-if="titleInvalid" id="inc-resident-title-error" class="incd-field__error" role="alert">
            {{ t('incidentFlow.fieldRequired') }}
          </p>
        </div>
        <div class="incd-field">
          <label for="inc-resident-description">{{ t('app.residentIncidentsDescriptionLabel') }} *</label>
          <textarea
            id="inc-resident-description"
            v-model="draftDescription"
            rows="5"
            :maxlength="INCIDENT_DESCRIPTION_MAX"
            :class="{ 'is-invalid': descriptionInvalid }"
            :aria-invalid="descriptionInvalid"
            aria-describedby="inc-resident-description-error"
            :placeholder="t('incidentFlow.descriptionPlaceholder')"
            :disabled="sending"
            @blur="descriptionTouched = true"
          />
          <p v-if="descriptionInvalid" id="inc-resident-description-error" class="incd-field__error" role="alert">
            {{ t('incidentFlow.fieldRequired') }}
          </p>
        </div>
        <p v-if="composeError" class="incd-alert" role="alert">{{ composeError }}</p>
      </form>
      <template #footer>
        <ConfirmActions
          ref="composeActionsRef"
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('incidentFlow.submitReport')"
          confirm-icon="pi pi-send"
          :loading="sending"
          :disabled="!canSubmit"
          @cancel="cancelCompose"
          @confirm="reportIncident"
        />
      </template>
    </Dialog>

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
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 72rem;
  box-sizing: border-box;
}

.rinc {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.rinc *,
.rinc *::before,
.rinc *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.rinc-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.rinc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.125rem;
  padding: 0.3rem 0.95rem;
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

.rinc-btn .pi {
  font-size: 0.78rem;
}

.rinc-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.rinc-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.rinc-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.rinc-btn--sm {
  min-height: 2.1rem;
  padding: 0.35rem 0.6rem 0.35rem 0.85rem;
  font-size: 0.78rem;
}

.rinc-btn:focus-visible,
.rinc-filter:focus-visible,
.rinc-provider a:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.rinc-alert {
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.84rem;
}

.rinc-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 1.25rem 0.25rem;
  font-size: 0.85rem;
  color: #6e6e73;
}

/* ---------- Summary ---------- */
.rinc-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.rinc-stat {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.85rem 1rem;
  border-radius: 16px;
  background: var(--stat-bg, #f1f5f9);
  min-width: 0;
}

.rinc-stat--orange { --stat-bg: #fdeee2; }
.rinc-stat--blue { --stat-bg: #e8eefc; }
.rinc-stat--green { --stat-bg: #e3f4e8; }

.rinc-stat__icon {
  width: 2.3rem;
  height: 2.3rem;
  border-radius: 12px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.9rem;
}

.rinc-stat__icon--orange { color: #c2410c; }
.rinc-stat__icon--blue { color: #1e3a8a; }
.rinc-stat__icon--green { color: #15803d; }

.rinc-stat__text {
  display: flex;
  flex-direction: column-reverse;
  min-width: 0;
}

.rinc-stat__value {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.rinc-stat__label {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

/* ---------- List card ---------- */
.rinc-card {
  padding: 1.1rem 1.25rem 1.2rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.rinc-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.95rem;
}

.rinc-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.rinc-filters {
  display: flex;
  flex-wrap: wrap;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.rinc-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.5rem 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.rinc-filter:hover:not(.is-active) {
  color: #0f172a;
}

.rinc-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.rinc-filter.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.rinc-filter.is-active .rinc-filter__count {
  background: #f1f5f9;
  color: #0f172a;
}

.rinc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
  gap: 0.75rem;
}

.rinc-item {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem 1.05rem;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
  min-width: 0;
}

.rinc-item__top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem 0.4rem;
}

.rinc-item__date {
  margin-left: auto;
  font-size: 0.74rem;
  color: #6e6e73;
  white-space: nowrap;
}

.rinc-item__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.rinc-item__desc {
  margin: -0.3rem 0 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #475569;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.rinc-provider {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.7rem;
  border-radius: 12px;
  background: #f8fafc;
  min-width: 0;
}

.rinc-provider.is-empty {
  background: #fdf3dc;
}

.rinc-provider__icon {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  background: #fff;
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
}

.rinc-provider.is-empty .rinc-provider__icon {
  color: #b45309;
}

.rinc-provider__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rinc-provider__text strong {
  font-size: 0.84rem;
  font-weight: 600;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.rinc-provider.is-empty .rinc-provider__text strong {
  color: #92400e;
}

.rinc-provider__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.rinc-provider a {
  color: #1e3a8a;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.rinc-provider a .pi {
  font-size: 0.65rem;
}

.rinc-provider a:hover {
  text-decoration: underline;
}

.rinc-item__resolution {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0;
  padding: 0.55rem 0.7rem;
  border-radius: 12px;
  background: #e3f4e8;
  color: #14532d;
  font-size: 0.8rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.rinc-item__resolution .pi {
  margin-top: 0.15rem;
  font-size: 0.75rem;
  color: #15803d;
}

.rinc-item__foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 0.75rem;
  padding-top: 0.6rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.rinc-item__last {
  margin: 0;
  min-width: 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #475569;
}

.rinc-item__last-label {
  font-weight: 600;
  color: #6e6e73;
}

.rinc-item__last time {
  color: #6e6e73;
}

/* ---------- Empty ---------- */
.rinc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.rinc-empty__icon {
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

.rinc-empty__text {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: #334155;
}

.rinc-empty__hint {
  margin: 0 0 0.25rem;
  font-size: 0.8rem;
  color: #6e6e73;
}

/* ---------- Responsive ---------- */
@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .rinc-head > .rinc-btn--primary {
    width: 100%;
  }
  .rinc-summary {
    gap: 0.5rem;
  }
  .rinc-stat {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem 0.8rem;
  }
  .rinc-stat__icon {
    width: 2rem;
    height: 2rem;
    border-radius: 10px;
    font-size: 0.8rem;
  }
  .rinc-stat__value {
    font-size: 1.25rem;
  }
  .rinc-card {
    padding: 1rem 0.85rem;
  }
  .rinc-item__foot {
    flex-direction: column;
    align-items: stretch;
  }
  .rinc-item__foot .rinc-btn {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rinc-btn {
    transition: none;
  }
}
</style>
