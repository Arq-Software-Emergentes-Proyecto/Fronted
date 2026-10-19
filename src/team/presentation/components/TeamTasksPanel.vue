<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { teamTasksApi, TASK_STATUSES } from '@/team/infrastructure/teamTasksApi.js'

/**
 * Team — maintenance tasks (Tabla 80 MaintenanceTask): list with filters, create, start, complete.
 * WorkloadPolicy errors from the API (WORKLOAD_EXCEEDED / WORKER_INACTIVE) are shown inline.
 */
const props = defineProps({
  workers: { type: Array, default: () => [] },
})
const emit = defineEmits(['changed'])

const { t, locale } = useI18n()

const tasks = ref([])
const loading = ref(false)
const error = ref('')
const busyId = ref('')
const filters = reactive({ staffId: null, status: null })
const form = reactive({ staffId: null, description: '', scheduledFor: '' })
const creating = ref(false)

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
const statusOptions = computed(() => [
  { value: null, label: t('teamMgmt.tasks.allStatuses') },
  ...TASK_STATUSES.map((s) => ({ value: s, label: t(`teamMgmt.taskStatuses.${s}`) })),
])

function errorMessage(err, fallbackKey) {
  const code = err?.code
  if (code === 'WORKLOAD_EXCEEDED') return t('teamMgmt.tasks.workloadExceeded')
  if (code === 'WORKER_INACTIVE') return t('teamMgmt.tasks.workerInactive')
  if (code === 'INVALID_TASK_TRANSITION') return t('teamMgmt.tasks.invalidTransition')
  if (code === 'TASK_FIELDS_REQUIRED') return t('teamMgmt.tasks.requiredFields')
  return t(fallbackKey)
}

async function loadTasks() {
  loading.value = true
  error.value = ''
  try {
    tasks.value = await teamTasksApi.list({ staffId: filters.staffId, status: filters.status })
  } catch {
    tasks.value = []
    error.value = t('teamMgmt.tasks.loadError')
  } finally {
    loading.value = false
  }
}

async function createTask() {
  if (creating.value) return
  error.value = ''
  if (!form.staffId || !form.description.trim()) {
    error.value = t('teamMgmt.tasks.requiredFields')
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
    await loadTasks()
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err, 'teamMgmt.tasks.saveError')
  } finally {
    creating.value = false
  }
}

async function transition(task, action) {
  if (busyId.value) return
  busyId.value = task.id
  error.value = ''
  try {
    await (action === 'start' ? teamTasksApi.start(task.id) : teamTasksApi.complete(task.id))
    await loadTasks()
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err, 'teamMgmt.tasks.saveError')
  } finally {
    busyId.value = ''
  }
}

function workerName(id) {
  return workerById.value.get(id)?.name ?? id
}

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}

defineExpose({ reload: loadTasks })
onMounted(loadTasks)
</script>

