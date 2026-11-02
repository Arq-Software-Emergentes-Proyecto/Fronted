<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import { getResidentLimitForActiveOwner, refreshSubscriptionFromApi } from '@/billing/infrastructure/subscriptionPlanStorage.js'
import {
  deriveFloorFromDepartment,
  parseDepartmentNumber,
} from '@/shared/domain/departmentNumber.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { RouterLink } from 'vue-router'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import ResidentImportPanel from '@/residents/presentation/components/ResidentImportPanel.vue'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'

const { t, locale } = useI18n()
const financesStore = useFinancesStore()

const residents = ref([])
const accessLinks = reactive({})
const isLoading = ref(false)
const loadError = ref('')

const isAddResidentModalOpen = ref(false)
const modalError = ref('')
/** RNF003: inline errors (i18n keys) for the resident form fields. */
const residentFieldErrors = reactive({ name: '', department: '' })
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

/** RF028 / US028: plan limit (or expired trial) blocks saving → suggest an upgrade. */
const modalNeedsUpgrade = ref(false)
const upgradePlanRoute = { name: AppRouteNames.APP_SETTINGS, query: { tab: 'plans' } }
const isAtPlanLimit = computed(() => totalResidents.value >= residentPlanLimitCap.value)

function openAddResidentModal() {
  modalError.value = ''
  modalNeedsUpgrade.value = false
  residentFieldErrors.name = ''
  residentFieldErrors.department = ''
  residentForm.name = ''
  residentForm.department = ''
  isAddResidentModalOpen.value = true
}

function closeAddResidentModal() {
  if (isSubmitting.value) return
  isAddResidentModalOpen.value = false
}

