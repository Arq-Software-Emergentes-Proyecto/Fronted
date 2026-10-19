<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import { teamTasksApi, TASK_STATUSES } from '@/team/infrastructure/teamTasksApi.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { formatDateTime, initialsOf, toDate } from '@/team/presentation/teamUi.js'

/**
 * Team — maintenance tasks (Tabla 80 MaintenanceTask): board grouped by status, filters, create, start, complete.
 * WorkloadPolicy errors from the API (WORKLOAD_EXCEEDED / WORKER_INACTIVE) are shown inline.
 */
const props = defineProps({
  workers: { type: Array, default: () => [] },
})
const emit = defineEmits(['changed', 'loaded'])

const { t, locale } = useI18n()

const tasks = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const busyId = ref('')
const busyAction = ref('')
const filters = reactive({ staffId: null, status: null })
const form = reactive({ staffId: null, description: '', scheduledFor: '' })
const formErrors = reactive({ staffId: false, description: false })
const formError = ref('')
const creating = ref(false)
const dialogOpen = ref(false)
const incidentTitles = ref(new Map())

const workerById = computed(() => new Map(props.workers.map((w) => [w.id, w])))
const activeWorkerOptions = computed(() =>
  props.workers
    .filter((w) => w.status !== 'INACTIVE')
    .map((w) => ({ value: w.id, label: w.name })),
)
const filterWorkerOptions = computed(() => [
  { value: null, label: t('teamMgmt.tasks.allWorkers') },
  ...props.workers.map((w) => ({ value: w.id, label: w.name })),
])

/** Tasks of the selected worker (status pills count over this set). */
const workerTasks = computed(() =>
  filters.staffId ? tasks.value.filter((task) => task.staffId === filters.staffId) : tasks.value,
)

const statusCounts = computed(() => {
  const counts = { PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0 }
  for (const task of workerTasks.value) {
    if (counts[task.status] != null) counts[task.status] += 1
  }
  return counts
})

const statusFilterOptions = computed(() => [
  { value: null, label: t('teamMgmt.tasks.allStatusesShort'), count: workerTasks.value.length },
  ...TASK_STATUSES.map((s) => ({
    value: s,
    label: t(`teamMgmt.taskStatuses.${s}`),
    count: statusCounts.value[s],
  })),
])

function scheduledTime(task) {
  return toDate(task.scheduledFor)?.getTime() ?? Number.POSITIVE_INFINITY
}

const columns = computed(() => {
  const statuses = filters.status ? [filters.status] : TASK_STATUSES
  return statuses.map((status) => {
    const items = workerTasks.value.filter((task) => task.status === status)
    items.sort((a, b) =>
      status === 'COMPLETED'
        ? String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? ''))
        : scheduledTime(a) - scheduledTime(b),
    )
    return { status, items }
  })
})

const visibleCount = computed(() => columns.value.reduce((sum, col) => sum + col.items.length, 0))

function errorMessage(err, fallbackKey) {
  const code = err?.code
  if (code === 'WORKLOAD_EXCEEDED') return t('teamMgmt.tasks.workloadExceeded')
  if (code === 'WORKER_INACTIVE') return t('teamMgmt.tasks.workerInactive')
  if (code === 'INVALID_TASK_TRANSITION') return t('teamMgmt.tasks.invalidTransition')
  if (code === 'TASK_FIELDS_REQUIRED') return t('teamMgmt.tasks.requiredFields')
  return t(fallbackKey)
}

function emitSummary() {
  const counts = { PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0 }
  for (const task of tasks.value) {
    if (counts[task.status] != null) counts[task.status] += 1
  }
  emit('loaded', { pending: counts.PENDING, inProgress: counts.IN_PROGRESS, completed: counts.COMPLETED })
}

async function loadTasks() {
  loading.value = true
  error.value = ''
  try {
    // Worker / status filters are applied client-side so the board and its counts stay consistent.
    tasks.value = await teamTasksApi.list()
  } catch {
    tasks.value = []
    error.value = t('teamMgmt.tasks.loadError')
  } finally {
    loading.value = false
    loaded.value = true
    emitSummary()
  }
}

