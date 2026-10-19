<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import { importUploadsApi, DOCUMENT_TYPES } from '@/communications/infrastructure/importUploadsApi.js'
import { importFoldersApi, isContextFolder, isHomeFolder, isSystemFolder } from '@/communications/infrastructure/importFoldersApi.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'

const { t, locale } = useI18n()

const intlLocale = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

const items = ref([])
const loading = ref(false)
const loadError = ref(false)
const uploading = ref(false)
const uploadError = ref('')
const isDragging = ref(false)
const fileInputRef = ref(null)
const uploadButtonRef = ref(null)
const deletingId = ref(null)
const deletingFolderId = ref(null)
const downloadingId = ref(null)

const folders = ref([])
const selectedFolderId = ref(null)
const draggingFileId = ref(null)
const dropFolderId = ref(null)
const movingFileId = ref(null)

const FILE_DRAG_TYPE = 'application/x-import-file'

const isEditModalOpen = ref(false)
const isSavingName = ref(false)
const editError = ref('')
const editCandidate = ref(null)
const editFileName = ref('')

const isFolderModalOpen = ref(false)
const isSavingFolder = ref(false)
const folderModalError = ref('')
const folderCandidate = ref(null)
const folderName = ref('')

/** Pending destructive action: { kind: 'file' | 'folder', item }. */
const pendingDelete = ref(null)

/** List filters (per selected folder). */
const statusFilter = ref('ALL')
const typeFilter = ref('ALL')
const searchQuery = ref('')

