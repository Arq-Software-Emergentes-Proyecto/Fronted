<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import { getResidentLimitForActiveOwner, refreshSubscriptionFromApi } from '@/billing/infrastructure/subscriptionPlanStorage.js'
import {
  deriveFloorFromDepartment,
  parseDepartmentNumber,
} from '@/shared/domain/departmentNumber.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'
import { formatDayMonth } from '@/finances/domain/billingCycle.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'

const { t, locale } = useI18n()
const financesStore = useFinancesStore()

const residents = ref([])
const accessLinks = reactive({})
const isLoading = ref(false)
const loadError = ref('')

const isAddResidentModalOpen = ref(false)
const modalError = ref('')
const isSubmitting = ref(false)
const residentForm = reactive({
  name: '',
  department: '',
})

const detectedFloor = computed(() => deriveFloorFromDepartment(residentForm.department))

const residentDeleteError = ref('')

const isDeleteResidentModalOpen = ref(false)
const deleteResidentCandidate = ref(null)
const deleteResidentPreview = ref(null)
const isLoadingDeletePreview = ref(false)
const isDeletingResidentCascade = ref(false)
const deleteResidentSummary = ref(null)
const deleteResidentHasErrors = ref(false)

const totalResidents = computed(() => residents.value.length)
const residentPlanLimitCap = ref(getResidentLimitForActiveOwner())

async function refreshPlanLimit() {
  await refreshSubscriptionFromApi()
  residentPlanLimitCap.value = getResidentLimitForActiveOwner()
}
function residentInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

async function loadResidents() {
  isLoading.value = true
  loadError.value = ''
  try {
    residents.value = await residentsApi.list()
  } catch {
    loadError.value = t('app.residentsLoadError')
  } finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  await refreshPlanLimit()
  await loadResidents()
})

function openAddResidentModal() {
  modalError.value = ''
  residentForm.name = ''
  residentForm.department = ''
  isAddResidentModalOpen.value = true
}

function closeAddResidentModal() {
  if (isSubmitting.value) return
  isAddResidentModalOpen.value = false
}

async function onAddResidentSubmit() {
  if (isSubmitting.value) return

  const name = residentForm.name.trim()
  const parsed = parseDepartmentNumber(residentForm.department)

  if (!name) {
    modalError.value = t('app.addResidentRequired')
    return
  }
  if (!parsed) {
    modalError.value = t('app.addResidentInvalidDepartment')
    return
  }

  isSubmitting.value = true
  modalError.value = ''
  try {
    const newResident = await residentsApi.add({
      name,
      department: parsed.department,
    })
    await refreshPlanLimit()
    await financesStore.generateInitialReceipt(newResident)
    residents.value = [newResident, ...residents.value]
    isAddResidentModalOpen.value = false
  } catch (error) {
    if (error?.code === 'RESIDENT_CODE_ALREADY_EXISTS') {
      modalError.value = t('app.addResidentCodeExists')
      return
    }
    if (error?.code === 'RESIDENT_FIELDS_REQUIRED') {
      modalError.value = t('app.addResidentRequired')
      return
    }
    if (error?.code === 'INVALID_DEPARTMENT_NUMBER') {
      modalError.value = t('app.addResidentInvalidDepartment')
      return
    }
    if (error?.code === 'RESIDENT_PLAN_LIMIT_REACHED') {
      modalError.value = t('app.addResidentPlanLimit', {
        max: getResidentLimitForActiveOwner(),
      })
      return
    }
    modalError.value = t('auth.genericError')
  } finally {
    isSubmitting.value = false
  }
}

function generateResidentAccessLink(resident) {
  if (accessLinks[resident.id]) {
    delete accessLinks[resident.id]
    return
  }
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const params = new URLSearchParams({
    invite: '1',
    token: resident.inviteToken || '',
  })
  if (!resident.inviteToken) {
    // Fallback legacy: unit code (no sirve si el backend ya exige InviteToken)
    params.set('code', resident.code || '')
    params.delete('token')
  }
  accessLinks[resident.id] = `${baseUrl}/login?${params.toString()}`
}

async function openDeleteResidentModal(resident) {
  if (isDeletingResidentCascade.value) return
  deleteResidentCandidate.value = resident
  deleteResidentPreview.value = null
  deleteResidentSummary.value = null
  deleteResidentHasErrors.value = false
  residentDeleteError.value = ''
  isDeleteResidentModalOpen.value = true
  isLoadingDeletePreview.value = true
  try {
    const preview = await residentsApi.previewLinkedData(resident.id)
    deleteResidentPreview.value = preview.summary
  } catch {
    deleteResidentPreview.value = { reservations: 0 }
  } finally {
    isLoadingDeletePreview.value = false
  }
}

function closeDeleteResidentModal() {
  if (isDeletingResidentCascade.value) return
  isDeleteResidentModalOpen.value = false
  deleteResidentCandidate.value = null
  deleteResidentPreview.value = null
  deleteResidentSummary.value = null
  deleteResidentHasErrors.value = false
}

async function confirmDeleteResidentCascade() {
  if (!deleteResidentCandidate.value || isDeletingResidentCascade.value) return
  const resident = deleteResidentCandidate.value
  isDeletingResidentCascade.value = true
  residentDeleteError.value = ''
  try {
    const result = await residentsApi.removeCascade(resident.id)
    deleteResidentSummary.value = result.summary
    deleteResidentHasErrors.value = (result.errors?.length ?? 0) > 0
    residents.value = residents.value.filter((item) => item.id !== resident.id)
    delete accessLinks[resident.id]
    if (result.errors?.length) {
      console.warn('Cascade delete partial errors:', result.errors)
    }
  } catch (error) {
    console.error('Cascade delete failed:', error)
    residentDeleteError.value = t('app.deleteResidentError')
  } finally {
    isDeletingResidentCascade.value = false
  }
}

const isBulkResidentsModalOpen = ref(false)
const bulkResidentsText = ref('')
const isSubmittingBulk = ref(false)
const bulkResults = ref([])

function openBulkResidentsModal() {
  bulkResidentsText.value = ''
  bulkResults.value = []
  isAddResidentModalOpen.value = false
  isBulkResidentsModalOpen.value = true
}

function closeBulkResidentsModal() {
  if (isSubmittingBulk.value) return
  isBulkResidentsModalOpen.value = false
}

function parseBulkLine(line) {
  const parts = line.split('-').map((part) => part.trim())
  if (parts.length !== 2) return null
  const [name, departmentRaw] = parts
  const parsed = parseDepartmentNumber(departmentRaw)
  if (!name || !parsed) return null
  return { name, department: parsed.department }
}