/** Linked incident titles (MaintenanceTask.incidentId) — best effort, falls back to a generic label. */
async function loadIncidentTitles() {
  try {
    const rows = await incidentsApi.list()
    incidentTitles.value = new Map(rows.map((row) => [String(row.id), row.title || row.description || '']))
  } catch {
    incidentTitles.value = new Map()
  }
}

function incidentLabel(task) {
  return incidentTitles.value.get(String(task.incidentId)) || t('teamMgmt.tasks.linkedIncident')
}

function resetForm(staffId = null) {
  const preset = staffId && activeWorkerOptions.value.some((o) => o.value === staffId) ? staffId : null
  form.staffId = preset ?? (activeWorkerOptions.value.some((o) => o.value === form.staffId) ? form.staffId : null)
  form.description = ''
  form.scheduledFor = ''
  formErrors.staffId = false
  formErrors.description = false
  formError.value = ''
}

function openCreate(staffId = null) {
  resetForm(staffId)
  dialogOpen.value = true
}

function closeCreate() {
  if (creating.value) return
  dialogOpen.value = false
}

async function createTask() {
  if (creating.value) return
  formError.value = ''
  formErrors.staffId = !form.staffId
  formErrors.description = !form.description.trim()
  if (formErrors.staffId || formErrors.description) {
    formError.value = t('teamMgmt.tasks.requiredFields')
    return
  }
  creating.value = true
  try {
    await teamTasksApi.create({
      staffId: form.staffId,
      description: form.description,
      scheduledFor: form.scheduledFor || null,
    })
    form.description = ''
    form.scheduledFor = ''
    dialogOpen.value = false
    await loadTasks()
    emit('changed')
  } catch (err) {
    formError.value = errorMessage(err, 'teamMgmt.tasks.saveError')
  } finally {
    creating.value = false
  }
}

async function transition(task, action) {
  if (busyId.value) return
  busyId.value = task.id
  busyAction.value = action
  error.value = ''
  try {
    await (action === 'start' ? teamTasksApi.start(task.id) : teamTasksApi.complete(task.id))
    await loadTasks()
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err, 'teamMgmt.tasks.saveError')
  } finally {
    busyId.value = ''
    busyAction.value = ''
  }
}

function worker(id) {
  return workerById.value.get(id) ?? null
}

function workerName(id) {
  return worker(id)?.name ?? id
}

function statusTone(status) {
  if (status === 'IN_PROGRESS') return 'blue'
  if (status === 'COMPLETED') return 'green'
  return 'amber'
}

defineExpose({ reload: loadTasks, openCreate })
onMounted(() => {
  loadTasks()
  loadIncidentTitles()
})
</script>

