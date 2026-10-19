<script setup>
/* Admin "Equipo": workers directory, maintenance tasks board and shifts. */
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import { teamWorkersApi, STAFF_POSITIONS } from '@/team/infrastructure/teamWorkersApi.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import TeamTasksPanel from '@/team/presentation/components/TeamTasksPanel.vue'
import TeamShiftsPanel from '@/team/presentation/components/TeamShiftsPanel.vue'
import { initialsOf, localeTag, positionTone } from '@/team/presentation/teamUi.js'

const { t, locale } = useI18n()

const positionOptions = computed(() =>
  STAFF_POSITIONS.map((value) => ({ value, label: t(`teamMgmt.positions.${value}`) })),
)

function positionLabel(position) {
  return STAFF_POSITIONS.includes(position) ? t(`teamMgmt.positions.${position}`) : '—'
}

const workers = ref([])
const loading = ref(false)
const loadError = ref('')
const modalOpen = ref(false)
const saving = ref(false)
const submitError = ref('')
const processingPhoto = ref(false)

const form = reactive({
  name: '',
  phone: '',
  dni: '',
  salary: null,
  photoUrl: '',
  position: 'MAINTENANCE',
})

/** RNF003: required fields left empty after a submit attempt. */
const fieldErrors = reactive({ name: false, phone: false, dni: false, salary: false })
/** RNF012: the worker list itself failed to load (retryable). */
const listLoadFailed = ref(false)

function errorIdFor(field, invalid) {
  return invalid ? `team-worker-${field}-error` : undefined
}

const MAX_IMAGE_DIMENSION = 1024
const IMAGE_OUTPUT_QUALITY = 0.82

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'))
    reader.readAsDataURL(file)
  })
}

async function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('IMAGE_DECODE_ERROR'))
    img.src = dataUrl
  })
}

async function processImageFile(file) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('IMAGE_INVALID')
  }
  const originalDataUrl = await readFileAsDataUrl(file)
  const img = await loadImageElement(originalDataUrl)

  const ratio = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1),
  )
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * ratio))
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('IMAGE_CANVAS_ERROR')
  context.drawImage(img, 0, 0, width, height)
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return canvas.toDataURL(mime, IMAGE_OUTPUT_QUALITY)
}

function resetForm() {
  form.name = ''
  form.phone = ''
  form.dni = ''
  form.salary = null
  form.photoUrl = ''
  form.position = 'MAINTENANCE'
  submitError.value = ''
  Object.keys(fieldErrors).forEach((key) => {
    fieldErrors[key] = false
  })
}

function openModal() {
  resetForm()
  modalOpen.value = true
}

function closeModal() {
  modalOpen.value = false
}

async function loadWorkers() {
  loading.value = true
  loadError.value = ''
  listLoadFailed.value = false
  try {
    workers.value = await teamWorkersApi.list()
  } catch {
    loadError.value = t('teamMgmt.loadError')
    listLoadFailed.value = true
    workers.value = []
  } finally {
    loading.value = false
  }
}

async function onPhotoChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  processingPhoto.value = true
  submitError.value = ''
  try {
    form.photoUrl = await processImageFile(file)
  } catch {
    submitError.value = t('teamMgmt.photoInvalid')
    form.photoUrl = ''
  } finally {
    processingPhoto.value = false
  }
}

async function submitWorker() {
  if (saving.value) return
  submitError.value = ''

  const salaryNum =
    form.salary === null || form.salary === undefined || form.salary === ''
      ? Number.NaN
      : Number(form.salary)

  fieldErrors.name = !form.name.trim()
  fieldErrors.phone = !form.phone.trim()
  fieldErrors.dni = !form.dni.trim()
  fieldErrors.salary = !Number.isFinite(salaryNum)
  if (fieldErrors.name || fieldErrors.phone || fieldErrors.dni || fieldErrors.salary) {
    submitError.value = t('teamMgmt.requiredFields')
    return
  }

  saving.value = true
  try {
    await teamWorkersApi.add({
      name: form.name,
      phone: form.phone,
      dni: form.dni,
      salary: salaryNum,
      photoUrl: form.photoUrl,
      position: form.position,
    })
    closeModal()
    await loadWorkers()
  } catch (err) {
    if (err?.code === 'TEAM_WORKER_FIELDS_REQUIRED') {
      submitError.value = t('teamMgmt.requiredFields')
    } else {
      submitError.value = t('teamMgmt.saveError')
    }
  } finally {
    saving.value = false
  }
}

const pendingDelete = ref(null)
const deleting = ref(false)

function askDelete(worker) {
  pendingDelete.value = worker
}

function closeDelete() {
  if (deleting.value) return
  pendingDelete.value = null
}

async function confirmDelete() {
  const worker = pendingDelete.value
  if (!worker || deleting.value) return

  deleting.value = true
  try {
    await teamWorkersApi.remove(worker.id)
    pendingDelete.value = null
    await loadWorkers()
  } catch {
    loadError.value = t('teamMgmt.deleteError')
  } finally {
    deleting.value = false
  }
}

