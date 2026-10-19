<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Select from 'primevue/select'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { teamShiftsApi } from '@/team/infrastructure/teamShiftsApi.js'

/** Team — shifts (Tabla 80 Shift). The API rejects overlapping shifts of one worker (409 SHIFT_OVERLAP). */
const props = defineProps({
  workers: { type: Array, default: () => [] },
})

const { t, locale } = useI18n()

const shifts = ref([])
const loading = ref(false)
const error = ref('')
const saving = ref(false)
const removingId = ref('')
const form = reactive({ staffId: null, start: '', end: '' })

const workerById = computed(() => new Map(props.workers.map((w) => [w.id, w])))
const workerOptions = computed(() =>
  props.workers
    .filter((w) => w.status !== 'INACTIVE')
    .map((w) => ({ value: w.id, label: w.name })),
)

async function loadShifts() {
  loading.value = true
  error.value = ''
  try {
    // Turnos desde hoy en adelante (los pasados no aportan a la planificación).
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    shifts.value = await teamShiftsApi.list({ from })
  } catch {
    shifts.value = []
    error.value = t('teamMgmt.shifts.loadError')
  } finally {
    loading.value = false
  }
}

async function createShift() {
  if (saving.value) return
  error.value = ''
  if (!form.staffId || !form.start || !form.end) {
    error.value = t('teamMgmt.shifts.requiredFields')
    return
  }
  if (new Date(form.end) <= new Date(form.start)) {
    error.value = t('teamMgmt.shifts.invalidRange')
    return
  }
  saving.value = true
  try {
    await teamShiftsApi.create({ staffId: form.staffId, start: form.start, end: form.end })
    form.start = ''
    form.end = ''
    await loadShifts()
  } catch (err) {
    if (err?.code === 'SHIFT_OVERLAP') error.value = t('teamMgmt.shifts.overlap')
    else if (err?.code === 'SHIFT_INVALID_RANGE') error.value = t('teamMgmt.shifts.invalidRange')
    else if (err?.code === 'WORKER_INACTIVE') error.value = t('teamMgmt.tasks.workerInactive')
    else error.value = t('teamMgmt.shifts.saveError')
  } finally {
    saving.value = false
  }
}

async function removeShift(shift) {
  if (removingId.value) return
  removingId.value = shift.id
  error.value = ''
  try {
    await teamShiftsApi.remove(shift.id)
    await loadShifts()
  } catch {
    error.value = t('teamMgmt.shifts.saveError')
  } finally {
    removingId.value = ''
  }
}

function formatDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}

onMounted(loadShifts)
</script>

<template>
  <section class="team-panel" aria-labelledby="team-shifts-title">
    <h2 id="team-shifts-title" class="team-panel__title">{{ t('teamMgmt.shifts.title') }}</h2>

    <form class="team-panel__form" @submit.prevent="createShift">
      <div class="team-panel__field">
        <label for="team-shift-worker">{{ t('teamMgmt.tasks.workerLabel') }}</label>
        <Select
          v-model="form.staffId"
          input-id="team-shift-worker"
          :options="workerOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('teamMgmt.tasks.workerPlaceholder')"
          fluid
        />
      </div>
      <div class="team-panel__field">
        <label for="team-shift-start">{{ t('teamMgmt.shifts.startLabel') }}</label>
        <input id="team-shift-start" v-model="form.start" type="datetime-local" class="team-panel__native" />
      </div>
      <div class="team-panel__field">
        <label for="team-shift-end">{{ t('teamMgmt.shifts.endLabel') }}</label>
        <input id="team-shift-end" v-model="form.end" type="datetime-local" class="team-panel__native" />
      </div>
      <Button
        type="submit"
        :label="t('teamMgmt.shifts.create')"
        icon="pi pi-calendar-plus"
        :loading="saving"
        :disabled="!workerOptions.length"
      />
    </form>

    <p v-if="error" class="team-panel__error" role="alert">{{ error }}</p>

    <DataTable :value="shifts" :loading="loading" striped-rows size="small">
      <template #empty>
        <p class="team-panel__empty">{{ t('teamMgmt.shifts.empty') }}</p>
      </template>
      <Column :header="t('teamMgmt.tasks.workerLabel')">
        <template #body="{ data }">{{ workerById.get(data.staffId)?.name ?? data.staffId }}</template>
      </Column>
      <Column :header="t('teamMgmt.shifts.startLabel')">
        <template #body="{ data }">{{ formatDate(data.start) }}</template>
      </Column>
      <Column :header="t('teamMgmt.shifts.endLabel')">
        <template #body="{ data }">{{ formatDate(data.end) }}</template>
      </Column>
      <Column :header="t('app.deleteAction')" class="team-panel__actions-col">
        <template #body="{ data }">
          <Button
            type="button"
            text
            rounded
            icon="pi pi-trash"
            severity="danger"
            :aria-label="t('app.deleteAction')"
            :loading="removingId === data.id"
            @click="removeShift(data)"
          />
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

.team-panel__title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
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

.team-panel__actions-col {
  text-align: right;
}
</style>
