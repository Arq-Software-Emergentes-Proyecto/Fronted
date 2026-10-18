<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Dropdown from 'primevue/dropdown'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { teamWorkersApi, STAFF_POSITIONS } from '@/team/infrastructure/teamWorkersApi.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import TeamTasksPanel from '@/team/presentation/components/TeamTasksPanel.vue'
import TeamShiftsPanel from '@/team/presentation/components/TeamShiftsPanel.vue'

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
  await tasksPanel.value?.reload?.()
}

function formatSalary(data) {
  const n = Number(data.salary)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US').format(n)
}

onMounted(loadWorkers)
</script>

<template>
  <div class="app-view">
    <div class="team-header">
      <h1 class="app-view__title">{{ t('app.team') }}</h1>
      <Button
        type="button"
        outlined
        :label="t('teamMgmt.addWorker')"
        icon="pi pi-user-plus"
        severity="success"
        @click="openModal"
      />
    </div>

    <Dialog
      v-model:visible="modalOpen"
      modal
      :header="t('teamMgmt.modalTitle')"
      class="team-dialog"
      :style="{ width: 'min(26rem, 92vw)' }"
      :draggable="false"
    >
      <div class="team-form">
        <div class="team-form__field" :class="{ 'bf-field--invalid': fieldErrors.name }">
          <label for="team-worker-name">{{ t('teamMgmt.nameLabel') }}</label>
          <InputText
            id="team-worker-name"
            v-model="form.name"
            class="team-form__input"
            autocomplete="name"
            required
            :invalid="fieldErrors.name"
            :aria-describedby="errorIdFor('name', fieldErrors.name)"
            fluid
            @update:model-value="fieldErrors.name = false"
          />
          <small v-if="fieldErrors.name" id="team-worker-name-error" class="bf-field-error">
            {{ t('common.fieldRequired') }}
          </small>
        </div>
        <div class="team-form__field" :class="{ 'bf-field--invalid': fieldErrors.phone }">
          <label for="team-worker-phone">{{ t('teamMgmt.phoneLabel') }}</label>
          <InputText
            id="team-worker-phone"
            v-model="form.phone"
            class="team-form__input"
            inputmode="tel"
            autocomplete="tel"
            required
            :invalid="fieldErrors.phone"
            :aria-describedby="errorIdFor('phone', fieldErrors.phone)"
            fluid
            @update:model-value="fieldErrors.phone = false"
          />
          <small v-if="fieldErrors.phone" id="team-worker-phone-error" class="bf-field-error">
            {{ t('common.fieldRequired') }}
          </small>
        </div>
        <div class="team-form__field" :class="{ 'bf-field--invalid': fieldErrors.dni }">
          <label for="team-worker-dni">{{ t('teamMgmt.dniLabel') }}</label>
          <InputText
            id="team-worker-dni"
            v-model="form.dni"
            class="team-form__input"
            required
            :invalid="fieldErrors.dni"
            :aria-describedby="errorIdFor('dni', fieldErrors.dni)"
            fluid
            @update:model-value="fieldErrors.dni = false"
          />
          <small v-if="fieldErrors.dni" id="team-worker-dni-error" class="bf-field-error">
            {{ t('common.fieldRequired') }}
          </small>
        </div>
        <div class="team-form__field" :class="{ 'bf-field--invalid': fieldErrors.salary }">
          <label for="team-worker-salary">{{ t('teamMgmt.salaryLabel') }}</label>
          <InputNumber
            v-model="form.salary"
            input-id="team-worker-salary"
            class="team-form__input-num w-full"
            :min="0"
            :maxFractionDigits="2"
            :invalid="fieldErrors.salary"
            :pt="{ pcInputText: { root: { 'aria-describedby': errorIdFor('salary', fieldErrors.salary) } } }"
            fluid
            @update:model-value="fieldErrors.salary = false"
          />
          <small v-if="fieldErrors.salary" id="team-worker-salary-error" class="bf-field-error">
            {{ t('common.fieldRequired') }}
          </small>
        </div>
        <div class="team-form__field">
          <label for="team-worker-position">{{ t('teamMgmt.positionLabel') }}</label>
          <Dropdown
            v-model="form.position"
            input-id="team-worker-position"
            :options="positionOptions"
            option-label="label"
            option-value="value"
            class="team-form__input w-full"
            fluid
          />
        </div>
        <div class="team-form__field team-form__field--photo">
          <span class="team-form__photo-label">{{ t('teamMgmt.photoLabel') }}</span>
          <p class="team-form__hint">{{ t('teamMgmt.photoHint') }}</p>
          <label class="team-form__file">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              class="team-form__file-input"
              :disabled="processingPhoto || saving"
              @change="onPhotoChange"
            />
            <span class="team-form__file-trigger">{{
              processingPhoto ? t('teamMgmt.processingPhoto') : t('teamMgmt.photoChoose')
            }}</span>
          </label>
          <div v-if="form.photoUrl" class="team-form__preview-row">
            <img
              :src="form.photoUrl"
              :alt="form.name.trim() ? form.name.trim() : t('teamMgmt.photoLabel')"
              class="team-form__preview"
              width="80"
              height="80"
            />
            <Button type="button" :label="t('teamMgmt.removePhoto')" variant="text" text @click="form.photoUrl = ''" />
          </div>
        </div>
        <p v-if="submitError" class="team-form__error" role="alert">{{ submitError }}</p>
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

    <DataTable :value="workers" :loading="loading" striped-rows class="team-table">
      <template #empty>
        <p class="team-table__empty">{{ t('teamMgmt.empty') }}</p>
      </template>
      <Column :header="t('teamMgmt.tablePhoto')" class="team-col-photo">
        <template #body="{ data }">
          <img
            v-if="data.photoUrl"
            :src="data.photoUrl"
            :alt="data.name"
            class="team-thumb"
            width="44"
            height="44"
          />
          <span v-else class="team-thumb-placeholder">—</span>
        </template>
      </Column>
      <Column field="name" :header="t('teamMgmt.tableName')" />
      <Column field="phone" :header="t('teamMgmt.tablePhone')" />
      <Column field="dni" :header="t('teamMgmt.tableDni')" />
      <Column :header="t('teamMgmt.tableSalary')">
        <template #body="{ data }">
          {{ formatSalary(data) }}
        </template>
      </Column>
      <Column :header="t('teamMgmt.tablePosition')">
        <template #body="{ data }">{{ positionLabel(data.position) }}</template>
      </Column>
      <Column :header="t('teamMgmt.tableOpenTasks')">
        <template #body="{ data }">{{ data.openTasks ?? 0 }}</template>
      </Column>
      <Column :header="t('teamMgmt.tableStatus')" class="team-col-status">
        <template #body="{ data }">
          <div class="team-status">
            <span
              class="team-status__badge"
              :class="data.status === 'INACTIVE' ? 'team-status__badge--inactive' : 'team-status__badge--active'"
            >
              {{ t(`teamMgmt.statuses.${data.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'}`) }}
            </span>
            <Button
              v-if="data.status === 'INACTIVE'"
              type="button"
              size="small"
              text
              :label="t('teamMgmt.reactivate')"
              :disabled="togglingStatus"
              @click="reactivateWorker(data)"
            />
            <Button
              v-else
              type="button"
              size="small"
              text
              severity="secondary"
              :label="t('teamMgmt.deactivate')"
              :disabled="togglingStatus"
              @click="askDeactivate(data)"
            />
          </div>
        </template>
      </Column>
      <Column :header="t('app.deleteAction')" class="team-col-actions">
        <template #body="{ data }">
          <Button
            type="button"
            text
            rounded
            class="team-row-delete"
            icon="pi pi-trash"
            :aria-label="t('app.deleteAction')"
            @click="askDelete(data)"
          />
        </template>
      </Column>
    </DataTable>

    <Dialog
      :visible="pendingDelete != null"
      modal
      :header="t('teamMgmt.deleteModalTitle')"
      class="team-delete-dialog"
      :style="{ width: 'min(24rem, 92vw)' }"
      :draggable="false"
      :closable="!deleting"
      @update:visible="(open) => { if (!open) closeDelete() }"
    >
      <p class="team-delete-dialog__text">
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

    <Dialog
      :visible="pendingDeactivate != null"
      modal
      :header="t('teamMgmt.deactivateModalTitle')"
      class="team-delete-dialog"
      :style="{ width: 'min(26rem, 92vw)' }"
      :draggable="false"
      :closable="!togglingStatus"
      @update:visible="(open) => { if (!open) closeDeactivate() }"
    >
      <p class="team-delete-dialog__text">
        {{ t('teamMgmt.deactivateConfirm', { name: pendingDeactivate?.name || '' }) }}
      </p>
      <div v-if="(pendingDeactivate?.openTasks ?? 0) > 0" class="team-form__field team-deactivate__reassign">
        <label for="team-reassign-to">
          {{ t('teamMgmt.reassignLabel', { count: pendingDeactivate?.openTasks ?? 0 }) }}
        </label>
        <Dropdown
          v-model="reassignToId"
          input-id="team-reassign-to"
          :options="reassignOptions"
          option-label="label"
          option-value="value"
          fluid
        />
      </div>
      <p v-if="statusError" class="team-form__error" role="alert">{{ statusError }}</p>
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

    <LoadErrorRetry v-if="listLoadFailed" :message="loadError" :loading="loading" @retry="loadWorkers" />
    <p v-else-if="loadError" class="app-view__error" role="alert">{{ loadError }}</p>

    <template v-if="!listLoadFailed">
      <TeamTasksPanel ref="tasksPanel" :workers="workers" @changed="loadWorkers" />
      <TeamShiftsPanel :workers="workers" />
    </template>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem;
  max-width: 72rem;
}

