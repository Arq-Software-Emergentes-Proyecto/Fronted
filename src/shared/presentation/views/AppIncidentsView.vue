<script setup>
import { computed, ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import { useConfirmDialog } from '@/shared/presentation/composables/useConfirmDialog.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { serviceProvidersApi } from '@/incidents/infrastructure/serviceProvidersApi.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import IncidentResolveDialog from '@/incidents/presentation/components/IncidentResolveDialog.vue'
import IncidentTimeline from '@/incidents/presentation/components/IncidentTimeline.vue'
import {
  IncidentRealtimeEvent,
  IncidentStatus,
  INCIDENT_TITLE_MAX,
  INCIDENT_DESCRIPTION_MAX,
} from '@/incidents/domain/model/incidentConstants.js'
import {
  formatIncidentDate,
  formatIncidentRelative,
  formatIncidentWhen,
  incidentPriorityLabel,
  incidentPriorityOptions,
  incidentStatusLabel,
  initialsOf,
} from '@/incidents/presentation/incidentLabels.js'
import '@/incidents/presentation/incidentDialog.css'
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
const taskWorkerId = ref('')

async function loadActiveWorkers() {
  try {
    const list = await teamWorkersApi.list()
    activeWorkers.value = list.filter((w) => w?.id && w.status !== 'INACTIVE')
  } catch {
    activeWorkers.value = []
  }
}

async function createTaskFromIncident(row, staffId) {
  if (!staffId || taskBusyId.value) return
  taskBusyId.value = row.id
  taskNotice.value = { id: '', text: '', error: false }
  try {
    const description = [row.title, row.description].filter(Boolean).join(' — ').slice(0, 2000)
    await teamTasksApi.create({ staffId, incidentId: row.id, description: description || row.id })
    taskNotice.value = { id: row.id, text: t('teamMgmt.tasks.createdFromIncident'), error: false }
    taskWorkerId.value = ''
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
const NO_PROVIDER = '__none__'

const incidents = ref([])
const serviceProviders = ref([])
const residents = ref([])
const loading = ref(false)
const error = ref(null)
/** RNF012: the incidents list itself failed to load (retryable). */
const loadFailed = ref(false)
const composing = ref(false)
const sending = ref(false)
const composeError = ref('')
const savingId = ref('')
const draftTitle = ref('')
const draftDescription = ref('')
const draftProviderId = ref('')
const draftPriority = ref('')
const draftCategory = ref('')
const titleTouched = ref(false)
const descriptionTouched = ref(false)
const statusFilter = ref('all')
const priorityFilter = ref('all')
const search = ref('')
const resolving = ref(null)
const resolveError = ref('')

const statusOptions = computed(() => [
  { label: incidentStatusLabel(t, IncidentStatus.OPEN), value: IncidentStatus.OPEN },
  { label: incidentStatusLabel(t, IncidentStatus.IN_PROGRESS), value: IncidentStatus.IN_PROGRESS },
  { label: incidentStatusLabel(t, IncidentStatus.RESOLVED), value: IncidentStatus.RESOLVED },
])

const priorityOptions = computed(() => incidentPriorityOptions(t))

const priorityFilterOptions = computed(() => [
  { value: 'all', label: t('incidentFlow.priorityAll') },
  ...priorityOptions.value,
  { value: 'none', label: t('incidentFlow.priorityNone') },
])

function statusOf(row) {
  return row?.status || IncidentStatus.OPEN
}

const statusCounts = computed(() => {
  const counts = { all: incidents.value.length }
  for (const opt of statusOptions.value) counts[opt.value] = 0
  for (const row of incidents.value) counts[statusOf(row)] = (counts[statusOf(row)] ?? 0) + 1
  return counts
})

const filters = computed(() => [
  { id: 'all', label: t('incidentFlow.filterAll'), count: statusCounts.value.all },
  ...statusOptions.value.map((opt) => ({
    id: opt.value,
    label: opt.label,
    count: statusCounts.value[opt.value] ?? 0,
  })),
])

const providerOptions = computed(() =>
  serviceProviders.value
    .filter((row) => row?.id && String(row?.name ?? '').trim())
    .map((row) => ({ id: String(row.id), name: String(row.name).trim(), specialty: row.specialty || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)

const draftProviderOptions = computed(() =>
  providerOptions.value.map((p) => ({
    id: p.id,
    label: p.specialty ? `${p.name} · ${p.specialty}` : p.name,
  })),
)

const workerOptions = computed(() =>
  activeWorkers.value.map((w) => ({ id: String(w.id), name: w.name || String(w.id) })),
)

const residentsById = computed(() => {
  const map = new Map()
  for (const r of residents.value) if (r?.id) map.set(String(r.id), r)
  return map
})

function residentUnit(row) {
  const resident = row?.residentId ? residentsById.value.get(String(row.residentId)) : null
  const code = resident?.code || resident?.department || ''
  return code ? t('incidentFlow.residentUnit', { code }) : ''
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
}

const searchNeedle = computed(() => normalizeText(search.value.trim()))

const visibleIncidents = computed(() =>
  incidents.value.filter((row) => {
    if (statusFilter.value !== 'all' && statusOf(row) !== statusFilter.value) return false
    if (priorityFilter.value === 'none' && row.priority) return false
    if (!['all', 'none'].includes(priorityFilter.value) && row.priority !== priorityFilter.value) return false
    if (!searchNeedle.value) return true
    const haystack = normalizeText(
      [row.title, row.description, row.residentName, row.provider, row.category, residentUnit(row)].join(' '),
    )
    return haystack.includes(searchNeedle.value)
  }),
)

const hasActiveFilters = computed(
  () => statusFilter.value !== 'all' || priorityFilter.value !== 'all' || !!search.value.trim(),
)

function clearFilters() {
  statusFilter.value = 'all'
  priorityFilter.value = 'all'
  search.value = ''
}

/** Summary cards. "Resueltas este mes" usa resolvedAt (o la última actualización). */
const monthLabel = computed(() => {
  const tag = locale.value === 'es' ? 'es-PE' : 'en-US'
  const month = new Date().toLocaleDateString(tag, { month: 'long' })
  // Spanish month names are lowercase mid-sentence ("Cerradas en octubre").
  return locale.value === 'es' ? month.toLocaleLowerCase(tag) : month
})

const summary = computed(() => {
  const now = new Date()
  const ym = `${now.getFullYear()}-${now.getMonth()}`
  let open = 0
  let inProgress = 0
  let resolvedMonth = 0
  let unassigned = 0
  for (const row of incidents.value) {
    const status = statusOf(row)
    if (status === IncidentStatus.OPEN) open++
    if (status === IncidentStatus.IN_PROGRESS) inProgress++
    if (status === IncidentStatus.RESOLVED) {
      const when = new Date(row.resolvedAt || row.updatedAt || row.createdAt || 0)
      if (`${when.getFullYear()}-${when.getMonth()}` === ym) resolvedMonth++
    } else if (!row.provider && !row.providerId) {
      unassigned++
    }
  }
  return { open, inProgress, resolvedMonth, unassigned }
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

function statusLabel(status) {
  return incidentStatusLabel(t, status)
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

function rowProviderOptions(row) {
  const options = [{ id: NO_PROVIDER, name: t('app.incidentUnassignProvider') }]
  if (row && providerValue(row) === LEGACY_PROVIDER) {
    options.push({ id: LEGACY_PROVIDER, name: row.provider, disabled: true })
  }
  return options.concat(providerOptions.value.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty })))
}

function formatDate(iso) {
  return formatIncidentDate(locale.value, iso)
}

function formatRelative(iso) {
  return formatIncidentRelative(locale.value, iso)
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

/** Solo para mostrar el departamento junto al residente (best effort). */
async function loadResidents() {
  try {
    const list = await residentsApi.list()
    residents.value = Array.isArray(list) ? list : []
  } catch {
    residents.value = []
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
    if (detailId.value && !incidents.value.some((row) => String(row.id) === detailId.value)) {
      closeDetail()
    }
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
    composeError.value = ''
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
    sending.value = false
    cancelCompose()
    await loadIncidents()
  } catch (err) {
    composeError.value = resolveErrorMessage(err)
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
    if (detailId.value === String(row.id)) await loadDetail()
  } catch (err) {
    error.value = resolveErrorMessage(err)
  } finally {
    savingId.value = ''
  }
}

/** Estado: "Resuelto" abre el modal que exige comentario de resolución (US031). */
function setStatus(row, next) {
  if (!row || !next || next === statusOf(row)) return
  if (next === IncidentStatus.RESOLVED) {
    resolveError.value = ''
    resolving.value = row
    return
  }
  runSave(row, () => incidentsApi.update(row.id, { ...row, status: next }))
}

/** PATCH /assign: asignar un proveedor pasa la incidencia abierta a "en proceso". */
function assignProvider(row, value) {
  if (!row || value === LEGACY_PROVIDER) return
  const providerId = value === NO_PROVIDER ? '' : value || ''
  if (providerId === providerValue(row)) return
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
    if (detailId.value === String(row.id)) await loadDetail()
  } catch (err) {
    resolveError.value = resolveErrorMessage(err)
  } finally {
    savingId.value = ''
  }
}

/* ---------- Delete (shared BuildingFex confirm dialog) ---------- */
const askConfirm = useConfirmDialog()

async function askDelete(row) {
  if (!row?.id) return
  const confirmed = await askConfirm({
    header: t('incidentFlow.deleteTitle'),
    message: t('incidentFlow.deleteConfirm', { title: row.title || row.description || '' }),
    acceptLabel: t('app.deleteAction'),
    rejectLabel: t('app.cancelAction'),
    icon: 'pi pi-trash',
    danger: true,
  })
  if (!confirmed) return
  try {
    error.value = null
    await incidentsApi.remove(row.id)
    if (detailId.value === String(row.id)) closeDetail()
    await loadIncidents()
  } catch (err) {
    error.value = resolveErrorMessage(err)
  }
}

/* ---------- Detail / manage dialog ---------- */
const detailId = ref('')
const detailData = ref(null)
const detailLoading = ref(false)
const detailFocus = ref('')
const providerFieldRef = ref(null)
const taskFieldRef = ref(null)

const detailRow = computed(() =>
  detailId.value ? incidents.value.find((row) => String(row.id) === detailId.value) ?? null : null,
)

const detailEvents = computed(() => {
  const fromDetail = detailData.value?.events
  if (Array.isArray(fromDetail)) return fromDetail
  return Array.isArray(detailRow.value?.events) ? detailRow.value.events : []
})

async function loadDetail() {
  const id = detailId.value
  if (!id) return
  detailLoading.value = true
  try {
    const data = await incidentsApi.get(id)
    if (detailId.value === id) detailData.value = data
  } catch {
    // The list row is enough to manage the incident; the timeline falls back to it.
  } finally {
    detailLoading.value = false
  }
}

function openDetail(row, focus = '') {
  if (!row?.id) return
  error.value = loadFailed.value ? error.value : null
  detailId.value = String(row.id)
  detailData.value = null
  detailFocus.value = focus
  taskWorkerId.value = ''
  if (taskNotice.value.id !== row.id) taskNotice.value = { id: '', text: '', error: false }
  void loadDetail()
}

function closeDetail() {
  detailId.value = ''
  detailData.value = null
  detailFocus.value = ''
}

/** PrimeVue Dialog focuses `[autofocus]` after its enter transition ('show' fires before it). */
async function onDetailShow() {
  await nextTick()
  for (const ref of [providerFieldRef.value, taskFieldRef.value]) {
    ref?.querySelectorAll('[autofocus]').forEach((el) => el.removeAttribute('autofocus'))
  }
  const target = detailFocus.value === 'provider' ? providerFieldRef.value : detailFocus.value === 'task' ? taskFieldRef.value : null
  const focusable = target?.querySelector('[role="combobox"], input, button')
  focusable?.setAttribute('autofocus', '')
}

/* ---------- Row actions menu ---------- */
const rowMenu = ref(null)
const menuRow = ref(null)

const menuItems = computed(() => {
  const row = menuRow.value
  if (!row) return []
  const status = statusOf(row)
  const items = [
    { label: t('incidentFlow.manage'), icon: 'pi pi-sliders-h', command: () => openDetail(row) },
    { separator: true },
  ]
  if (status !== IncidentStatus.OPEN) {
    items.push({ label: t('incidentFlow.markOpen'), icon: 'pi pi-circle', command: () => setStatus(row, IncidentStatus.OPEN) })
  }
  if (status !== IncidentStatus.IN_PROGRESS) {
    items.push({ label: t('incidentFlow.markInProgress'), icon: 'pi pi-sync', command: () => setStatus(row, IncidentStatus.IN_PROGRESS) })
  }
  if (status !== IncidentStatus.RESOLVED) {
    items.push({ label: t('incidentFlow.markResolved'), icon: 'pi pi-check-circle', command: () => setStatus(row, IncidentStatus.RESOLVED) })
  }
  items.push(
    { separator: true },
    { label: t('incidentFlow.assignProvider'), icon: 'pi pi-wrench', command: () => openDetail(row, 'provider') },
  )
  if (activeWorkers.value.length) {
    items.push({ label: t('teamMgmt.tasks.createFromIncident'), icon: 'pi pi-briefcase', command: () => openDetail(row, 'task') })
  }
  items.push(
    { separator: true },
    { label: t('app.deleteAction'), icon: 'pi pi-trash', class: 'inc-menu__danger', command: () => askDelete(row) },
  )
  return items
})

function toggleRowMenu(event, row) {
  menuRow.value = row
  rowMenu.value?.toggle(event)
}

// RF024: nuevas incidencias / cambios en tiempo real (conexión iniciada por el shell del admin).
let stopRealtime = () => {}

onMounted(async () => {
  markIncidentsSeen()
  stopRealtime = onIncidentRealtime((type, payload) => {
    if (type === IncidentRealtimeEvent.CREATED) markIncidentsSeen()
    if (type === IncidentRealtimeEvent.CREATED || type === IncidentRealtimeEvent.UPDATED) {
      loadIncidents({ silent: true })
      if (detailId.value && (!payload?.id || String(payload.id) === detailId.value)) loadDetail()
    }
  })
  await Promise.all([loadIncidents(), loadServiceProviders(), loadActiveWorkers(), loadResidents()])
})

onBeforeUnmount(() => stopRealtime())
</script>

<template>
  <div class="app-view inc">
    <header class="inc-head">
      <div class="inc-head__text">
        <h1 class="inc-head__title">{{ t('app.pageIncidents') }}</h1>
        <p class="inc-head__sub">{{ t('app.incidentsAdminSubtitle') }}</p>
      </div>
      <div class="inc-head__actions">
        <button
          type="button"
          class="inc-icon-btn"
          :aria-label="t('incidentFlow.refresh')"
          :title="t('incidentFlow.refresh')"
          :disabled="loading"
          @click="loadIncidents()"
        >
          <i class="pi" :class="loading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
        </button>
        <button type="button" class="inc-btn inc-btn--primary" @click="startCompose">
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('incidentFlow.newIncident') }}
        </button>
      </div>
    </header>

    <LoadErrorRetry v-if="loadFailed" :message="error" :loading="loading" @retry="loadIncidents()" />

    <template v-else>
      <p v-if="error && !detailId" class="inc-alert" role="alert">
        <i class="pi pi-exclamation-circle" aria-hidden="true" />
        {{ error }}
      </p>

      <section class="inc-summary" :aria-label="t('incidentFlow.summaryAria')">
        <article class="inc-stat inc-stat--orange">
          <div class="inc-stat__head">
            <h2 class="inc-stat__label">{{ t('incidentFlow.summaryOpen') }}</h2>
            <span class="inc-stat__icon inc-stat__icon--orange"><i class="pi pi-exclamation-circle" aria-hidden="true" /></span>
          </div>
          <p class="inc-stat__value">{{ loading && !incidents.length ? '…' : summary.open }}</p>
          <p class="inc-stat__hint">{{ t('incidentFlow.summaryOpenHint') }}</p>
        </article>
        <article class="inc-stat inc-stat--blue">
          <div class="inc-stat__head">
            <h2 class="inc-stat__label">{{ t('incidentFlow.summaryInProgress') }}</h2>
            <span class="inc-stat__icon inc-stat__icon--blue"><i class="pi pi-sync" aria-hidden="true" /></span>
          </div>
          <p class="inc-stat__value">{{ loading && !incidents.length ? '…' : summary.inProgress }}</p>
          <p class="inc-stat__hint">{{ t('incidentFlow.summaryInProgressHint') }}</p>
        </article>
        <article class="inc-stat inc-stat--green">
          <div class="inc-stat__head">
            <h2 class="inc-stat__label">{{ t('incidentFlow.summaryResolvedMonth') }}</h2>
            <span class="inc-stat__icon inc-stat__icon--green"><i class="pi pi-check-circle" aria-hidden="true" /></span>
          </div>
          <p class="inc-stat__value">{{ loading && !incidents.length ? '…' : summary.resolvedMonth }}</p>
          <p class="inc-stat__hint">{{ t('incidentFlow.summaryResolvedMonthHint', { month: monthLabel }) }}</p>
        </article>
        <article class="inc-stat inc-stat--amber">
          <div class="inc-stat__head">
            <h2 class="inc-stat__label">{{ t('incidentFlow.summaryUnassigned') }}</h2>
            <span class="inc-stat__icon inc-stat__icon--amber"><i class="pi pi-wrench" aria-hidden="true" /></span>
          </div>
          <p class="inc-stat__value">{{ loading && !incidents.length ? '…' : summary.unassigned }}</p>
          <p class="inc-stat__hint">{{ t('incidentFlow.summaryUnassignedHint') }}</p>
        </article>
      </section>

      <section class="inc-card" aria-labelledby="inc-list-title">
        <div class="inc-card__head">
          <div>
            <h2 id="inc-list-title" class="inc-card__title">{{ t('app.incidentsAdminListTitle') }}</h2>
            <p class="inc-card__hint">{{ t('incidentFlow.listHint') }}</p>
          </div>
          <span class="inc-card__count">{{ t('incidentFlow.incidentCount', visibleIncidents.length) }}</span>
        </div>

        <div class="inc-toolbar">
          <div class="inc-filters" role="group" :aria-label="t('incidentFlow.filterAria')">
            <button
              v-for="filter in filters"
              :key="filter.id"
              type="button"
              class="inc-filter"
              :class="[`inc-filter--${filter.id}`, { 'is-active': statusFilter === filter.id }]"
              :aria-pressed="statusFilter === filter.id ? 'true' : 'false'"
              @click="statusFilter = filter.id"
            >
              {{ filter.label }}
              <span class="inc-filter__count">{{ filter.count }}</span>
            </button>
          </div>
          <div class="inc-toolbar__right">
            <label class="inc-search" for="inc-search-input">
              <i class="pi pi-search" aria-hidden="true" />
              <input
                id="inc-search-input"
                v-model="search"
                type="search"
                :placeholder="t('incidentFlow.searchPlaceholder')"
                :aria-label="t('incidentFlow.searchLabel')"
              />
            </label>
            <Select
              v-model="priorityFilter"
              :options="priorityFilterOptions"
              option-label="label"
              option-value="value"
              class="inc-priority-filter"
              :aria-label="t('incidentFlow.priorityFilterLabel')"
            >
              <template #value="{ value }">
                <span class="inc-priority-filter__value">
                  <i class="pi pi-flag" aria-hidden="true" />
                  {{ priorityFilterOptions.find((o) => o.value === value)?.label }}
                </span>
              </template>
            </Select>
          </div>
        </div>

        <p v-if="loading && !incidents.length" class="inc-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('app.incidentsLoading') }}
        </p>

        <div v-else-if="!visibleIncidents.length" class="inc-empty">
          <span class="inc-empty__icon"><i class="pi" :class="incidents.length ? 'pi-filter-slash' : 'pi-flag'" aria-hidden="true" /></span>
          <p class="inc-empty__text">
            {{ incidents.length ? t('incidentFlow.emptyFiltered') : t('app.incidentsEmptyList') }}
          </p>
          <p v-if="!incidents.length" class="inc-empty__hint">{{ t('incidentFlow.emptyAdminHint') }}</p>
          <div class="inc-empty__actions">
            <button v-if="incidents.length && hasActiveFilters" type="button" class="inc-btn" @click="clearFilters">
              <i class="pi pi-filter-slash" aria-hidden="true" />
              {{ t('incidentFlow.clearFilters') }}
            </button>
            <button v-else type="button" class="inc-btn inc-btn--primary" @click="startCompose">
              <i class="pi pi-plus" aria-hidden="true" />
              {{ t('incidentFlow.newIncident') }}
            </button>
          </div>
        </div>

        <div v-else class="inc-table-wrap">
          <table class="inc-table">
            <thead>
              <tr>
                <th scope="col">{{ t('incidentFlow.colIncident') }}</th>
                <th scope="col">{{ t('app.incidentResidentName') }}</th>
                <th scope="col">{{ t('app.incidentStatus') }}</th>
                <th scope="col">{{ t('app.incidentProvider') }}</th>
                <th scope="col">{{ t('incidentFlow.colReported') }}</th>
                <th scope="col" class="is-actions">
                  <span class="visually-hidden">{{ t('app.incidentActions') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visibleIncidents" :key="row.id" :class="{ 'is-saving': savingId === row.id }">
                <td class="c-main">
                  <div class="inc-item">
                    <strong class="inc-item__title">{{ row.title || row.description }}</strong>
                    <span v-if="row.title && row.description" class="inc-item__desc">{{ row.description }}</span>
                    <span v-if="row.priority || row.category" class="inc-item__tags">
                      <span v-if="row.priority" class="inc-pill" :class="`inc-pill--${row.priority}`">
                        <i class="pi pi-flag" aria-hidden="true" />
                        {{ incidentPriorityLabel(t, row.priority) }}
                      </span>
                      <span v-if="row.category" class="inc-pill inc-pill--soft">{{ row.category }}</span>
                    </span>
                  </div>
                </td>
                <td class="c-resident" :data-label="t('app.incidentResidentName')">
                  <div class="inc-res">
                    <span v-if="row.residentName" class="inc-avatar" aria-hidden="true">{{ initialsOf(row.residentName) }}</span>
                    <span v-else class="inc-avatar inc-avatar--admin" aria-hidden="true"><i class="pi pi-building" /></span>
                    <div class="inc-res__text">
                      <strong>{{ row.residentName || t('incidentFlow.authorAdmin') }}</strong>
                      <small>{{ row.residentName ? residentUnit(row) : t('incidentFlow.adminLogged') }}</small>
                    </div>
                  </div>
                </td>
                <td class="c-status" :data-label="t('app.incidentStatus')">
                  <span class="inc-pill" :class="`inc-pill--${statusOf(row)}`">
                    <span class="inc-pill__dot" aria-hidden="true" />
                    {{ statusLabel(row.status) }}
                  </span>
                </td>
                <td class="c-provider" :data-label="t('app.incidentProvider')">
                  <button
                    type="button"
                    class="inc-provider"
                    :class="{ 'is-empty': !row.provider }"
                    :aria-label="t('incidentFlow.assignProviderFor', { title: row.title || row.description })"
                    :disabled="savingId === row.id"
                    @click="openDetail(row, 'provider')"
                  >
                    <i class="pi" :class="row.provider ? 'pi-wrench' : 'pi-plus'" aria-hidden="true" />
                    <span>{{ row.provider || t('incidentFlow.assignProvider') }}</span>
                  </button>
                </td>
                <td class="c-date" :data-label="t('incidentFlow.colReported')">
                  <time v-if="row.createdAt" :datetime="row.createdAt" :title="formatIncidentWhen(locale, row.createdAt)">
                    <span class="inc-date">{{ formatDate(row.createdAt) }}</span>
                    <span class="inc-rel">{{ formatRelative(row.createdAt) }}</span>
                  </time>
                  <span v-else class="inc-rel">—</span>
                </td>
                <td class="c-actions">
                  <div class="inc-row-actions">
                    <button
                      type="button"
                      class="inc-chip"
                      :aria-label="t('incidentFlow.manageFor', { title: row.title || row.description })"
                      @click="openDetail(row)"
                    >
                      <i class="pi" :class="savingId === row.id ? 'pi-spin pi-spinner' : 'pi-sliders-h'" aria-hidden="true" />
                      {{ t('incidentFlow.manage') }}
                    </button>
                    <button
                      type="button"
                      class="inc-kebab"
                      aria-haspopup="true"
                      :aria-label="t('incidentFlow.moreActions', { title: row.title || row.description })"
                      :disabled="savingId === row.id"
                      @click="toggleRowMenu($event, row)"
                    >
                      <i class="pi pi-ellipsis-v" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <Menu ref="rowMenu" :model="menuItems" popup class="inc-menu" />

    <!-- Nueva incidencia -->
    <Dialog
      :visible="composing"
      modal
      :header="t('incidentFlow.newIncident')"
      class="inc-dialog"
      :style="{ width: 'min(34rem, 94vw)' }"
      :draggable="false"
      :closable="!sending"
      @update:visible="onComposeVisible"
    >
      <form id="inc-create-form" class="incd-form" novalidate @submit.prevent="createIncident">
        <p class="incd-hint">{{ t('incidentFlow.createDialogHint') }}</p>
        <div class="incd-field">
          <label for="inc-draft-title">{{ t('incidentFlow.titleLabel') }} *</label>
          <InputText
            id="inc-draft-title"
            v-model="draftTitle"
            :maxlength="INCIDENT_TITLE_MAX"
            :invalid="titleInvalid"
            :aria-invalid="titleInvalid"
            aria-describedby="inc-draft-title-error"
            :placeholder="t('incidentFlow.titlePlaceholder')"
            :disabled="sending"
            autocomplete="off"
            autofocus
            fluid
            @blur="titleTouched = true"
          />
          <p v-if="titleInvalid" id="inc-draft-title-error" class="incd-field__error" role="alert">
            {{ t('incidentFlow.fieldRequired') }}
          </p>
        </div>
        <div class="incd-field">
          <label for="inc-draft-description">{{ t('app.incidentDescription') }} *</label>
          <textarea
            id="inc-draft-description"
            v-model="draftDescription"
            rows="4"
            :maxlength="INCIDENT_DESCRIPTION_MAX"
            :class="{ 'is-invalid': descriptionInvalid }"
            :aria-invalid="descriptionInvalid"
            aria-describedby="inc-draft-description-error"
            :placeholder="t('incidentFlow.descriptionPlaceholder')"
            :disabled="sending"
            @blur="descriptionTouched = true"
          />
          <p v-if="descriptionInvalid" id="inc-draft-description-error" class="incd-field__error" role="alert">
            {{ t('incidentFlow.fieldRequired') }}
          </p>
        </div>
        <div class="incd-form__row">
          <div class="incd-field">
            <label for="inc-draft-priority">{{ t('incidentFlow.priorityLabel') }}</label>
            <Select
              v-model="draftPriority"
              input-id="inc-draft-priority"
              :options="priorityOptions"
              option-label="label"
              option-value="value"
              :placeholder="t('incidentFlow.priorityNone')"
              :disabled="sending"
              show-clear
              fluid
            />
          </div>
          <div class="incd-field">
            <label for="inc-draft-category">{{ t('incidentFlow.categoryLabel') }}</label>
            <InputText
              id="inc-draft-category"
              v-model="draftCategory"
              maxlength="50"
              :placeholder="t('incidentFlow.categoryPlaceholder')"
              :disabled="sending"
              autocomplete="off"
              fluid
            />
          </div>
        </div>
        <div class="incd-field">
          <label for="inc-draft-provider">{{ t('app.incidentProvider') }}</label>
          <Select
            v-model="draftProviderId"
            input-id="inc-draft-provider"
            :options="draftProviderOptions"
            option-label="label"
            option-value="id"
            :placeholder="t('app.incidentUnassignProvider')"
            :disabled="sending || !providerOptions.length"
            show-clear
            fluid
          />
          <p v-if="!serviceProviders.length" class="incd-field__hint">
            {{ t('app.incidentProvidersEmptyHint') }}
          </p>
        </div>
        <p v-if="composeError" class="incd-alert" role="alert">{{ composeError }}</p>
      </form>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('incidentFlow.createSubmit')"
          confirm-icon="pi pi-check"
          :loading="sending"
          :disabled="!canSubmit"
          @cancel="cancelCompose"
          @confirm="createIncident"
        />
      </template>
    </Dialog>

    <!-- Gestionar incidencia -->
    <Dialog
      :visible="!!detailRow"
      modal
      :header="detailRow?.title || t('incidentFlow.detailTitle')"
      class="inc-dialog"
      :style="{ width: 'min(38rem, 94vw)' }"
      :draggable="false"
      :dismissable-mask="true"
      @update:visible="(v) => { if (!v) closeDetail() }"
      @show="onDetailShow"
    >
      <div v-if="detailRow" class="incd-body">
        <div class="incd-meta">
          <span class="inc-pill" :class="`inc-pill--${statusOf(detailRow)}`">
            <span class="inc-pill__dot" aria-hidden="true" />
            {{ statusLabel(detailRow.status) }}
          </span>
          <span v-if="detailRow.priority" class="inc-pill" :class="`inc-pill--${detailRow.priority}`">
            <i class="pi pi-flag" aria-hidden="true" />
            {{ incidentPriorityLabel(t, detailRow.priority) }}
          </span>
          <span v-if="detailRow.category" class="inc-pill inc-pill--soft">{{ detailRow.category }}</span>
          <time v-if="detailRow.createdAt" class="incd-muted" :datetime="detailRow.createdAt">
            {{ t('incidentFlow.reportedOn', { date: formatIncidentWhen(locale, detailRow.createdAt) }) }}
          </time>
        </div>

        <div class="inc-res">
          <span v-if="detailRow.residentName" class="inc-avatar" aria-hidden="true">{{ initialsOf(detailRow.residentName) }}</span>
          <span v-else class="inc-avatar inc-avatar--admin" aria-hidden="true"><i class="pi pi-building" /></span>
          <div class="inc-res__text">
            <strong>{{ detailRow.residentName || t('incidentFlow.authorAdmin') }}</strong>
            <small>{{ detailRow.residentName ? residentUnit(detailRow) : t('incidentFlow.adminLogged') }}</small>
          </div>
        </div>

        <p class="incd-text">{{ detailRow.description }}</p>

        <p v-if="error" class="incd-alert" role="alert">{{ error }}</p>

        <section v-if="detailRow.resolutionComment" class="incd-block incd-block--resolved" aria-labelledby="incd-resolution">
          <h3 id="incd-resolution" class="incd-block__title">{{ t('incidentFlow.resolutionTitle') }}</h3>
          <p class="incd-text">{{ detailRow.resolutionComment }}</p>
          <p v-if="detailRow.resolvedAt" class="incd-muted">
            {{ t('incidentFlow.resolvedAt', { date: formatIncidentWhen(locale, detailRow.resolvedAt) }) }}
          </p>
        </section>

        <section class="incd-block" aria-labelledby="incd-status-title">
          <h3 id="incd-status-title" class="incd-block__title">{{ t('app.incidentStatus') }}</h3>
          <div class="incd-segment" role="group" :aria-labelledby="'incd-status-title'">
            <button
              v-for="opt in statusOptions"
              :key="opt.value"
              type="button"
              class="incd-segment__btn"
              :class="`incd-segment__btn--${opt.value}`"
              :aria-pressed="statusOf(detailRow) === opt.value ? 'true' : 'false'"
              :disabled="savingId === detailRow.id"
              @click="setStatus(detailRow, opt.value)"
            >
              <span class="incd-dot" aria-hidden="true" />
              {{ opt.label }}
            </button>
          </div>
        </section>

        <section ref="providerFieldRef" class="incd-block" aria-labelledby="incd-provider-title">
          <h3 id="incd-provider-title" class="incd-block__title">{{ t('app.incidentProvider') }}</h3>
          <Select
            :model-value="providerValue(detailRow) || NO_PROVIDER"
            :options="rowProviderOptions(detailRow)"
            option-label="name"
            option-value="id"
            option-disabled="disabled"
            :disabled="savingId === detailRow.id"
            aria-labelledby="incd-provider-title"
            fluid
            @update:model-value="(v) => assignProvider(detailRow, v)"
          >
            <template #option="{ option }">
              <span class="inc-opt">
                <span>{{ option.name }}</span>
                <small v-if="option.specialty">{{ option.specialty }}</small>
              </span>
            </template>
          </Select>
          <p v-if="detailRow.provider && (detailRow.providerPhone || detailRow.providerSpecialty)" class="incd-muted">
            <template v-if="detailRow.providerSpecialty">{{ detailRow.providerSpecialty }}</template>
            <template v-if="detailRow.providerSpecialty && detailRow.providerPhone"> · </template>
            <a v-if="detailRow.providerPhone" :href="`tel:${detailRow.providerPhone}`">{{ detailRow.providerPhone }}</a>
          </p>
          <p v-if="!serviceProviders.length" class="incd-muted">{{ t('app.incidentProvidersEmptyHint') }}</p>
        </section>

        <section ref="taskFieldRef" class="incd-block" aria-labelledby="incd-task-title">
          <h3 id="incd-task-title" class="incd-block__title">{{ t('teamMgmt.tasks.createFromIncident') }}</h3>
          <template v-if="workerOptions.length">
            <p class="incd-muted">{{ t('incidentFlow.taskHint') }}</p>
            <div class="incd-inline">
              <Select
                v-model="taskWorkerId"
                :options="workerOptions"
                option-label="name"
                option-value="id"
                :placeholder="t('teamMgmt.tasks.workerPlaceholder')"
                :disabled="taskBusyId === detailRow.id"
                aria-labelledby="incd-task-title"
              />
              <button
                type="button"
                class="incd-btn"
                :disabled="!taskWorkerId || taskBusyId === detailRow.id"
                @click="createTaskFromIncident(detailRow, taskWorkerId)"
              >
                <i class="pi" :class="taskBusyId === detailRow.id ? 'pi-spin pi-spinner' : 'pi-briefcase'" aria-hidden="true" />
                {{ t('incidentFlow.taskCreate') }}
              </button>
            </div>
          </template>
          <p v-else class="incd-muted">{{ t('incidentFlow.noWorkersHint') }}</p>
          <p
            v-if="taskNotice.id === detailRow.id && taskNotice.text"
            class="incd-note"
            :class="taskNotice.error ? 'incd-note--error' : 'incd-note--ok'"
            role="status"
          >
            <i class="pi" :class="taskNotice.error ? 'pi-exclamation-circle' : 'pi-check'" aria-hidden="true" />
            <span>{{ taskNotice.text }}</span>
          </p>
        </section>

        <section class="incd-block" aria-labelledby="incd-timeline-title" :aria-busy="detailLoading ? 'true' : 'false'">
          <h3 id="incd-timeline-title" class="incd-block__title">{{ t('incidentFlow.timelineTitle') }}</h3>
          <IncidentTimeline :events="detailEvents" />
        </section>
      </div>
      <template #footer>
        <div v-if="detailRow" class="incd-footer">
          <button type="button" class="incd-btn incd-btn--danger" @click="askDelete(detailRow)">
            <i class="pi pi-trash" aria-hidden="true" />
            {{ t('app.deleteAction') }}
          </button>
          <button type="button" class="incd-btn incd-btn--primary" @click="closeDetail">
            {{ t('information.close') }}
          </button>
        </div>
      </template>
    </Dialog>

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
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.inc {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.inc *,
.inc *::before,
.inc *::after {
  box-sizing: border-box;
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

/* ---------- Header ---------- */
.inc-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.inc-head__text {
  min-width: 0;
}

.inc-head__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.inc-head__sub {
  margin: 0.25rem 0 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

.inc-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 0.95rem;
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

.inc-btn .pi {
  font-size: 0.78rem;
}

.inc-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.inc-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.inc-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.inc-icon-btn {
  width: 2.45rem;
  height: 2.45rem;
  border-radius: 50%;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.inc-icon-btn:hover:not(:disabled) {
  background: #e8eefc;
}

.inc-icon-btn:disabled {
  cursor: progress;
  opacity: 0.75;
}

.inc-btn:focus-visible,
.inc-icon-btn:focus-visible,
.inc-filter:focus-visible,
.inc-chip:focus-visible,
.inc-kebab:focus-visible,
.inc-provider:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.inc-alert {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.84rem;
}

.inc-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 1.25rem 0.25rem;
  font-size: 0.85rem;
  color: #6e6e73;
}

/* ---------- Summary ---------- */
.inc-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}

.inc-stat {
  background: var(--stat-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.inc-stat--blue { --stat-bg: #e8eefc; }
.inc-stat--green { --stat-bg: #e3f4e8; }
.inc-stat--orange { --stat-bg: #fdeee2; }
.inc-stat--amber { --stat-bg: #fdf3dc; }

.inc-stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}

.inc-stat__label {
  margin: 0;
  color: #475569;
  font-weight: 600;
  font-size: 0.8rem;
}

.inc-stat__icon {
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.85rem;
  background: #fff;
}

.inc-stat__icon--blue { color: #1e3a8a; }
.inc-stat__icon--green { color: #15803d; }
.inc-stat__icon--orange { color: #c2410c; }
.inc-stat__icon--amber { color: #b45309; }

.inc-stat__value {
  margin: 0 0 0.35rem;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.65rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.inc-stat__hint {
  margin: auto 0 0;
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
}

/* ---------- List card ---------- */
.inc-card {
  padding: 1.1rem 1.25rem 1.15rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.inc-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.inc-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.inc-card__hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: #6e6e73;
}

.inc-card__count {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
  white-space: nowrap;
}

.inc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}

.inc-toolbar__right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 0 1 auto;
  min-width: 0;
}

.inc-filters {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.inc-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.5rem 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.inc-filter:hover:not(.is-active) {
  background: #f1f5f9;
}

.inc-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.inc-filter--open:not(.is-active) .inc-filter__count { background: #fdeee2; color: #9a3412; }
.inc-filter--in-progress:not(.is-active) .inc-filter__count { background: #e8eefc; color: #1e3a8a; }
.inc-filter--resolved:not(.is-active) .inc-filter__count { background: #e3f4e8; color: #15803d; }

.inc-filter.is-active {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.inc-filter.is-active .inc-filter__count {
  background: #fff;
  color: #1e3a8a;
}

.inc-search {
  position: relative;
  flex: 0 1 20rem;
  min-width: 12rem;
}

.inc-search .pi {
  position: absolute;
  left: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8rem;
  color: #94a3b8;
  pointer-events: none;
}

.inc-search input {
  width: 100%;
  height: 2.4rem;
  padding: 0 0.9rem 0 2.2rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #f8fafc;
  font: inherit;
  font-size: 0.84rem;
  color: #0f172a;
}

.inc-search input:focus {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  background: #fff;
}

.inc-priority-filter {
  height: 2.4rem;
  border-radius: 999px;
  border-color: rgba(15, 23, 42, 0.12);
  min-width: 11.5rem;
  align-items: center;
}

.inc-priority-filter :deep(.p-select-label) {
  padding-left: 0.9rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: #334155;
}

.inc-priority-filter__value {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.inc-priority-filter__value .pi {
  font-size: 0.72rem;
  color: #1e3a8a;
}

/* ---------- Table ---------- */
.inc-table-wrap {
  overflow-x: auto;
}

.inc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.inc-table th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
  background: #f8fafc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  white-space: nowrap;
}

.inc-table th:first-child {
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}

.inc-table th:last-child {
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}

.inc-table td {
  padding: 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  vertical-align: middle;
  color: #0f172a;
}

.inc-table tbody tr:last-child td {
  border-bottom: none;
}

.inc-table tbody tr:hover td {
  background: #fafbfd;
}

.inc-table tr.is-saving td {
  opacity: 0.65;
}

.inc-table .is-actions,
.inc-table .c-actions {
  text-align: right;
  white-space: nowrap;
}

.inc-table .c-main {
  min-width: 15rem;
  max-width: 26rem;
}

.inc-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.inc-item__title {
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.inc-item__desc {
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.inc-item__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.2rem;
}

.inc-item__tags .pi {
  font-size: 0.62rem;
}

.inc-res {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
}

.inc-avatar {
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.74rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.inc-avatar--admin {
  background: #f1f5f9;
  color: #475569;
  font-size: 0.8rem;
}

.inc-res__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.inc-res__text strong {
  font-weight: 600;
  font-size: 0.84rem;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.inc-res__text small {
  font-size: 0.74rem;
  color: #6e6e73;
}

.inc-provider {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 13rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #0f172a;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.inc-provider span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inc-provider .pi {
  font-size: 0.7rem;
  color: #1e3a8a;
}

.inc-provider:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.inc-provider.is-empty {
  border-style: dashed;
  border-color: rgba(180, 83, 9, 0.45);
  background: #fdf3dc;
  color: #92400e;
}

.inc-provider.is-empty .pi {
  color: #b45309;
}

.inc-provider.is-empty:hover:not(:disabled) {
  background: #fbe8bd;
}

.inc-provider:disabled {
  cursor: progress;
}

.inc-date {
  display: block;
  font-size: 0.82rem;
  white-space: nowrap;
}

.inc-rel {
  display: block;
  font-size: 0.72rem;
  color: #6e6e73;
  white-space: nowrap;
}

.inc-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.inc-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.inc-chip .pi {
  font-size: 0.7rem;
}

.inc-chip:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.inc-kebab {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #475569;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
}

.inc-kebab:hover:not(:disabled) {
  background: #f1f5f9;
}

.inc-kebab:disabled {
  cursor: progress;
  opacity: 0.6;
}

/* ---------- Empty state ---------- */
.inc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.inc-empty__icon {
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

.inc-empty__text {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: #334155;
}

.inc-empty__hint {
  margin: 0;
  font-size: 0.8rem;
  color: #6e6e73;
}

.inc-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 0.25rem;
}

/* Provider option in the manage dialog select */
.inc-opt {
  display: flex;
  flex-direction: column;
}

.inc-opt small {
  font-size: 0.72rem;
  color: #6e6e73;
}

/* ---------- Responsive ---------- */
@media (max-width: 1100px) {
  .inc-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .inc-toolbar__right {
    width: 100%;
    flex-wrap: wrap;
  }
  .inc-search {
    flex: 1 1 14rem;
  }
}

@media (max-width: 960px) {
  /* Table rows become cards. */
  .inc-table-wrap {
    overflow: visible;
  }
  .inc-table,
  .inc-table tbody,
  .inc-table tr,
  .inc-table td {
    display: block;
    width: 100%;
  }
  .inc-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  .inc-table tbody {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .inc-table tbody tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem 0.85rem;
    padding: 0.9rem 0.95rem;
    border-radius: 16px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: #fff;
  }
  .inc-table tbody tr:hover td {
    background: transparent;
  }
  .inc-table td {
    padding: 0;
    border: none;
    min-width: 0;
    max-width: none;
  }
  .inc-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.25rem;
    font-size: 0.68rem;
    font-weight: 600;
    color: #6e6e73;
  }
  .inc-table .c-main {
    grid-column: 1 / -1;
    grid-row: 1;
    min-width: 0;
    padding-right: 2.4rem;
  }
  .inc-table .c-resident {
    grid-column: 1 / -1;
  }
  .inc-table tbody tr {
    position: relative;
  }
  .inc-table .c-actions {
    grid-column: 1 / -1;
    text-align: left;
    padding-top: 0.7rem;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
  }
  .inc-row-actions {
    display: flex;
    width: 100%;
  }
  .inc-row-actions .inc-chip {
    flex: 1;
    justify-content: center;
    min-height: 2.3rem;
  }
  .inc-kebab {
    position: absolute;
    top: 0.65rem;
    right: 0.6rem;
  }
  .inc-provider {
    max-width: 100%;
  }
  .inc-item__desc {
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .inc-head__title {
    font-size: 1.35rem;
  }
  .inc-head,
  .inc-head__actions {
    width: 100%;
  }
  .inc-head__actions .inc-btn--primary {
    flex: 1;
  }
  .inc-summary {
    gap: 0.55rem;
  }
  .inc-stat {
    padding: 0.8rem 0.85rem 0.85rem;
  }
  .inc-stat__value {
    font-size: 1.35rem;
  }
  .inc-card {
    padding: 1rem 0.85rem;
  }
  .inc-filters {
    width: 100%;
  }
  .inc-search,
  .inc-priority-filter {
    flex: 1 1 100%;
    min-width: 0;
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inc-btn {
    transition: none;
  }
}
</style>

<style>
/* Popup menu is teleported to <body>. */
.inc-menu.p-menu {
  min-width: 14rem;
  padding: 0.3rem;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}

.inc-menu .p-menu-item-link {
  gap: 0.6rem;
  padding: 0.55rem 0.7rem;
  border-radius: 10px;
  font-size: 0.84rem;
}

.inc-menu .p-menu-item-icon {
  font-size: 0.8rem;
  color: #1e3a8a;
}

.inc-menu .inc-menu__danger .p-menu-item-label,
.inc-menu .inc-menu__danger .p-menu-item-icon {
  color: #b42318;
}

.inc-menu .p-menu-separator {
  margin: 0.25rem 0.3rem;
  border-color: rgba(15, 23, 42, 0.07);
}
</style>