async function onBulkResidentsSubmit() {
  if (isSubmittingBulk.value) return

  const lines = bulkResidentsText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (!lines.length) {
    bulkResults.value = [
      { line: 0, raw: '', status: 'error', message: t('app.bulkEmpty') },
    ]
    return
  }

  isSubmittingBulk.value = true
  const results = []
  const created = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const parsed = parseBulkLine(raw)
    if (!parsed) {
      results.push({
        line: i + 1,
        raw,
        status: 'error',
        message: t('app.bulkLineFormatError'),
      })
      continue
    }

    try {
      const newResident = await residentsApi.add(parsed)
      await financesStore.generateInitialReceipt(newResident)
      created.push(newResident)
      results.push({
        line: i + 1,
        raw,
        status: 'ok',
        message: t('app.bulkLineCreated', { name: newResident.name }),
      })
    } catch (error) {
      let message = t('auth.genericError')
      if (error?.code === 'RESIDENT_CODE_ALREADY_EXISTS') {
        message = t('app.addResidentCodeExists')
      } else if (error?.code === 'RESIDENT_FIELDS_REQUIRED') {
        message = t('app.addResidentRequired')
      } else if (error?.code === 'INVALID_DEPARTMENT_NUMBER') {
        message = t('app.addResidentInvalidDepartment')
      } else if (error?.code === 'RESIDENT_PLAN_LIMIT_REACHED') {
        message = t('app.addResidentPlanLimit', {
          max: getResidentLimitForActiveOwner(),
        })
      }
      results.push({ line: i + 1, raw, status: 'error', message })
    }
  }

  if (created.length) {
    residents.value = [...created, ...residents.value]
    const failedLines = results
      .filter((r) => r.status === 'error')
      .map((r) => r.raw)
    bulkResidentsText.value = failedLines.join('\n')
  }

  bulkResults.value = results
  isSubmittingBulk.value = false
}

const spaces = ref([])
const isLoadingSpaces = ref(false)
const spacesLoadError = ref('')

const isAddSpaceModalOpen = ref(false)
const spaceForm = reactive({ name: '', description: '', capacity: '', imageUrl: '' })
const spaceModalError = ref('')
const isSubmittingSpace = ref(false)
const isProcessingAddImage = ref(false)

const isEditSpaceModalOpen = ref(false)
const editSpaceForm = reactive({
  id: '',
  name: '',
  description: '',
  capacity: '',
  imageUrl: '',
})
const editSpaceModalError = ref('')
const isSubmittingEditSpace = ref(false)
const isProcessingEditImage = ref(false)

const deletingSpaceIds = reactive({})
const spaceDeleteError = ref('')

const isSpaceCalendarModalOpen = ref(false)
const selectedSpace = ref(null)
const spaceReservations = ref([])
const isLoadingReservations = ref(false)
const reservationsLoadError = ref('')

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

async function loadSpaces() {
  isLoadingSpaces.value = true
  spacesLoadError.value = ''
  try {
    spaces.value = await spacesApi.list()
  } catch {
    spacesLoadError.value = t('app.spacesLoadError')
  } finally {
    isLoadingSpaces.value = false
  }
}

onMounted(loadSpaces)

function openAddSpaceModal() {
  spaceModalError.value = ''
  spaceForm.name = ''
  spaceForm.description = ''
  spaceForm.capacity = ''
  spaceForm.imageUrl = ''
  isAddSpaceModalOpen.value = true
}

function closeAddSpaceModal() {
  if (isSubmittingSpace.value) return
  isAddSpaceModalOpen.value = false
}

async function onAddSpaceImageSelected(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!file.type?.startsWith('image/')) {
    spaceModalError.value = t('app.spaceImageInvalid')
    return
  }
  isProcessingAddImage.value = true
  spaceModalError.value = ''
  try {
    spaceForm.imageUrl = await processImageFile(file)
  } catch {
    spaceModalError.value = t('app.spaceImageError')
  } finally {
    isProcessingAddImage.value = false
  }
}

function clearAddSpaceImage() {
  spaceForm.imageUrl = ''
}

async function onAddSpaceSubmit() {
  if (isSubmittingSpace.value) return

  const name = spaceForm.name.trim()
  if (!name) {
    spaceModalError.value = t('app.spaceNameRequired')
    return
  }

  isSubmittingSpace.value = true
  spaceModalError.value = ''
  try {
    const newSpace = await spacesApi.add({
      name,
      description: spaceForm.description,
      capacity: spaceForm.capacity,
      imageUrl: spaceForm.imageUrl,
    })
    spaces.value = [newSpace, ...spaces.value]
    isAddSpaceModalOpen.value = false
  } catch (error) {
    if (error?.code === 'SPACE_NAME_REQUIRED') {
      spaceModalError.value = t('app.spaceNameRequired')
      return
    }
    spaceModalError.value = t('auth.genericError')
  } finally {
    isSubmittingSpace.value = false
  }
}

function openEditSpaceModal(space) {
  editSpaceModalError.value = ''
  editSpaceForm.id = space.id
  editSpaceForm.name = space.name ?? ''
  editSpaceForm.description = space.description ?? ''
  editSpaceForm.capacity = space.capacity ?? ''
  editSpaceForm.imageUrl = space.imageUrl ?? ''
  isEditSpaceModalOpen.value = true
}

function closeEditSpaceModal() {
  if (isSubmittingEditSpace.value) return
  isEditSpaceModalOpen.value = false
}

async function onEditSpaceImageSelected(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!file.type?.startsWith('image/')) {
    editSpaceModalError.value = t('app.spaceImageInvalid')
    return
  }
  isProcessingEditImage.value = true
  editSpaceModalError.value = ''
  try {
    editSpaceForm.imageUrl = await processImageFile(file)
  } catch {
    editSpaceModalError.value = t('app.spaceImageError')
  } finally {
    isProcessingEditImage.value = false
  }
}

function clearEditSpaceImage() {
  editSpaceForm.imageUrl = ''
}

async function onEditSpaceSubmit() {
  if (isSubmittingEditSpace.value) return

  const name = editSpaceForm.name.trim()
  if (!name) {
    editSpaceModalError.value = t('app.spaceNameRequired')
    return
  }

  isSubmittingEditSpace.value = true
  editSpaceModalError.value = ''
  try {
    const updated = await spacesApi.update({
      id: editSpaceForm.id,
      name,
      description: editSpaceForm.description,
      capacity: editSpaceForm.capacity,
      imageUrl: editSpaceForm.imageUrl,
    })
    spaces.value = spaces.value.map((space) =>
      space.id === updated.id ? updated : space,
    )
    isEditSpaceModalOpen.value = false
  } catch (error) {
    if (error?.code === 'SPACE_NAME_REQUIRED') {
      editSpaceModalError.value = t('app.spaceNameRequired')
      return
    }
    editSpaceModalError.value = t('auth.genericError')
  } finally {
    isSubmittingEditSpace.value = false
  }
}

