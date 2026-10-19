<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import { teamShiftsApi } from '@/team/infrastructure/teamShiftsApi.js'
import {
  dayHeading,
  dayKey,
  formatTimeRange,
  initialsOf,
  isSameDay,
  positionTone,
  toDate,
} from '@/team/presentation/teamUi.js'

/** Team — shifts (Tabla 80 Shift). The API rejects overlapping shifts of one worker (409 SHIFT_OVERLAP). */
const props = defineProps({
  workers: { type: Array, default: () => [] },
})
const emit = defineEmits(['loaded'])

const { t, locale } = useI18n()

const shifts = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const formError = ref('')
const saving = ref(false)
const removingId = ref('')
const dialogOpen = ref(false)
const form = reactive({ staffId: null, start: '', end: '' })
const formErrors = reactive({ staffId: false, start: false, end: false })

const workerById = computed(() => new Map(props.workers.map((w) => [w.id, w])))
const workerOptions = computed(() =>
  props.workers
    .filter((w) => w.status !== 'INACTIVE')
    .map((w) => ({ value: w.id, label: w.name })),
)

/** Shifts grouped by the local day they start on (API returns them sorted by start). */
const dayGroups = computed(() => {
  const groups = []
  const byKey = new Map()
  for (const shift of shifts.value) {
    const start = toDate(shift.start)
    if (!start) continue
    const key = dayKey(start)
    let group = byKey.get(key)
    if (!group) {
      group = { key, date: start, items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.items.push(shift)
  }
  return groups
})

function emitSummary() {
  const now = new Date()
  const today = shifts.value.filter((s) => {
    const start = toDate(s.start)
    const end = toDate(s.end)
    if (!start || !end) return false
    return isSameDay(start, now) || (start < now && end > now)
  }).length
  emit('loaded', { today, upcoming: shifts.value.length })
}

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
    loaded.value = true
    emitSummary()
  }
}

function openCreate(staffId = null) {
  const keep = workerOptions.value.some((o) => o.value === form.staffId) ? form.staffId : null
  form.staffId = staffId && workerOptions.value.some((o) => o.value === staffId) ? staffId : keep
  form.start = ''
  form.end = ''
  formErrors.staffId = false
  formErrors.start = false
  formErrors.end = false
  formError.value = ''
  dialogOpen.value = true
}

function closeCreate() {
  if (saving.value) return
  dialogOpen.value = false
}