<template>
  <section class="team-panel" aria-labelledby="team-tasks-title">
    <div class="team-panel__header">
      <h2 id="team-tasks-title" class="team-panel__title">{{ t('teamMgmt.tasks.title') }}</h2>
      <div class="team-panel__filters">
        <Select
          v-model="filters.staffId"
          :options="filterWorkerOptions"
          option-label="label"
          option-value="value"
          :aria-label="t('teamMgmt.tasks.workerLabel')"
          :placeholder="t('teamMgmt.tasks.allWorkers')"
          class="team-panel__filter"
          @change="loadTasks"
        />
        <Select
          v-model="filters.status"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          :aria-label="t('teamMgmt.tasks.statusLabel')"
          :placeholder="t('teamMgmt.tasks.allStatuses')"
          class="team-panel__filter"
          @change="loadTasks"
        />
      </div>
    </div>

    <form class="team-panel__form" @submit.prevent="createTask">
      <div class="team-panel__field">
        <label for="team-task-worker">{{ t('teamMgmt.tasks.workerLabel') }}</label>
        <Select
          v-model="form.staffId"
          input-id="team-task-worker"
          :options="activeWorkerOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('teamMgmt.tasks.workerPlaceholder')"
          fluid
        />
      </div>
      <div class="team-panel__field team-panel__field--grow">
        <label for="team-task-description">{{ t('teamMgmt.tasks.descriptionLabel') }}</label>
        <InputText id="team-task-description" v-model="form.description" maxlength="2000" fluid />
      </div>
      <div class="team-panel__field">
        <label for="team-task-scheduled">{{ t('teamMgmt.tasks.scheduledForLabel') }}</label>
        <input id="team-task-scheduled" v-model="form.scheduledFor" type="datetime-local" class="team-panel__native" />
      </div>
      <Button
        type="submit"
        :label="t('teamMgmt.tasks.create')"
        icon="pi pi-plus"
        :loading="creating"
        :disabled="!activeWorkerOptions.length"
      />
    </form>

    <p v-if="error" class="team-panel__error" role="alert">{{ error }}</p>

    <DataTable :value="tasks" :loading="loading" striped-rows size="small">
      <template #empty>
        <p class="team-panel__empty">{{ t('teamMgmt.tasks.empty') }}</p>
      </template>
      <Column :header="t('teamMgmt.tasks.descriptionLabel')">
        <template #body="{ data }">
          <span>{{ data.description }}</span>
          <small v-if="data.incidentId" class="team-panel__muted">
            · {{ t('teamMgmt.tasks.fromIncident', { id: data.incidentId }) }}
          </small>
        </template>
      </Column>
      <Column :header="t('teamMgmt.tasks.workerLabel')">
        <template #body="{ data }">{{ workerName(data.staffId) }}</template>
      </Column>
      <Column :header="t('teamMgmt.tasks.scheduledForLabel')">
        <template #body="{ data }">{{ formatDate(data.scheduledFor) }}</template>
      </Column>
      <Column :header="t('teamMgmt.tasks.statusLabel')">
        <template #body="{ data }">
          <span class="team-badge" :class="`team-badge--${String(data.status).toLowerCase()}`">
            {{ t(`teamMgmt.taskStatuses.${data.status}`) }}
          </span>
        </template>
      </Column>
      <Column :header="t('teamMgmt.tasks.actions')" class="team-panel__actions-col">
        <template #body="{ data }">
          <div class="team-panel__actions">
            <Button
              v-if="data.status === 'PENDING'"
              type="button"
              size="small"
              outlined
              :label="t('teamMgmt.tasks.start')"
              :loading="busyId === data.id"
              @click="transition(data, 'start')"
            />
            <Button
              v-if="data.status !== 'COMPLETED'"
              type="button"
              size="small"
              severity="success"
              :label="t('teamMgmt.tasks.complete')"
              :loading="busyId === data.id"
              @click="transition(data, 'complete')"
            />
            <span v-if="data.status === 'COMPLETED'" class="team-panel__muted">{{ formatDate(data.completedAt) }}</span>
          </div>
        </template>
      </Column>
    </DataTable>
  </section>
</template>

<style scoped>
.team-panel {
  margin-top: 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.team-panel__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.team-panel__title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.team-panel__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.team-panel__filter {
  min-width: 11rem;
}

.team-panel__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}

.team-panel__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 12rem;
}

.team-panel__field--grow {
  flex: 1 1 16rem;
}

.team-panel__field label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.team-panel__native {
  padding: 0.55rem 0.65rem;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  font: inherit;
}

.team-panel__error {
  margin: 0;
  font-size: 0.8125rem;
  color: #b42318;
}

.team-panel__empty {
  margin: 0;
  padding: 0.75rem 0;
  color: var(--apple-text-secondary, #6e6e73);
}

.team-panel__muted {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.8125rem;
}

.team-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  justify-content: flex-end;
}

.team-panel__actions-col {
  text-align: right;
}

.team-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  background: #f2f2f7;
  color: #3a3a3c;
}

.team-badge--in_progress {
  background: #fff4e5;
  color: #8a4b00;
}

.team-badge--completed {
  background: #e8f7ee;
  color: #1a7f37;
}
</style>