/** DeactivateStaff (Team 5.8): INACTIVE workers get no new tasks/shifts; open tasks can be reassigned. */
const pendingDeactivate = ref(null)
const reassignToId = ref(null)
const togglingStatus = ref(false)
const statusError = ref('')
const tasksPanel = ref(null)

const reassignOptions = computed(() => [
  { value: null, label: t('teamMgmt.keepTasksAssigned') },
  ...workers.value
    .filter((w) => w.id !== pendingDeactivate.value?.id && w.status !== 'INACTIVE')
    .map((w) => ({ value: w.id, label: w.name })),
])

function askDeactivate(worker) {
  statusError.value = ''
  reassignToId.value = null
  pendingDeactivate.value = worker
}

function closeDeactivate() {
  if (togglingStatus.value) return
  pendingDeactivate.value = null
}

async function confirmDeactivate() {
  const worker = pendingDeactivate.value
  if (!worker || togglingStatus.value) return
  togglingStatus.value = true
  statusError.value = ''
  try {
    await teamWorkersApi.deactivate(worker.id, { reassignToId: reassignToId.value })
    pendingDeactivate.value = null
    await refreshAll()
  } catch (err) {
    statusError.value =
      err?.code === 'WORKLOAD_EXCEEDED' ? t('teamMgmt.tasks.workloadExceeded') : t('teamMgmt.statusError')
  } finally {
    togglingStatus.value = false
  }
}

async function reactivateWorker(worker) {
  if (togglingStatus.value) return
  togglingStatus.value = true
  loadError.value = ''
  try {
    await teamWorkersApi.reactivate(worker.id)
    await loadWorkers()
  } catch {
    loadError.value = t('teamMgmt.statusError')
  } finally {
    togglingStatus.value = false
  }
}

async function refreshAll() {
  await loadWorkers()
  await Promise.all([tasksPanel.value?.reload?.(), shiftsPanel.value?.reload?.()])
}

function formatSalary(data) {
  const n = Number(data.salary)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(localeTag(locale.value), {
    style: 'currency',
    currency: 'PEN',
    maximumFractionDigits: 2,
  }).format(n)
}

/* ---------- Layout: summary, tabs, filters ---------- */
const shiftsPanel = ref(null)
const tasksSummary = ref(null)
const shiftsSummary = ref(null)

const activeWorkers = computed(() => workers.value.filter((w) => w.status !== 'INACTIVE'))
const hasActiveWorkers = computed(() => activeWorkers.value.length > 0)
const openTasksTotal = computed(() =>
  tasksSummary.value
    ? tasksSummary.value.pending + tasksSummary.value.inProgress
    : workers.value.reduce((sum, w) => sum + (Number(w.openTasks) || 0), 0),
)

const TAB_KEYS = ['workers', 'tasks', 'shifts']
const activeTab = ref('workers')
const tabs = computed(() => [
  { key: 'workers', label: t('teamMgmt.tabWorkers'), count: workers.value.length },
  { key: 'tasks', label: t('teamMgmt.tabTasks'), count: openTasksTotal.value },
  { key: 'shifts', label: t('teamMgmt.tabShifts'), count: shiftsSummary.value?.upcoming ?? 0 },
])

function selectTab(key) {
  activeTab.value = key
}

function onTabKeydown(event) {
  const index = TAB_KEYS.indexOf(activeTab.value)
  let next = null
  if (event.key === 'ArrowRight') next = (index + 1) % TAB_KEYS.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + TAB_KEYS.length) % TAB_KEYS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TAB_KEYS.length - 1
  if (next == null) return
  event.preventDefault()
  activeTab.value = TAB_KEYS[next]
  document.getElementById(`tm-tab-${TAB_KEYS[next]}`)?.focus()
}

const workerFilter = ref('all')
const workerFilterOptions = computed(() => [
  { key: 'all', label: t('teamMgmt.filterAll'), count: workers.value.length },
  { key: 'active', label: t('teamMgmt.filterActive'), count: activeWorkers.value.length },
  {
    key: 'inactive',
    label: t('teamMgmt.filterInactive'),
    count: workers.value.length - activeWorkers.value.length,
  },
])
const visibleWorkers = computed(() => {
  if (workerFilter.value === 'active') return activeWorkers.value
  if (workerFilter.value === 'inactive') return workers.value.filter((w) => w.status === 'INACTIVE')
  return workers.value
})

function openNewTask(staffId = null) {
  activeTab.value = 'tasks'
  tasksPanel.value?.openCreate?.(staffId)
}

function openNewShift() {
  activeTab.value = 'shifts'
  shiftsPanel.value?.openCreate?.()
}

function onTasksChanged() {
  loadWorkers()
}

onMounted(loadWorkers)
</script>