async function onAddResidentSubmit(event) {
  if (isSubmitting.value) return

  const name = residentForm.name.trim()
  const parsed = parseDepartmentNumber(residentForm.department)

  residentFieldErrors.name = name ? '' : 'common.fieldRequired'
  residentFieldErrors.department = !String(residentForm.department ?? '').trim()
    ? 'common.fieldRequired'
    : parsed
      ? ''
      : 'app.addResidentInvalidDepartment'
  if (residentFieldErrors.name || residentFieldErrors.department) {
    modalError.value = ''
    return
  }

  isSubmitting.value = true
  modalError.value = ''
  modalNeedsUpgrade.value = false
  try {
    const newResident = await residentsApi.add({
      name,
      department: parsed.department,
    })
    await refreshPlanLimit()
    await financesStore.generateInitialReceipt(newResident)
    await confirmSuccess(event, t('feedback.residentAdded'))
    isAddResidentModalOpen.value = false
    residents.value = [newResident, ...residents.value]
    markFresh('resident', newResident.id)
  } catch (error) {
    if (error?.code === 'RESIDENT_CODE_ALREADY_EXISTS') {
      residentFieldErrors.department = 'app.addResidentCodeExists'
      return
    }
    if (error?.code === 'RESIDENT_FIELDS_REQUIRED') {
      modalError.value = t('app.addResidentRequired')
      return
    }
    if (error?.code === 'INVALID_DEPARTMENT_NUMBER') {
      residentFieldErrors.department = 'app.addResidentInvalidDepartment'
      return
    }
    if (error?.code === 'RESIDENT_PLAN_LIMIT_REACHED') {
      modalError.value = t('billing.limitReached', {
        current: totalResidents.value,
        max: getResidentLimitForActiveOwner(),
      })
      modalNeedsUpgrade.value = true
      return
    }
    if (error?.code === 'SUBSCRIPTION_TRIAL_EXPIRED' || error?.code === 'SUBSCRIPTION_INACTIVE') {
      modalError.value = t(error.code === 'SUBSCRIPTION_TRIAL_EXPIRED' ? 'billing.trialExpiredBlocked' : 'billing.inactiveBlocked')
      modalNeedsUpgrade.value = true
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

/** US028: editar nombre y unidad de un residente. */
const editResidentCandidate = ref(null)
const editResidentForm = reactive({ name: '', department: '' })
const editResidentErrors = reactive({ name: '', department: '' })
const editResidentError = ref('')
const isSavingResidentEdit = ref(false)
const editDetectedFloor = computed(() => deriveFloorFromDepartment(editResidentForm.department))

function openEditResidentModal(resident) {
  editResidentForm.name = resident?.name ?? ''
  editResidentForm.department = resident?.code ?? ''
  editResidentErrors.name = ''
  editResidentErrors.department = ''
  editResidentError.value = ''
  editResidentCandidate.value = resident
}

function closeEditResidentModal() {
  if (isSavingResidentEdit.value) return
  editResidentCandidate.value = null
}

async function onEditResidentSubmit(event) {
  const resident = editResidentCandidate.value
  if (!resident || isSavingResidentEdit.value) return
  const name = editResidentForm.name.trim()
  const parsed = parseDepartmentNumber(editResidentForm.department)
  editResidentErrors.name = name ? '' : 'common.fieldRequired'
  editResidentErrors.department = parsed ? '' : 'app.addResidentInvalidDepartment'
  if (editResidentErrors.name || editResidentErrors.department) return

  isSavingResidentEdit.value = true
  editResidentError.value = ''
  try {
    const updated = await residentsApi.update(resident.id, { name, department: editResidentForm.department })
    await confirmSuccess(event, t('feedback.residentUpdated'))
    residents.value = residents.value.map((item) =>
      item.id === resident.id ? { ...item, name: updated.name, floor: updated.floor, code: updated.code } : item,
    )
    markFresh('resident', resident.id)
    editResidentCandidate.value = null
  } catch (error) {
    if (error?.code === 'RESIDENT_CODE_ALREADY_EXISTS') {
      editResidentErrors.department = 'app.addResidentCodeExists'
      return
    }
    editResidentError.value = t('app.editResidentError')
  } finally {
    isSavingResidentEdit.value = false
  }
}

/** IAM AccountStatus: deactivate/reactivate a resident account (reversible, keeps data). */
const accountStatusCandidate = ref(null)
const isChangingAccountStatus = ref(false)
const accountStatusError = ref('')
/** Last resident shown in the status dialog (kept while the dialog fades out). */
const accountStatusShown = ref(null)

function openAccountStatusModal(resident) {
  if (isChangingAccountStatus.value) return
  accountStatusError.value = ''
  accountStatusCandidate.value = resident
  accountStatusShown.value = resident
}

function closeAccountStatusModal() {
  if (isChangingAccountStatus.value) return
  accountStatusCandidate.value = null
}

async function confirmAccountStatusChange() {
  const resident = accountStatusCandidate.value
  if (!resident || isChangingAccountStatus.value) return
  const activate = resident.accountStatus === 'DEACTIVATED'
  isChangingAccountStatus.value = true
  accountStatusError.value = ''
  try {
    const updated = await residentsApi.setAccountActive(resident.id, activate)
    residents.value = residents.value.map((item) =>
      item.id === resident.id ? { ...item, accountStatus: updated.accountStatus } : item,
    )
    accountStatusCandidate.value = null
  } catch {
    accountStatusError.value = t('app.residentAccountStatusError')
  } finally {
    isChangingAccountStatus.value = false
  }
}

const isBulkResidentsModalOpen = ref(false)
const bulkResidentsText = ref('')
const isSubmittingBulk = ref(false)
const bulkResults = ref([])
/** US016: 'file' = Excel/CSV upload (server validates all rows); 'text' = paste lines (legacy). */
const bulkMode = ref('file')

async function onRosterImported(createdResidents) {
  if (!Array.isArray(createdResidents) || !createdResidents.length) return
  residents.value = [...createdResidents, ...residents.value]
  createdResidents.forEach((resident) => markFresh('resident', resident.id))
  await refreshPlanLimit()
  // One idempotent server-side run for the current month instead of ~3 requests per resident:
  // MonthlyBillingService applies the same admission-date / bill-from-next-month rule
  // (ResidentOwesMonth) and skips residents already billed.
  try {
    await financesStore.generateMonthlyReceipts()
  } catch (error) {
    console.warn('Initial receipts generation failed after roster import', error?.code || error)
  }
}

function openBulkResidentsModal() {
  bulkResidentsText.value = ''
  bulkResults.value = []
  bulkMode.value = 'file'
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

async function onBulkResidentsSubmit(event) {
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
      } else if (error?.code === 'SUBSCRIPTION_TRIAL_EXPIRED') {
        message = t('billing.trialExpiredBlocked')
      }
      results.push({ line: i + 1, raw, status: 'error', message })
    }
  }

  if (created.length) {
    await confirmSuccess(event, t('feedback.residentsImported'))
    residents.value = [...created, ...residents.value]
    created.forEach((resident) => markFresh('resident', resident.id))
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
const spaceForm = reactive({
  name: '',
  description: '',
  capacity: '',
  imageUrl: '',
  rules: '',
  maxReservationsPerDay: '',
})
const spaceModalError = ref('')
/** RNF003: the space name is the required field of the add / edit forms. */
const spaceNameInvalid = ref(false)
const editSpaceNameInvalid = ref(false)
const isSubmittingSpace = ref(false)
const isProcessingAddImage = ref(false)

const isEditSpaceModalOpen = ref(false)
const editSpaceForm = reactive({
  id: '',
  name: '',
  description: '',
  capacity: '',
  imageUrl: '',
  rules: '',
  status: 'AVAILABLE',
  maxReservationsPerDay: '',
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
  spaceNameInvalid.value = false
  spaceForm.name = ''
  spaceForm.description = ''
  spaceForm.capacity = ''
  spaceForm.imageUrl = ''
  spaceForm.rules = ''
  spaceForm.maxReservationsPerDay = ''
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

async function onAddSpaceSubmit(event) {
  if (isSubmittingSpace.value) return

  const name = spaceForm.name.trim()
  spaceNameInvalid.value = !name
  if (!name) {
    spaceModalError.value = ''
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
      rules: spaceForm.rules,
      maxReservationsPerDay: spaceForm.maxReservationsPerDay,
    })
    await confirmSuccess(event, t('feedback.spaceAdded'))
    isAddSpaceModalOpen.value = false
    spaces.value = [newSpace, ...spaces.value]
    markFresh('space', newSpace.id)
  } catch (error) {
    if (error?.code === 'SPACE_NAME_REQUIRED') {
      spaceNameInvalid.value = true
      return
    }
    spaceModalError.value = t('auth.genericError')
  } finally {
    isSubmittingSpace.value = false
  }
}

function openEditSpaceModal(space) {
  editSpaceModalError.value = ''
  editSpaceNameInvalid.value = false
  editSpaceForm.id = space.id
  editSpaceForm.name = space.name ?? ''
  editSpaceForm.description = space.description ?? ''
  editSpaceForm.capacity = space.capacity ?? ''
  editSpaceForm.imageUrl = space.imageUrl ?? ''
  editSpaceForm.rules = space.rules ?? ''
  editSpaceForm.status = space.status === 'MAINTENANCE' ? 'MAINTENANCE' : 'AVAILABLE'
  editSpaceForm.maxReservationsPerDay = space.maxReservationsPerDay ?? ''
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

async function onEditSpaceSubmit(event) {
  if (isSubmittingEditSpace.value) return

  const name = editSpaceForm.name.trim()
  editSpaceNameInvalid.value = !name
  if (!name) {
    editSpaceModalError.value = ''
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
      rules: editSpaceForm.rules,
      status: editSpaceForm.status,
      maxReservationsPerDay: editSpaceForm.maxReservationsPerDay,
    })
    await confirmSuccess(event, t('feedback.changesSaved'))
    isEditSpaceModalOpen.value = false
    spaces.value = spaces.value.map((space) =>
      space.id === updated.id ? updated : space,
    )
    markFresh('space', updated.id)
  } catch (error) {
    if (error?.code === 'SPACE_NAME_REQUIRED') {
      editSpaceNameInvalid.value = true
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

/* ---------- Presentation helpers (summary, tabs, filters, dates) ---------- */

const intlLocale = computed(() => (String(locale.value).startsWith('es') ? 'es-PE' : 'en-US'))

function parseYmd(value) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

/** "7 oct. 2026" / "Oct 7, 2026". */
function nfDate(value) {
  const d = parseYmd(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat(intlLocale.value, { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

/** "sáb., 24 oct. 2026" / "Sat, Oct 24, 2026" (reservation day headings). */
function nfDayLong(value) {
  const d = parseYmd(value)
  if (!d) return String(value ?? '')
  return new Intl.DateTimeFormat(intlLocale.value, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

const todayYmd = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

/** active = can sign in · pending = invitation not used yet · deactivated = blocked by the admin. */
function residentStatus(resident) {
  if (resident?.accountStatus === 'DEACTIVATED') return 'deactivated'
  return resident?.hasCredentials ? 'active' : 'pending'
}

const STATUS_LABEL_KEYS = {
  active: 'app.advancedMgmt.statusActive',
  pending: 'app.advancedMgmt.statusPending',
  deactivated: 'app.advancedMgmt.statusDeactivated',
}

const statusCounts = computed(() => {
  const counts = { active: 0, pending: 0, deactivated: 0 }
  for (const resident of residents.value) counts[residentStatus(resident)] += 1
  return counts
})

const remainingSlots = computed(() =>
  Math.max(0, (Number(residentPlanLimitCap.value) || 0) - totalResidents.value),
)

const spaceCounts = computed(() => {
  let maintenance = 0
  for (const space of spaces.value) if (space.status === 'MAINTENANCE') maintenance += 1
  return { available: spaces.value.length - maintenance, maintenance }
})

const kpiPills = computed(() => {
  const residentsValue = isLoading.value ? '…' : totalResidents.value
  const spacesValue = isLoadingSpaces.value ? '…' : spaces.value.length
  const spacesHint = [
    t('app.advancedMgmt.statSpacesAvailable', { n: spaceCounts.value.available }, spaceCounts.value.available),
    spaceCounts.value.maintenance
      ? t('app.advancedMgmt.statSpacesMaintenance', { n: spaceCounts.value.maintenance })
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return [
    {
      key: 'residents',
      tone: isAtPlanLimit.value ? 'red' : 'blue',
      icon: 'pi-users',
      label: t('app.advancedMgmt.statResidents'),
      value: residentsValue,
      total: residentPlanLimitCap.value,
      hint: isAtPlanLimit.value
        ? t('app.advancedMgmt.statResidentsFull')
        : t('app.advancedMgmt.statResidentsLeft', { n: remainingSlots.value }, remainingSlots.value),
      link: isAtPlanLimit.value ? { to: upgradePlanRoute, label: t('billing.upgradeCta') } : null,
    },
    {
      key: 'active',
      tone: 'green',
      icon: 'pi-check-circle',
      label: t('app.advancedMgmt.statActive'),
      short: t('kpiShort.activeAccounts'),
      value: isLoading.value ? '…' : statusCounts.value.active,
      hint: t('app.advancedMgmt.statActiveHint'),
    },
    {
      key: 'pending',
      tone: 'amber',
      icon: 'pi-envelope',
      label: t('app.advancedMgmt.statPending'),
      short: t('kpiShort.invitations'),
      value: isLoading.value ? '…' : statusCounts.value.pending,
      hint: statusCounts.value.pending
        ? t('app.advancedMgmt.statPendingHint')
        : t('app.advancedMgmt.statPendingNone'),
    },
    {
      key: 'spaces',
      tone: 'orange',
      icon: 'pi-building',
      label: t('app.advancedMgmt.statSpaces'),
      short: t('kpiShort.spaces'),
      value: spacesValue,
      hint: spacesHint,
    },
  ]
})

/* Tabs: Residentes | Espacios comunes */
const activeTab = ref('residents')
const TAB_KEYS = ['residents', 'spaces']
const tabs = computed(() => [
  { key: 'residents', label: t('app.advancedMgmt.tabResidents'), icon: 'pi pi-users', count: totalResidents.value },
  { key: 'spaces', label: t('app.advancedMgmt.tabSpaces'), icon: 'pi pi-building', count: spaces.value.length },
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
  if (next === null) return
  event.preventDefault()
  activeTab.value = TAB_KEYS[next]
  document.getElementById(`adv-tab-${TAB_KEYS[next]}`)?.focus()
}

/* Residents filters */
const residentSearch = ref('')
const statusFilter = ref('all')

const statusFilters = computed(() => [
  { key: 'all', label: t('app.advancedMgmt.filterAll'), count: totalResidents.value },
  { key: 'active', label: t('app.advancedMgmt.filterActive'), count: statusCounts.value.active },
  { key: 'pending', label: t('app.advancedMgmt.filterPending'), count: statusCounts.value.pending },
  { key: 'deactivated', label: t('app.advancedMgmt.filterDeactivated'), count: statusCounts.value.deactivated },
])

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const filteredResidents = computed(() => {
  const query = normalizeText(residentSearch.value)
  return residents.value.filter((resident) => {
    if (statusFilter.value !== 'all' && residentStatus(resident) !== statusFilter.value) return false
    if (!query) return true
    return [resident.name, resident.code, resident.floor, resident.email].some((field) =>
      normalizeText(field).includes(query),
    )
  })
})

const hasResidentFilters = computed(() => Boolean(residentSearch.value.trim()) || statusFilter.value !== 'all')

function clearResidentFilters() {
  residentSearch.value = ''
  statusFilter.value = 'all'
}

/* Invitation link: open the row panel and copy it to the clipboard in one click. */
const copiedInviteId = ref('')
let copiedInviteTimer = null

async function copyInviteLink(resident) {
  const link = accessLinks[resident.id]
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    copiedInviteId.value = resident.id
    window.clearTimeout(copiedInviteTimer)
    copiedInviteTimer = window.setTimeout(() => {
      if (copiedInviteId.value === resident.id) copiedInviteId.value = ''
    }, 2500)
  } catch {
    // Clipboard blocked (permissions / insecure context): the link stays visible to copy by hand.
  }
}

async function onInviteAction(resident) {
  const wasOpen = Boolean(accessLinks[resident.id])
  generateResidentAccessLink(resident)
  if (wasOpen) {
    if (copiedInviteId.value === resident.id) copiedInviteId.value = ''
    return
  }
  await copyInviteLink(resident)
}

onBeforeUnmount(() => window.clearTimeout(copiedInviteTimer))

/** Dialog v-model bridge that respects each close guard (busy states). */
function onDialogVisible(visible, close) {
  if (!visible) close()
}

const accountStatusView = computed(() => accountStatusCandidate.value || accountStatusShown.value)
const accountStatusReactivate = computed(() => accountStatusView.value?.accountStatus === 'DEACTIVATED')
</script>

<template>
  <div class="app-view adv">
    <header class="adv-head">
      <h1 class="bf-sr-only">{{ t('app.advancedMgmt.pageTitle') }}</h1>
      <KpiPills inline :items="kpiPills" :aria-label="t('app.advancedMgmt.summaryLabel')" />
      <div class="adv-head__actions" role="group" :aria-label="t('app.advancedMgmt.headerActions')">
        <button type="button" class="adv-btn" @click="openBulkResidentsModal">
          <i class="pi pi-file-import" aria-hidden="true" />
          {{ t('app.advancedMgmt.import') }}
        </button>
        <button type="button" class="adv-btn" @click="openAddSpaceModal">
          <i class="pi pi-building" aria-hidden="true" />
          {{ t('app.addSpaceAction') }}
        </button>
        <button type="button" class="adv-btn adv-btn--primary" @click="openAddResidentModal">
          <i class="pi pi-user-plus" aria-hidden="true" />
          {{ t('app.advancedMgmt.addResident') }}
        </button>
      </div>
    </header>

    <!-- Summary -->

    <!-- Residents | Common spaces -->
    <section class="adv-card">
      <div class="adv-tabs" v-bf-seg role="tablist" :aria-label="t('app.advancedMgmt.tabsLabel')">
        <button
          v-for="tab in tabs"
          :id="`adv-tab-${tab.key}`"
          :key="tab.key"
          type="button"
          role="tab"
          class="adv-tab"
          :class="{ 'is-active': activeTab === tab.key }"
          :aria-selected="activeTab === tab.key ? 'true' : 'false'"
          :aria-controls="`adv-panel-${tab.key}`"
          :tabindex="activeTab === tab.key ? 0 : -1"
          @click="selectTab(tab.key)"
          @keydown="onTabKeydown"
        >
          <i :class="tab.icon" aria-hidden="true" />
          {{ tab.label }}
          <span class="adv-tab__count">{{ tab.count }}</span>
        </button>
      </div>

      <!-- Residents -->
      <div
        v-show="activeTab === 'residents'"
        id="adv-panel-residents"
        class="adv-panel"
        role="tabpanel"
        aria-labelledby="adv-tab-residents"
      >
        <p class="adv-panel__intro">{{ t('app.advancedMgmt.residentsIntro') }}</p>

        <p v-if="residentDeleteError && !isDeleteResidentModalOpen" class="adv-alert" role="alert">
          {{ residentDeleteError }}
        </p>

        <p v-if="isLoading" class="adv-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('app.residentsLoading') }}
        </p>
        <LoadErrorRetry
          v-else-if="loadError"
          :message="loadError"
          :loading="isLoading"
          @retry="loadResidents"
        />
        <div v-else-if="!residents.length" class="adv-empty">
          <span class="adv-empty__icon"><i class="pi pi-users" aria-hidden="true" /></span>
          <p class="adv-empty__text">{{ t('app.emptyResidents') }}</p>
          <div class="adv-empty__actions">
            <button type="button" class="adv-btn" @click="openBulkResidentsModal">
              <i class="pi pi-file-import" aria-hidden="true" />
              {{ t('app.advancedMgmt.import') }}
            </button>
            <button type="button" class="adv-btn adv-btn--primary" @click="openAddResidentModal">
              <i class="pi pi-user-plus" aria-hidden="true" />
              {{ t('app.advancedMgmt.addResident') }}
            </button>
          </div>
        </div>

        <template v-else>
          <div class="adv-toolbar">
            <label class="adv-search">
              <i class="pi pi-search" aria-hidden="true" />
              <span class="visually-hidden">{{ t('app.advancedMgmt.searchLabel') }}</span>
              <input
                v-model="residentSearch"
                type="search"
                autocomplete="off"
                :placeholder="t('app.advancedMgmt.searchPlaceholder')"
              />
            </label>
            <div class="adv-filters" v-bf-seg role="group" :aria-label="t('app.advancedMgmt.filterLabel')">
              <button
                v-for="filter in statusFilters"
                :key="filter.key"
                type="button"
                class="adv-filter"
                :class="{ 'is-active': statusFilter === filter.key }"
                :aria-pressed="statusFilter === filter.key ? 'true' : 'false'"
                @click="statusFilter = filter.key"
              >
                {{ filter.label }}
                <span class="adv-filter__count">{{ filter.count }}</span>
              </button>
            </div>
          </div>

          <div v-if="filteredResidents.length" class="adv-table-wrap">
            <table class="adv-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('app.advancedMgmt.colResident') }}</th>
                  <th scope="col">{{ t('app.advancedMgmt.colUnit') }}</th>
                  <th scope="col">{{ t('app.advancedMgmt.colAdmission') }}</th>
                  <th scope="col">{{ t('app.advancedMgmt.colStatus') }}</th>
                  <th scope="col" class="is-actions">
                    <span class="visually-hidden">{{ t('app.advancedMgmt.colActions') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <template v-for="resident in filteredResidents" :key="resident.id">
                  <tr :class="{ 'has-invite': accessLinks[resident.id], 'bf-fresh': isFresh('resident', resident.id) }">
                    <td class="c-main">
                      <div class="adv-person">
                        <span class="adv-avatar" :class="`is-${residentStatus(resident)}`" aria-hidden="true">
                          {{ residentInitials(resident.name) }}
                        </span>
                        <div class="adv-person__text">
                          <strong>{{ resident.name }}</strong>
                          <small :class="{ 'is-muted': !resident.email }">
                            {{ resident.email || t('app.advancedMgmt.noEmail') }}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td class="c-unit" :data-label="t('app.advancedMgmt.colUnit')">
                      {{ t('app.residentFloorApt', { floor: resident.floor, code: resident.code }) }}
                    </td>
                    <td class="c-date" :data-label="t('app.advancedMgmt.colAdmission')">
                      {{ nfDate(resident.admissionDate) }}
                    </td>
                    <td class="c-status" :data-label="t('app.advancedMgmt.colStatus')">
                      <span class="adv-pill" :class="`adv-pill--${residentStatus(resident)}`">
                        <span class="adv-pill__dot" aria-hidden="true" />
                        {{ t(STATUS_LABEL_KEYS[residentStatus(resident)]) }}
                      </span>
                    </td>
                    <td class="c-actions">
                      <div class="adv-actions">
                        <button
                          type="button"
                          class="adv-action adv-action--blue"
                          :class="{ 'is-open': accessLinks[resident.id] }"
                          :aria-label="
                            accessLinks[resident.id]
                              ? `${t('app.hideResidentLinkAction')} — ${resident.name}`
                              : `${t('app.advancedMgmt.copyInvite')} — ${resident.name}`
                          "
                          :aria-expanded="accessLinks[resident.id] ? 'true' : 'false'"
                          :aria-controls="`adv-invite-${resident.id}`"
                          :data-tip="accessLinks[resident.id] ? t('app.hideResidentLinkAction') : t('app.advancedMgmt.copyInvite')"
                          @click="onInviteAction(resident)"
                        >
                          <i :class="accessLinks[resident.id] ? 'pi pi-chevron-up' : 'pi pi-link'" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          class="adv-action"
                          :aria-label="`${t('app.editResidentAction')} — ${resident.name}`"
                          :data-tip="t('app.editResidentAction')"
                          @click="openEditResidentModal(resident)"
                        >
                          <i class="pi pi-pencil" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          class="adv-action"
                          :class="resident.accountStatus === 'DEACTIVATED' ? 'adv-action--green' : 'adv-action--amber'"
                          :aria-label="`${
                            resident.accountStatus === 'DEACTIVATED'
                              ? t('app.reactivateResidentAction')
                              : t('app.deactivateResidentAction')
                          } — ${resident.name}`"
                          :data-tip="
                            resident.accountStatus === 'DEACTIVATED'
                              ? t('app.reactivateResidentAction')
                              : t('app.deactivateResidentAction')
                          "
                          :disabled="isChangingAccountStatus && accountStatusCandidate?.id === resident.id"
                          @click="openAccountStatusModal(resident)"
                        >
                          <i :class="resident.accountStatus === 'DEACTIVATED' ? 'pi pi-replay' : 'pi pi-ban'" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          class="adv-action adv-action--danger"
                          :aria-label="`${t('app.deleteResidentAction')} — ${resident.name}`"
                          :data-tip="t('app.deleteResidentAction')"
                          :disabled="isDeletingResidentCascade && deleteResidentCandidate?.id === resident.id"
                          @click="openDeleteResidentModal(resident)"
                        >
                          <i class="pi pi-trash" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="accessLinks[resident.id]" :id="`adv-invite-${resident.id}`" class="adv-invite-row">
                    <td colspan="5">
                      <div class="adv-invite">
                        <p class="adv-invite__text" :class="{ 'is-copied': copiedInviteId === resident.id }" aria-live="polite">
                          <i
                            :class="copiedInviteId === resident.id ? 'pi pi-check-circle' : 'pi pi-info-circle'"
                            aria-hidden="true"
                          />
                          {{
                            copiedInviteId === resident.id
                              ? t('app.advancedMgmt.inviteCopied', { name: resident.name })
                              : t('app.advancedMgmt.inviteHint', { name: resident.name })
                          }}
                        </p>
                        <div class="adv-invite__field">
                          <input
                            type="text"
                            readonly
                            :value="accessLinks[resident.id]"
                            :aria-label="t('app.advancedMgmt.inviteLinkLabel', { name: resident.name })"
                            @focus="$event.target.select()"
                          />
                          <button type="button" class="adv-btn adv-btn--sm" @click="copyInviteLink(resident)">
                            <i :class="copiedInviteId === resident.id ? 'pi pi-check' : 'pi pi-copy'" aria-hidden="true" />
                            {{ copiedInviteId === resident.id ? t('app.advancedMgmt.copied') : t('app.advancedMgmt.copy') }}
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <div v-else class="adv-empty">
            <span class="adv-empty__icon"><i class="pi pi-search" aria-hidden="true" /></span>
            <p class="adv-empty__text">{{ t('app.emptyResidentsSearch') }}</p>
            <div v-if="hasResidentFilters" class="adv-empty__actions">
              <button type="button" class="adv-btn" @click="clearResidentFilters">
                {{ t('app.advancedMgmt.clearFilters') }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Common spaces -->
      <div
        v-show="activeTab === 'spaces'"
        id="adv-panel-spaces"
        class="adv-panel"
        role="tabpanel"
        aria-labelledby="adv-tab-spaces"
      >
        <p class="adv-panel__intro">{{ t('app.advancedMgmt.spacesIntro') }}</p>

        <p v-if="spaceDeleteError && !isDeleteSpaceModalOpen" class="adv-alert" role="alert">
          {{ spaceDeleteError }}
        </p>

        <p v-if="isLoadingSpaces" class="adv-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('app.spacesLoading') }}
        </p>
        <LoadErrorRetry
          v-else-if="spacesLoadError"
          :message="spacesLoadError"
          :loading="isLoadingSpaces"
          @retry="loadSpaces"
        />
        <div v-else-if="!spaces.length" class="adv-empty">
          <span class="adv-empty__icon"><i class="pi pi-building" aria-hidden="true" /></span>
          <p class="adv-empty__text">{{ t('app.emptySpaces') }}</p>
          <div class="adv-empty__actions">
            <button type="button" class="adv-btn adv-btn--primary" @click="openAddSpaceModal">
              <i class="pi pi-plus" aria-hidden="true" />
              {{ t('app.addSpaceAction') }}
            </button>
          </div>
        </div>
        <ul v-else class="adv-spaces" role="list">
          <li
            v-for="space in spaces"
            :key="space.id"
            class="adv-space"
            :class="{ 'bf-fresh': isFresh('space', space.id) }"
          >
            <div class="adv-space__media">
              <img
                v-if="space.imageUrl"
                :src="space.imageUrl"
                :alt="t('app.spaceImageAlt', { name: space.name })"
                class="adv-space__img"
              />
              <span v-else class="adv-space__placeholder" aria-hidden="true">
                <span class="adv-space__placeholder-icon"><i class="pi pi-image" /></span>
              </span>
            </div>
            <div class="adv-space__body">
              <div class="adv-space__title-row">
                <h3 class="adv-space__name">{{ space.name }}</h3>
                <span
                  class="adv-pill"
                  :class="space.status === 'MAINTENANCE' ? 'adv-pill--maintenance' : 'adv-pill--active'"
                >
                  <span class="adv-pill__dot" aria-hidden="true" />
                  {{
                    space.status === 'MAINTENANCE'
                      ? t('socialSpaces.statusMaintenance')
                      : t('socialSpaces.statusAvailable')
                  }}
                </span>
              </div>
              <p class="adv-space__desc" :class="{ 'is-muted': !space.description }">
                {{ space.description || t('app.advancedMgmt.noDescription') }}
              </p>
              <ul class="adv-space__facts" role="list">
                <li v-if="space.capacity">
                  <i class="pi pi-users" aria-hidden="true" />
                  {{ t('app.advancedMgmt.capacityValue', { n: space.capacity }, Number(space.capacity)) }}
                </li>
                <li>
                  <i class="pi pi-calendar" aria-hidden="true" />
                  {{
                    space.maxReservationsPerDay
                      ? t(
                          'app.advancedMgmt.maxPerDayValue',
                          { n: space.maxReservationsPerDay },
                          Number(space.maxReservationsPerDay),
                        )
                      : t('app.advancedMgmt.noDailyLimit')
                  }}
                </li>
              </ul>
              <div class="adv-space__rules" :class="{ 'is-muted': !space.rules }">
                <i class="pi pi-book" aria-hidden="true" />
                <p>
                  <template v-if="space.rules">
                    <strong>{{ t('socialSpaces.rulesLabel') }}:</strong> {{ space.rules }}
                  </template>
                  <template v-else>{{ t('app.advancedMgmt.noRules') }}</template>
                </p>
              </div>
            </div>
            <div class="adv-space__foot" role="group" :aria-label="t('app.advancedMgmt.spaceActionsFor', { name: space.name })">
              <button type="button" class="adv-btn adv-btn--sm" @click="openSpaceCalendar(space)">
                <i class="pi pi-calendar" aria-hidden="true" />
                {{ t('app.advancedMgmt.viewReservations') }}
              </button>
              <div class="adv-actions">
                <button
                  type="button"
                  class="adv-action adv-action--blue"
                  :aria-label="`${t('app.editSpaceAction')} — ${space.name}`"
                  :data-tip="t('app.editSpaceAction')"
                  @click="openEditSpaceModal(space)"
                >
                  <i class="pi pi-pencil" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="adv-action adv-action--danger"
                  :aria-label="`${t('app.deleteSpaceAction')} — ${space.name}`"
                  :data-tip="t('app.deleteSpaceAction')"
                  :disabled="isDeletingSpace && deleteSpaceCandidate?.id === space.id"
                  @click="openDeleteSpaceModal(space)"
                >
                  <i class="pi pi-trash" aria-hidden="true" />
                </button>
              </div>
            </div>
          </li>
          <li class="adv-space adv-space--add">
            <button type="button" class="adv-space__add" @click="openAddSpaceModal">
              <span class="adv-space__add-icon"><i class="pi pi-plus" aria-hidden="true" /></span>
              <strong>{{ t('app.addSpaceAction') }}</strong>
              <small>{{ t('app.advancedMgmt.newSpaceHint') }}</small>
            </button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Nuevo residente -->
    <Dialog
      :visible="isAddResidentModalOpen"
      modal
      dismissable-mask
      :header="t('app.addResidentModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!isSubmitting"
      :close-on-escape="!isSubmitting"
      @update:visible="onDialogVisible($event, closeAddResidentModal)"
    >
      <form class="adv-form" novalidate @submit.prevent="onAddResidentSubmit">
        <p v-if="isAtPlanLimit" class="adv-form__note adv-form__note--warn">
          <i class="pi pi-exclamation-triangle" aria-hidden="true" />
          <span>{{ t('app.advancedMgmt.planLimitNote', { current: totalResidents, max: residentPlanLimitCap }) }}</span>
        </p>

        <div class="adv-field" :class="{ 'bf-field--invalid': residentFieldErrors.name }">
          <label for="adv-resident-name">{{ t('app.residentNameLabel') }}</label>
          <input
            id="adv-resident-name"
            v-model="residentForm.name"
            type="text"
            autocomplete="name"
            required
            :aria-invalid="residentFieldErrors.name ? 'true' : 'false'"
            :aria-describedby="residentFieldErrors.name ? 'resident-name-error' : undefined"
            @input="residentFieldErrors.name = ''"
          />
          <small v-if="residentFieldErrors.name" id="resident-name-error" class="bf-field-error">
            {{ t(residentFieldErrors.name) }}
          </small>
        </div>

        <div class="adv-field" :class="{ 'bf-field--invalid': residentFieldErrors.department }">
          <label for="adv-resident-dept">{{ t('app.residentDepartmentLabel') }}</label>
          <input
            id="adv-resident-dept"
            v-model="residentForm.department"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="4"
            required
            :placeholder="t('app.residentDepartmentPlaceholder')"
            autocomplete="off"
            :aria-invalid="residentFieldErrors.department ? 'true' : 'false'"
            :aria-describedby="residentFieldErrors.department ? 'resident-department-error' : 'resident-department-hint'"
            @input="residentFieldErrors.department = ''"
          />
          <small v-if="residentFieldErrors.department" id="resident-department-error" class="bf-field-error">
            {{ t(residentFieldErrors.department) }}
          </small>
          <small v-else-if="detectedFloor" id="resident-department-hint" class="adv-field__preview" aria-live="polite">
            <i class="pi pi-check" aria-hidden="true" />
            {{ t('app.residentFloorDetected', { floor: detectedFloor }) }}
          </small>
          <small v-else id="resident-department-hint" class="adv-field__hint">
            {{ t('app.residentDepartmentHint') }}
          </small>
        </div>

        <p v-if="modalError" class="adv-form__error" role="alert">{{ modalError }}</p>
        <RouterLink
          v-if="modalNeedsUpgrade || isAtPlanLimit"
          class="adv-btn adv-btn--primary adv-form__upgrade"
          :to="upgradePlanRoute"
          @click="isAddResidentModalOpen = false"
        >
          <i class="pi pi-arrow-up-right" aria-hidden="true" />
          {{ t('billing.upgradeCta') }}
        </RouterLink>

        <button type="button" class="adv-text-btn" :disabled="isSubmitting" @click="openBulkResidentsModal">
          <i class="pi pi-file-import" aria-hidden="true" />
          {{ t('app.advancedMgmt.importInstead') }}
        </button>

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
    </Dialog>

    <!-- Editar residente (US028) -->
    <Dialog
      :visible="!!editResidentCandidate"
      modal
      dismissable-mask
      :header="t('app.editResidentModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!isSavingResidentEdit"
      :close-on-escape="!isSavingResidentEdit"
      @update:visible="onDialogVisible($event, closeEditResidentModal)"
    >
      <form class="adv-form" novalidate @submit.prevent="onEditResidentSubmit">
        <div class="adv-field" :class="{ 'bf-field--invalid': editResidentErrors.name }">
          <label for="adv-edit-resident-name">{{ t('app.residentNameLabel') }}</label>
          <input
            id="adv-edit-resident-name"
            v-model="editResidentForm.name"
            type="text"
            autocomplete="name"
            required
            :aria-invalid="editResidentErrors.name ? 'true' : 'false'"
            @input="editResidentErrors.name = ''"
          />
          <small v-if="editResidentErrors.name" class="bf-field-error">{{ t(editResidentErrors.name) }}</small>
        </div>
        <div class="adv-field" :class="{ 'bf-field--invalid': editResidentErrors.department }">
          <label for="adv-edit-resident-dept">{{ t('app.residentDepartmentLabel') }}</label>
          <input
            id="adv-edit-resident-dept"
            v-model="editResidentForm.department"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="4"
            required
            autocomplete="off"
            :aria-invalid="editResidentErrors.department ? 'true' : 'false'"
            @input="editResidentErrors.department = ''"
          />
          <small v-if="editResidentErrors.department" class="bf-field-error">{{ t(editResidentErrors.department) }}</small>
          <small v-else-if="editDetectedFloor" class="adv-field__preview" aria-live="polite">
            <i class="pi pi-check" aria-hidden="true" />
            {{ t('app.residentFloorDetected', { floor: editDetectedFloor }) }}
          </small>
        </div>
        <p v-if="editResidentError" class="adv-form__error" role="alert">{{ editResidentError }}</p>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="isSavingResidentEdit ? t('app.savingResidentAction') : t('app.saveChangesAction')"
          confirm-type="submit"
          :stagger="false"
          :loading="isSavingResidentEdit"
          :cancel-disabled="isSavingResidentEdit"
          @cancel="closeEditResidentModal"
        />
      </form>
    </Dialog>

    <!-- Importar residentes -->
    <Dialog
      :visible="isBulkResidentsModalOpen"
      modal
      dismissable-mask
      :header="t('app.advancedMgmt.importTitle')"
      class="adv-dialog"
      :style="{ width: 'min(38rem, 94vw)' }"
      :draggable="false"
      :closable="!isSubmittingBulk"
      :close-on-escape="!isSubmittingBulk"
      @update:visible="onDialogVisible($event, closeBulkResidentsModal)"
    >
      <div class="adv-segment" v-bf-seg role="tablist" :aria-label="t('rosterImport.modeLabel')">
        <button
          type="button"
          role="tab"
          class="adv-segment__tab"
          :class="{ 'is-active': bulkMode === 'file' }"
          :aria-selected="bulkMode === 'file' ? 'true' : 'false'"
          :disabled="isSubmittingBulk"
          @click="bulkMode = 'file'"
        >
          <i class="pi pi-file-excel" aria-hidden="true" />
          {{ t('rosterImport.modeFile') }}
        </button>
        <button
          type="button"
          role="tab"
          class="adv-segment__tab"
          :class="{ 'is-active': bulkMode === 'text' }"
          :aria-selected="bulkMode === 'text' ? 'true' : 'false'"
          @click="bulkMode = 'text'"
        >
          <i class="pi pi-list" aria-hidden="true" />
          {{ t('rosterImport.modeText') }}
        </button>
      </div>

      <div v-if="bulkMode === 'file'" class="adv-form">
        <ResidentImportPanel @imported="onRosterImported" />
        <ConfirmActions
          :cancel-label="t('app.closeAction')"
          :show-confirm="false"
          :stagger="false"
          @cancel="closeBulkResidentsModal"
        />
      </div>

      <form v-else class="adv-form" @submit.prevent="onBulkResidentsSubmit">
        <div class="adv-form__note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          <span>
            {{ t('app.bulkResidentsHint') }}
            <code class="adv-code">{{ t('app.bulkResidentsExample') }}</code>
          </span>
        </div>
        <div class="adv-field">
          <label for="adv-bulk-text">{{ t('app.bulkResidentsTextareaLabel') }}</label>
          <textarea
            id="adv-bulk-text"
            v-model="bulkResidentsText"
            class="adv-field__mono"
            rows="7"
            :placeholder="t('app.bulkResidentsPlaceholder')"
          />
        </div>

        <ul v-if="bulkResults.length" class="adv-bulk-results" role="list">
          <li
            v-for="result in bulkResults"
            :key="result.line"
            class="adv-bulk-results__item"
            :class="result.status === 'ok' ? 'is-ok' : 'is-error'"
          >
            <i :class="result.status === 'ok' ? 'pi pi-check-circle' : 'pi pi-times-circle'" aria-hidden="true" />
            <span v-if="result.line" class="adv-bulk-results__line">#{{ result.line }}</span>
            <span class="adv-bulk-results__msg">{{ result.message }}</span>
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
    </Dialog>

    <!-- Nuevo espacio -->
    <Dialog
      :visible="isAddSpaceModalOpen"
      modal
      dismissable-mask
      :header="t('app.addSpaceModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(34rem, 94vw)' }"
      :draggable="false"
      :closable="!isSubmittingSpace"
      :close-on-escape="!isSubmittingSpace"
      @update:visible="onDialogVisible($event, closeAddSpaceModal)"
    >
      <form class="adv-form" novalidate @submit.prevent="onAddSpaceSubmit">
        <div class="adv-field" :class="{ 'bf-field--invalid': spaceNameInvalid }">
          <label for="adv-space-name">{{ t('app.spaceNameLabel') }}</label>
          <input
            id="adv-space-name"
            v-model="spaceForm.name"
            type="text"
            required
            :aria-invalid="spaceNameInvalid ? 'true' : 'false'"
            :aria-describedby="spaceNameInvalid ? 'space-name-error' : undefined"
            @input="spaceNameInvalid = false"
          />
          <small v-if="spaceNameInvalid" id="space-name-error" class="bf-field-error">
            {{ t('app.spaceNameRequired') }}
          </small>
        </div>

        <div class="adv-field">
          <label for="adv-space-desc">{{ t('app.spaceDescriptionLabel') }}</label>
          <input id="adv-space-desc" v-model="spaceForm.description" type="text" />
        </div>

        <div class="adv-form__row">
          <div class="adv-field">
            <label for="adv-space-capacity">{{ t('app.spaceCapacityLabel') }}</label>
            <input id="adv-space-capacity" v-model="spaceForm.capacity" type="number" min="1" />
          </div>
          <div class="adv-field">
            <label for="adv-space-max">{{ t('socialSpaces.maxPerDayLabel') }}</label>
            <input
              id="adv-space-max"
              v-model="spaceForm.maxReservationsPerDay"
              type="number"
              min="1"
              aria-describedby="adv-space-max-hint"
            />
            <small id="adv-space-max-hint" class="adv-field__hint">{{ t('socialSpaces.maxPerDayHint') }}</small>
          </div>
        </div>

        <div class="adv-field">
          <label for="adv-space-rules">{{ t('socialSpaces.rulesLabel') }}</label>
          <textarea
            id="adv-space-rules"
            v-model="spaceForm.rules"
            rows="3"
            maxlength="2000"
            :placeholder="t('socialSpaces.rulesPlaceholder')"
          />
        </div>

        <div class="adv-field">
          <span class="adv-field__label">{{ t('app.spaceImageLabel') }}</span>
          <div class="adv-upload">
            <img v-if="spaceForm.imageUrl" :src="spaceForm.imageUrl" alt="" class="adv-upload__preview" />
            <span v-else class="adv-upload__preview adv-upload__preview--empty" aria-hidden="true">
              <i class="pi pi-image" />
            </span>
            <div class="adv-upload__body">
              <div class="adv-upload__buttons">
                <label class="adv-file">
                  <input
                    type="file"
                    accept="image/*"
                    class="adv-file__input"
                    :disabled="isProcessingAddImage || isSubmittingSpace"
                    @change="onAddSpaceImageSelected"
                  />
                  <span class="adv-file__trigger">
                    <i :class="isProcessingAddImage ? 'pi pi-spin pi-spinner' : 'pi pi-upload'" aria-hidden="true" />
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
                  class="adv-link-btn"
                  :disabled="isProcessingAddImage || isSubmittingSpace"
                  @click="clearAddSpaceImage"
                >
                  {{ t('app.spaceImageRemove') }}
                </button>
              </div>
              <p class="adv-field__hint">{{ t('app.spaceImageHint') }}</p>
            </div>
          </div>
        </div>

        <p v-if="spaceModalError" class="adv-form__error" role="alert">{{ spaceModalError }}</p>

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
    </Dialog>

    <!-- Editar espacio -->
    <Dialog
      :visible="isEditSpaceModalOpen"
      modal
      dismissable-mask
      :header="t('app.editSpaceModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(34rem, 94vw)' }"
      :draggable="false"
      :closable="!isSubmittingEditSpace"
      :close-on-escape="!isSubmittingEditSpace"
      @update:visible="onDialogVisible($event, closeEditSpaceModal)"
    >
      <form class="adv-form" novalidate @submit.prevent="onEditSpaceSubmit">
        <div class="adv-field" :class="{ 'bf-field--invalid': editSpaceNameInvalid }">
          <label for="adv-edit-space-name">{{ t('app.spaceNameLabel') }}</label>
          <input
            id="adv-edit-space-name"
            v-model="editSpaceForm.name"
            type="text"
            required
            :aria-invalid="editSpaceNameInvalid ? 'true' : 'false'"
            :aria-describedby="editSpaceNameInvalid ? 'edit-space-name-error' : undefined"
            @input="editSpaceNameInvalid = false"
          />
          <small v-if="editSpaceNameInvalid" id="edit-space-name-error" class="bf-field-error">
            {{ t('app.spaceNameRequired') }}
          </small>
        </div>

        <div class="adv-field">
          <label for="adv-edit-space-desc">{{ t('app.spaceDescriptionLabel') }}</label>
          <input id="adv-edit-space-desc" v-model="editSpaceForm.description" type="text" />
        </div>

        <fieldset class="adv-field adv-fieldset">
          <legend class="adv-field__label">{{ t('socialSpaces.statusFieldLabel') }}</legend>
          <div class="adv-choice">
            <label class="adv-choice__opt" :class="{ 'is-active': editSpaceForm.status === 'AVAILABLE' }">
              <input v-model="editSpaceForm.status" type="radio" name="adv-space-status" value="AVAILABLE" />
              <span class="adv-pill__dot is-green" aria-hidden="true" />
              {{ t('socialSpaces.statusAvailable') }}
            </label>
            <label class="adv-choice__opt" :class="{ 'is-active': editSpaceForm.status === 'MAINTENANCE' }">
              <input v-model="editSpaceForm.status" type="radio" name="adv-space-status" value="MAINTENANCE" />
              <span class="adv-pill__dot is-amber" aria-hidden="true" />
              {{ t('socialSpaces.statusMaintenance') }}
            </label>
          </div>
        </fieldset>

        <div class="adv-form__row">
          <div class="adv-field">
            <label for="adv-edit-space-capacity">{{ t('app.spaceCapacityLabel') }}</label>
            <input id="adv-edit-space-capacity" v-model="editSpaceForm.capacity" type="number" min="1" />
          </div>
          <div class="adv-field">
            <label for="adv-edit-space-max">{{ t('socialSpaces.maxPerDayLabel') }}</label>
            <input
              id="adv-edit-space-max"
              v-model="editSpaceForm.maxReservationsPerDay"
              type="number"
              min="1"
              aria-describedby="adv-edit-space-max-hint"
            />
            <small id="adv-edit-space-max-hint" class="adv-field__hint">{{ t('socialSpaces.maxPerDayHint') }}</small>
          </div>
        </div>

        <div class="adv-field">
          <label for="adv-edit-space-rules">{{ t('socialSpaces.rulesLabel') }}</label>
          <textarea
            id="adv-edit-space-rules"
            v-model="editSpaceForm.rules"
            rows="3"
            maxlength="2000"
            :placeholder="t('socialSpaces.rulesPlaceholder')"
          />
        </div>

        <div class="adv-field">
          <span class="adv-field__label">{{ t('app.spaceImageLabel') }}</span>
          <div class="adv-upload">
            <img v-if="editSpaceForm.imageUrl" :src="editSpaceForm.imageUrl" alt="" class="adv-upload__preview" />
            <span v-else class="adv-upload__preview adv-upload__preview--empty" aria-hidden="true">
              <i class="pi pi-image" />
            </span>
            <div class="adv-upload__body">
              <div class="adv-upload__buttons">
                <label class="adv-file">
                  <input
                    type="file"
                    accept="image/*"
                    class="adv-file__input"
                    :disabled="isProcessingEditImage || isSubmittingEditSpace"
                    @change="onEditSpaceImageSelected"
                  />
                  <span class="adv-file__trigger">
                    <i :class="isProcessingEditImage ? 'pi pi-spin pi-spinner' : 'pi pi-upload'" aria-hidden="true" />
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
                  class="adv-link-btn"
                  :disabled="isProcessingEditImage || isSubmittingEditSpace"
                  @click="clearEditSpaceImage"
                >
                  {{ t('app.spaceImageRemove') }}
                </button>
              </div>
              <p class="adv-field__hint">{{ t('app.spaceImageHint') }}</p>
            </div>
          </div>
        </div>

        <p v-if="editSpaceModalError" class="adv-form__error" role="alert">{{ editSpaceModalError }}</p>

        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="isSubmittingEditSpace ? t('app.savingSpaceUpdateAction') : t('app.saveSpaceUpdateAction')"
          confirm-type="submit"
          :stagger="false"
          :loading="isSubmittingEditSpace"
          :disabled="isSubmittingEditSpace || isProcessingEditImage"
          :cancel-disabled="isSubmittingEditSpace"
          @cancel="closeEditSpaceModal"
        />
      </form>
    </Dialog>

    <!-- Eliminar residente -->
    <Dialog
      :visible="isDeleteResidentModalOpen"
      modal
      dismissable-mask
      :header="t('app.deleteResidentModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!isDeletingResidentCascade"
      :close-on-escape="!isDeletingResidentCascade"
      @update:visible="onDialogVisible($event, closeDeleteResidentModal)"
    >
      <div class="adv-form">
        <div v-if="deleteResidentCandidate && !deleteResidentSummary" class="adv-confirm-who">
          <span class="adv-avatar" :class="`is-${residentStatus(deleteResidentCandidate)}`" aria-hidden="true">
            {{ residentInitials(deleteResidentCandidate.name) }}
          </span>
          <div class="adv-person__text">
            <strong>{{ deleteResidentCandidate.name }}</strong>
            <small>{{ t('app.residentFloorApt', { floor: deleteResidentCandidate.floor, code: deleteResidentCandidate.code }) }}</small>
          </div>
        </div>
        <p v-if="!deleteResidentSummary" class="adv-confirm-text">
          {{ t('app.deleteResidentWarning', { name: deleteResidentCandidate?.name || '' }) }}
        </p>

        <div v-if="!deleteResidentSummary" class="adv-impact">
          <p class="adv-impact__title">{{ t('app.deleteResidentImpactTitle') }}</p>
          <p v-if="isLoadingDeletePreview" class="adv-impact__loading">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            {{ t('app.deleteResidentLoadingPreview') }}
          </p>
          <ul v-else class="adv-impact__list" role="list">
            <li v-if="(deleteResidentPreview?.reservations ?? 0) > 0">
              <i class="pi pi-calendar" aria-hidden="true" />
              {{
                t(
                  'app.advancedMgmt.impactReservations',
                  { n: deleteResidentPreview?.reservations ?? 0 },
                  deleteResidentPreview?.reservations ?? 0,
                )
              }}
            </li>
            <li>
              <i class="pi pi-id-card" aria-hidden="true" />
              {{ t('app.deleteResidentImpactAccount') }}
            </li>
            <li v-if="(deleteResidentPreview?.reservations ?? 0) === 0" class="is-muted">
              <i class="pi pi-info-circle" aria-hidden="true" />
              {{ t('app.deleteResidentImpactNone') }}
            </li>
          </ul>
        </div>

        <div v-else class="adv-done">
          <span class="adv-done__icon"><i class="pi pi-check" aria-hidden="true" /></span>
          <p class="adv-done__title">{{ t('app.deleteResidentSuccessTitle') }}</p>
          <p class="adv-done__sub">{{ t('app.deleteResidentSuccessSummary') }}</p>
          <ul class="adv-impact__list" role="list">
            <li>
              <i class="pi pi-calendar" aria-hidden="true" />
              {{
                t(
                  'app.advancedMgmt.summaryReservations',
                  { n: deleteResidentSummary.reservations },
                  Number(deleteResidentSummary.reservations) || 0,
                )
              }}
            </li>
            <li>
              <i class="pi pi-id-card" aria-hidden="true" />
              {{ t('app.deleteResidentSummaryAccount') }}
            </li>
          </ul>
          <p v-if="deleteResidentHasErrors" class="adv-done__partial">
            {{ t('app.deleteResidentPartialError') }}
          </p>
        </div>

        <p v-if="residentDeleteError" class="adv-form__error" role="alert">{{ residentDeleteError }}</p>

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
                isDeletingResidentCascade ? t('app.deleteResidentInProgress') : t('app.deleteResidentConfirmAction')
              }}</span>
            </button>
            <button v-else type="button" class="bf-btn bf-btn--confirm" @click="closeDeleteResidentModal">
              {{ t('app.closeAction') }}
            </button>
          </template>
        </ConfirmActions>
      </div>
    </Dialog>

    <!-- Desactivar / reactivar cuenta -->
    <Dialog
      :visible="Boolean(accountStatusCandidate)"
      modal
      dismissable-mask
      :header="accountStatusReactivate ? t('app.reactivateResidentModalTitle') : t('app.deactivateResidentModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!isChangingAccountStatus"
      :close-on-escape="!isChangingAccountStatus"
      @update:visible="onDialogVisible($event, closeAccountStatusModal)"
    >
      <div class="adv-form">
        <div v-if="accountStatusView" class="adv-confirm-who">
          <span class="adv-avatar" :class="`is-${residentStatus(accountStatusView)}`" aria-hidden="true">
            {{ residentInitials(accountStatusView.name) }}
          </span>
          <div class="adv-person__text">
            <strong>{{ accountStatusView.name }}</strong>
            <small>{{ t('app.residentFloorApt', { floor: accountStatusView.floor, code: accountStatusView.code }) }}</small>
          </div>
        </div>
        <p class="adv-confirm-text">
          {{
            accountStatusReactivate
              ? t('app.reactivateResidentWarning', { name: accountStatusView?.name || '' })
              : t('app.deactivateResidentWarning', { name: accountStatusView?.name || '' })
          }}
        </p>
        <p v-if="accountStatusError" class="adv-form__error" role="alert">{{ accountStatusError }}</p>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :cancel-disabled="isChangingAccountStatus"
          :stagger="false"
          align="end"
          @cancel="closeAccountStatusModal"
        >
          <template #confirm>
            <button
              type="button"
              class="bf-btn"
              :class="accountStatusReactivate ? 'bf-btn--confirm' : 'bf-btn--danger'"
              :disabled="isChangingAccountStatus"
              @click="confirmAccountStatusChange"
            >
              <span v-if="isChangingAccountStatus" class="bf-btn__spinner" aria-hidden="true" />
              <span>{{
                accountStatusReactivate ? t('app.reactivateResidentAction') : t('app.deactivateResidentAction')
              }}</span>
            </button>
          </template>
        </ConfirmActions>
      </div>
    </Dialog>

    <!-- Eliminar espacio -->
    <Dialog
      :visible="isDeleteSpaceModalOpen"
      modal
      dismissable-mask
      :header="t('app.deleteSpaceModalTitle')"
      class="adv-dialog"
      :style="{ width: 'min(28rem, 94vw)' }"
      :draggable="false"
      :closable="!isDeletingSpace"
      :close-on-escape="!isDeletingSpace"
      @update:visible="onDialogVisible($event, closeDeleteSpaceModal)"
    >
      <div class="adv-form">
        <p v-if="!deleteSpaceSummary" class="adv-confirm-text">
          {{ t('app.deleteSpaceWarning', { name: deleteSpaceCandidate?.name || '' }) }}
        </p>

        <div v-if="!deleteSpaceSummary" class="adv-impact">
          <p class="adv-impact__title">{{ t('app.deleteSpaceImpactTitle') }}</p>
          <p v-if="isLoadingSpaceDeletePreview" class="adv-impact__loading">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            {{ t('app.deleteResidentLoadingPreview') }}
          </p>
          <ul v-else class="adv-impact__list" role="list">
            <li v-if="(deleteSpacePreview?.reservations ?? 0) > 0">
              <i class="pi pi-calendar" aria-hidden="true" />
              {{
                t(
                  'app.advancedMgmt.impactReservations',
                  { n: deleteSpacePreview?.reservations ?? 0 },
                  deleteSpacePreview?.reservations ?? 0,
                )
              }}
            </li>
            <li>
              <i class="pi pi-image" aria-hidden="true" />
              {{ t('app.deleteSpaceImpactSpace') }}
            </li>
            <li v-if="(deleteSpacePreview?.reservations ?? 0) === 0" class="is-muted">
              <i class="pi pi-info-circle" aria-hidden="true" />
              {{ t('app.deleteResidentImpactNone') }}
            </li>
          </ul>
        </div>

        <div v-else class="adv-done">
          <span class="adv-done__icon"><i class="pi pi-check" aria-hidden="true" /></span>
          <p class="adv-done__title">{{ t('app.deleteSpaceSuccessTitle') }}</p>
          <p class="adv-done__sub">{{ t('app.deleteResidentSuccessSummary') }}</p>
          <ul class="adv-impact__list" role="list">
            <li>
              <i class="pi pi-calendar" aria-hidden="true" />
              {{
                t(
                  'app.advancedMgmt.summaryReservations',
                  { n: deleteSpaceSummary.reservations },
                  Number(deleteSpaceSummary.reservations) || 0,
                )
              }}
            </li>
            <li>
              <i class="pi pi-image" aria-hidden="true" />
              {{ t('app.deleteSpaceImpactSpace') }}
            </li>
          </ul>
        </div>

        <p v-if="spaceDeleteError" class="adv-form__error" role="alert">{{ spaceDeleteError }}</p>

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
              <span>{{ isDeletingSpace ? t('app.deleteResidentInProgress') : t('app.deleteResidentConfirmAction') }}</span>
            </button>
            <button v-else type="button" class="bf-btn bf-btn--confirm" @click="closeDeleteSpaceModal">
              {{ t('app.closeAction') }}
            </button>
          </template>
        </ConfirmActions>
      </div>
    </Dialog>

    <!-- Calendario de reservas -->
    <Dialog
      :visible="isSpaceCalendarModalOpen"
      modal
      dismissable-mask
      class="adv-dialog"
      :style="{ width: 'min(34rem, 94vw)' }"
      :draggable="false"
      @update:visible="onDialogVisible($event, closeSpaceCalendar)"
    >
      <template #header>
        <div class="adv-dialog__head">
          <span class="p-dialog-title">{{ t('app.spaceCalendarTitle') }}</span>
          <span v-if="selectedSpace" class="adv-dialog__sub">{{ selectedSpace.name }}</span>
        </div>
      </template>

      <p v-if="isLoadingReservations" class="adv-status" role="status">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        {{ t('app.reservationsLoading') }}
      </p>
      <LoadErrorRetry
        v-else-if="reservationsLoadError"
        compact
        :message="reservationsLoadError"
        @retry="openSpaceCalendar(selectedSpace)"
      />
      <div v-else-if="!groupedReservations.length" class="adv-empty">
        <span class="adv-empty__icon"><i class="pi pi-calendar" aria-hidden="true" /></span>
        <p class="adv-empty__text">{{ t('app.emptyReservations') }}</p>
      </div>
      <template v-else>
        <p class="adv-field__hint adv-reservations__hint">
          {{ t('app.advancedMgmt.reservationsHint') }}
          · {{ t('app.advancedMgmt.reservationsCount', { n: spaceReservations.length }, spaceReservations.length) }}
        </p>
        <ul class="adv-reservations" role="list">
          <li
            v-for="group in groupedReservations"
            :key="group.date"
            class="adv-reservations__day"
            :class="{ 'is-past': group.date < todayYmd }"
          >
            <h4 class="adv-reservations__date">
              {{ nfDayLong(group.date) }}
              <span v-if="group.date === todayYmd" class="adv-pill adv-pill--active">{{ t('app.advancedMgmt.today') }}</span>
            </h4>
            <ul class="adv-reservations__slots" role="list">
              <li v-for="r in group.items" :key="r.id" class="adv-reservations__slot">
                <span class="adv-reservations__time">{{ r.startTime }} – {{ r.endTime }}</span>
                <span class="adv-reservations__resident">
                  {{ r.residentName }}<span v-if="r.residentCode" class="is-muted"> · {{ r.residentCode }}</span>
                </span>
              </li>
            </ul>
          </li>
        </ul>
      </template>

      <template #footer>
        <ConfirmActions
          :show-cancel="false"
          :confirm-label="t('app.closeAction')"
          :stagger="false"
          @confirm="closeSpaceCalendar"
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

.adv {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.adv *,
.adv *::before,
.adv *::after,
.adv-form *,
.adv-form *::before,
.adv-form *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.adv-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.adv-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* ---------- Buttons ---------- */
.adv-btn {
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
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.adv-btn .pi {
  font-size: 0.78rem;
}

.adv-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.adv-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.adv-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.adv-btn--sm {
  min-height: 2.1rem;
  padding: 0.35rem 0.8rem;
  font-size: 0.78rem;
}

.adv-btn:focus-visible,
.adv-tab:focus-visible,
.adv-filter:focus-visible,
.adv-action:focus-visible,
.adv-space__add:focus-visible,
.adv-text-btn:focus-visible,
.adv-segment__tab:focus-visible,
.adv-link-btn:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.adv-text-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.1rem;
  border: none;
  background: none;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.adv-text-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.adv-text-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.is-blue { color: #1e3a8a; }
.is-green { color: #15803d; }
.is-amber { color: #b45309; }
.is-orange { color: #c2410c; }
.is-red { color: #b42318; }

/* ---------- Main card + tabs ---------- */
.adv-card {
  padding: 1.1rem 1.25rem 1.2rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.adv-tabs {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.adv-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.5rem 0.45rem 0.9rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.adv-tab .pi {
  font-size: 0.78rem;
}

.adv-tab:hover:not(.is-active) {
  color: #0f172a;
}

.adv-tab__count,
.adv-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.adv-tab.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.adv-filter.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.adv-tab.is-active .adv-tab__count {
  background: #f1f5f9;
  color: #0f172a;
}

.adv-filter.is-active .adv-filter__count {
  background: #f1f5f9;
  color: #0f172a;
}

.adv-panel {
  min-width: 0;
}

.adv-panel__intro {
  margin: 0 0 0.85rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #6e6e73;
}

.adv-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 1.25rem 0.25rem;
  font-size: 0.85rem;
  color: #6e6e73;
}

.adv-alert {
  margin: 0 0 0.8rem;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

/* Toolbar: search + status pills */
.adv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}

.adv-search {
  position: relative;
  flex: 1 1 18rem;
  max-width: 26rem;
  min-width: 0;
}

.adv-search .pi {
  position: absolute;
  left: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8rem;
  color: #94a3b8;
  pointer-events: none;
}

.adv-search input {
  width: 100%;
  min-height: 2.35rem;
  padding: 0.45rem 0.9rem 0.45rem 2.2rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  font: inherit;
  font-size: 0.82rem;
  color: #0f172a;
}

.adv-search input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.adv-filters {
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

.adv-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.4rem 0.35rem 0.8rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.adv-filter:hover:not(.is-active) {
  color: #0f172a;
}

/* ---------- Residents table ---------- */
.adv-table-wrap {
  overflow-x: auto;
}

.adv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.adv-table th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
  background: #f8fafc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  white-space: nowrap;
}

.adv-table th:first-child {
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}

.adv-table th:last-child {
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}

.adv-table td {
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  vertical-align: middle;
  color: #0f172a;
}

.adv-table tbody tr:last-child td,
.adv-table tbody tr.has-invite td {
  border-bottom: none;
}

.adv-table tbody tr:not(.adv-invite-row):hover td {
  background: #fafbfd;
}

.adv-table .c-unit,
.adv-table .c-date {
  white-space: nowrap;
  color: #334155;
}

.adv-table .is-actions,
.adv-table .c-actions {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}

.adv-person {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}

.adv-person__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.adv-person__text strong {
  font-weight: 650;
  font-size: 0.875rem;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.adv-person__text small {
  font-size: 0.74rem;
  color: #6e6e73;
  overflow-wrap: anywhere;
}

.adv-person__text small.is-muted,
.is-muted {
  color: #94a3b8;
}

.adv-avatar {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.adv-avatar.is-active {
  background: #e3f4e8;
  color: #15803d;
}

.adv-avatar.is-pending {
  background: #fdf3dc;
  color: #b45309;
}

.adv-avatar.is-deactivated {
  background: #f1f5f9;
  color: #64748b;
}

/* Status pills */
.adv-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
  background: #f1f5f9;
  color: #334155;
}

.adv-pill__dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.adv-pill--active {
  background: #e3f4e8;
  color: #15803d;
}

.adv-pill--pending,
.adv-pill--maintenance {
  background: #fdf3dc;
  color: #b45309;
}

.adv-pill--deactivated {
  background: #fde4e4;
  color: #b42318;
}

.adv-pill__dot.is-green { background: #15803d; }
.adv-pill__dot.is-amber { background: #b45309; }

/* Row icon actions with a visible tooltip on hover / keyboard focus */
.adv-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

.adv-action {
  position: relative;
  width: 2.1rem;
  height: 2.1rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.12s ease;
}

.adv-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.adv-action--blue { color: #1e3a8a; }
.adv-action--blue:hover:not(:disabled),
.adv-action--blue.is-open { background: #e8eefc; }
.adv-action--amber { color: #b45309; }
.adv-action--amber:hover:not(:disabled) { background: #fdf3dc; }
.adv-action--green { color: #15803d; }
.adv-action--green:hover:not(:disabled) { background: #e3f4e8; }
.adv-action--danger { background: #dc2626; color: #fff; }
.adv-action--danger:hover:not(:disabled) { background: #b91c1c; color: #fff; }

.adv-action[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 0.35rem);
  left: 50%;
  transform: translateX(-50%);
  padding: 0.25rem 0.55rem;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 3;
}

.adv-actions .adv-action:last-child[data-tip]::after {
  left: auto;
  right: 0;
  transform: none;
}

.adv-action[data-tip]:hover::after,
.adv-action[data-tip]:focus-visible::after {
  opacity: 1;
}

/* Invitation link row */
.adv-invite-row td {
  padding: 0 0.75rem 0.75rem;
}

.adv-invite {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.7rem 0.8rem;
  border-radius: 14px;
  background: #e8eefc;
}

.adv-invite__text {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #1e3a8a;
}

.adv-invite__text .pi {
  margin-top: 0.12rem;
  font-size: 0.78rem;
}

.adv-invite__text.is-copied {
  color: #15803d;
}

.adv-invite__field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.adv-invite__field input {
  flex: 1;
  min-width: 0;
  min-height: 2.1rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  font: inherit;
  font-size: 0.75rem;
  color: #334155;
}

.adv-invite__field input:focus {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
}

/* Empty states */
.adv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 1.75rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.adv-empty__icon {
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

.adv-empty__text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.adv-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* ---------- Spaces grid ---------- */
.adv-spaces {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.85rem;
}

.adv-space {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
  overflow: hidden;
}

.adv-space__media {
  aspect-ratio: 2 / 1;
  background: #e8eefc;
  overflow: hidden;
}

.adv-space__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.adv-space__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.adv-space__placeholder-icon {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 12px;
  background: #fff;
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05rem;
}

.adv-space__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.85rem 0.95rem 0.6rem;
  min-width: 0;
}

.adv-space__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.adv-space__name {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.98rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.adv-space__desc {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #475569;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.adv-space__desc.is-muted {
  color: #94a3b8;
}

.adv-space__facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.adv-space__facts li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 600;
}

.adv-space__facts .pi {
  font-size: 0.68rem;
  color: #64748b;
}

.adv-space__rules {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.5rem 0.6rem;
  border-radius: 12px;
  background: #f8fafc;
  font-size: 0.75rem;
  line-height: 1.4;
  color: #475569;
}

.adv-space__rules .pi {
  margin-top: 0.12rem;
  font-size: 0.72rem;
  color: #1e3a8a;
}

.adv-space__rules p {
  margin: 0;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.adv-space__rules strong {
  color: #0f172a;
  font-weight: 650;
}

.adv-space__rules.is-muted,
.adv-space__rules.is-muted .pi {
  color: #94a3b8;
}

.adv-space__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem 0.75rem 0.95rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.adv-space--add {
  border-style: dashed;
  border-color: rgba(15, 23, 42, 0.16);
  background: #f8fafc;
}

.adv-space__add {
  flex: 1;
  min-height: 12rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 1.25rem;
  border: none;
  background: transparent;
  font: inherit;
  color: #1e3a8a;
  cursor: pointer;
  border-radius: 16px;
}

.adv-space__add:hover {
  background: #eef2fb;
}

.adv-space__add strong {
  font-size: 0.88rem;
  font-weight: 650;
}

.adv-space__add small {
  font-size: 0.75rem;
  color: #6e6e73;
}

.adv-space__add-icon {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 12px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

/* ---------- Dialog content (slot content keeps this component's scope) ---------- */
.adv-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.adv-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 0.9rem;
}

.adv-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.adv-field > label,
.adv-field__label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.adv-field input:not([type='radio']):not([type='file']),
.adv-field textarea,
.adv-field select {
  width: 100%;
  min-height: 2.6rem;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  background: #fff;
  font: inherit;
  font-size: 0.875rem;
  color: #0f172a;
}

.adv-field textarea {
  resize: vertical;
  line-height: 1.45;
}

.adv-field input:focus,
.adv-field textarea:focus,
.adv-field select:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.adv-field__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
  font-size: 0.82rem !important;
}

.adv-field__hint {
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.adv-field__preview {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #15803d;
}

.adv-field__preview .pi {
  font-size: 0.68rem;
}

.adv-fieldset {
  margin: 0;
  padding: 0;
  border: none;
}

.adv-fieldset legend {
  padding: 0;
  margin-bottom: 0.35rem;
}

.adv-choice {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.adv-choice__opt {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #334155;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.adv-choice__opt input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.adv-choice__opt.is-active {
  border-color: #1e3a8a;
  background: #e8eefc;
  color: #1e3a8a;
}

.adv-choice__opt:has(input:focus-visible) {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.adv-form__error {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

.adv-form__note {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 12px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.78rem;
  line-height: 1.45;
}

.adv-form__note .pi {
  margin-top: 0.15rem;
  font-size: 0.75rem;
}

.adv-form__note--warn {
  background: #fdf3dc;
  color: #78350f;
}

.adv-form__upgrade {
  align-self: flex-start;
}

.adv-code {
  display: inline-block;
  margin-top: 0.2rem;
  padding: 0.05rem 0.4rem;
  border-radius: 6px;
  background: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: #0f172a;
}

/* Segmented control (import mode) */
.adv-segment {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.25rem;
  margin: 0 0 0.9rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
  max-width: 100%;
  flex-wrap: wrap;
}

.adv-segment__tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.9rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
}

.adv-segment__tab.is-active {
  background: transparent;
  color: #0f172a;
}

.adv-segment__tab:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Bulk (paste) results */
.adv-bulk-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-height: 14rem;
  overflow-y: auto;
}

.adv-bulk-results__item {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.4rem 0.6rem;
  border-radius: 10px;
  font-size: 0.78rem;
}

.adv-bulk-results__item .pi {
  margin-top: 0.12rem;
  font-size: 0.75rem;
}

.adv-bulk-results__item.is-ok {
  background: #e3f4e8;
  color: #14532d;
}

.adv-bulk-results__item.is-error {
  background: #fde4e4;
  color: #7f1d1d;
}

.adv-bulk-results__line {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.adv-bulk-results__msg {
  flex: 1;
  min-width: 0;
}

/* Image upload */
.adv-upload {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.65rem 0.75rem;
  border-radius: 14px;
  border: 1px dashed rgba(15, 23, 42, 0.18);
  background: #f8fafc;
}

.adv-upload__preview {
  flex-shrink: 0;
  width: 5.5rem;
  height: 3.6rem;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(15, 23, 42, 0.07);
}

.adv-upload__preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: #94a3b8;
  font-size: 0.95rem;
}

.adv-upload__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.adv-upload__buttons {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.adv-file {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.adv-file__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.adv-file__input:disabled {
  cursor: not-allowed;
}

.adv-file__trigger {
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

.adv-file:hover .adv-file__trigger {
  background: #e8eefc;
}

.adv-file:focus-within .adv-file__trigger {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.adv-link-btn {
  padding: 0.2rem 0.3rem;
  border: none;
  background: none;
  color: #b42318;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.adv-link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.adv-link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Confirmation dialogs */
.adv-confirm-who {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.65rem 0.75rem;
  border-radius: 14px;
  background: #f8fafc;
}

.adv-confirm-text {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.45;
  color: #0f172a;
}

.adv-impact {
  padding: 0.7rem 0.8rem;
  border-radius: 14px;
  background: #fde4e4;
}

.adv-impact__title {
  margin: 0 0 0.45rem;
  font-size: 0.78rem;
  font-weight: 650;
  color: #7f1d1d;
}

.adv-impact__loading {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  font-size: 0.8rem;
  color: #7f1d1d;
}

.adv-impact__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.adv-impact__list li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.8rem;
  color: #0f172a;
}

.adv-impact__list .pi {
  font-size: 0.75rem;
  color: #b42318;
}

.adv-impact__list li.is-muted {
  color: #6e6e73;
}

.adv-impact__list li.is-muted .pi {
  color: #94a3b8;
}

.adv-done {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.85rem 0.9rem;
  border-radius: 14px;
  background: #e3f4e8;
}

.adv-done__icon {
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  background: #fff;
  color: #15803d;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
}

.adv-done__title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 650;
  color: #14532d;
}

.adv-done__sub {
  margin: 0;
  font-size: 0.78rem;
  color: #3f6212;
}

.adv-done .adv-impact__list .pi {
  color: #15803d;
}

.adv-done__partial {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  color: #b45309;
}

/* Reservation calendar */
.adv-reservations__hint {
  margin-bottom: 0.7rem;
}

.adv-reservations {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.adv-reservations__day {
  padding: 0.65rem 0.8rem;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  background: #fff;
}

.adv-reservations__day.is-past {
  background: #f8fafc;
}

.adv-reservations__day.is-past .adv-reservations__date {
  color: #64748b;
}

.adv-reservations__date {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.45rem;
  font-size: 0.85rem;
  font-weight: 650;
  color: #0f172a;
}

.adv-reservations__slots {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.adv-reservations__slot {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: #0f172a;
  min-width: 0;
}

.adv-reservations__time {
  flex-shrink: 0;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.74rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.adv-reservations__resident {
  min-width: 0;
  overflow-wrap: anywhere;
}

.adv-dialog__head {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.adv-dialog__sub {
  font-size: 0.8rem;
  color: #6e6e73;
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

/* ---------- Responsive ---------- */

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .adv-head,
  .adv-head__actions {
    width: 100%;
  }
  .adv-head__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .adv-head__actions .adv-btn {
    padding-inline: 0.6rem;
    white-space: normal;
    text-align: center;
  }
  .adv-head__actions .adv-btn--primary {
    grid-column: 1 / -1;
    order: -1;
  }
  .adv-card {
    padding: 1rem 0.85rem;
  }
  .adv-tabs {
    flex-wrap: nowrap;
    width: 100%;
  }
  .adv-tab {
    flex: 1 1 0;
    min-width: 0;
    justify-content: center;
    padding-inline: 0.6rem 0.45rem;
    font-size: 0.78rem;
  }
  .adv-tab .pi {
    display: none;
  }
  .adv-search {
    flex: 1 1 100%;
    max-width: none;
  }

  /* Table → one card per resident */
  .adv-table-wrap {
    overflow: visible;
  }
  .adv-table,
  .adv-table tbody,
  .adv-table tr,
  .adv-table td {
    display: block;
    width: 100%;
  }
  .adv-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  .adv-table tbody {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .adv-table tbody tr:not(.adv-invite-row) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.6rem 0.75rem;
    padding: 0.8rem 0.85rem;
    border-radius: 16px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: #fff;
  }
  .adv-table tbody tr.has-invite {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom: none;
  }
  .adv-table tbody tr.adv-invite-row {
    margin-top: -0.55rem;
    padding: 0 0.85rem 0.85rem;
    border: 1px solid rgba(15, 23, 42, 0.08);
    border-top: none;
    border-radius: 0 0 16px 16px;
    background: #fff;
  }
  .adv-table tbody tr:hover td {
    background: transparent !important;
  }
  .adv-table td {
    padding: 0;
    border: none;
    text-align: left !important;
    min-width: 0;
    white-space: normal !important;
  }
  .adv-invite-row td {
    padding: 0;
  }
  .adv-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.2rem;
    font-size: 0.68rem;
    font-weight: 600;
    color: #6e6e73;
  }
  .adv-table .c-main {
    grid-column: 1 / -1;
  }
  .adv-table .c-status {
    grid-column: 1 / 2;
  }
  .adv-table .c-actions {
    grid-column: 2 / 3;
    width: auto;
    align-self: end;
    text-align: right !important;
  }
  .adv-actions {
    justify-content: flex-end;
    width: 100%;
  }
  .adv-invite__field {
    flex-wrap: wrap;
  }
  .adv-invite__field input {
    flex-basis: 100%;
  }
  .adv-spaces {
    grid-template-columns: minmax(0, 1fr);
  }
  .adv-space__add {
    min-height: 8rem;
  }
  .adv-space__media {
    aspect-ratio: 5 / 2;
  }
}

@media (max-width: 480px) {
  .adv-form__row {
    grid-template-columns: minmax(0, 1fr);
  }
  .adv-upload {
    align-items: flex-start;
  }
  .adv-upload__preview {
    width: 4rem;
    height: 3rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .adv-btn,
  .adv-action,
  .adv-action[data-tip]::after {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.adv-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.adv-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.adv-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.adv-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 1.1rem;
}

.adv-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  gap: 0.5rem;
}

.adv-dialog .bf-actions {
  margin-top: 0.25rem;
}
</style>
