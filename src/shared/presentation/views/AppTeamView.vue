<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { teamWorkersApi } from '@/team/infrastructure/teamWorkersApi.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'

const { t, locale } = useI18n()

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
})

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
  submitError.value = ''
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
  try {
    workers.value = await teamWorkersApi.list()
  } catch {
    loadError.value = t('teamMgmt.loadError')
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

  if (
    !form.name.trim() ||
    !form.phone.trim() ||
    !form.dni.trim() ||
    !Number.isFinite(salaryNum)
  ) {
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
        <div class="team-form__field">
          <label for="team-worker-name">{{ t('teamMgmt.nameLabel') }}</label>
          <InputText
            id="team-worker-name"
            v-model="form.name"
            class="team-form__input"
            autocomplete="name"
            fluid
          />
        </div>
        <div class="team-form__field">
          <label for="team-worker-phone">{{ t('teamMgmt.phoneLabel') }}</label>
          <InputText
            id="team-worker-phone"
            v-model="form.phone"
            class="team-form__input"
            inputmode="tel"
            autocomplete="tel"
            fluid
          />
        </div>
        <div class="team-form__field">
          <label for="team-worker-dni">{{ t('teamMgmt.dniLabel') }}</label>
          <InputText id="team-worker-dni" v-model="form.dni" class="team-form__input" fluid />
        </div>
        <div class="team-form__field">
          <label for="team-worker-salary">{{ t('teamMgmt.salaryLabel') }}</label>
          <InputNumber
            id="team-worker-salary"
            v-model="form.salary"
            class="team-form__input-num w-full"
            :min="0"
            :maxFractionDigits="2"
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

    <p v-if="loadError" class="app-view__error" role="alert">{{ loadError }}</p>
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

.team-dialog :deep(.p-inputnumber) {
  width: 100%;
}
</style>