.app-view__title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--apple-text, #1d1d1f);
}

.team-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.team-table {
  margin-top: 0.25rem;
}

.team-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.team-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.team-form__field label,
.team-form__photo-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.team-form__hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.team-form__input,
.team-form__input-num {
  width: 100%;
}

.team-form__file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  overflow: hidden;
}

.team-form__file {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.team-form__file-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.85rem;
  border-radius: 10px;
  border: 1px solid #e8e8ed;
  background: #f5f5f7;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.team-form__file-trigger:hover {
  background: #ececf0;
}

.team-form__preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.35rem;
}

.team-form__preview {
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid #e8e8ed;
}

.team-form__error {
  margin: 0;
  font-size: 0.8125rem;
  color: #b42318;
}

.team-table__empty {
  margin: 0;
  padding: 1rem 0;
  color: var(--apple-text-secondary, #6e6e73);
}

.team-thumb {
  border-radius: 8px;
  object-fit: cover;
  vertical-align: middle;
  border: 1px solid #e8e8ed;
}

.team-thumb-placeholder {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.875rem;
}

.app-view__error {
  margin-top: 1rem;
  color: #b42318;
}

.team-col-actions {
  width: 5.5rem;
  text-align: right;
}

.team-row-delete :deep(.p-button) {
  color: #ff3b30;
}

.team-delete-dialog__text {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.45;
  color: var(--apple-text, #1d1d1f);
}

.team-dialog :deep(.p-dialog-footer),
.team-delete-dialog :deep(.p-dialog-footer) {
  gap: 0.5rem;
}

.team-status {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.team-status__badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}

.team-status__badge--active {
  background: #e8f7ee;
  color: #1a7f37;
}

.team-status__badge--inactive {
  background: #f2f2f7;
  color: #6e6e73;
}

.team-deactivate__reassign {
  margin-top: 0.85rem;
}

.team-dialog :deep(.p-inputnumber) {
  width: 100%;
}
</style>