<template>
  <section class="tm-tasks" aria-labelledby="team-tasks-title">
    <div class="tm-bar">
      <div class="tm-bar__text">
        <h2 id="team-tasks-title" class="tm-bar__title">{{ t('teamMgmt.tasks.title') }}</h2>
        <p class="tm-bar__intro">{{ t('teamMgmt.tasks.intro') }}</p>
      </div>
      <div class="tm-bar__tools">
        <Select
          v-model="filters.staffId"
          :options="filterWorkerOptions"
          option-label="label"
          option-value="value"
          :aria-label="t('teamMgmt.tasks.workerLabel')"
          :placeholder="t('teamMgmt.tasks.allWorkers')"
          size="small"
          class="tm-select"
        />
      </div>
    </div>

    <div class="tm-filters" v-bf-seg role="group" :aria-label="t('teamMgmt.tasks.filterAria')">
      <button
        v-for="option in statusFilterOptions"
        :key="option.value ?? 'all'"
        type="button"
        class="tm-filter"
        :class="{ 'is-active': filters.status === option.value }"
        :aria-pressed="filters.status === option.value ? 'true' : 'false'"
        @click="filters.status = option.value"
      >
        {{ option.label }}
        <span class="tm-filter__count">{{ option.count }}</span>
      </button>
    </div>

    <p v-if="error" class="tm-alert" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      {{ error }}
    </p>

    <p v-if="loading && !loaded" class="tm-status" role="status">{{ t('teamMgmt.loading') }}</p>

    <div
      v-else-if="visibleCount"
      class="tm-board"
      :class="{ 'tm-board--single': columns.length === 1 }"
      :aria-busy="loading ? 'true' : 'false'"
    >
      <section
        v-for="col in columns"
        :key="col.status"
        class="tm-col"
        :aria-labelledby="`tm-col-${col.status}`"
      >
        <header class="tm-col__head">
          <h3 :id="`tm-col-${col.status}`" class="tm-col__title">
            <span class="tm-dot" :class="`tm-dot--${statusTone(col.status)}`" aria-hidden="true" />
            {{ t(`teamMgmt.taskStatuses.${col.status}`) }}
          </h3>
          <span class="tm-col__count">{{ col.items.length }}</span>
        </header>

        <ul v-if="col.items.length" class="tm-col__list">
          <li v-for="task in col.items" :key="task.id" class="tm-task">
            <p class="tm-task__desc">{{ task.description }}</p>

            <div class="tm-task__meta">
              <span v-if="task.status === 'COMPLETED' && task.completedAt" class="tm-meta">
                <i class="pi pi-check-circle" aria-hidden="true" />
                {{ t('teamMgmt.tasks.completedOn', { date: formatDateTime(task.completedAt, locale) }) }}
              </span>
              <span v-else class="tm-meta">
                <i class="pi pi-calendar" aria-hidden="true" />
                <span class="visually-hidden">{{ t('teamMgmt.tasks.scheduledForLabel') }}:</span>
                {{ task.scheduledFor ? formatDateTime(task.scheduledFor, locale) : t('teamMgmt.tasks.noDate') }}
              </span>
              <span v-if="task.incidentId" class="tm-chip" :title="t('teamMgmt.tasks.linkedIncident')">
                <i class="pi pi-flag" aria-hidden="true" />
                <span class="visually-hidden">{{ t('teamMgmt.tasks.linkedIncident') }}:</span>
                <span class="tm-chip__text">{{ incidentLabel(task) }}</span>
              </span>
            </div>

            <div class="tm-task__foot">
              <span class="tm-person">
                <img
                  v-if="worker(task.staffId)?.photoUrl"
                  :src="worker(task.staffId).photoUrl"
                  alt=""
                  class="tm-avatar tm-avatar--sm tm-avatar--photo"
                  width="28"
                  height="28"
                />
                <span v-else class="tm-avatar tm-avatar--sm" aria-hidden="true">{{ initialsOf(workerName(task.staffId)) }}</span>
                <span class="tm-person__name">{{ workerName(task.staffId) }}</span>
              </span>
              <div v-if="task.status !== 'COMPLETED'" class="tm-task__actions">
                <button
                  v-if="task.status === 'PENDING'"
                  type="button"
                  class="tm-btn tm-btn--sm"
                  :disabled="Boolean(busyId)"
                  @click="transition(task, 'start')"
                >
                  <i
                    class="pi"
                    :class="busyId === task.id && busyAction === 'start' ? 'pi-spin pi-spinner' : 'pi-play'"
                    aria-hidden="true"
                  />
                  {{ t('teamMgmt.tasks.start') }}
                </button>
                <button
                  type="button"
                  class="tm-btn tm-btn--sm tm-btn--primary"
                  :disabled="Boolean(busyId)"
                  @click="transition(task, 'complete')"
                >
                  <i
                    class="pi"
                    :class="busyId === task.id && busyAction === 'complete' ? 'pi-spin pi-spinner' : 'pi-check'"
                    aria-hidden="true"
                  />
                  {{ t('teamMgmt.tasks.complete') }}
                </button>
              </div>
            </div>
          </li>
        </ul>
        <p v-else class="tm-col__empty">{{ t('teamMgmt.tasks.columnEmpty') }}</p>
      </section>
    </div>

    <div v-else class="tm-empty">
      <span class="tm-empty__icon"><i class="pi pi-list-check" aria-hidden="true" /></span>
      <p class="tm-empty__text">
        {{ tasks.length ? t('teamMgmt.tasks.emptyFiltered') : t('teamMgmt.tasks.empty') }}
      </p>
      <p v-if="!activeWorkerOptions.length" class="tm-empty__hint">{{ t('teamMgmt.tasks.noActiveWorkers') }}</p>
      <div class="tm-empty__actions">
        <button
          v-if="tasks.length"
          type="button"
          class="tm-btn"
          @click="filters.staffId = null; filters.status = null"
        >
          <i class="pi pi-filter-slash" aria-hidden="true" />
          {{ t('teamMgmt.clearFilters') }}
        </button>
        <button
          type="button"
          class="tm-btn tm-btn--primary"
          :disabled="!activeWorkerOptions.length"
          @click="openCreate()"
        >
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('teamMgmt.newTask') }}
        </button>
      </div>
    </div>

    <Dialog
      v-model:visible="dialogOpen"
      modal
      :header="t('teamMgmt.tasks.modalTitle')"
      class="tm-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!creating"
    >
      <form id="team-task-form" class="tm-form" novalidate @submit.prevent="createTask">
        <div class="tm-field">
          <label for="team-task-worker">{{ t('teamMgmt.tasks.workerLabel') }}</label>
          <Select
            v-model="form.staffId"
            input-id="team-task-worker"
            :options="activeWorkerOptions"
            option-label="label"
            option-value="value"
            :placeholder="t('teamMgmt.tasks.workerPlaceholder')"
            :invalid="formErrors.staffId"
            fluid
            @change="formErrors.staffId = false"
          />
        </div>
        <div class="tm-field">
          <label for="team-task-description">{{ t('teamMgmt.tasks.descriptionLabel') }}</label>
          <Textarea
            id="team-task-description"
            v-model="form.description"
            maxlength="2000"
            rows="3"
            auto-resize
            :placeholder="t('teamMgmt.tasks.descriptionPlaceholder')"
            :invalid="formErrors.description"
            fluid
            @update:model-value="formErrors.description = false"
          />
        </div>
        <div class="tm-field">
          <label for="team-task-scheduled">{{ t('teamMgmt.tasks.scheduledForLabel') }}</label>
          <input id="team-task-scheduled" v-model="form.scheduledFor" type="datetime-local" class="tm-native" />
          <small class="tm-field__hint">{{ t('teamMgmt.optionalHint') }}</small>
        </div>
        <p v-if="!activeWorkerOptions.length" class="tm-form__note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          {{ t('teamMgmt.tasks.noActiveWorkers') }}
        </p>
        <p v-if="formError" class="tm-form__error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('teamMgmt.tasks.create')"
          confirm-icon="pi pi-plus"
          :loading="creating"
          :disabled="!activeWorkerOptions.length"
          @cancel="closeCreate"
          @confirm="createTask"
        />
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.tm-tasks {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-width: 0;
}

.tm-board {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  align-items: start;
}

.tm-board--single {
  grid-template-columns: minmax(0, 1fr);
}

.tm-col {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem;
  border-radius: 16px;
  background: #f8fafc;
  min-width: 0;
}

.tm-col__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.15rem;
}

.tm-col__title {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  font-size: 0.82rem;
  font-weight: 650;
  color: #0f172a;
}

.tm-col__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.tm-col__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.tm-board--single .tm-col__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
}

.tm-col__empty {
  margin: 0;
  padding: 1rem 0.5rem;
  border-radius: 12px;
  border: 1px dashed rgba(15, 23, 42, 0.12);
  text-align: center;
  font-size: 0.78rem;
  color: #94a3b8;
}

.tm-task {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.8rem 0.85rem;
  border-radius: 14px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.tm-task__desc {
  margin: 0;
  font-size: 0.86rem;
  font-weight: 600;
  line-height: 1.4;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.tm-task__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
  align-items: center;
}

.tm-task__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding-top: 0.55rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.tm-task__actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
  margin-left: auto;
}

@media (max-width: 1100px) {
  .tm-board {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