const isDeleteSpaceModalOpen = ref(false)
const deleteSpaceCandidate = ref(null)
const deleteSpacePreview = ref(null)
const isLoadingSpaceDeletePreview = ref(false)
const isDeletingSpace = ref(false)
const deleteSpaceSummary = ref(null)

async function openDeleteSpaceModal(space) {
  if (isDeletingSpace.value) return
  deleteSpaceCandidate.value = space
  deleteSpacePreview.value = null
  deleteSpaceSummary.value = null
  spaceDeleteError.value = ''
  isDeleteSpaceModalOpen.value = true
  isLoadingSpaceDeletePreview.value = true
  try {
    const reservations = await reservationsApi.listBySpace(space.id)
    deleteSpacePreview.value = {
      reservations: Array.isArray(reservations) ? reservations.length : 0,
    }
  } catch {
    deleteSpacePreview.value = { reservations: 0 }
  } finally {
    isLoadingSpaceDeletePreview.value = false
  }
}

function closeDeleteSpaceModal() {
  if (isDeletingSpace.value) return
  isDeleteSpaceModalOpen.value = false
  deleteSpaceCandidate.value = null
  deleteSpacePreview.value = null
  deleteSpaceSummary.value = null
}

async function confirmDeleteSpace() {
  const space = deleteSpaceCandidate.value
  if (!space || isDeletingSpace.value) return

  isDeletingSpace.value = true
  spaceDeleteError.value = ''
  deletingSpaceIds[space.id] = true
  try {
    const result = await reservationsApi.removeBySpace(space.id)
    await spacesApi.remove(space.id)
    spaces.value = spaces.value.filter((item) => item.id !== space.id)
    deleteSpaceSummary.value = { reservations: result?.removed ?? 0 }
  } catch {
    spaceDeleteError.value = t('app.deleteSpaceError')
  } finally {
    isDeletingSpace.value = false
    delete deletingSpaceIds[space.id]
  }
}

async function openSpaceCalendar(space) {
  selectedSpace.value = space
  isSpaceCalendarModalOpen.value = true
  isLoadingReservations.value = true
  reservationsLoadError.value = ''
  try {
    spaceReservations.value = await reservationsApi.listBySpace(space.id)
  } catch {
    reservationsLoadError.value = t('app.reservationsLoadError')
    spaceReservations.value = []
  } finally {
    isLoadingReservations.value = false
  }
}

function closeSpaceCalendar() {
  isSpaceCalendarModalOpen.value = false
  selectedSpace.value = null
  spaceReservations.value = []
}

const groupedReservations = computed(() => {
  const map = new Map()
  for (const reservation of spaceReservations.value) {
    if (!map.has(reservation.date)) {
      map.set(reservation.date, [])
    }
    map.get(reservation.date).push(reservation)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      items: items
        .slice()
        .sort((a, b) => a.startTime.localeCompare(b.startTime)),
    }))
})
</script>