<template>
  <div class="app-view tm">
    <header class="tm-head">
      <div class="tm-head__text">
        <h1 class="tm-head__title">{{ t('app.team') }}</h1>
        <p class="tm-head__sub">{{ t('teamMgmt.pageSubtitle') }}</p>
      </div>
      <div class="tm-head__actions" role="group" :aria-label="t('teamMgmt.headerActions')">
        <button
          type="button"
          class="tm-btn"
          :disabled="listLoadFailed || !hasActiveWorkers"
          :title="hasActiveWorkers ? undefined : t('teamMgmt.tasks.noActiveWorkers')"
          @click="openNewTask()"
        >
          <i class="pi pi-list-check" aria-hidden="true" />
          {{ t('teamMgmt.newTask') }}
        </button>
        <button
          type="button"
          class="tm-btn"
          :disabled="listLoadFailed || !hasActiveWorkers"
          :title="hasActiveWorkers ? undefined : t('teamMgmt.shifts.noActiveWorkers')"
          @click="openNewShift"
        >
          <i class="pi pi-calendar-plus" aria-hidden="true" />
          {{ t('teamMgmt.newShift') }}
        </button>
        <button type="button" class="tm-btn tm-btn--primary" @click="openModal">
          <i class="pi pi-user-plus" aria-hidden="true" />
          {{ t('teamMgmt.addWorker') }}
        </button>
      </div>
    </header>

    <LoadErrorRetry v-if="listLoadFailed" :message="loadError" :loading="loading" @retry="loadWorkers" />
    <p v-else-if="loadError" class="tm-alert" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      {{ loadError }}
    </p>

    <template v-if="!listLoadFailed">
      <section class="tm-kpis" :aria-label="t('teamMgmt.summaryAria')">
        <article class="tm-kpi tm-kpi--blue">
          <div class="tm-kpi__head">
            <p class="tm-kpi__label">{{ t('teamMgmt.kpiActive') }}</p>
            <span class="tm-kpi__icon tm-kpi__icon--blue"><i class="pi pi-users" aria-hidden="true" /></span>
          </div>
          <p class="tm-kpi__value">{{ loading && !workers.length ? '…' : activeWorkers.length }}</p>
          <p class="tm-kpi__hint">{{ t('teamMgmt.kpiActiveHint', { n: workers.length }) }}</p>
        </article>
        <article class="tm-kpi tm-kpi--amber">
          <div class="tm-kpi__head">
            <p class="tm-kpi__label">{{ t('teamMgmt.kpiOpen') }}</p>
            <span class="tm-kpi__icon tm-kpi__icon--amber"><i class="pi pi-inbox" aria-hidden="true" /></span>
          </div>
          <p class="tm-kpi__value">{{ openTasksTotal }}</p>
          <p class="tm-kpi__hint">
            {{
              tasksSummary
                ? t('teamMgmt.kpiOpenHint', { n: tasksSummary.pending }, tasksSummary.pending)
                : '…'
            }}
          </p>
        </article>
        <article class="tm-kpi tm-kpi--orange">
          <div class="tm-kpi__head">
            <p class="tm-kpi__label">{{ t('teamMgmt.kpiInProgress') }}</p>
            <span class="tm-kpi__icon tm-kpi__icon--orange"><i class="pi pi-wrench" aria-hidden="true" /></span>
          </div>
          <p class="tm-kpi__value">{{ tasksSummary ? tasksSummary.inProgress : '…' }}</p>
          <p class="tm-kpi__hint">
            {{
              tasksSummary
                ? t('teamMgmt.kpiInProgressHint', { n: tasksSummary.completed }, tasksSummary.completed)
                : '…'
            }}
          </p>
        </article>
        <article class="tm-kpi tm-kpi--green">
          <div class="tm-kpi__head">
            <p class="tm-kpi__label">{{ t('teamMgmt.kpiShiftsToday') }}</p>
            <span class="tm-kpi__icon tm-kpi__icon--green"><i class="pi pi-calendar" aria-hidden="true" /></span>
          </div>
          <p class="tm-kpi__value">{{ shiftsSummary ? shiftsSummary.today : '…' }}</p>
          <p class="tm-kpi__hint">
            {{
              shiftsSummary
                ? t('teamMgmt.kpiShiftsHint', { n: shiftsSummary.upcoming }, shiftsSummary.upcoming)
                : '…'
            }}
          </p>
        </article>
      </section>

      <section class="tm-card">
        <div class="tm-tabs" role="tablist" :aria-label="t('teamMgmt.tabsLabel')">
          <button
            v-for="tab in tabs"
            :id="`tm-tab-${tab.key}`"
            :key="tab.key"
            type="button"
            role="tab"
            class="tm-tab"
            :class="{ 'is-active': activeTab === tab.key }"
            :aria-selected="activeTab === tab.key ? 'true' : 'false'"
            :aria-controls="`tm-panel-${tab.key}`"
            :tabindex="activeTab === tab.key ? 0 : -1"
            @click="selectTab(tab.key)"
            @keydown="onTabKeydown"
          >
            {{ tab.label }}
            <span class="tm-tab__count">{{ tab.count }}</span>
          </button>
        </div>

        <!-- Trabajadores -->
        <div
          v-show="activeTab === 'workers'"
          id="tm-panel-workers"
          class="tm-panel"
          role="tabpanel"
          aria-labelledby="tm-tab-workers"
          tabindex="0"
        >
          <div class="tm-bar">
            <div class="tm-bar__text">
              <h2 class="tm-bar__title">{{ t('teamMgmt.workersTitle') }}</h2>
              <p class="tm-bar__intro">{{ t('teamMgmt.workersIntro') }}</p>
            </div>
          </div>

          <div v-if="workers.length" class="tm-filters" role="group" :aria-label="t('teamMgmt.filterAria')">
            <button
              v-for="option in workerFilterOptions"
              :key="option.key"
              type="button"
              class="tm-filter"
              :class="{ 'is-active': workerFilter === option.key }"
              :aria-pressed="workerFilter === option.key ? 'true' : 'false'"
              @click="workerFilter = option.key"
            >
              {{ option.label }}
              <span class="tm-filter__count">{{ option.count }}</span>
            </button>
          </div>

          <p v-if="loading && !workers.length" class="tm-status" role="status">{{ t('teamMgmt.loading') }}</p>

          <ul v-else-if="visibleWorkers.length" class="tm-workers" :aria-busy="loading ? 'true' : 'false'">
            <li
              v-for="w in visibleWorkers"
              :key="w.id"
              class="tm-worker"
              :class="{ 'is-inactive': w.status === 'INACTIVE' }"
            >
              <div class="tm-worker__top">
                <img
                  v-if="w.photoUrl"
                  :src="w.photoUrl"
                  :alt="w.name"
                  class="tm-avatar tm-avatar--lg tm-avatar--photo"
                  width="48"
                  height="48"
                />
                <span v-else class="tm-avatar tm-avatar--lg" aria-hidden="true">{{ initialsOf(w.name) }}</span>
                <div class="tm-worker__id">
                  <h3 class="tm-worker__name">{{ w.name }}</h3>
                  <span class="tm-pill" :class="`tm-pill--${positionTone(w.position)}`">
                    {{ positionLabel(w.position) }}
                  </span>
                </div>
                <span
                  class="tm-pill tm-worker__status"
                  :class="w.status === 'INACTIVE' ? 'tm-pill--neutral' : 'tm-pill--green'"
                >
                  {{ t(`teamMgmt.statuses.${w.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'}`) }}
                </span>
              </div>

              <dl class="tm-worker__facts">
                <div class="tm-fact">
                  <dt><i class="pi pi-phone" aria-hidden="true" />{{ t('teamMgmt.tablePhone') }}</dt>
                  <dd>{{ w.phone || '—' }}</dd>
                </div>
                <div class="tm-fact">
                  <dt><i class="pi pi-id-card" aria-hidden="true" />{{ t('teamMgmt.tableDni') }}</dt>
                  <dd>{{ w.dni || '—' }}</dd>
                </div>
                <div class="tm-fact">
                  <dt><i class="pi pi-wallet" aria-hidden="true" />{{ t('teamMgmt.tableSalary') }}</dt>
                  <dd>{{ formatSalary(w) }}</dd>
                </div>
                <div class="tm-fact">
                  <dt><i class="pi pi-list-check" aria-hidden="true" />{{ t('teamMgmt.tableOpenTasks') }}</dt>
                  <dd>
                    <span class="tm-count" :class="{ 'is-zero': !(w.openTasks ?? 0) }">{{ w.openTasks ?? 0 }}</span>
                  </dd>
                </div>
              </dl>

              <div class="tm-worker__actions" role="group" :aria-label="t('teamMgmt.workerActions', { name: w.name })">
                <template v-if="w.status === 'INACTIVE'">
                  <button
                    type="button"
                    class="tm-btn tm-btn--sm"
                    :disabled="togglingStatus"
                    @click="reactivateWorker(w)"
                  >
                    <i class="pi pi-replay" aria-hidden="true" />
                    {{ t('teamMgmt.reactivate') }}
                  </button>
                </template>
                <template v-else>
                  <button type="button" class="tm-btn tm-btn--sm" @click="openNewTask(w.id)">
                    <i class="pi pi-plus" aria-hidden="true" />
                    {{ t('teamMgmt.assignTask') }}
                  </button>
                  <button
                    type="button"
                    class="tm-btn tm-btn--sm tm-btn--ghost"
                    :disabled="togglingStatus"
                    @click="askDeactivate(w)"
                  >
                    <i class="pi pi-ban" aria-hidden="true" />
                    {{ t('teamMgmt.deactivate') }}
                  </button>
                </template>
                <button
                  type="button"
                  class="tm-icon-btn tm-icon-btn--danger tm-worker__delete"
                  :aria-label="t('teamMgmt.deleteWorkerAria', { name: w.name })"
                  :title="t('app.deleteAction')"
                  @click="askDelete(w)"
                >
                  <i class="pi pi-trash" aria-hidden="true" />
                </button>
              </div>
            </li>
          </ul>

          <div v-else class="tm-empty">
            <span class="tm-empty__icon"><i class="pi pi-users" aria-hidden="true" /></span>
            <p class="tm-empty__text">{{ workers.length ? t('teamMgmt.emptyFiltered') : t('teamMgmt.empty') }}</p>
            <div class="tm-empty__actions">
              <button v-if="workers.length" type="button" class="tm-btn" @click="workerFilter = 'all'">
                <i class="pi pi-filter-slash" aria-hidden="true" />
                {{ t('teamMgmt.clearFilters') }}
              </button>
              <button v-else type="button" class="tm-btn tm-btn--primary" @click="openModal">
                <i class="pi pi-user-plus" aria-hidden="true" />
                {{ t('teamMgmt.addWorker') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Tareas -->
        <div
          v-show="activeTab === 'tasks'"
          id="tm-panel-tasks"
          class="tm-panel"
          role="tabpanel"
          aria-labelledby="tm-tab-tasks"
          tabindex="0"
        >
          <TeamTasksPanel
            ref="tasksPanel"
            :workers="workers"
            @changed="onTasksChanged"
            @loaded="(s) => (tasksSummary = s)"
          />
        </div>

        <!-- Turnos -->
        <div
          v-show="activeTab === 'shifts'"
          id="tm-panel-shifts"
          class="tm-panel"
          role="tabpanel"
          aria-labelledby="tm-tab-shifts"
          tabindex="0"
        >
          <TeamShiftsPanel ref="shiftsPanel" :workers="workers" @loaded="(s) => (shiftsSummary = s)" />
        </div>
      </section>
    </template>

    <!-- Agregar trabajador -->
    <Dialog
      v-model:visible="modalOpen"
      modal
      :header="t('teamMgmt.modalTitle')"
      class="tm-dialog"
      :style="{ width: 'min(30rem, 94vw)' }"
      :draggable="false"
      :closable="!saving"
    >
      <div class="tm-form">
        <div class="tm-field" :class="{ 'bf-field--invalid': fieldErrors.name }">
          <label for="team-worker-name">{{ t('teamMgmt.nameLabel') }}</label>
          <InputText
            id="team-worker-name"
            v-model="form.name"
            autocomplete="name"
            required
            :invalid="fieldErrors.name"
            :aria-describedby="errorIdFor('name', fieldErrors.name)"
            fluid
            @update:model-value="fieldErrors.name = false"
          />
          <small v-if="fieldErrors.name" id="team-worker-name-error" class="tm-field__error">
            {{ t('common.fieldRequired') }}
          </small>
        </div>
        <div class="tm-form__row">
          <div class="tm-field" :class="{ 'bf-field--invalid': fieldErrors.phone }">
            <label for="team-worker-phone">{{ t('teamMgmt.phoneLabel') }}</label>
            <InputText
              id="team-worker-phone"
              v-model="form.phone"
              inputmode="tel"
              autocomplete="tel"
              required
              :invalid="fieldErrors.phone"
              :aria-describedby="errorIdFor('phone', fieldErrors.phone)"
              fluid
              @update:model-value="fieldErrors.phone = false"
            />
            <small v-if="fieldErrors.phone" id="team-worker-phone-error" class="tm-field__error">
              {{ t('common.fieldRequired') }}
            </small>
          </div>
          <div class="tm-field" :class="{ 'bf-field--invalid': fieldErrors.dni }">
            <label for="team-worker-dni">{{ t('teamMgmt.dniLabel') }}</label>
            <InputText
              id="team-worker-dni"
              v-model="form.dni"
              inputmode="numeric"
              required
              :invalid="fieldErrors.dni"
              :aria-describedby="errorIdFor('dni', fieldErrors.dni)"
              fluid
              @update:model-value="fieldErrors.dni = false"
            />
            <small v-if="fieldErrors.dni" id="team-worker-dni-error" class="tm-field__error">
              {{ t('common.fieldRequired') }}
            </small>
          </div>
        </div>
        <div class="tm-form__row">
          <div class="tm-field" :class="{ 'bf-field--invalid': fieldErrors.salary }">
            <label for="team-worker-salary">{{ t('teamMgmt.salaryLabel') }}</label>
            <InputNumber
              v-model="form.salary"
              input-id="team-worker-salary"
              :min="0"
              :maxFractionDigits="2"
              :invalid="fieldErrors.salary"
              :pt="{ pcInputText: { root: { 'aria-describedby': errorIdFor('salary', fieldErrors.salary) } } }"
              fluid
              @update:model-value="fieldErrors.salary = false"
            />
            <small v-if="fieldErrors.salary" id="team-worker-salary-error" class="tm-field__error">
              {{ t('common.fieldRequired') }}
            </small>
          </div>
          <div class="tm-field">
            <label for="team-worker-position">{{ t('teamMgmt.positionLabel') }}</label>
            <Select
              v-model="form.position"
              input-id="team-worker-position"
              :options="positionOptions"
              option-label="label"
              option-value="value"
              fluid
            />
          </div>
        </div>
        <div class="tm-field">
          <span class="tm-field__label">{{ t('teamMgmt.photoLabel') }}</span>
          <div class="tm-upload">
            <img
              v-if="form.photoUrl"
              :src="form.photoUrl"
              :alt="form.name.trim() ? form.name.trim() : t('teamMgmt.photoLabel')"
              class="tm-upload__preview"
              width="56"
              height="56"
            />
            <span v-else class="tm-upload__preview tm-upload__preview--empty" aria-hidden="true">
              <template v-if="form.name.trim()">{{ initialsOf(form.name) }}</template>
              <i v-else class="pi pi-user" />
            </span>
            <div class="tm-upload__body">
              <div class="tm-upload__buttons">
                <label class="tm-file">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                    class="tm-file__input"
                    :aria-label="t('teamMgmt.photoLabel')"
                    :disabled="processingPhoto || saving"
                    @change="onPhotoChange"
                  />
                  <span class="tm-file__trigger">
                    <i class="pi" :class="processingPhoto ? 'pi-spin pi-spinner' : 'pi-upload'" aria-hidden="true" />
                    {{ processingPhoto ? t('teamMgmt.processingPhoto') : t('teamMgmt.photoChoose') }}
                  </span>
                </label>
                <button v-if="form.photoUrl" type="button" class="tm-link-btn" @click="form.photoUrl = ''">
                  {{ t('teamMgmt.removePhoto') }}
                </button>
              </div>
              <p class="tm-field__hint">{{ t('teamMgmt.photoHint') }}</p>
            </div>
          </div>
        </div>
        <p v-if="submitError" class="tm-form__error" role="alert">{{ submitError }}</p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('teamMgmt.accept')"
          cancel-icon="pi pi-times"
          confirm-icon="pi pi-check"
          :loading="saving"
          @cancel="closeModal"
          @confirm="submitWorker"
        />
      </template>
    </Dialog>

    <!-- Eliminar trabajador -->
    <Dialog
      :visible="pendingDelete != null"
      modal
      :header="t('teamMgmt.deleteModalTitle')"
      class="tm-dialog"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
      :closable="!deleting"
      @update:visible="(open) => { if (!open) closeDelete() }"
    >
      <p class="tm-dialog__text">
        {{ t('teamMgmt.deleteConfirm', { name: pendingDelete?.name || '' }) }}
      </p>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('app.deleteAction')"
          confirm-variant="danger"
          :loading="deleting"
          @cancel="closeDelete"
          @confirm="confirmDelete"
        />
      </template>
    </Dialog>

    <!-- Desactivar trabajador (con reasignación de tareas abiertas) -->
    <Dialog
      :visible="pendingDeactivate != null"
      modal
      :header="t('teamMgmt.deactivateModalTitle')"
      class="tm-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!togglingStatus"
      @update:visible="(open) => { if (!open) closeDeactivate() }"
    >
      <div class="tm-form">
        <p class="tm-dialog__text">
          {{ t('teamMgmt.deactivateConfirm', { name: pendingDeactivate?.name || '' }) }}
        </p>
        <div v-if="(pendingDeactivate?.openTasks ?? 0) > 0" class="tm-field">
          <label for="team-reassign-to">
            {{
              t(
                'teamMgmt.reassignLabelCount',
                { count: pendingDeactivate?.openTasks ?? 0 },
                pendingDeactivate?.openTasks ?? 0,
              )
            }}
          </label>
          <Select
            v-model="reassignToId"
            input-id="team-reassign-to"
            :options="reassignOptions"
            option-label="label"
            option-value="value"
            fluid
          />
        </div>
        <p v-if="statusError" class="tm-form__error" role="alert">{{ statusError }}</p>
      </div>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('teamMgmt.deactivate')"
          confirm-variant="danger"
          :loading="togglingStatus"
          @cancel="closeDeactivate"
          @confirm="confirmDeactivate"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.tm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

/* ---------- Header ---------- */
.tm-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.tm-head__text {
  min-width: 0;
}

.tm-head__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.tm-head__sub {
  margin: 0.25rem 0 0;
  font-size: 0.88rem;
  color: #6e6e73;
}

.tm-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ---------- Summary ---------- */
.tm-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.9rem;
}

.tm-kpi {
  background: var(--kpi-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tm-kpi--blue { --kpi-bg: #e8eefc; }
.tm-kpi--green { --kpi-bg: #e3f4e8; }
.tm-kpi--orange { --kpi-bg: #fdeee2; }
.tm-kpi--amber { --kpi-bg: #fdf3dc; }

.tm-kpi__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}

.tm-kpi__label {
  margin: 0;
  color: #475569;
  font-weight: 600;
  font-size: 0.8rem;
}

.tm-kpi__icon {
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.92rem;
  background: #fff;
}

.tm-kpi__icon--blue { color: #1e3a8a; }
.tm-kpi__icon--green { color: #15803d; }
.tm-kpi__icon--orange { color: #c2410c; }
.tm-kpi__icon--amber { color: #b45309; }

.tm-kpi__value {
  margin: 0 0 0.4rem;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.65rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.tm-kpi__hint {
  margin: auto 0 0;
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
}

/* ---------- Card + tabs ---------- */
.tm-card {
  padding: 1.1rem 1.25rem 1.25rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.tm-tabs {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  padding-bottom: 0.9rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
}

.tm-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.5rem 0.45rem 0.9rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.tm-tab:hover:not(.is-active) {
  background: #f1f5f9;
}

.tm-tab__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.tm-tab.is-active {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.tm-tab.is-active .tm-tab__count {
  background: #fff;
  color: #1e3a8a;
}

.tm-tab:focus-visible,
.tm-panel:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.tm-panel {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-width: 0;
  border-radius: 12px;
}

/* ---------- Worker cards ---------- */
.tm-workers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18.5rem, 1fr));
  gap: 0.75rem;
}

.tm-worker {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 0.95rem 1rem;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
  min-width: 0;
}

.tm-worker.is-inactive {
  background: #fafbfc;
}

.tm-worker.is-inactive .tm-avatar {
  filter: grayscale(1);
  opacity: 0.7;
}

.tm-worker__top {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  min-width: 0;
}

.tm-worker__id {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
  min-width: 0;
  flex: 1;
}

.tm-worker__name {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  color: #0f172a;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.tm-worker__status {
  flex-shrink: 0;
}

.tm-worker__facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem 0.75rem;
  padding: 0.7rem 0.75rem;
  border-radius: 12px;
  background: #f8fafc;
}

.tm-fact {
  min-width: 0;
}

.tm-fact dt {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.68rem;
  font-weight: 600;
  color: #6e6e73;
}

.tm-fact dt .pi {
  font-size: 0.68rem;
  color: #94a3b8;
}

.tm-fact dd {
  margin: 0.15rem 0 0;
  font-size: 0.84rem;
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.tm-count {
  display: inline-flex;
  min-width: 1.5rem;
  justify-content: center;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: #fdf3dc;
  color: #92400e;
  font-size: 0.75rem;
  font-weight: 700;
}

.tm-count.is-zero {
  background: #e3f4e8;
  color: #15803d;
}

.tm-worker__actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-top: auto;
}

.tm-worker__delete {
  margin-left: auto;
}

/* ---------- Responsive ---------- */
@media (max-width: 1100px) {
  .tm-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .tm-head__title {
    font-size: 1.35rem;
  }
  .tm-head,
  .tm-head__actions {
    width: 100%;
  }
  .tm-head__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tm-head__actions .tm-btn {
    padding-inline: 0.6rem;
    white-space: normal;
    text-align: center;
    line-height: 1.2;
  }
  .tm-head__actions .tm-btn--primary {
    grid-column: 1 / -1;
    order: -1;
  }
  .tm-kpis {
    gap: 0.6rem;
  }
  .tm-kpi {
    padding: 0.85rem 0.9rem 0.9rem;
  }
  .tm-kpi__value {
    font-size: 1.4rem;
  }
  .tm-card {
    padding: 1rem 0.85rem;
  }
  .tm-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.3rem;
  }
  .tm-tab {
    justify-content: center;
    gap: 0.3rem;
    padding: 0.45rem 0.4rem;
    font-size: 0.78rem;
    min-width: 0;
  }
  .tm-workers {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<style>
/* Shared Team primitives — unscoped so the Tasks/Shifts panels (child components) reuse them. Prefixed by .tm. */
.tm *,
.tm *::before,
.tm *::after,
.tm-dialog *,
.tm-dialog *::before,
.tm-dialog *::after {
  box-sizing: border-box;
}

.tm .tm-btn,
.tm-dialog .tm-btn {
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

.tm .tm-btn .pi {
  font-size: 0.78rem;
}

.tm .tm-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.tm .tm-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.tm .tm-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.tm .tm-btn--ghost {
  color: #475569;
}

.tm .tm-btn--ghost:hover:not(:disabled) {
  background: #f1f5f9;
}

.tm .tm-btn--sm {
  min-height: 2rem;
  padding: 0.3rem 0.75rem;
  font-size: 0.76rem;
}

.tm .tm-btn--sm .pi {
  font-size: 0.7rem;
}

.tm .tm-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.tm .tm-icon-btn {
  width: 2.1rem;
  height: 2.1rem;
  flex-shrink: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
}

.tm .tm-icon-btn--danger {
  color: #b42318;
}

.tm .tm-icon-btn--danger:hover:not(:disabled) {
  background: #fde4e4;
}

.tm .tm-icon-btn:disabled {
  cursor: progress;
  opacity: 0.6;
}

.tm .tm-btn:focus-visible,
.tm .tm-icon-btn:focus-visible,
.tm .tm-filter:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

/* Section bar inside a tab */
.tm .tm-bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
}

.tm .tm-bar__text {
  min-width: 0;
  flex: 1 1 20rem;
}

.tm .tm-bar__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.tm .tm-bar__intro {
  margin: 0.2rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #6e6e73;
}

.tm .tm-bar__tools {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.tm .tm-select.p-select {
  min-width: 13rem;
  border-radius: 999px;
}

/* Filter pills */
.tm .tm-filters {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.tm .tm-filter {
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

.tm .tm-filter:hover:not(.is-active) {
  background: #f1f5f9;
}

.tm .tm-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.tm .tm-filter.is-active {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.tm .tm-filter.is-active .tm-filter__count {
  background: #fff;
  color: #1e3a8a;
}

/* Pills, dots, chips */
.tm .tm-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
  background: #f1f5f9;
  color: #334155;
}

.tm .tm-pill--blue { background: #e8eefc; color: #1e3a8a; }
.tm .tm-pill--green { background: #e3f4e8; color: #15803d; }
.tm .tm-pill--orange { background: #fdeee2; color: #c2410c; }
.tm .tm-pill--amber { background: #fdf3dc; color: #92400e; }
.tm .tm-pill--red { background: #fde4e4; color: #b42318; }
.tm .tm-pill--neutral { background: #f1f5f9; color: #475569; }

.tm .tm-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: #94a3b8;
}

.tm .tm-dot--amber { background: #d97706; }
.tm .tm-dot--blue { background: #1e3a8a; }
.tm .tm-dot--green { background: #15803d; }

.tm .tm-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: #475569;
}

.tm .tm-meta .pi {
  font-size: 0.72rem;
  color: #94a3b8;
}

.tm .tm-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: #fde4e4;
  color: #9f1d1d;
  font-size: 0.72rem;
  font-weight: 600;
}

.tm .tm-chip .pi {
  font-size: 0.66rem;
}

.tm .tm-chip__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Avatars */
.tm .tm-avatar {
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.74rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.tm .tm-avatar--sm {
  width: 1.75rem;
  height: 1.75rem;
  font-size: 0.62rem;
}

.tm .tm-avatar--lg {
  width: 3rem;
  height: 3rem;
  font-size: 0.92rem;
}

.tm .tm-avatar--photo {
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.tm .tm-person {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.tm .tm-person__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tm .tm-person__name {
  font-size: 0.8rem;
  font-weight: 600;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.tm .tm-person__sub {
  font-size: 0.72rem;
  color: #6e6e73;
}

/* Status, alerts, empty states */
.tm .tm-status {
  margin: 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

.tm .tm-alert {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.82rem;
}

.tm .tm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 2rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.tm .tm-empty__icon {
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

.tm .tm-empty__text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.tm .tm-empty__hint {
  margin: 0;
  font-size: 0.78rem;
  color: #6e6e73;
}

.tm .tm-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
}

.tm .visually-hidden,
.tm-dialog .visually-hidden {
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

/* ---------- Dialogs (PrimeVue teleports them to <body>) ---------- */
.tm-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.tm-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.tm-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.tm-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.tm-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  gap: 0.5rem;
}

.tm-dialog .tm-dialog__text {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  color: #0f172a;
}

.tm-dialog .tm-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.tm-dialog .tm-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem;
}

.tm-dialog .tm-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.tm-dialog .tm-field > label,
.tm-dialog .tm-field__label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.tm-dialog .tm-field .p-inputtext,
.tm-dialog .tm-field .p-select,
.tm-dialog .tm-field .p-textarea {
  border-radius: 12px;
}

.tm-dialog .tm-field .p-inputtext {
  min-height: 2.6rem;
}

.tm-dialog .tm-field .p-inputnumber {
  width: 100%;
}

.tm-dialog .tm-native {
  width: 100%;
  min-height: 2.6rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  background: #fff;
  color: #0f172a;
  font: inherit;
  font-size: 0.9rem;
}

.tm-dialog .tm-native:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  border-color: #1e3a8a;
}

.tm-dialog .tm-native.is-invalid {
  border-color: #b42318;
}

.tm-dialog .tm-field__hint {
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.tm-dialog .tm-field__error {
  font-size: 0.75rem;
  color: #b42318;
}

.tm-dialog .tm-form__error {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

.tm-dialog .tm-form__note {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.78rem;
  line-height: 1.4;
}

.tm-dialog .tm-form__note .pi {
  margin-top: 0.12rem;
  font-size: 0.75rem;
}

.tm-dialog .tm-upload {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.65rem 0.75rem;
  border-radius: 14px;
  border: 1px dashed rgba(15, 23, 42, 0.18);
  background: #f8fafc;
}

.tm-dialog .tm-upload__preview {
  flex-shrink: 0;
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.tm-dialog .tm-upload__preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.95rem;
  font-weight: 700;
  border-color: transparent;
}

.tm-dialog .tm-upload__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.tm-dialog .tm-upload__buttons {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.tm-dialog .tm-file {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.tm-dialog .tm-file__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.tm-dialog .tm-file__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.42rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 600;
}

.tm-dialog .tm-file:hover .tm-file__trigger {
  background: #e8eefc;
}

.tm-dialog .tm-file:focus-within .tm-file__trigger {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.tm-dialog .tm-link-btn {
  padding: 0.2rem 0.3rem;
  border: none;
  background: none;
  color: #b42318;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.tm-dialog .tm-link-btn:hover {
  text-decoration: underline;
}

@media (max-width: 480px) {
  .tm-dialog .tm-form__row {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tm .tm-btn {
    transition: none;
  }
}
</style>