async function createShift() {
  if (saving.value) return
  formError.value = ''
  formErrors.staffId = !form.staffId
  formErrors.start = !form.start
  formErrors.end = !form.end
  if (formErrors.staffId || formErrors.start || formErrors.end) {
    formError.value = t('teamMgmt.shifts.requiredFields')
    return
  }
  if (new Date(form.end) <= new Date(form.start)) {
    formErrors.end = true
    formError.value = t('teamMgmt.shifts.invalidRange')
    return
  }
  saving.value = true
  try {
    await teamShiftsApi.create({ staffId: form.staffId, start: form.start, end: form.end })
    form.start = ''
    form.end = ''
    dialogOpen.value = false
    await loadShifts()
  } catch (err) {
    if (err?.code === 'SHIFT_OVERLAP') formError.value = t('teamMgmt.shifts.overlap')
    else if (err?.code === 'SHIFT_INVALID_RANGE') formError.value = t('teamMgmt.shifts.invalidRange')
    else if (err?.code === 'WORKER_INACTIVE') formError.value = t('teamMgmt.tasks.workerInactive')
    else formError.value = t('teamMgmt.shifts.saveError')
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

function worker(id) {
  return workerById.value.get(id) ?? null
}

function workerName(id) {
  return worker(id)?.name ?? id
}

function durationLabel(shift) {
  const start = toDate(shift.start)
  const end = toDate(shift.end)
  if (!start || !end) return ''
  const hours = Math.round(((end - start) / 3600000) * 10) / 10
  const n = new Intl.NumberFormat(locale.value === 'en' ? 'en-US' : 'es-PE', { maximumFractionDigits: 1 }).format(hours)
  return t('teamMgmt.shifts.durationHours', { n })
}

defineExpose({ reload: loadShifts, openCreate })
onMounted(loadShifts)
</script>

<template>
  <section class="tm-shifts" aria-labelledby="team-shifts-title">
    <div class="tm-bar">
      <div class="tm-bar__text">
        <h2 id="team-shifts-title" class="tm-bar__title">{{ t('teamMgmt.shifts.title') }}</h2>
        <p class="tm-bar__intro">{{ t('teamMgmt.shifts.intro') }}</p>
      </div>
    </div>

    <p v-if="error" class="tm-alert" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      {{ error }}
    </p>

    <p v-if="loading && !loaded" class="tm-status" role="status">{{ t('teamMgmt.loading') }}</p>

    <div v-else-if="dayGroups.length" class="tm-days" :aria-busy="loading ? 'true' : 'false'">
      <section
        v-for="group in dayGroups"
        :key="group.key"
        class="tm-day"
        :aria-labelledby="`tm-day-${group.key}`"
      >
        <header class="tm-day__head">
          <h3 :id="`tm-day-${group.key}`" class="tm-day__title">
            {{ dayHeading(group.date, locale).title }}
            <span v-if="dayHeading(group.date, locale).subtitle" class="tm-day__sub">
              · {{ dayHeading(group.date, locale).subtitle }}
            </span>
          </h3>
          <span class="tm-day__count">{{ t('teamMgmt.shifts.countLabel', { n: group.items.length }, group.items.length) }}</span>
        </header>
        <ul class="tm-day__list">
          <li v-for="shift in group.items" :key="shift.id" class="tm-shift">
            <span class="tm-shift__time">
              <strong>{{ formatTimeRange(shift.start, shift.end, locale) }}</strong>
              <small>{{ durationLabel(shift) }}</small>
            </span>
            <span class="tm-person tm-shift__person">
              <img
                v-if="worker(shift.staffId)?.photoUrl"
                :src="worker(shift.staffId).photoUrl"
                alt=""
                class="tm-avatar tm-avatar--photo"
                width="36"
                height="36"
              />
              <span v-else class="tm-avatar" aria-hidden="true">{{ initialsOf(workerName(shift.staffId)) }}</span>
              <span class="tm-person__text">
                <span class="tm-person__name">{{ workerName(shift.staffId) }}</span>
                <small v-if="shift.notes" class="tm-person__sub">{{ shift.notes }}</small>
              </span>
            </span>
            <span
              v-if="worker(shift.staffId)?.position"
              class="tm-pill tm-shift__pos"
              :class="`tm-pill--${positionTone(worker(shift.staffId).position)}`"
            >
              {{ t(`teamMgmt.positions.${worker(shift.staffId).position}`) }}
            </span>
            <button
              type="button"
              class="tm-icon-btn tm-icon-btn--danger tm-shift__delete"
              :aria-label="t('teamMgmt.shifts.deleteAria', { name: workerName(shift.staffId) })"
              :title="t('app.deleteAction')"
              :disabled="Boolean(removingId)"
              @click="removeShift(shift)"
            >
              <i class="pi" :class="removingId === shift.id ? 'pi-spin pi-spinner' : 'pi-trash'" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </section>
    </div>

    <div v-else class="tm-empty">
      <span class="tm-empty__icon"><i class="pi pi-calendar" aria-hidden="true" /></span>
      <p class="tm-empty__text">{{ t('teamMgmt.shifts.empty') }}</p>
      <p v-if="!workerOptions.length" class="tm-empty__hint">{{ t('teamMgmt.shifts.noActiveWorkers') }}</p>
      <div class="tm-empty__actions">
        <button type="button" class="tm-btn tm-btn--primary" :disabled="!workerOptions.length" @click="openCreate()">
          <i class="pi pi-calendar-plus" aria-hidden="true" />
          {{ t('teamMgmt.newShift') }}
        </button>
      </div>
    </div>

    <Dialog
      v-model:visible="dialogOpen"
      modal
      :header="t('teamMgmt.shifts.modalTitle')"
      class="tm-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!saving"
    >
      <form id="team-shift-form" class="tm-form" novalidate @submit.prevent="createShift">
        <div class="tm-field">
          <label for="team-shift-worker">{{ t('teamMgmt.tasks.workerLabel') }}</label>
          <Select
            v-model="form.staffId"
            input-id="team-shift-worker"
            :options="workerOptions"
            option-label="label"
            option-value="value"
            :placeholder="t('teamMgmt.tasks.workerPlaceholder')"
            :invalid="formErrors.staffId"
            fluid
            @change="formErrors.staffId = false"
          />
        </div>
        <div class="tm-form__row">
          <div class="tm-field">
            <label for="team-shift-start">{{ t('teamMgmt.shifts.startLabel') }}</label>
            <input
              id="team-shift-start"
              v-model="form.start"
              type="datetime-local"
              class="tm-native"
              :class="{ 'is-invalid': formErrors.start }"
              :aria-invalid="formErrors.start ? 'true' : 'false'"
              @input="formErrors.start = false"
            />
          </div>
          <div class="tm-field">
            <label for="team-shift-end">{{ t('teamMgmt.shifts.endLabel') }}</label>
            <input
              id="team-shift-end"
              v-model="form.end"
              type="datetime-local"
              class="tm-native"
              :class="{ 'is-invalid': formErrors.end }"
              :aria-invalid="formErrors.end ? 'true' : 'false'"
              @input="formErrors.end = false"
            />
          </div>
        </div>
        <p class="tm-form__note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          {{ t('teamMgmt.shifts.overlapHint') }}
        </p>
        <p v-if="formError" class="tm-form__error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('teamMgmt.shifts.create')"
          confirm-icon="pi pi-calendar-plus"
          :loading="saving"
          :disabled="!workerOptions.length"
          @cancel="closeCreate"
          @confirm="createShift"
        />
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.tm-shifts {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-width: 0;
}

.tm-days {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.tm-day {
  min-width: 0;
}

.tm-day__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding: 0 0.15rem;
}

.tm-day__title {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 650;
  color: #0f172a;
}

.tm-day__sub {
  font-weight: 500;
  color: #6e6e73;
}

.tm-day__count {
  font-size: 0.75rem;
  color: #6e6e73;
  white-space: nowrap;
}

.tm-day__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  overflow: hidden;
}

.tm-shift {
  display: grid;
  grid-template-columns: minmax(10rem, 13rem) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0.7rem 0.85rem;
  background: #fff;
}

.tm-shift + .tm-shift {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.tm-shift:hover {
  background: #fafbfd;
}

.tm-shift__time {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tm-shift__time strong {
  font-size: 0.86rem;
  font-weight: 650;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.tm-shift__time small {
  font-size: 0.72rem;
  color: #6e6e73;
}

@media (max-width: 720px) {
  .tm-shift {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.55rem 0.75rem;
  }
  .tm-shift__person {
    grid-column: 1;
    grid-row: 1;
  }
  .tm-shift__delete {
    grid-column: 2;
    grid-row: 1;
  }
  .tm-shift__time {
    grid-column: 1;
    grid-row: 2;
  }
  .tm-shift__pos {
    grid-column: 2;
    grid-row: 2;
    justify-self: end;
  }
}
</style>