<template>
  <div class="app-view">
    <div class="finance-page">
      <div class="finance-main-row">
        <article class="finance-panel finance-panel--table import-panel mgmt-col" aria-labelledby="residents-col-heading">
          <div class="mgmt-panel-toolbar">
            <h2 id="residents-col-heading" class="finance-panel__section-title">
              <i class="pi pi-users" aria-hidden="true" />
              {{ t('app.residentsColumnTitle') }}
            </h2>
            <Button
              type="button"
              icon="pi pi-plus"
              class="import-dropzone__btn"
              :label="t('app.addResidentAction')"
              @click="openAddResidentModal"
            />
          </div>

          <p v-if="residentDeleteError" class="import-alert import-alert--error" role="alert">
            {{ residentDeleteError }}
          </p>

          <div v-if="isLoading" class="import-status import-panel-state">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>{{ t('app.residentsLoading') }}</span>
          </div>
          <div v-else-if="loadError" class="import-alert import-alert--error import-panel-state" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true" />
            <span>{{ loadError }}</span>
          </div>
          <div v-else-if="!residents.length" class="import-empty import-panel-state">
            <i class="pi pi-inbox" aria-hidden="true" />
            <span>{{ t('app.emptyResidents') }}</span>
          </div>
        <ul v-else class="r-list" role="list">
          <li v-for="resident in residents" :key="resident.id" class="r-card">
            <div class="r-card__row">
              <span class="r-card__avatar" :class="{ 'r-card__avatar--active': resident.hasCredentials }">
                {{ residentInitials(resident.name) }}
              </span>
              <div class="r-card__body">
                <p class="r-card__name">
                  {{ resident.name }}
                  <span v-if="resident.hasCredentials" class="r-card__badge">
                    <i class="pi pi-check-circle" aria-hidden="true" />
                  </span>
                </p>
                <p class="r-card__meta">
                  {{ t('app.residentFloorApt', { floor: resident.floor, code: resident.code }) }}
                  <template v-if="resident.admissionDate">
                    · {{ t('app.residentAdmissionDate', { date: formatDayMonth(resident.admissionDate, locale) }) }}
                  </template>
                  <template v-if="resident.email"> · {{ resident.email }}</template>
                </p>
              </div>
              <div class="r-card__actions">
                <button
                  type="button"
                  class="r-card__icon-btn r-card__icon-btn--link"
                  :class="{ 'is-open': accessLinks[resident.id] }"
                  :title="
                    accessLinks[resident.id]
                      ? t('app.hideResidentLinkAction')
                      : t('app.shareResidentAction')
                  "
                  @click="generateResidentAccessLink(resident)"
                >
                  <span class="r-card__link-icon" :class="{ 'r-card__link-icon--open': accessLinks[resident.id] }">
                    <i class="pi pi-link r-card__link-icon-item r-card__link-icon-item--link" aria-hidden="true" />
                    <i class="pi pi-chevron-up r-card__link-icon-item r-card__link-icon-item--up" aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  class="r-card__icon-btn r-card__icon-btn--danger"
                  :title="t('app.deleteResidentAction')"
                  :disabled="isDeletingResidentCascade && deleteResidentCandidate?.id === resident.id"
                  @click="openDeleteResidentModal(resident)"
                >
                  <i class="pi pi-trash" aria-hidden="true" />
                </button>
              </div>
            </div>
            <Transition name="r-card-link">
              <a
                v-if="accessLinks[resident.id]"
                class="r-card__link"
                :href="accessLinks[resident.id]"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ accessLinks[resident.id] }}
              </a>
            </Transition>
          </li>
        </ul>
      </article>

        <article class="finance-panel finance-panel--table import-panel mgmt-col" aria-labelledby="spaces-col-heading">
          <div class="mgmt-panel-toolbar">
            <h2 id="spaces-col-heading" class="finance-panel__section-title">
              <i class="pi pi-building" aria-hidden="true" />
              {{ t('app.spacesColumnTitle') }}
            </h2>
            <Button
              type="button"
              icon="pi pi-plus"
              class="import-dropzone__btn"
              :label="t('app.addSpaceAction')"
              @click="openAddSpaceModal"
            />
          </div>

          <p v-if="spaceDeleteError" class="import-alert import-alert--error" role="alert">
            {{ spaceDeleteError }}
          </p>

          <div v-if="isLoadingSpaces" class="import-status import-panel-state">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>{{ t('app.spacesLoading') }}</span>
          </div>
          <div v-else-if="spacesLoadError" class="import-alert import-alert--error import-panel-state" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true" />
            <span>{{ spacesLoadError }}</span>
          </div>
          <div v-else-if="!spaces.length" class="import-empty import-panel-state">
            <i class="pi pi-image" aria-hidden="true" />
            <span>{{ t('app.emptySpaces') }}</span>
          </div>
        <ul v-else class="s-list" role="list">
          <li
            v-for="space in spaces"
            :key="space.id"
            class="s-card"
            tabindex="0"
            role="button"
            @click="openSpaceCalendar(space)"
            @keyup.enter="openSpaceCalendar(space)"
            @keyup.space.prevent="openSpaceCalendar(space)"
          >
            <div class="s-card__thumb">
              <img
                v-if="space.imageUrl"
                :src="space.imageUrl"
                :alt="t('app.spaceImageAlt', { name: space.name })"
                class="s-card__img"
              />
              <div v-else class="s-card__placeholder" aria-hidden="true">
                <i class="pi pi-image" />
              </div>
            </div>
            <div class="s-card__info">
              <p class="s-card__name">{{ space.name }}</p>
              <p class="s-card__meta">
                <template v-if="space.capacity">
                  <i class="pi pi-users" aria-hidden="true" />
                  {{ space.capacity }}
                </template>
                <template v-if="space.capacity && space.description"> · </template>
                <template v-if="space.description">{{ space.description }}</template>
              </p>
            </div>
            <div class="s-card__actions" @click.stop @keyup.stop @keydown.stop>
              <button
                type="button"
                class="r-card__icon-btn r-card__icon-btn--edit"
                :title="t('app.editSpaceAction')"
                @click.stop="openEditSpaceModal(space)"
              >
                <i class="pi pi-pencil" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="r-card__icon-btn r-card__icon-btn--danger"
                :title="t('app.deleteSpaceAction')"
                :disabled="isDeletingSpace && deleteSpaceCandidate?.id === space.id"
                @click.stop="openDeleteSpaceModal(space)"
              >
                <i class="pi pi-trash" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ul>
      </article>
      </div>

      <p class="mgmt-view-footer" role="note">
        {{ t('app.residentPlanUsageHint', { current: totalResidents, max: residentPlanLimitCap }) }}
      </p>
    </div>

    <div
      v-if="isAddResidentModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeAddResidentModal"
    >
      <section class="resident-modal bf-modal-panel" role="dialog" aria-modal="true" :aria-label="t('app.addResidentModalTitle')">
        <div class="resident-modal__header">
          <h3 class="resident-modal__title">{{ t('app.addResidentModalTitle') }}</h3>
          <button
            type="button"
            class="resident-modal__bulk-btn"
            :disabled="isSubmitting"
            @click="openBulkResidentsModal"
          >
            <i class="pi pi-list" aria-hidden="true" />
            {{ t('app.addBulkResidentsAction') }}
          </button>
        </div>

        <form class="resident-modal__form" @submit.prevent="onAddResidentSubmit">
          <label class="resident-modal__field">
            <span>{{ t('app.residentNameLabel') }}</span>
            <input v-model="residentForm.name" type="text" autocomplete="name" />
          </label>

          <label class="resident-modal__field">
            <span>{{ t('app.residentDepartmentLabel') }}</span>
            <input
              v-model="residentForm.department"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="4"
              :placeholder="t('app.residentDepartmentPlaceholder')"
              autocomplete="off"
            />
            <span
              v-if="detectedFloor"
              class="resident-modal__field-preview"
              aria-live="polite"
            >
              {{ t('app.residentFloorDetected', { floor: detectedFloor }) }}
            </span>
          </label>

          <p v-if="modalError" class="resident-modal__error">{{ modalError }}</p>

          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="isSubmitting ? t('app.savingResidentAction') : t('app.saveResidentAction')"
            confirm-type="submit"
            :stagger="false"
            :loading="isSubmitting"
            :cancel-disabled="isSubmitting"
            @cancel="closeAddResidentModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="isBulkResidentsModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeBulkResidentsModal"
    >
      <section
        class="resident-modal resident-modal--wide bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.bulkResidentsModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('app.bulkResidentsModalTitle') }}</h3>
        <p class="resident-modal__hint">{{ t('app.bulkResidentsHint') }}</p>
        <p class="resident-modal__example">{{ t('app.bulkResidentsExample') }}</p>

        <form class="resident-modal__form" @submit.prevent="onBulkResidentsSubmit">
          <label class="resident-modal__field">
            <span>{{ t('app.bulkResidentsTextareaLabel') }}</span>
            <textarea
              v-model="bulkResidentsText"
              class="resident-modal__textarea"
              rows="8"
              :placeholder="t('app.bulkResidentsPlaceholder')"
            />
          </label>

          <ul v-if="bulkResults.length" class="bulk-results" role="list">
            <li
              v-for="result in bulkResults"
              :key="result.line"
              class="bulk-results__item"
              :class="{
                'bulk-results__item--ok': result.status === 'ok',
                'bulk-results__item--error': result.status === 'error',
              }"
            >
              <span class="bulk-results__line">#{{ result.line }}</span>
              <span class="bulk-results__msg">{{ result.message }}</span>
            </li>
          </ul>

          <ConfirmActions
            :cancel-label="t('app.closeAction')"
            :confirm-label="isSubmittingBulk ? t('app.bulkResidentsSubmitting') : t('app.bulkResidentsSubmit')"
            confirm-type="submit"
            :stagger="false"
            :loading="isSubmittingBulk"
            :cancel-disabled="isSubmittingBulk"
            @cancel="closeBulkResidentsModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="isAddSpaceModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeAddSpaceModal"
    >
      <section class="resident-modal bf-modal-panel" role="dialog" aria-modal="true" :aria-label="t('app.addSpaceModalTitle')">
        <h3 class="resident-modal__title">{{ t('app.addSpaceModalTitle') }}</h3>

        <form class="resident-modal__form" @submit.prevent="onAddSpaceSubmit">
          <label class="resident-modal__field">
            <span>{{ t('app.spaceNameLabel') }}</span>
            <input v-model="spaceForm.name" type="text" />
          </label>

          <label class="resident-modal__field">
            <span>{{ t('app.spaceDescriptionLabel') }}</span>
            <input v-model="spaceForm.description" type="text" />
          </label>

          <label class="resident-modal__field">
            <span>{{ t('app.spaceCapacityLabel') }}</span>
            <input v-model="spaceForm.capacity" type="number" min="1" />
          </label>

          <div class="resident-modal__field space-image-field">
            <div v-if="spaceForm.imageUrl" class="space-image-field__preview">
              <img :src="spaceForm.imageUrl" alt="" />
            </div>
            <div class="space-image-field__controls">
              <label class="space-image-field__btn">
                <input
                  type="file"
                  accept="image/*"
                  class="space-image-field__input"
                  :disabled="isProcessingAddImage || isSubmittingSpace"
                  @change="onAddSpaceImageSelected"
                />
                <i class="pi pi-upload" aria-hidden="true" />
                <span>
                  {{
                    isProcessingAddImage
                      ? t('app.spaceImageProcessing')
                      : spaceForm.imageUrl
                        ? t('app.spaceImageChange')
                        : t('app.spaceImageLabel')
                  }}
                </span>
              </label>
              <button
                v-if="spaceForm.imageUrl"
                type="button"
                class="r-card__icon-btn r-card__icon-btn--danger"
                :title="t('app.spaceImageRemove')"
                :aria-label="t('app.spaceImageRemove')"
                :disabled="isProcessingAddImage || isSubmittingSpace"
                @click="clearAddSpaceImage"
              >
                <i class="pi pi-trash" aria-hidden="true" />
              </button>
            </div>
          </div>

          <p v-if="spaceModalError" class="resident-modal__error">{{ spaceModalError }}</p>

          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="isSubmittingSpace ? t('app.savingSpaceAction') : t('app.saveSpaceAction')"
            confirm-type="submit"
            :stagger="false"
            :loading="isSubmittingSpace"
            :disabled="isSubmittingSpace || isProcessingAddImage"
            :cancel-disabled="isSubmittingSpace"
            @cancel="closeAddSpaceModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="isEditSpaceModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeEditSpaceModal"
    >
      <section
        class="resident-modal resident-modal--horizontal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.editSpaceModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('app.editSpaceModalTitle') }}</h3>

        <form class="resident-modal__form" @submit.prevent="onEditSpaceSubmit">
          <div class="resident-modal__grid">
            <div class="resident-modal__fields">
              <label class="resident-modal__field">
                <span>{{ t('app.spaceNameLabel') }}</span>
                <input v-model="editSpaceForm.name" type="text" />
              </label>

              <label class="resident-modal__field">
                <span>{{ t('app.spaceDescriptionLabel') }}</span>
                <input v-model="editSpaceForm.description" type="text" />
              </label>

              <label class="resident-modal__field">
                <span>{{ t('app.spaceCapacityLabel') }}</span>
                <input v-model="editSpaceForm.capacity" type="number" min="1" />
              </label>
            </div>

            <div class="resident-modal__field space-image-field">
              <span>{{ t('app.spaceImageLabel') }}</span>
              <div v-if="editSpaceForm.imageUrl" class="space-image-field__preview">
                <img :src="editSpaceForm.imageUrl" alt="" />
              </div>
              <div class="space-image-field__controls">
                <label class="space-image-field__btn">
                  <input
                    type="file"
                    accept="image/*"
                    class="space-image-field__input"
                    :disabled="isProcessingEditImage || isSubmittingEditSpace"
                    @change="onEditSpaceImageSelected"
                  />
                  <i class="pi pi-upload" aria-hidden="true" />
                  <span>
                    {{
                      isProcessingEditImage
                        ? t('app.spaceImageProcessing')
                        : editSpaceForm.imageUrl
                          ? t('app.spaceImageChange')
                          : t('app.spaceImageLabel')
                    }}
                  </span>
                </label>
                <button
                  v-if="editSpaceForm.imageUrl"
                  type="button"
                  class="r-card__icon-btn r-card__icon-btn--danger"
                  :title="t('app.spaceImageRemove')"
                  :aria-label="t('app.spaceImageRemove')"
                  :disabled="isProcessingEditImage || isSubmittingEditSpace"
                  @click="clearEditSpaceImage"
                >
                  <i class="pi pi-trash" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <p v-if="editSpaceModalError" class="resident-modal__error">{{ editSpaceModalError }}</p>

          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="
              isSubmittingEditSpace ? t('app.savingSpaceUpdateAction') : t('app.saveSpaceUpdateAction')
            "
            confirm-type="submit"
            :stagger="false"
            :loading="isSubmittingEditSpace"
            :disabled="isSubmittingEditSpace || isProcessingEditImage"
            :cancel-disabled="isSubmittingEditSpace"
            @cancel="closeEditSpaceModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="isDeleteResidentModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeDeleteResidentModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.deleteResidentModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('app.deleteResidentModalTitle') }}</h3>

        <div class="resident-modal__form">
          <p class="resident-modal__hint">
            {{
              t('app.deleteResidentWarning', {
                name: deleteResidentCandidate?.name || '',
              })
            }}
          </p>

          <div v-if="!deleteResidentSummary" class="delete-impact">
            <p class="delete-impact__title">{{ t('app.deleteResidentImpactTitle') }}</p>
            <p v-if="isLoadingDeletePreview" class="delete-impact__loading">
              {{ t('app.deleteResidentLoadingPreview') }}
            </p>
            <ul v-else class="delete-impact__list">
              <li
                v-if="(deleteResidentPreview?.reservations ?? 0) > 0"
                class="delete-impact__item"
              >
                <i class="pi pi-calendar" aria-hidden="true" />
                {{
                  t('app.deleteResidentImpactReservations', {
                    n: deleteResidentPreview?.reservations ?? 0,
                  })
                }}
              </li>
              <li class="delete-impact__item">
                <i class="pi pi-id-card" aria-hidden="true" />
                {{ t('app.deleteResidentImpactAccount') }}
              </li>
              <li
                v-if="(deleteResidentPreview?.reservations ?? 0) === 0"
                class="delete-impact__item delete-impact__item--muted"
              >
                <i class="pi pi-info-circle" aria-hidden="true" />
                {{ t('app.deleteResidentImpactNone') }}
              </li>
            </ul>
          </div>

          <div v-else class="delete-summary">
            <p class="delete-summary__title">
              <i class="pi pi-check-circle" aria-hidden="true" />
              {{ t('app.deleteResidentSuccessTitle') }}
            </p>
            <p class="delete-summary__subtitle">
              {{ t('app.deleteResidentSuccessSummary') }}
            </p>
            <ul class="delete-summary__list">
              <li class="delete-summary__item">
                <i class="pi pi-calendar" aria-hidden="true" />
                {{
                  t('app.deleteResidentSummaryReservations', {
                    n: deleteResidentSummary.reservations,
                  })
                }}
              </li>
              <li class="delete-summary__item">
                <i class="pi pi-id-card" aria-hidden="true" />
                {{ t('app.deleteResidentSummaryAccount') }}
              </li>
            </ul>
            <p
              v-if="deleteResidentHasErrors"
              class="delete-summary__partial"
            >
              {{ t('app.deleteResidentPartialError') }}
            </p>
          </div>

          <p v-if="residentDeleteError" class="resident-modal__error">
            {{ residentDeleteError }}
          </p>

          <ConfirmActions
            :show-cancel="!deleteResidentSummary"
            :cancel-label="t('app.cancelAction')"
            :cancel-disabled="isDeletingResidentCascade"
            :stagger="false"
            align="end"
            @cancel="closeDeleteResidentModal"
          >
            <template #confirm>
              <button
                v-if="!deleteResidentSummary"
                type="button"
                class="bf-btn bf-btn--danger"
                :disabled="isDeletingResidentCascade || isLoadingDeletePreview"
                @click="confirmDeleteResidentCascade"
              >
                <span v-if="isDeletingResidentCascade" class="bf-btn__spinner" aria-hidden="true" />
                <span>{{
                  isDeletingResidentCascade
                    ? t('app.deleteResidentInProgress')
                    : t('app.deleteResidentConfirmAction')
                }}</span>
              </button>
              <button
                v-else
                type="button"
                class="bf-btn bf-btn--confirm"
                @click="closeDeleteResidentModal"
              >
                {{ t('app.closeAction') }}
              </button>
            </template>
          </ConfirmActions>
        </div>
      </section>
    </div>

    <div
      v-if="isDeleteSpaceModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeDeleteSpaceModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.deleteSpaceModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('app.deleteSpaceModalTitle') }}</h3>

        <div class="resident-modal__form">
          <p class="resident-modal__hint">
            {{
              t('app.deleteSpaceWarning', {
                name: deleteSpaceCandidate?.name || '',
              })
            }}
          </p>

          <div v-if="!deleteSpaceSummary" class="delete-impact">
            <p class="delete-impact__title">{{ t('app.deleteSpaceImpactTitle') }}</p>
            <p v-if="isLoadingSpaceDeletePreview" class="delete-impact__loading">
              {{ t('app.deleteResidentLoadingPreview') }}
            </p>
            <ul v-else class="delete-impact__list">
              <li
                v-if="(deleteSpacePreview?.reservations ?? 0) > 0"
                class="delete-impact__item"
              >
                <i class="pi pi-calendar" aria-hidden="true" />
                {{
                  t('app.deleteSpaceImpactReservations', {
                    n: deleteSpacePreview?.reservations ?? 0,
                  })
                }}
              </li>
              <li class="delete-impact__item">
                <i class="pi pi-image" aria-hidden="true" />
                {{ t('app.deleteSpaceImpactSpace') }}
              </li>
              <li
                v-if="(deleteSpacePreview?.reservations ?? 0) === 0"
                class="delete-impact__item delete-impact__item--muted"
              >
                <i class="pi pi-info-circle" aria-hidden="true" />
                {{ t('app.deleteResidentImpactNone') }}
              </li>
            </ul>
          </div>

          <div v-else class="delete-summary">
            <p class="delete-summary__title">
              <i class="pi pi-check-circle" aria-hidden="true" />
              {{ t('app.deleteSpaceSuccessTitle') }}
            </p>
            <p class="delete-summary__subtitle">
              {{ t('app.deleteResidentSuccessSummary') }}
            </p>
            <ul class="delete-summary__list">
              <li class="delete-summary__item">
                <i class="pi pi-calendar" aria-hidden="true" />
                {{
                  t('app.deleteResidentSummaryReservations', {
                    n: deleteSpaceSummary.reservations,
                  })
                }}
              </li>
              <li class="delete-summary__item">
                <i class="pi pi-image" aria-hidden="true" />
                {{ t('app.deleteSpaceImpactSpace') }}
              </li>
            </ul>
          </div>

          <p v-if="spaceDeleteError" class="resident-modal__error">
            {{ spaceDeleteError }}
          </p>

          <ConfirmActions
            :show-cancel="!deleteSpaceSummary"
            :cancel-label="t('app.cancelAction')"
            :cancel-disabled="isDeletingSpace"
            :stagger="false"
            align="end"
            @cancel="closeDeleteSpaceModal"
          >
            <template #confirm>
              <button
                v-if="!deleteSpaceSummary"
                type="button"
                class="bf-btn bf-btn--danger"
                :disabled="isDeletingSpace || isLoadingSpaceDeletePreview"
                @click="confirmDeleteSpace"
              >
                <span v-if="isDeletingSpace" class="bf-btn__spinner" aria-hidden="true" />
                <span>{{
                  isDeletingSpace
                    ? t('app.deleteResidentInProgress')
                    : t('app.deleteResidentConfirmAction')
                }}</span>
              </button>
              <button
                v-else
                type="button"
                class="bf-btn bf-btn--confirm"
                @click="closeDeleteSpaceModal"
              >
                {{ t('app.closeAction') }}
              </button>
            </template>
          </ConfirmActions>
        </div>
      </section>
    </div>

    <div
      v-if="isSpaceCalendarModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeSpaceCalendar"
    >
      <section
        class="resident-modal resident-modal--wide bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('app.spaceCalendarTitle')"
      >
        <h3 class="resident-modal__title">
          {{ t('app.spaceCalendarTitle') }}
          <span v-if="selectedSpace" class="resident-modal__title-suffix">— {{ selectedSpace.name }}</span>
        </h3>

        <p v-if="isLoadingReservations" class="mgmt-msg">
          {{ t('app.reservationsLoading') }}
        </p>
        <p v-else-if="reservationsLoadError" class="mgmt-msg mgmt-msg--error">
          {{ reservationsLoadError }}
        </p>
        <p v-else-if="!groupedReservations.length" class="mgmt-msg">
          {{ t('app.emptyReservations') }}
        </p>
        <ul v-else class="reservations-list" role="list">
          <li v-for="group in groupedReservations" :key="group.date" class="reservations-list__day">
            <h4 class="reservations-list__date">{{ group.date }}</h4>
            <ul class="reservations-list__slots" role="list">
              <li v-for="r in group.items" :key="r.id" class="reservations-list__slot">
                <span class="reservations-list__time">{{ r.startTime }} – {{ r.endTime }}</span>
                <span class="reservations-list__resident">
                  {{ r.residentName }}<span v-if="r.residentCode"> · {{ r.residentCode }}</span>
                </span>
              </li>
            </ul>
          </li>
        </ul>

        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.closeAction')"
          :stagger="false"
          align="center"
          @confirm="closeSpaceCalendar"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 1.25rem;
  width: 100%;
  max-width: none;
  min-height: 100dvh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.finance-page {
  margin-top: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-height: 0;
}