function formatBytes(n) {
  const x = Number(n) || 0
  if (x < 1024) return `${x} B`
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(x < 10240 ? 1 : 0)} KB`
  return `${(x / (1024 * 1024)).toFixed(1)} MB`
}

const maxSizeLabel = computed(() => formatBytes(MAX_BYTES))

function localDateKey(iso) {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayKey() {
  return localDateKey(new Date().toISOString())
}

function yesterdayKey() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return localDateKey(d.toISOString())
}

function dateGroupLabel(dateKey) {
  if (dateKey === todayKey()) return t('importView.today')
  if (dateKey === yesterdayKey()) return t('importView.yesterday')
  const d = new Date(`${dateKey}T12:00:00`)
  return d.toLocaleDateString(intlLocale.value, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(intlLocale.value, { hour: '2-digit', minute: '2-digit' }).format(d)
}

function formatDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(intlLocale.value, { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

const homeFolder = computed(() => folders.value.find((folder) => isHomeFolder(folder)) ?? null)
const contextFolder = computed(() => folders.value.find((folder) => isContextFolder(folder)) ?? null)

const selectedFolder = computed(
  () => folders.value.find((folder) => folder.id === selectedFolderId.value) ?? homeFolder.value,
)

function fileBelongsToFolder(file, folder) {
  if (!folder) return false
  const folderId = String(file.folderId ?? '')
  if (isHomeFolder(folder)) {
    return !folderId || folderId === String(folder.id)
  }
  return folderId === String(folder.id)
}

const visibleItems = computed(() => {
  const folder = selectedFolder.value
  if (!folder) return items.value
  return items.value.filter((row) => fileBelongsToFolder(row, folder))
})

function folderFileCount(folder) {
  return items.value.filter((row) => fileBelongsToFolder(row, folder)).length
}

function sortFolders(list) {
  return [...list].sort((a, b) => {
    const rank = (f) => (isHomeFolder(f) ? 2 : isContextFolder(f) ? 1 : 0)
    const diff = rank(b) - rank(a)
    if (diff) return diff
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  })
}

function selectFolder(folder) {
  if (!folder) return
  selectedFolderId.value = folder.id
}

function folderDisplayName(folder) {
  if (!folder || isHomeFolder(folder)) return t('importView.homeFolderName')
  if (isContextFolder(folder)) return t('importView.contextFolderName')
  return folder.name
}

function folderIcon(folder) {
  if (isHomeFolder(folder)) return 'pi-inbox'
  if (isContextFolder(folder)) return 'pi-sparkles'
  return 'pi-folder'
}

/* ---------- Document status, type and AI usage ---------- */

function documentStatusOf(file) {
  return String(file?.documentStatus ?? 'PUBLISHED').toUpperCase()
}

function documentTypeOf(file) {
  const value = String(file?.documentType ?? 'OTHER').toUpperCase()
  return DOCUMENT_TYPES.includes(value) ? value : 'OTHER'
}

function documentTypeLabel(type) {
  const value = String(type ?? 'OTHER').toUpperCase()
  return DOCUMENT_TYPES.includes(value) ? t(`importView.documentTypes.${value}`) : t('importView.documentTypes.OTHER')
}

function documentStatusLabel(file) {
  const status = documentStatusOf(file)
  return ['PUBLISHED', 'SUPERSEDED', 'ARCHIVED', 'PENDING_UPLOAD'].includes(status)
    ? t(`importView.documentStatuses.${status}`)
    : status
}

function isInContextFolder(file) {
  return Boolean(contextFolder.value) && fileBelongsToFolder(file, contextFolder.value)
}

/**
 * How the AI assistant uses a file: only PUBLISHED documents feed it (RF033); files in the
 * "Contexto IA" folder are indexed. Returns ready | pending | failed | queued | off.
 */
function aiStateOf(file) {
  if (documentStatusOf(file) !== 'PUBLISHED') return 'off'
  const s = String(file?.indexingStatus ?? '').toLowerCase()
  if (s === 'failed') return 'failed'
  if (s === 'pending' || s === 'indexing') return 'pending'
  if (s === 'done' || s === 'ready') return 'ready'
  return isInContextFolder(file) ? 'queued' : 'off'
}

function aiStateLabel(state) {
  if (state === 'ready') return t('importView.indexingDone')
  if (state === 'pending') return t('importView.indexingPending')
  if (state === 'failed') return t('importView.indexingFailed')
  if (state === 'queued') return t('importView.aiQueued')
  return t('importView.aiOff')
}

function aiStateIcon(state) {
  if (state === 'ready') return 'pi-sparkles'
  if (state === 'pending') return 'pi-spin pi-spinner'
  if (state === 'failed') return 'pi-exclamation-triangle'
  if (state === 'queued') return 'pi-clock'
  return 'pi-minus-circle'
}

function fileKind(file) {
  const mime = String(file?.mimeType ?? '').toLowerCase()
  const name = String(file?.fileName ?? '').toLowerCase()
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return { icon: 'pi-file-pdf', tone: 'red' }
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(name)) return { icon: 'pi-image', tone: 'blue' }
  if (mime === 'text/csv' || name.endsWith('.csv')) return { icon: 'pi-file-excel', tone: 'green' }
  if (mime === 'application/json' || name.endsWith('.json')) return { icon: 'pi-code', tone: 'amber' }
  return { icon: 'pi-file', tone: 'slate' }
}

/* ---------- Summary ---------- */

const summary = computed(() => {
  const rows = items.value
  const current = rows.filter((f) => documentStatusOf(f) === 'PUBLISHED')
  const aiUsed = current.filter((f) => ['ready', 'pending', 'queued'].includes(aiStateOf(f)))
  const aiReady = current.filter((f) => aiStateOf(f) === 'ready')
  const inactive = rows.filter((f) => ['SUPERSEDED', 'ARCHIVED'].includes(documentStatusOf(f)))
  const bytes = rows.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  return {
    current: current.length,
    aiUsed: aiUsed.length,
    aiReady: aiReady.length,
    inactive: inactive.length,
    superseded: inactive.filter((f) => documentStatusOf(f) === 'SUPERSEDED').length,
    archived: inactive.filter((f) => documentStatusOf(f) === 'ARCHIVED').length,
    bytes,
    total: rows.length,
  }
})

/* ---------- Filters ---------- */

const STATUS_FILTERS = ['ALL', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED']

const statusFilterOptions = computed(() =>
  STATUS_FILTERS.map((key) => ({
    key,
    label: key === 'ALL' ? t('importView.filterAll') : t(`importView.documentStatuses.${key}`),
    count:
      key === 'ALL'
        ? visibleItems.value.length
        : visibleItems.value.filter((f) => documentStatusOf(f) === key).length,
  })),
)

const typeFilterOptions = computed(() => [
  { key: 'ALL', label: t('importView.filterAllTypes') },
  ...DOCUMENT_TYPES.map((key) => ({ key, label: documentTypeLabel(key) })),
])

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

const hasActiveFilters = computed(
  () => statusFilter.value !== 'ALL' || typeFilter.value !== 'ALL' || Boolean(searchQuery.value.trim()),
)

function clearFilters() {
  statusFilter.value = 'ALL'
  typeFilter.value = 'ALL'
  searchQuery.value = ''
}

const filteredItems = computed(() => {
  const q = normalizeText(searchQuery.value.trim())
  return visibleItems.value.filter((file) => {
    if (statusFilter.value !== 'ALL' && documentStatusOf(file) !== statusFilter.value) return false
    if (typeFilter.value !== 'ALL' && documentTypeOf(file) !== typeFilter.value) return false
    if (q && !normalizeText(file.fileName).includes(q)) return false
    return true
  })
})

const groupedByDate = computed(() => {
  const map = new Map()
  for (const row of filteredItems.value) {
    const key = localDateKey(row.uploadedAt)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  const keys = [...map.keys()].sort((a, b) => b.localeCompare(a))
  return keys.map((dateKey) => ({
    dateKey,
    label: dateGroupLabel(dateKey),
    items: map
      .get(dateKey)
      .sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? ''))),
  }))
})

function isAllowedMime(file) {
  const mime = String(file?.type || '').toLowerCase()
  if (ALLOWED_MIME.has(mime)) return true
  const name = String(file?.name || '').toLowerCase()
  return (
    name.endsWith('.pdf') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv') ||
    name.endsWith('.json') ||
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp')
  )
}

async function loadList() {
  loading.value = true
  loadError.value = false
  try {
    const [files, folderRows] = await Promise.all([
      importUploadsApi.list(),
      importFoldersApi.list(),
    ])
    const home = await importFoldersApi.ensureHome(folderRows)
    const context = await importFoldersApi.ensureContext(
      folderRows.some((folder) => folder.id === home.id)
        ? folderRows.map((folder) => (folder.id === home.id ? home : folder))
        : [home, ...folderRows],
    )
    let nextFolders = folderRows.some((folder) => folder.id === home.id)
      ? folderRows.map((folder) => (folder.id === home.id ? home : folder))
      : [home, ...folderRows]
    nextFolders = nextFolders.some((folder) => folder.id === context.id)
      ? nextFolders.map((folder) => (folder.id === context.id ? context : folder))
      : [context, ...nextFolders]

    const orphans = files.filter((file) => !file.folderId)
    if (orphans.length) {
      await Promise.all(orphans.map((file) => importUploadsApi.setFolder(file.id, home.id)))
    }

    items.value = files.map((file) =>
      file.folderId ? file : { ...file, folderId: home.id },
    )
    folders.value = sortFolders(nextFolders)
    if (
      !selectedFolderId.value ||
      !nextFolders.some((folder) => folder.id === selectedFolderId.value)
    ) {
      selectedFolderId.value = home.id
    }
  } catch {
    loadError.value = true
    items.value = []
  } finally {
    loading.value = false
  }
}

async function ingestFiles(fileList) {
  const files = Array.from(fileList ?? []).filter((f) => f.size > 0)
  if (!files.length) return
  uploadError.value = ''
  uploading.value = true
  const uploadedIds = []
  try {
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        uploadError.value = t('importView.fileTooLarge', { max: maxSizeLabel.value })
        continue
      }
      if (!isAllowedMime(file)) {
        uploadError.value = t('importView.mimeNotAllowed')
        continue
      }
      const uploaded = await importUploadsApi.add({
        file,
        folderId: selectedFolderId.value || homeFolder.value?.id,
      })
      if (uploaded?.id) uploadedIds.push(uploaded.id)
    }
    await loadList()
    uploadedIds.forEach((id) => markFresh('document', id))
    // No dialog to close: the button turns green while the upload area goes back to idle.
    if (uploadedIds.length) {
      void confirmSuccess(
        uploadButtonRef,
        uploadedIds.length > 1 ? t('feedback.documentsUploaded') : t('feedback.documentUploaded'),
      )
    }
  } catch (err) {
    const code = err?.response?.data?.code || err?.code
    if (code === 'QUOTA_EXCEEDED') uploadError.value = t('importView.quotaExceeded')
    else if (code === 'MIME_NOT_ALLOWED') uploadError.value = t('importView.mimeNotAllowed')
    else if (code === 'FILE_TOO_LARGE') uploadError.value = t('importView.fileTooLarge', { max: maxSizeLabel.value })
    else if (code === 'STORAGE_NOT_CONFIGURED' || err?.status === 503) uploadError.value = t('importView.storageUnavailable')
    else uploadError.value = t('importView.uploadError')
  } finally {
    uploading.value = false
    if (fileInputRef.value) fileInputRef.value.value = ''
  }
}

function onFileInputChange(e) {
  ingestFiles(e.target?.files)
}

function isInternalFileDrag() {
  return Boolean(draggingFileId.value)
}

function onDrop(e) {
  e.preventDefault()
  isDragging.value = false
  if (isInternalFileDrag()) return
  ingestFiles(e.dataTransfer?.files)
}

function onDragOver(e) {
  if (isInternalFileDrag()) return
  e.preventDefault()
  isDragging.value = true
}

function onDragLeave() {
  isDragging.value = false
}

function onFileDragStart(event, file) {
  if (!file?.id) return
  draggingFileId.value = file.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(FILE_DRAG_TYPE, file.id)
  event.dataTransfer.setData('text/plain', file.fileName || file.id)
}

function onFileDragEnd() {
  draggingFileId.value = null
  dropFolderId.value = null
}

function onFolderDragOver(event, folder) {
  if (!draggingFileId.value || !folder) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropFolderId.value = folder.id
}

function onFolderDragLeave(folder) {
  if (dropFolderId.value === folder.id) dropFolderId.value = null
}

async function onFolderDrop(event, folder) {
  event.preventDefault()
  const fileId = event.dataTransfer.getData(FILE_DRAG_TYPE) || draggingFileId.value
  draggingFileId.value = null
  dropFolderId.value = null
  if (!fileId || !folder?.id || movingFileId.value) return

  const file = items.value.find((row) => String(row.id) === String(fileId))
  if (!file || fileBelongsToFolder(file, folder)) return

  movingFileId.value = file.id
  uploadError.value = ''
  try {
    await importUploadsApi.setFolder(file.id, folder.id)
    items.value = items.value.map((row) =>
      row.id === file.id ? { ...row, folderId: folder.id } : row,
    )
  } catch {
    uploadError.value = t('importView.moveError')
  } finally {
    movingFileId.value = null
  }
}

function openFilePicker() {
  if (uploading.value) return
  fileInputRef.value?.click()
}

function fileExtension(name) {
  const value = String(name ?? '')
  const dot = value.lastIndexOf('.')
  if (dot <= 0 || dot === value.length - 1) return ''
  return value.slice(dot)
}

function normalizeFileName(nextName, originalName) {
  const trimmed = String(nextName ?? '').trim()
  if (!trimmed) return ''
  const ext = fileExtension(originalName)
  if (!ext) return trimmed
  if (trimmed.toLowerCase().endsWith(ext.toLowerCase())) return trimmed
  if (trimmed.includes('.')) return trimmed
  return `${trimmed}${ext}`
}

function openEditModal(file) {
  if (!file || isSavingName.value) return
  editCandidate.value = file
  editFileName.value = file.fileName ?? ''
  editError.value = ''
  isEditModalOpen.value = true
}

function closeEditModal() {
  if (isSavingName.value) return
  isEditModalOpen.value = false
  editCandidate.value = null
  editFileName.value = ''
  editError.value = ''
}

async function onSaveFileName(event) {
  if (isSavingName.value || !editCandidate.value) return
  const nextName = normalizeFileName(editFileName.value, editCandidate.value.fileName)
  if (!nextName) {
    editError.value = t('importView.editRequired')
    return
  }

  isSavingName.value = true
  editError.value = ''
  try {
    const updated = await importUploadsApi.updateFileName(editCandidate.value.id, nextName)
    const savedName = updated?.fileName || nextName
    const savedId = editCandidate.value.id
    await confirmSuccess(event, t('feedback.changesSaved'))
    isEditModalOpen.value = false
    items.value = items.value.map((row) =>
      row.id === savedId ? { ...row, fileName: savedName } : row,
    )
    markFresh('document', savedId)
    editCandidate.value = null
    editFileName.value = ''
  } catch {
    editError.value = t('importView.editError')
  } finally {
    isSavingName.value = false
  }
}

function openFolderModal(folder = null) {
  if (isSavingFolder.value || isSystemFolder(folder)) return
  folderCandidate.value = folder
  folderName.value = folder?.name ?? ''
  folderModalError.value = ''
  isFolderModalOpen.value = true
}

function closeFolderModal() {
  if (isSavingFolder.value) return
  isFolderModalOpen.value = false
  folderCandidate.value = null
  folderName.value = ''
  folderModalError.value = ''
}

async function onSaveFolder(event) {
  if (isSavingFolder.value) return
  const name = String(folderName.value ?? '').trim()
  if (!name) {
    folderModalError.value = t('importView.folderRequired')
    return
  }

  isSavingFolder.value = true
  folderModalError.value = ''
  try {
    if (folderCandidate.value) {
      const folderId = folderCandidate.value.id
      const updated = await importFoldersApi.updateName(folderId, name)
      const savedName = updated?.name || name
      await confirmSuccess(event, t('feedback.changesSaved'))
      isFolderModalOpen.value = false
      folders.value = folders.value.map((folder) =>
        folder.id === folderId ? { ...folder, name: savedName } : folder,
      )
      markFresh('folder', folderId)
    } else {
      const created = await importFoldersApi.add({ name })
      await confirmSuccess(event, t('feedback.folderCreated'))
      isFolderModalOpen.value = false
      folders.value = sortFolders([created, ...folders.value])
      selectedFolderId.value = created.id
      markFresh('folder', created.id)
    }
    folderCandidate.value = null
    folderName.value = ''
  } catch {
    folderModalError.value = t('importView.folderError')
  } finally {
    isSavingFolder.value = false
  }
}

async function onDiscardFolder(folder) {
  if (!folder?.id || deletingFolderId.value || isSystemFolder(folder)) return
  deletingFolderId.value = folder.id
  uploadError.value = ''
  const homeId = homeFolder.value?.id
  try {
    const filesInFolder = items.value.filter((row) => fileBelongsToFolder(row, folder))
    if (homeId) {
      await Promise.all(filesInFolder.map((file) => importUploadsApi.setFolder(file.id, homeId)))
    }
    await importFoldersApi.remove(folder.id)
    items.value = items.value.map((row) =>
      fileBelongsToFolder(row, folder) ? { ...row, folderId: homeId || null } : row,
    )
    folders.value = folders.value.filter((item) => item.id !== folder.id)
    if (selectedFolderId.value === folder.id) selectedFolderId.value = homeId || null
  } catch {
    uploadError.value = t('importView.folderDeleteError')
  } finally {
    deletingFolderId.value = null
  }
}

async function onDownload(file) {
  if (!file?.id || downloadingId.value) return
  downloadingId.value = file.id
  uploadError.value = ''
  try {
    const { downloadUrl } = await importUploadsApi.getDownloadUrl(file.id)
    if (!downloadUrl) throw new Error('NO_URL')
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = file.fileName || 'archivo'
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    uploadError.value =
      err?.code === 'STORAGE_NOT_CONFIGURED' || err?.status === 503
        ? t('importView.storageUnavailable')
        : t('importView.downloadError')
  } finally {
    downloadingId.value = null
  }
}

async function onDiscard(id) {
  if (!id || deletingId.value) return
  deletingId.value = id
  uploadError.value = ''
  try {
    await importUploadsApi.remove(id)
    items.value = items.value.filter((r) => r.id !== id)
  } catch {
    uploadError.value = t('importView.deleteError')
  } finally {
    deletingId.value = null
  }
}

/* ---------- Delete confirmation ---------- */

const deletingPending = computed(() => Boolean(deletingId.value || deletingFolderId.value))

function askDeleteFile(file) {
  if (!file?.id) return
  pendingDelete.value = { kind: 'file', item: file }
}

function askDeleteFolder(folder) {
  if (!folder?.id || isSystemFolder(folder)) return
  pendingDelete.value = { kind: 'folder', item: folder }
}

function closeDelete() {
  if (deletingPending.value) return
  pendingDelete.value = null
}

async function confirmDelete() {
  const target = pendingDelete.value
  if (!target) return
  if (target.kind === 'folder') await onDiscardFolder(target.item)
  else await onDiscard(target.item.id)
  pendingDelete.value = null
}

/**
 * OfficialDocument (Communications 5.7): type, version and validity. Only PUBLISHED documents are
 * "vigentes" and feed the AI assistant (RF033); publishing a new version supersedes the previous one.
 */
const docCandidate = ref(null)
const docType = ref('OTHER')
const docSupersedesId = ref('')
const docSaving = ref(false)
const docError = ref('')

const docTypeOptions = computed(() =>
  DOCUMENT_TYPES.map((type) => ({ value: type, label: documentTypeLabel(type) })),
)

const supersedeOptions = computed(() =>
  items.value.filter(
    (file) => file.id !== docCandidate.value?.id && documentStatusOf(file) === 'PUBLISHED',
  ),
)

const supersedeSelectOptions = computed(() => [
  { value: '', label: t('importView.supersedesNone') },
  ...supersedeOptions.value.map((other) => ({
    value: other.id,
    label: `${other.fileName} (v${other.version || 1})`,
  })),
])

function openDocModal(file) {
  docCandidate.value = file
  docType.value = documentTypeOf(file)
  docSupersedesId.value = ''
  docError.value = ''
}

function closeDocModal() {
  if (docSaving.value) return
  docCandidate.value = null
}

function mergeDocRows(...rows) {
  const byId = new Map(rows.filter(Boolean).map((row) => [row.id, row]))
  items.value = items.value.map((row) => (byId.has(row.id) ? { ...row, ...byId.get(row.id) } : row))
}

async function runDocAction(action, event) {
  const file = docCandidate.value
  if (!file || docSaving.value) return
  docSaving.value = true
  docError.value = ''
  try {
    if (action === 'type') {
      const updated = await importUploadsApi.setDocumentType(file.id, docType.value)
      await confirmSuccess(event, t('feedback.changesSaved'))
      docCandidate.value = null
      mergeDocRows(updated)
      markFresh('document', file.id)
    } else if (action === 'publish') {
      const result = await importUploadsApi.publish(file.id, {
        supersedesId: docSupersedesId.value || null,
        documentType: docType.value,
      })
      await confirmSuccess(event, t('feedback.documentPublished'))
      docCandidate.value = null
      mergeDocRows(result?.document, result?.superseded)
      markFresh('document', result?.document?.id ?? file.id)
    } else if (action === 'archive') {
      mergeDocRows(await importUploadsApi.archive(file.id))
    }
    docCandidate.value = null
  } catch {
    docError.value = t('importView.documentActionError')
  } finally {
    docSaving.value = false
  }
}

onMounted(loadList)
</script>

<template>
  <div class="app-view imp">
    <header class="imp-head">
      <h1 class="bf-sr-only">{{ t('importView.pageTitle') }}</h1>
      <div class="imp-head__actions" role="group" :aria-label="t('importView.headerActions')">
        <button type="button" class="imp-btn" :disabled="isSavingFolder" @click="openFolderModal()">
          <i class="pi pi-folder-plus" aria-hidden="true" />
          {{ t('importView.newFolder') }}
        </button>
        <button
          ref="uploadButtonRef"
          type="button"
          class="imp-btn imp-btn--primary"
          :disabled="uploading || loading"
          @click="openFilePicker"
        >
          <i class="pi" :class="uploading ? 'pi-spin pi-spinner' : 'pi-upload'" aria-hidden="true" />
          <span>{{ uploading ? t('importView.uploadingFiles') : t('importView.uploadDocument') }}</span>
        </button>
      </div>
    </header>

    <!-- Summary -->
    <section class="imp-stats" :aria-label="t('importView.summaryLabel')" :aria-busy="loading ? 'true' : 'false'">
      <article class="imp-stat imp-stat--blue">
        <div class="imp-stat__head">
          <h2 class="imp-stat__label">{{ t('importView.statCurrent') }}</h2>
          <span class="imp-stat__icon imp-stat__icon--blue"><i class="pi pi-verified" aria-hidden="true" /></span>
        </div>
        <p class="imp-stat__value">{{ loading && !items.length ? '…' : summary.current }}</p>
        <p class="imp-stat__hint">{{ t('importView.statCurrentHint') }}</p>
      </article>
      <article class="imp-stat imp-stat--green">
        <div class="imp-stat__head">
          <h2 class="imp-stat__label">{{ t('importView.statAi') }}</h2>
          <span class="imp-stat__icon imp-stat__icon--green"><i class="pi pi-sparkles" aria-hidden="true" /></span>
        </div>
        <p class="imp-stat__value">{{ loading && !items.length ? '…' : summary.aiUsed }}</p>
        <p class="imp-stat__hint">{{ t('importView.statAiHint', { n: summary.aiReady }, summary.aiReady) }}</p>
      </article>
      <article class="imp-stat imp-stat--amber">
        <div class="imp-stat__head">
          <h2 class="imp-stat__label">{{ t('importView.statInactive') }}</h2>
          <span class="imp-stat__icon imp-stat__icon--amber"><i class="pi pi-history" aria-hidden="true" /></span>
        </div>
        <p class="imp-stat__value">{{ loading && !items.length ? '…' : summary.inactive }}</p>
        <p class="imp-stat__hint">
          {{ t('importView.statSupersededCount', { n: summary.superseded }, summary.superseded) }}
          · {{ t('importView.statArchivedCount', { n: summary.archived }, summary.archived) }}
        </p>
      </article>
      <article class="imp-stat imp-stat--orange">
        <div class="imp-stat__head">
          <h2 class="imp-stat__label">{{ t('importView.statStorage') }}</h2>
          <span class="imp-stat__icon imp-stat__icon--orange"><i class="pi pi-database" aria-hidden="true" /></span>
        </div>
        <p class="imp-stat__value">{{ loading && !items.length ? '…' : formatBytes(summary.bytes) }}</p>
        <p class="imp-stat__hint">{{ t('importView.statStorageHint', { n: summary.total }, summary.total) }}</p>
      </article>
    </section>

    <LoadErrorRetry
      v-if="loadError && !loading"
      :message="t('importView.loadError')"
      :loading="loading"
      @retry="loadList"
    />

    <div class="imp-layout">
      <!-- Folders -->
      <aside class="imp-card imp-folders" aria-labelledby="imp-folders-title">
        <div class="imp-card__head">
          <h2 id="imp-folders-title" class="imp-card__title">{{ t('importView.folderSectionTitle') }}</h2>
          <button
            type="button"
            class="imp-icon-btn"
            :aria-label="t('importView.newFolder')"
            :title="t('importView.newFolder')"
            :disabled="isSavingFolder"
            @click="openFolderModal()"
          >
            <i class="pi pi-plus" aria-hidden="true" />
          </button>
        </div>

        <p v-if="loading && !folders.length" class="imp-status" role="status">{{ t('importView.loading') }}</p>

        <ul class="imp-folder-list" role="list">
          <li
            v-for="folder in folders"
            :key="folder.id"
            class="imp-folder"
            :class="{
              'is-selected': selectedFolderId === folder.id,
              'is-drop': dropFolderId === folder.id,
              'bf-fresh': isFresh('folder', folder.id),
            }"
            @dragover="onFolderDragOver($event, folder)"
            @dragleave="onFolderDragLeave(folder)"
            @drop="onFolderDrop($event, folder)"
          >
            <button
              type="button"
              class="imp-folder__main"
              :aria-current="selectedFolderId === folder.id ? 'true' : undefined"
              :aria-label="`${folderDisplayName(folder)} · ${t('importView.folderFilesCount', { n: folderFileCount(folder) }, folderFileCount(folder))}`"
              @click="selectFolder(folder)"
            >
              <span
                class="imp-folder__icon"
                :class="{ 'is-ai': isContextFolder(folder) }"
                aria-hidden="true"
              >
                <i class="pi" :class="folderIcon(folder)" />
              </span>
              <span class="imp-folder__text">
                <span class="imp-folder__name">
                  {{ folderDisplayName(folder) }}
                  <span v-if="isContextFolder(folder)" class="imp-pill imp-pill--green imp-pill--xs">
                    {{ t('importView.contextFolderBadge') }}
                  </span>
                </span>
                <span class="imp-folder__meta" :class="{ 'is-ai': isContextFolder(folder) }">
                  {{
                    isContextFolder(folder)
                      ? t('importView.contextFolderMeta')
                      : isHomeFolder(folder)
                        ? t('importView.homeFolderMeta')
                        : t('importView.customFolderMeta')
                  }}
                </span>
              </span>
              <span class="imp-folder__count" aria-hidden="true">{{ folderFileCount(folder) }}</span>
            </button>
            <div v-if="!isSystemFolder(folder)" class="imp-folder__actions">
              <button
                type="button"
                class="imp-action"
                :aria-label="t('importView.editFolderAria', { name: folder.name })"
                :title="t('importView.editAction')"
                :disabled="isSavingFolder"
                @click="openFolderModal(folder)"
              >
                <i class="pi pi-pencil" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="imp-action imp-action--danger"
                :aria-label="t('importView.deleteFolderAria', { name: folder.name })"
                :title="t('importView.discard')"
                :disabled="deletingFolderId === folder.id"
                @click="askDeleteFolder(folder)"
              >
                <i class="pi pi-trash" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ul>

        <p class="imp-folders__note">
          <i class="pi pi-info-circle" aria-hidden="true" />
          {{ t('importView.moveHint') }}
        </p>
      </aside>

      <div class="imp-main">
        <!-- Dropzone -->
        <section class="imp-upload" :aria-label="t('importView.uploadSectionTitle')">
          <div
            class="imp-drop"
            :class="{ 'is-drag': isDragging, 'is-busy': uploading }"
            role="button"
            tabindex="0"
            :aria-busy="uploading ? 'true' : 'false'"
            :aria-label="`${t('importView.dropTitleLong')}. ${t('importView.uploadToFolderHint', { name: folderDisplayName(selectedFolder) })}`"
            @click="openFilePicker"
            @keydown.enter.prevent="openFilePicker"
            @keydown.space.prevent="openFilePicker"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <span class="imp-drop__icon" aria-hidden="true">
              <i class="pi" :class="uploading ? 'pi-spin pi-spinner' : 'pi-cloud-upload'" />
            </span>
            <div class="imp-drop__text">
              <p class="imp-drop__title">
                {{ uploading ? t('importView.uploadingFiles') : t('importView.dropTitleLong') }}
              </p>
              <p class="imp-drop__hint">
                {{ t('importView.uploadToFolderHint', { name: folderDisplayName(selectedFolder) }) }}
                · {{ t('importView.dropMeta', { size: maxSizeLabel }) }}
              </p>
            </div>
            <span class="imp-btn imp-drop__btn" aria-hidden="true">
              <i class="pi pi-paperclip" />
              {{ t('importView.chooseFiles') }}
            </span>
            <input
              ref="fileInputRef"
              type="file"
              class="imp-drop__input"
              multiple
              tabindex="-1"
              aria-hidden="true"
              accept=".pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,text/csv,application/json,image/png,image/jpeg,image/webp"
              @change="onFileInputChange"
            />
          </div>

          <p v-if="uploadError" class="imp-alert" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true" />
            <span>{{ uploadError }}</span>
            <button
              type="button"
              class="imp-alert__close"
              :aria-label="t('importView.dismissError')"
              @click="uploadError = ''"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </p>
        </section>

        <!-- Documents -->
        <section class="imp-card imp-docs" aria-labelledby="imp-docs-title">
          <div class="imp-docs__head">
            <span
              class="imp-folder__icon"
              :class="{ 'is-ai': isContextFolder(selectedFolder) }"
              aria-hidden="true"
            >
              <i
                class="pi"
                :class="isHomeFolder(selectedFolder) ? 'pi-inbox' : isContextFolder(selectedFolder) ? 'pi-sparkles' : 'pi-folder-open'"
              />
            </span>
            <div class="imp-docs__head-text">
              <h2 id="imp-docs-title" class="imp-card__title">
                {{ folderDisplayName(selectedFolder) }}
                <span class="imp-count">{{ visibleItems.length }}</span>
              </h2>
              <p class="imp-docs__hint">
                {{ isContextFolder(selectedFolder) ? t('importView.contextFolderHint') : t('importView.folderHint') }}
              </p>
            </div>
          </div>

          <div v-if="visibleItems.length" class="imp-toolbar">
            <label class="imp-search">
              <i class="pi pi-search" aria-hidden="true" />
              <span class="visually-hidden">{{ t('importView.searchLabel') }}</span>
              <input
                v-model="searchQuery"
                type="search"
                :placeholder="t('importView.searchPlaceholder')"
                autocomplete="off"
              />
            </label>
            <div class="imp-filters" v-bf-seg role="group" :aria-label="t('importView.filterStatusLabel')">
              <button
                v-for="opt in statusFilterOptions"
                :key="opt.key"
                type="button"
                class="imp-filter"
                :class="{ 'is-active': statusFilter === opt.key }"
                :aria-pressed="statusFilter === opt.key ? 'true' : 'false'"
                @click="statusFilter = opt.key"
              >
                {{ opt.label }}
                <span class="imp-filter__count">{{ opt.count }}</span>
              </button>
            </div>
            <div class="imp-filters imp-filters--type" v-bf-seg role="group" :aria-label="t('importView.filterTypeLabel')">
              <button
                v-for="opt in typeFilterOptions"
                :key="opt.key"
                type="button"
                class="imp-filter imp-filter--soft"
                :class="{ 'is-active': typeFilter === opt.key }"
                :aria-pressed="typeFilter === opt.key ? 'true' : 'false'"
                @click="typeFilter = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <p v-if="loading && !items.length" class="imp-status" role="status">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            {{ t('importView.loading') }}
          </p>

          <div v-else-if="!visibleItems.length && !loadError" class="imp-empty">
            <span class="imp-empty__icon"><i class="pi pi-file" aria-hidden="true" /></span>
            <p class="imp-empty__text">{{ t('importView.emptyFolder') }}</p>
            <p class="imp-empty__hint">{{ t('importView.emptyFolderHint') }}</p>
            <button type="button" class="imp-btn imp-btn--primary" :disabled="uploading" @click="openFilePicker">
              <i class="pi pi-upload" aria-hidden="true" />
              {{ t('importView.uploadDocument') }}
            </button>
          </div>

          <div v-else-if="!filteredItems.length && visibleItems.length" class="imp-empty">
            <span class="imp-empty__icon"><i class="pi pi-filter-slash" aria-hidden="true" /></span>
            <p class="imp-empty__text">{{ t('importView.emptyFiltered') }}</p>
            <button v-if="hasActiveFilters" type="button" class="imp-btn" @click="clearFilters">
              {{ t('importView.clearFilters') }}
            </button>
          </div>

          <div v-else-if="filteredItems.length" class="imp-list">
            <div class="imp-list__cols" aria-hidden="true">
              <span>{{ t('importView.colDocument') }}</span>
              <span>{{ t('importView.colType') }}</span>
              <span>{{ t('importView.colStatus') }}</span>
              <span>{{ t('importView.colAi') }}</span>
              <span class="is-actions">{{ t('importView.colActions') }}</span>
            </div>

            <section
              v-for="group in groupedByDate"
              :key="group.dateKey"
              class="imp-group"
              :aria-label="group.label"
            >
              <h3 class="imp-group__title">
                <span class="imp-group__label">{{ group.label }}</span>
                <span class="imp-group__count">
                  {{ t('importView.filesInDay', { n: group.items.length }, group.items.length) }}
                </span>
              </h3>
              <ul class="imp-rows" role="list">
                <li
                  v-for="file in group.items"
                  :key="file.id"
                  class="imp-row"
                  :class="{
                    'is-dragging': draggingFileId === file.id,
                    'is-inactive': documentStatusOf(file) !== 'PUBLISHED',
                    'bf-fresh': isFresh('document', file.id),
                  }"
                  draggable="true"
                  @dragstart="onFileDragStart($event, file)"
                  @dragend="onFileDragEnd"
                >
                  <div class="imp-row__doc">
                    <span class="imp-file-icon" :class="`is-${fileKind(file).tone}`" aria-hidden="true">
                      <i class="pi" :class="fileKind(file).icon" />
                    </span>
                    <div class="imp-row__text">
                      <p class="imp-row__name" :title="file.fileName">{{ file.fileName }}</p>
                      <p class="imp-row__meta">
                        <span class="imp-row__version" :title="t('importView.versionLabel', { n: file.version || 1 })">
                          v{{ file.version || 1 }}
                        </span>
                        <span aria-hidden="true">·</span>
                        {{ formatBytes(file.size) }}
                        <span aria-hidden="true">·</span>
                        <time :datetime="file.uploadedAt" :title="formatDate(file.uploadedAt)">
                          {{ formatTime(file.uploadedAt) }}
                        </time>
                      </p>
                    </div>
                  </div>

                  <div class="imp-row__tags">
                    <span class="imp-row__cell">
                      <span class="imp-pill" :class="`imp-pill--type-${documentTypeOf(file)}`">
                        {{ documentTypeLabel(file.documentType) }}
                      </span>
                    </span>
                    <span class="imp-row__cell">
                      <span class="imp-pill" :class="`imp-pill--status-${documentStatusOf(file)}`">
                        <span class="imp-pill__dot" aria-hidden="true" />
                        {{ documentStatusLabel(file) }}
                      </span>
                    </span>
                    <span class="imp-row__cell">
                      <span class="imp-ai" :class="`is-${aiStateOf(file)}`">
                        <i class="pi" :class="aiStateIcon(aiStateOf(file))" aria-hidden="true" />
                        {{ aiStateLabel(aiStateOf(file)) }}
                      </span>
                    </span>
                  </div>

                  <div class="imp-row__actions">
                    <button
                      v-if="file.id"
                      type="button"
                      class="imp-action"
                      :aria-label="t('importView.downloadAria', { name: file.fileName })"
                      :data-tip="t('importView.download')"
                      :disabled="downloadingId === file.id"
                      @click="onDownload(file)"
                    >
                      <i class="pi" :class="downloadingId === file.id ? 'pi-spin pi-spinner' : 'pi-download'" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="imp-action imp-action--blue"
                      :aria-label="t('importView.documentActionAria', { name: file.fileName })"
                      :data-tip="t('importView.documentAction')"
                      :disabled="docSaving"
                      @click="openDocModal(file)"
                    >
                      <i class="pi pi-verified" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="imp-action"
                      :aria-label="t('importView.renameAria', { name: file.fileName })"
                      :data-tip="t('importView.renameAction')"
                      :disabled="isSavingName"
                      @click="openEditModal(file)"
                    >
                      <i class="pi pi-pencil" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="imp-action imp-action--danger"
                      :aria-label="t('importView.deleteAria', { name: file.fileName })"
                      :data-tip="t('importView.discard')"
                      :disabled="deletingId === file.id"
                      @click="askDeleteFile(file)"
                    >
                      <i class="pi pi-trash" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </section>

        <p class="imp-footnote" role="note">
          {{ t('importView.maxSizeHint', { size: maxSizeLabel }) }}
        </p>
      </div>
    </div>

    <!-- Rename document -->
    <Dialog
      :visible="isEditModalOpen"
      modal
      :header="t('importView.editModalTitle')"
      class="imp-dialog"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
      :closable="!isSavingName"
      @update:visible="(open) => { if (!open) closeEditModal() }"
    >
      <form id="imp-edit-form" class="imp-form" novalidate @submit.prevent="onSaveFileName">
        <div class="imp-field">
          <label for="imp-edit-name">{{ t('importView.fileNameLabel') }}</label>
          <InputText
            id="imp-edit-name"
            v-model="editFileName"
            autofocus
            @focus="$event.target.select()"
            maxlength="180"
            :disabled="isSavingName"
            :invalid="Boolean(editError)"
            :aria-invalid="Boolean(editError)"
            aria-describedby="imp-edit-error"
            fluid
          />
          <small v-if="editError" id="imp-edit-error" class="imp-field__error" role="alert">{{ editError }}</small>
        </div>
      </form>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="isSavingName ? t('importView.savingAction') : t('importView.saveAction')"
          :stagger="false"
          :loading="isSavingName"
          :disabled="isSavingName"
          :cancel-disabled="isSavingName"
          @cancel="closeEditModal"
          @confirm="onSaveFileName"
        />
      </template>
    </Dialog>

    <!-- Document type and validity -->
    <Dialog
      :visible="docCandidate != null"
      modal
      :header="t('importView.documentModalTitle')"
      class="imp-dialog"
      :style="{ width: 'min(34rem, 94vw)' }"
      :draggable="false"
      :closable="!docSaving"
      @update:visible="(open) => { if (!open) closeDocModal() }"
    >
      <div v-if="docCandidate" class="imp-form">
        <div class="imp-doc-card">
          <span class="imp-file-icon" :class="`is-${fileKind(docCandidate).tone}`" aria-hidden="true">
            <i class="pi" :class="fileKind(docCandidate).icon" />
          </span>
          <div class="imp-doc-card__text">
            <p class="imp-doc-card__name">{{ docCandidate.fileName }}</p>
            <p class="imp-doc-card__meta">
              <span>{{ t('importView.versionLabel', { n: docCandidate.version || 1 }) }}</span>
              <span class="imp-pill" :class="`imp-pill--status-${documentStatusOf(docCandidate)}`">
                <span class="imp-pill__dot" aria-hidden="true" />
                {{ documentStatusLabel(docCandidate) }}
              </span>
            </p>
          </div>
        </div>

        <div class="imp-field">
          <label for="imp-doc-type">{{ t('importView.documentTypeLabel') }}</label>
          <Select
            v-model="docType"
            input-id="imp-doc-type"
            :options="docTypeOptions"
            option-label="label"
            option-value="value"
            :disabled="docSaving"
            fluid
          />
        </div>
        <div v-if="supersedeOptions.length" class="imp-field">
          <label for="imp-doc-supersedes">{{ t('importView.supersedesLabel') }}</label>
          <Select
            v-model="docSupersedesId"
            input-id="imp-doc-supersedes"
            :options="supersedeSelectOptions"
            option-label="label"
            option-value="value"
            :disabled="docSaving"
            fluid
          />
        </div>
        <p class="imp-form__note">
          <i class="pi pi-sparkles" aria-hidden="true" />
          {{ t('importView.documentCurrentHint') }}
        </p>
        <div v-if="documentStatusOf(docCandidate) === 'PUBLISHED'" class="imp-archive">
          <div class="imp-archive__text">
            <p class="imp-archive__title">{{ t('importView.archiveTitle') }}</p>
            <p class="imp-archive__hint">{{ t('importView.archiveHint') }}</p>
          </div>
          <button
            type="button"
            class="imp-archive__btn"
            :disabled="docSaving"
            @click="runDocAction('archive')"
          >
            <i class="pi pi-box" aria-hidden="true" />
            {{ t('importView.archiveAction') }}
          </button>
        </div>
        <p v-if="docError" class="imp-form__error" role="alert">{{ docError }}</p>
      </div>
      <template #footer>
        <div v-if="docCandidate" class="imp-doc-actions">
          <button type="button" class="bf-btn bf-btn--cancel" :disabled="docSaving" @click="closeDocModal">
            {{ t('app.cancelAction') }}
          </button>
          <button type="button" class="bf-btn bf-btn--cancel" :disabled="docSaving" @click="runDocAction('type', $event)">
            <span>{{ t('importView.saveTypeAction') }}</span>
          </button>
          <button
            v-if="documentStatusOf(docCandidate) !== 'PUBLISHED' || docSupersedesId"
            type="button"
            class="bf-btn bf-btn--confirm"
            :disabled="docSaving"
            @click="runDocAction('publish', $event)"
          >
            <span v-if="docSaving" class="bf-btn__spinner" aria-hidden="true" />
            <i v-else class="pi pi-check" aria-hidden="true" />
            <span>{{ docSupersedesId ? t('importView.publishVersionAction') : t('importView.publishAction') }}</span>
          </button>
        </div>
      </template>
    </Dialog>

    <!-- New / edit folder -->
    <Dialog
      :visible="isFolderModalOpen"
      modal
      :header="folderCandidate ? t('importView.editFolderModalTitle') : t('importView.addFolderModalTitle')"
      class="imp-dialog"
      :style="{ width: 'min(26rem, 94vw)' }"
      :draggable="false"
      :closable="!isSavingFolder"
      @update:visible="(open) => { if (!open) closeFolderModal() }"
    >
      <form class="imp-form" novalidate @submit.prevent="onSaveFolder">
        <div class="imp-field">
          <label for="imp-folder-name">{{ t('importView.folderNameLabel') }}</label>
          <InputText
            id="imp-folder-name"
            v-model="folderName"
            autofocus
            @focus="$event.target.select()"
            maxlength="80"
            :disabled="isSavingFolder"
            :invalid="Boolean(folderModalError)"
            :aria-invalid="Boolean(folderModalError)"
            aria-describedby="imp-folder-error"
            fluid
          />
          <small v-if="folderModalError" id="imp-folder-error" class="imp-field__error" role="alert">
            {{ folderModalError }}
          </small>
        </div>
      </form>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="isSavingFolder ? t('importView.savingAction') : t('importView.saveAction')"
          :stagger="false"
          :loading="isSavingFolder"
          :disabled="isSavingFolder"
          :cancel-disabled="isSavingFolder"
          @cancel="closeFolderModal"
          @confirm="onSaveFolder"
        />
      </template>
    </Dialog>

    <!-- Confirm delete -->
    <Dialog
      :visible="pendingDelete != null"
      modal
      :header="pendingDelete?.kind === 'folder' ? t('importView.deleteFolderModalTitle') : t('importView.deleteModalTitle')"
      class="imp-dialog"
      :style="{ width: 'min(24rem, 94vw)' }"
      :draggable="false"
      :closable="!deletingPending"
      @update:visible="(open) => { if (!open) closeDelete() }"
    >
      <p class="imp-delete__text">
        {{
          pendingDelete?.kind === 'folder'
            ? t('importView.deleteFolderConfirm', { name: pendingDelete?.item?.name })
            : t('importView.deleteConfirm', { name: pendingDelete?.item?.fileName })
        }}
      </p>
      <p class="imp-delete__hint">
        {{
          pendingDelete?.kind === 'folder'
            ? t('importView.deleteFolderHint', { home: t('importView.homeFolderName') })
            : t('importView.deleteHint')
        }}
      </p>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('app.cancelAction')"
          :confirm-label="t('importView.discard')"
          confirm-variant="danger"
          :stagger="false"
          :loading="deletingPending"
          @cancel="closeDelete"
          @confirm="confirmDelete"
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

.imp {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.imp *,
.imp *::before,
.imp *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.imp-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.imp-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.imp-btn {
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

.imp-btn .pi {
  font-size: 0.78rem;
}

.imp-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.imp-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.imp-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.imp-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.imp-btn:focus-visible,
.imp-icon-btn:focus-visible,
.imp-action:focus-visible,
.imp-filter:focus-visible,
.imp-folder__main:focus-visible,
.imp-drop:focus-visible,
.imp-alert__close:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.imp-icon-btn {
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.78rem;
  flex-shrink: 0;
}

.imp-icon-btn:hover:not(:disabled) {
  background: #e8eefc;
}

.imp-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.75rem 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

/* ---------- Summary ---------- */
.imp-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}

.imp-stat {
  background: var(--stat-bg, #f1f5f9);
  border-radius: 16px;
  padding: 1rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.imp-stat--blue { --stat-bg: #e8eefc; }
.imp-stat--green { --stat-bg: #e3f4e8; }
.imp-stat--amber { --stat-bg: #fdf3dc; }
.imp-stat--orange { --stat-bg: #fdeee2; }

.imp-stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}

.imp-stat__label {
  margin: 0;
  color: #475569;
  font-weight: 600;
  font-size: 0.8rem;
}

.imp-stat__icon {
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

.imp-stat__icon--blue { color: #1e3a8a; }
.imp-stat__icon--green { color: #15803d; }
.imp-stat__icon--amber { color: #b45309; }
.imp-stat__icon--orange { color: #c2410c; }

.imp-stat__value {
  margin: 0 0 0.4rem;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.65rem;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.imp-stat__hint {
  margin: auto 0 0;
  color: #6e6e73;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.35;
}

/* ---------- Layout ---------- */
.imp-layout {
  display: grid;
  grid-template-columns: minmax(14rem, 16.5rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
  min-width: 0;
}

.imp-main {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.imp-card {
  padding: 1.1rem 1.25rem 1.15rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.imp-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.imp-card__title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
  min-width: 0;
}

.imp-count {
  min-width: 1.5rem;
  padding: 0.08rem 0.45rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.72rem;
  font-weight: 700;
  text-align: center;
  font-family: inherit;
  letter-spacing: 0;
}

/* ---------- Folders ---------- */
.imp-folders {
  position: sticky;
  top: 1rem;
  padding: 1rem 0.85rem 0.9rem;
}

.imp-folders .imp-card__head {
  padding: 0 0.35rem;
}

.imp-folder-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.imp-folder {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 12px;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.imp-folder:hover {
  background: #f8fafc;
}

.imp-folder.is-selected {
  background: #e8eefc;
}

.imp-folder.is-drop {
  border-color: #1e3a8a;
  border-style: dashed;
  background: #e8eefc;
}

.imp-folder__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.6rem;
  border: none;
  border-radius: 12px;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: inherit;
}

.imp-folder__icon {
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.85rem;
}

.imp-folder.is-selected .imp-folder__icon {
  background: #fff;
  color: #1e3a8a;
}

.imp-folder__icon.is-ai {
  background: #e3f4e8;
  color: #15803d;
}

.imp-folder.is-selected .imp-folder__icon.is-ai {
  background: #fff;
}

.imp-folder__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.imp-folder__name {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.86rem;
  font-weight: 650;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.imp-folder__meta {
  font-size: 0.72rem;
  color: #6e6e73;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.imp-folder__meta.is-ai {
  color: #15803d;
}

.imp-folder__count {
  flex-shrink: 0;
  min-width: 1.5rem;
  padding: 0.08rem 0.45rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.imp-folder.is-selected .imp-folder__count {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.imp-folder__actions {
  display: flex;
  gap: 0.1rem;
  padding-right: 0.3rem;
}

.imp-folder__actions .imp-action {
  width: 1.85rem;
  height: 1.85rem;
  font-size: 0.75rem;
}

.imp-folders__note {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0.85rem 0.35rem 0;
  padding-top: 0.75rem;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.imp-folders__note .pi {
  margin-top: 0.12rem;
  font-size: 0.72rem;
  color: #94a3b8;
}

/* ---------- Dropzone ---------- */
.imp-upload {
  min-width: 0;
}

.imp-drop {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 1rem 1.1rem;
  border-radius: 14px;
  border: 1.5px dashed rgba(30, 58, 138, 0.28);
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.imp-drop:hover {
  border-color: rgba(30, 58, 138, 0.5);
  background: #f3f6fd;
}

.imp-drop.is-drag {
  border-color: #1e3a8a;
  background: #e8eefc;
}

.imp-drop.is-busy {
  pointer-events: none;
  opacity: 0.85;
}

.imp-drop__icon {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 12px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  color: #1e3a8a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15rem;
}

.imp-drop__text {
  flex: 1;
  min-width: 0;
}

.imp-drop__title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 650;
  color: #0f172a;
}

.imp-drop__hint {
  margin: 0.2rem 0 0;
  font-size: 0.76rem;
  line-height: 1.4;
  color: #6e6e73;
}

.imp-drop__btn {
  flex-shrink: 0;
  pointer-events: none;
}

.imp-drop__input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.imp-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.65rem 0 0;
  padding: 0.6rem 0.5rem 0.6rem 0.8rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
  line-height: 1.4;
}

.imp-alert > .pi {
  margin-top: 0.15rem;
  font-size: 0.8rem;
  color: #b42318;
}

.imp-alert > span {
  flex: 1;
  min-width: 0;
}

.imp-alert__close {
  flex-shrink: 0;
  width: 1.6rem;
  height: 1.6rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #7f1d1d;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.7rem;
}

.imp-alert__close:hover {
  background: rgba(255, 255, 255, 0.6);
}

/* ---------- Documents ---------- */
.imp-docs__head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 0.9rem;
}

.imp-docs__head .imp-folder__icon {
  width: 2.4rem;
  height: 2.4rem;
  background: #e8eefc;
  color: #1e3a8a;
}

.imp-docs__head .imp-folder__icon.is-ai {
  background: #e3f4e8;
  color: #15803d;
}

.imp-docs__head-text {
  min-width: 0;
  flex: 1;
}

.imp-docs__hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #6e6e73;
}

.imp-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 0.75rem;
  margin-bottom: 0.9rem;
}

.imp-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 14rem;
  min-width: 0;
  max-width: 20rem;
}

.imp-search .pi {
  position: absolute;
  left: 0.85rem;
  font-size: 0.8rem;
  color: #94a3b8;
  pointer-events: none;
}

.imp-search input {
  width: 100%;
  min-height: 2.35rem;
  padding: 0.45rem 0.85rem 0.45rem 2.2rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  font: inherit;
  font-size: 0.82rem;
  color: #0f172a;
}

.imp-search input:focus {
  outline: 2px solid #1e3a8a;
  outline-offset: 1px;
  border-color: transparent;
}

.imp-filters {
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

.imp-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.45rem 0.4rem 0.8rem;
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

.imp-filter--soft {
  padding-right: 0.8rem;
}

.imp-filter:hover:not(.is-active) {
  color: #0f172a;
}

.imp-filter__count {
  min-width: 1.35rem;
  padding: 0.03rem 0.38rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.68rem;
  font-weight: 700;
  text-align: center;
}

.imp-filter.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.imp-filter.is-active .imp-filter__count {
  background: #f1f5f9;
  color: #0f172a;
}

.imp-list {
  --cols: minmax(0, 1fr) 6.75rem 7rem 8.75rem 8.75rem;
}

.imp-list__cols {
  display: grid;
  grid-template-columns: var(--cols);
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  border-radius: 10px;
  background: #f8fafc;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
}

.imp-list__cols .is-actions {
  text-align: right;
}

.imp-group + .imp-group {
  margin-top: 0.35rem;
}

.imp-group__title {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  padding: 0.85rem 0.75rem 0.35rem;
  font-size: 0.76rem;
  font-weight: 650;
  color: #0f172a;
}

.imp-group__label::first-letter {
  text-transform: uppercase;
}

.imp-group__count {
  font-weight: 500;
  color: #94a3b8;
}

.imp-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.imp-row {
  display: grid;
  grid-template-columns: var(--cols);
  align-items: center;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  cursor: grab;
}

.imp-row:last-child {
  border-bottom: none;
}

.imp-row:hover {
  background: #fafbfd;
}

.imp-row.is-dragging {
  opacity: 0.45;
}

.imp-row.is-inactive .imp-row__name {
  color: #475569;
}

.imp-row__doc {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}

.imp-file-icon {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.95rem;
  background: #f1f5f9;
  color: #475569;
}

.imp-file-icon.is-red { background: #fde4e4; color: #b42318; }
.imp-file-icon.is-blue { background: #e8eefc; color: #1e3a8a; }
.imp-file-icon.is-green { background: #e3f4e8; color: #15803d; }
.imp-file-icon.is-amber { background: #fdf3dc; color: #b45309; }

.imp-row__text {
  min-width: 0;
}

.imp-row__name {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 650;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.imp-row__meta {
  margin: 0.1rem 0 0;
  display: flex;
  gap: 0.35rem;
  white-space: nowrap;
  overflow: hidden;
  font-size: 0.74rem;
  color: #6e6e73;
  font-variant-numeric: tabular-nums;
}

.imp-row__tags {
  display: contents;
}

.imp-row__cell {
  min-width: 0;
}

.imp-row__version {
  font-weight: 650;
  color: #334155;
}

.imp-row__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.1rem;
}

/* Pills */
.imp-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
  line-height: 1.35;
}

.imp-pill--xs {
  padding: 0.05rem 0.42rem;
  font-size: 0.64rem;
}

.imp-pill--green { background: #e3f4e8; color: #166534; }

.imp-pill--type-REGULATION { background: #e8eefc; color: #1e3a8a; }
.imp-pill--type-MINUTES { background: #fdeee2; color: #9a3412; }
.imp-pill--type-OTHER { background: #f1f5f9; color: #334155; }

.imp-pill__dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.imp-pill--status-PUBLISHED { background: #e3f4e8; color: #166534; }
.imp-pill--status-SUPERSEDED { background: #fdf3dc; color: #92400e; }
.imp-pill--status-ARCHIVED { background: #f1f5f9; color: #475569; }
.imp-pill--status-PENDING_UPLOAD { background: #fdeee2; color: #9a3412; }

.imp-ai {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
  white-space: nowrap;
}

.imp-ai .pi {
  font-size: 0.72rem;
}

.imp-ai.is-ready { color: #15803d; }
.imp-ai.is-pending,
.imp-ai.is-queued { color: #b45309; }
.imp-ai.is-failed { color: #b42318; }
.imp-ai.is-off { color: #94a3b8; font-weight: 500; }

/* Row actions with a tooltip */
.imp-action {
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
  flex-shrink: 0;
}

.imp-action:hover:not(:disabled) {
  background: #f1f5f9;
  color: #0f172a;
}

.imp-action--blue {
  color: #1e3a8a;
}

.imp-action--blue:hover:not(:disabled) {
  background: #e8eefc;
  color: #1e3a8a;
}

.imp-action--danger {
  color: #b42318;
}

.imp-action--danger:hover:not(:disabled) {
  background: #fde4e4;
  color: #b42318;
}

.imp-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.imp-action[data-tip]::after {
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

.imp-row__actions .imp-action:last-child[data-tip]::after {
  left: auto;
  right: 0;
  transform: none;
}

.imp-action[data-tip]:hover::after,
.imp-action[data-tip]:focus-visible::after {
  opacity: 1;
}

/* Empty state */
.imp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.imp-empty__icon {
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

.imp-empty__text {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: #334155;
}

.imp-empty__hint {
  margin: 0 0 0.35rem;
  max-width: 26rem;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #6e6e73;
}

.imp-footnote {
  margin: 0;
  text-align: center;
  font-size: 0.72rem;
  color: #94a3b8;
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
@media (max-width: 1280px) {
  .imp-list {
    --cols: minmax(0, 1fr) 6.5rem 6.75rem 8.5rem 8.75rem;
  }
}

@media (max-width: 1100px) {
  .imp-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .imp-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .imp-folders {
    position: static;
  }

  .imp-folder-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  }

  .imp-folders__note {
    display: none;
  }
}

@media (max-width: 900px) {
  .imp-list__cols {
    display: none;
  }

  .imp-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.55rem 0.5rem;
    padding: 0.75rem 0.25rem;
  }

  .imp-row__doc {
    grid-column: 1;
    grid-row: 1;
  }

  .imp-row__actions {
    grid-column: 2;
    grid-row: 1;
  }

  .imp-row__tags {
    grid-column: 1 / -1;
    grid-row: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.55rem;
    padding-left: 3.2rem;
  }

  .imp-group__title {
    padding-inline: 0.25rem;
  }
}

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }

  .imp-head__actions {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .imp-head__actions .imp-btn {
    white-space: normal;
    text-align: center;
    line-height: 1.2;
    padding-inline: 0.6rem;
  }

  .imp-stats {
    gap: 0.55rem;
  }

  .imp-stat {
    padding: 0.8rem 0.85rem 0.85rem;
  }

  .imp-stat__value {
    font-size: 1.35rem;
  }

  .imp-stat__icon {
    width: 1.75rem;
    height: 1.75rem;
    font-size: 0.75rem;
  }

  .imp-card {
    padding: 1rem 0.85rem;
  }

  .imp-drop {
    flex-wrap: wrap;
    padding: 0.9rem;
  }

  .imp-drop__btn {
    display: none;
  }

  .imp-folder-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .imp-search {
    max-width: none;
    flex-basis: 100%;
  }

  .imp-row {
    padding: 0.8rem 0.8rem;
    margin-bottom: 0.5rem;
    border: 1px solid rgba(15, 23, 42, 0.08);
    border-radius: 16px;
    background: #fff;
  }

  .imp-row:last-child {
    border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  }

  .imp-row__tags {
    padding-left: 0;
    padding-top: 0.55rem;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
  }

  .imp-row__actions {
    gap: 0;
    align-self: start;
  }

  .imp-row__name {
    white-space: normal;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .imp-row__meta {
    flex-wrap: wrap;
    white-space: normal;
    row-gap: 0;
  }

  .imp-row__actions .imp-action {
    width: 1.95rem;
    height: 1.95rem;
  }

  .imp-action[data-tip]::after {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .imp-btn,
  .imp-drop,
  .imp-folder,
  .imp-action[data-tip]::after {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.imp-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 90vh;
}

.imp-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.imp-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.imp-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.imp-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  gap: 0.5rem;
}

.imp-dialog .imp-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.imp-dialog .imp-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.imp-dialog .imp-field > label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.imp-dialog .imp-field .p-inputtext,
.imp-dialog .imp-field .p-select {
  border-radius: 12px;
}

.imp-dialog .imp-field .p-inputtext {
  min-height: 2.6rem;
}

.imp-dialog .imp-field .p-select-label,
.imp-dialog .imp-field .p-inputtext {
  font-size: 0.9rem;
}

.imp-dialog .imp-field__error {
  font-size: 0.75rem;
  color: #b42318;
}

.imp-dialog .imp-form__error {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

.imp-dialog .imp-form__note {
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

.imp-dialog .imp-form__note .pi {
  margin-top: 0.12rem;
  font-size: 0.75rem;
}

.imp-dialog .imp-doc-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.8rem;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.06);
}

.imp-dialog .imp-doc-card .imp-file-icon {
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.95rem;
  background: #f1f5f9;
  color: #475569;
}

.imp-dialog .imp-file-icon.is-red { background: #fde4e4; color: #b42318; }
.imp-dialog .imp-file-icon.is-blue { background: #e8eefc; color: #1e3a8a; }
.imp-dialog .imp-file-icon.is-green { background: #e3f4e8; color: #15803d; }
.imp-dialog .imp-file-icon.is-amber { background: #fdf3dc; color: #b45309; }

.imp-dialog .imp-doc-card__text {
  min-width: 0;
}

.imp-dialog .imp-doc-card__name {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 650;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.imp-dialog .imp-doc-card__meta {
  margin: 0.25rem 0 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.76rem;
  color: #6e6e73;
}

.imp-dialog .imp-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 650;
  white-space: nowrap;
}

.imp-dialog .imp-pill__dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: currentColor;
}

.imp-dialog .imp-pill--status-PUBLISHED { background: #e3f4e8; color: #166534; }
.imp-dialog .imp-pill--status-SUPERSEDED { background: #fdf3dc; color: #92400e; }
.imp-dialog .imp-pill--status-ARCHIVED { background: #f1f5f9; color: #475569; }
.imp-dialog .imp-pill--status-PENDING_UPLOAD { background: #fdeee2; color: #9a3412; }

.imp-dialog .imp-archive {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
}

.imp-dialog .imp-archive__text {
  flex: 1;
  min-width: 0;
}

.imp-dialog .imp-archive__title {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 650;
  color: #0f172a;
}

.imp-dialog .imp-archive__hint {
  margin: 0.1rem 0 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.imp-dialog .imp-archive__btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.25rem;
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(180, 35, 24, 0.25);
  background: #fff;
  color: #b42318;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.imp-dialog .imp-archive__btn .pi {
  font-size: 0.72rem;
}

.imp-dialog .imp-archive__btn:hover:not(:disabled) {
  background: #fde4e4;
}

.imp-dialog .imp-archive__btn:focus-visible {
  outline: 2px solid #b42318;
  outline-offset: 2px;
}

.imp-dialog .imp-archive__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.imp-dialog .imp-doc-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  width: 100%;
}

.imp-dialog .bf-btn .pi {
  font-size: 0.75rem;
}

.imp-dialog .imp-delete__text {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.imp-dialog .imp-delete__hint {
  margin: 0.7rem 0 0;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #6e6e73;
}

@media (max-width: 480px) {
  .imp-dialog .imp-doc-actions .bf-btn {
    flex: 1 1 calc(50% - 0.5rem);
    padding-inline: 0.75rem;
  }
}
</style>