.finance-main-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch;
  gap: 2.5rem;
  width: 100%;
  flex: 1;
}

.mgmt-col {
  min-width: 0;
  width: 100%;
}

@media (max-width: 1024px) {
  .finance-main-row {
    flex-direction: column;
  }
}

.finance-panel {
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.finance-panel--table {
  padding: 1.2rem 1.25rem 1.35rem;
  overflow: hidden;
}

.finance-panel__section-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--apple-text, #1d1d1f);
  text-transform: capitalize;
}

.finance-panel__section-title .pi {
  font-size: 1.25rem;
  color: #0071e3;
}

.mgmt-panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.mgmt-view-footer {
  margin-top: auto;
  padding: 1.5rem 0 0.25rem;
  width: 100%;
  text-align: center;
  font-size: 0.6875rem;
  font-weight: 400;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: #aeaeb2;
}

.import-dropzone__btn :deep(.p-button),
.app-view :deep(.import-dropzone__btn.p-button) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.8125rem;
  box-shadow: none;
  border: none;
  background: #0071e3;
  color: #ffffff;
}

.app-view :deep(.import-dropzone__btn.p-button:hover),
.app-view :deep(.import-dropzone__btn .p-button:hover) {
  background: #0066cc;
  color: #ffffff;
}

.import-alert {
  margin: 0.75rem 0 0;
  padding: 0.65rem 0.85rem;
  border-radius: 10px;
  font-size: 0.8125rem;
  font-weight: 500;
}

.import-alert--error {
  color: #b42318;
  background: rgba(180, 35, 24, 0.06);
  border: 1px solid rgba(180, 35, 24, 0.12);
}

.import-alert.import-panel-state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.import-panel-state {
  margin-top: 0.75rem;
}

.import-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 2rem 1rem;
  color: #86868b;
  font-size: 0.875rem;
  text-align: center;
}

.import-status .pi {
  font-size: 1.5rem;
  color: #c7c7cc;
}

.import-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 2rem 1rem;
  color: #86868b;
  font-size: 0.875rem;
  text-align: center;
}

.import-empty .pi {
  font-size: 1.5rem;
  color: #c7c7cc;
}

.r-list {
  margin: 0.85rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.r-card {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  padding: 0.75rem 0.85rem;
  background: #fafafa;
  transition: box-shadow 0.15s ease;
}

.r-card:hover {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.r-card__row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.r-card__avatar {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: #e8e8ed;
  color: #6e6e73;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

.r-card__avatar--active {
  background: #d1fae5;
  color: #166534;
}

.r-card__body {
  flex: 1;
  min-width: 0;
}

.r-card__name {
  margin: 0;
  font-weight: 600;
  font-size: 0.875rem;
  color: #1d1d1f;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.r-card__badge {
  color: #34c759;
  font-size: 0.7rem;
  display: inline-flex;
}

.r-card__meta {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: #86868b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.r-card__actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.25rem;
}

.r-card__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.85rem;
  height: 1.85rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #86868b;
  cursor: pointer;
  font-size: 0.8rem;
  transition: background 0.12s ease, color 0.12s ease;
}

.r-card__icon-btn--link {
  color: #34c759;
}

.r-card__link-icon {
  position: relative;
  display: block;
  width: 0.85rem;
  height: 0.85rem;
}

.r-card__link-icon-item {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  transition:
    opacity 0.22s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.r-card__link-icon-item--link {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}

.r-card__link-icon-item--up {
  opacity: 0;
  transform: rotate(-90deg) scale(0.55);
}

.r-card__link-icon--open .r-card__link-icon-item--link {
  opacity: 0;
  transform: rotate(90deg) scale(0.55);
}

.r-card__link-icon--open .r-card__link-icon-item--up {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}

.r-card__icon-btn--link:hover {
  background: #f0fff4;
  color: #248a3d;
}

.r-card__icon-btn--edit {
  color: #0071e3;
}

.r-card__icon-btn--edit:hover {
  background: #f0f7ff;
  color: #0066cc;
}

.r-card__icon-btn--danger {
  color: #ff3b30;
}

.r-card__icon-btn--danger:hover {
  background: #fff2f2;
  color: #e0352b;
}

.r-card__icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.r-card__link {
  display: block;
  margin-top: 0.45rem;
  padding: 0.3rem 0.55rem;
  border-radius: 6px;
  background: #f5f5f7;
  font-size: 0.7rem;
  color: #0a84ff;
  text-decoration: none;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.r-card__link:hover {
  text-decoration: underline;
}

.r-card-link-enter-active,
.r-card-link-leave-active {
  overflow: hidden;
  transform-origin: top;
  transition:
    max-height 0.32s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.24s ease,
    margin-top 0.32s ease,
    transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

.r-card-link-enter-from,
.r-card-link-leave-to {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  transform: translateY(-6px);
}

.r-card-link-enter-to,
.r-card-link-leave-from {
  max-height: 6rem;
  opacity: 1;
  margin-top: 0.45rem;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .r-card__link-icon-item,
  .r-card-link-enter-active,
  .r-card-link-leave-active {
    transition: none;
  }
}

.s-list {
  margin: 0.85rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.s-card {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  padding: 0.75rem 0.85rem;
  background: #fafafa;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}

.s-card:hover {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.s-card:focus-visible {
  outline: 2px solid #0a84ff;
  outline-offset: 2px;
}

.s-card__thumb {
  flex-shrink: 0;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 8px;
  overflow: hidden;
  background: #e8e8ed;
}

.s-card__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.s-card__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6e6e73;
  font-size: 0.75rem;
}

.s-card__info {
  flex: 1;
  min-width: 0;
}

.s-card__name {
  margin: 0;
  font-weight: 600;
  font-size: 0.875rem;
  color: #1d1d1f;
}

.s-card__meta {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: #86868b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.s-card__meta .pi {
  font-size: 0.62rem;
}

.s-card__actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.2rem;
}

/* Space calendar modal — legacy class names in template */
.mgmt-msg {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.mgmt-msg--error {
  color: #b42318;
}

.resident-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1000;
}

.resident-modal {
  width: min(100%, 26rem);
  background: #ffffff;
  border-radius: 14px;
  border: 1px solid #e8e8ed;
  padding: 1.15rem;
  max-height: 90vh;
  overflow-y: auto;
}

.resident-modal--wide {
  width: min(100%, 36rem);
}

.resident-modal--horizontal {
  width: min(100%, 46rem);
}

.resident-modal__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(13rem, 16.5rem);
  gap: 1rem;
  align-items: stretch;
}

.resident-modal__fields {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.resident-modal--horizontal .space-image-field {
  height: 100%;
}

.resident-modal--horizontal .space-image-field__preview {
  aspect-ratio: 4 / 3;
}

@media (max-width: 640px) {
  .resident-modal__grid {
    grid-template-columns: 1fr;
  }
}

.resident-modal__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #1d1d1f;
}

.resident-modal__title-suffix {
  font-weight: 500;
  color: #86868b;
  margin-left: 0.2rem;
}

.resident-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.resident-modal__bulk-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border: none;
  background: transparent;
  color: #0a84ff;
  border-radius: 8px;
  padding: 0.32rem 0.65rem;
  font-weight: 600;
  font-size: 0.78rem;
  cursor: pointer;
}

.resident-modal__bulk-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.resident-modal__hint {
  margin: 0.5rem 0 0;
  color: #1d1d1f;
  font-size: 0.85rem;
}

.resident-modal__example {
  margin: 0.15rem 0 0;
  color: #86868b;
  font-size: 0.78rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.resident-modal__textarea {
  width: 100%;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  resize: vertical;
  box-sizing: border-box;
}

.resident-modal__textarea:focus {
  outline: none;
  border-color: #0a84ff;
}

.bulk-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 14rem;
  overflow-y: auto;
}

.bulk-results__item {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.8rem;
}

.bulk-results__item--ok {
  background: #f0fdf4;
  color: #166534;
}

.bulk-results__item--error {
  background: #fff2f2;
  color: #ff3b30;
}

.bulk-results__line {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.bulk-results__msg {
  flex: 1;
}

.resident-modal__form {
  margin-top: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.resident-modal__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: #6e6e73;
  font-weight: 500;
}

.resident-modal__field input {
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  font: inherit;
  color: #1d1d1f;
  font-weight: 400;
}

.resident-modal__field input:focus {
  outline: none;
  border-color: #0a84ff;
}

.resident-modal__field-preview {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-blue, #1e3a8a);
}

.space-image-field {
  border: 1px dashed #d2d2d7;
  border-radius: 8px;
  padding: 0.6rem 0.65rem;
  background: #fafafc;
}


.space-image-field__preview {
  margin-top: 0.5rem;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  background: #f5f5f7;
}

.space-image-field__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.space-image-field__controls {
  position: relative;
  margin-top: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  width: 100%;
}

.space-image-field__controls .r-card__icon-btn {
  position: absolute;
  right: 0;
}

.space-image-field__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border: none;
  background: transparent;
  color: #0a84ff;
  border-radius: 8px;
  padding: 0.35rem 0.65rem;
  font-weight: 600;
  font-size: 0.78rem;
  cursor: pointer;
}

.space-image-field__input {
  display: none;
}

.space-image-field__btn:has(input:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

.resident-modal__error {
  margin: 0;
  color: #ff3b30;
  font-size: 0.78rem;
}

.resident-modal__form .bf-actions {
  margin-top: 0.4rem;
}

.app-view :deep(.bf-btn) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  box-shadow: none;
  transform: none;
}

.app-view :deep(.bf-btn:not(:disabled):hover),
.app-view :deep(.bf-btn:not(:disabled):active) {
  transform: none;
  box-shadow: none;
}

.app-view :deep(.bf-btn--cancel) {
  background: #f5f5f7;
  color: #1d1d1f;
  border-color: transparent;
}

.app-view :deep(.bf-btn--cancel:not(:disabled):hover) {
  background: #e8e8ed;
  border-color: transparent;
}

.app-view :deep(.bf-btn--confirm) {
  background: #0071e3;
  color: #ffffff;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):hover) {
  background: #0066cc;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):focus-visible) {
  animation: none;
}

.app-view :deep(.bf-btn--danger) {
  background: #ff3b30;
  color: #ffffff;
}

.app-view :deep(.bf-btn--danger:not(:disabled):hover) {
  background: #e0352b;
}

.delete-impact,
.delete-summary {
  background: #fafafa;
  border: 1px solid #e8e8ed;
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
}

.delete-impact__title {
  margin: 0 0 0.4rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #6e6e73;
}

.delete-impact__loading {
  margin: 0;
  color: #86868b;
  font-size: 0.8rem;
}

.delete-impact__list,
.delete-summary__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.delete-impact__item,
.delete-summary__item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: #1d1d1f;
}

.delete-impact__item .pi,
.delete-summary__item .pi {
  color: #0071e3;
  font-size: 0.8rem;
}

.delete-impact__item--muted {
  color: #86868b;
}

.delete-impact__item--muted .pi {
  color: #c7c7cc;
}

.delete-summary__title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: #1d1d1f;
}

.delete-summary__title .pi {
  color: #34c759;
}

.delete-summary__subtitle {
  margin: 0.35rem 0 0.5rem;
  color: #6e6e73;
  font-size: 0.78rem;
}

.delete-summary__partial {
  margin: 0.5rem 0 0;
  color: #ff9500;
  font-size: 0.75rem;
}

.reservations-list {
  list-style: none;
  margin: 0.85rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.reservations-list__day {
  border: 1px solid #e8e8ed;
  border-radius: 10px;
  padding: 0.6rem 0.75rem;
  background: #fafafc;
}

.reservations-list__date {
  margin: 0 0 0.35rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: #1d1d1f;
}

.reservations-list__slots {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.reservations-list__slot {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: #1d1d1f;
}

.reservations-list__time {
  font-weight: 600;
}

.reservations-list__resident {
  color: #86868b;
}
</style>
