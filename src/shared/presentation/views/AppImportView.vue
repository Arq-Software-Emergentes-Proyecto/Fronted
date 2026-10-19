<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import { importUploadsApi, DOCUMENT_TYPES } from '@/communications/infrastructure/importUploadsApi.js'
import { importFoldersApi, isContextFolder, isHomeFolder, isSystemFolder } from '@/communications/infrastructure/importFoldersApi.js'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'

const { t, locale } = useI18n()

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
const editNameInputRef = ref(null)
const folderNameInputRef = ref(null)
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
  return d.toLocaleDateString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
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
  if (isHomeFolder(folder)) return 'pi-home'
  if (isContextFolder(folder)) return 'pi-sparkles'
  return 'pi-folder'
}

const listColumnTitle = computed(() => folderDisplayName(selectedFolder.value))

const groupedByDate = computed(() => {
  const map = new Map()
  for (const row of visibleItems.value) {
    const key = localDateKey(row.uploadedAt)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  const keys = [...map.keys()].sort((a, b) => b.localeCompare(a))
  return keys.map((dateKey) => ({
    dateKey,
    label: dateGroupLabel(dateKey),
    items: map.get(dateKey),
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

function indexingLabel(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'pending' || s === 'indexing') return t('importView.indexingPending')
  if (s === 'failed') return t('importView.indexingFailed')
  if (s === 'done') return t('importView.indexingDone')
  return ''
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
      await importUploadsApi.add({
        file,
        folderId: selectedFolderId.value || homeFolder.value?.id,
      })
    }
    await loadList()
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

async function openEditModal(file) {
  if (!file || isSavingName.value) return
  editCandidate.value = file
  editFileName.value = file.fileName ?? ''
  editError.value = ''
  isEditModalOpen.value = true
  await nextTick()
  editNameInputRef.value?.focus()
  editNameInputRef.value?.select()
}

function closeEditModal() {
  if (isSavingName.value) return
  isEditModalOpen.value = false
  editCandidate.value = null
  editFileName.value = ''
  editError.value = ''
}

async function onSaveFileName() {
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
    items.value = items.value.map((row) =>
      row.id === editCandidate.value.id ? { ...row, fileName: savedName } : row,
    )
    isEditModalOpen.value = false
    editCandidate.value = null
    editFileName.value = ''
  } catch {
    editError.value = t('importView.editError')
  } finally {
    isSavingName.value = false
  }
}

async function openFolderModal(folder = null) {
  if (isSavingFolder.value || isSystemFolder(folder)) return
  folderCandidate.value = folder
  folderName.value = folder?.name ?? ''
  folderModalError.value = ''
  isFolderModalOpen.value = true
  await nextTick()
  folderNameInputRef.value?.focus()
  folderNameInputRef.value?.select()
}

function closeFolderModal() {
  if (isSavingFolder.value) return
  isFolderModalOpen.value = false
  folderCandidate.value = null
  folderName.value = ''
  folderModalError.value = ''
}

async function onSaveFolder() {
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
      const updated = await importFoldersApi.updateName(folderCandidate.value.id, name)
      const savedName = updated?.name || name
      folders.value = folders.value.map((folder) =>
        folder.id === folderCandidate.value.id ? { ...folder, name: savedName } : folder,
      )
    } else {
      const created = await importFoldersApi.add({ name })
      folders.value = sortFolders([created, ...folders.value])
      selectedFolderId.value = created.id
    }
    isFolderModalOpen.value = false
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

/**
 * OfficialDocument (Communications 5.7): type, version and validity. Only PUBLISHED documents are
 * "vigentes" and feed the AI assistant (RF033); publishing a new version supersedes the previous one.
 */
const docCandidate = ref(null)
const docType = ref('OTHER')
const docSupersedesId = ref('')
const docSaving = ref(false)
const docError = ref('')

function documentStatusOf(file) {
  return String(file?.documentStatus ?? 'PUBLISHED').toUpperCase()
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

const supersedeOptions = computed(() =>
  items.value.filter(
    (file) => file.id !== docCandidate.value?.id && documentStatusOf(file) === 'PUBLISHED',
  ),
)

function openDocModal(file) {
  docCandidate.value = file
  docType.value = String(file.documentType ?? 'OTHER').toUpperCase()
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

async function runDocAction(action) {
  const file = docCandidate.value
  if (!file || docSaving.value) return
  docSaving.value = true
  docError.value = ''
  try {
    if (action === 'type') {
      mergeDocRows(await importUploadsApi.setDocumentType(file.id, docType.value))
    } else if (action === 'publish') {
      const result = await importUploadsApi.publish(file.id, {
        supersedesId: docSupersedesId.value || null,
        documentType: docType.value,
      })
      mergeDocRows(result?.document, result?.superseded)
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
  <div class="app-view">
    <div class="finance-page">
      <div class="finance-main-row">
        <article class="finance-panel finance-panel--table import-panel mgmt-col import-col" aria-labelledby="import-folders-heading">
          <section class="import-folders">
            <div class="mgmt-panel-toolbar">
              <h2 id="import-folders-heading" class="finance-panel__section-title">
                <i class="pi pi-folder" aria-hidden="true" />
                {{ t('importView.folderSectionTitle') }}
              </h2>
              <Button
                type="button"
                icon="pi pi-plus"
                class="import-dropzone__btn"
                :label="t('importView.addFolderAction')"
                :disabled="isSavingFolder"
                @click="openFolderModal()"
              />
            </div>

            <ul class="r-list import-folders__list" role="list">
              <li
                v-for="folder in folders"
                :key="folder.id"
                class="r-card"
                :class="{
                  'r-card--selected': selectedFolderId === folder.id,
                  'r-card--drop': dropFolderId === folder.id,
                }"
                @dragover="onFolderDragOver($event, folder)"
                @dragleave="onFolderDragLeave(folder)"
                @drop="onFolderDrop($event, folder)"
              >
                <div
                  class="r-card__row r-card__row--clickable"
                  role="button"
                  tabindex="0"
                  @click="selectFolder(folder)"
                  @keydown.enter.prevent="selectFolder(folder)"
                  @keydown.space.prevent="selectFolder(folder)"
                >
                  <span class="r-card__avatar" aria-hidden="true">
                    <i class="pi" :class="folderIcon(folder)" />
                  </span>
                  <div class="r-card__body">
                    <p class="r-card__name">
                      {{ folderDisplayName(folder) }}
                      <span v-if="isContextFolder(folder)" class="import-ai-badge">{{ t('importView.contextFolderBadge') }}</span>
                    </p>
                    <p class="r-card__meta">
                      {{ t('importView.folderFilesCount', { n: folderFileCount(folder) }) }}
                    </p>
                  </div>
                  <div v-if="!isSystemFolder(folder)" class="r-card__actions" @click.stop @keydown.stop>
                    <button
                      type="button"
                      class="r-card__icon-btn r-card__icon-btn--edit"
                      :title="t('importView.editAction')"
                      :disabled="isSavingFolder"
                      @click="openFolderModal(folder)"
                    >
                      <i class="pi pi-pencil" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="r-card__icon-btn r-card__icon-btn--danger"
                      :title="t('importView.discard')"
                      :disabled="deletingFolderId === folder.id"
                      @click="onDiscardFolder(folder)"
                    >
                      <i class="pi pi-trash" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            </ul>
          </section>

          <section class="import-upload" aria-labelledby="import-upload-heading">
            <div class="mgmt-panel-toolbar">
              <h2 id="import-upload-heading" class="finance-panel__section-title">
                <i class="pi pi-cloud-upload" aria-hidden="true" />
                {{ t('importView.uploadSectionTitle') }}
              </h2>
            </div>

            <div
              class="import-dropzone"
              :class="{ 'import-dropzone--drag': isDragging, 'import-dropzone--busy': uploading }"
              role="button"
              tabindex="0"
              :aria-busy="uploading"
              @click="openFilePicker"
              @keydown.enter.prevent="openFilePicker"
              @keydown.space.prevent="openFilePicker"
              @dragover="onDragOver"
              @dragleave="onDragLeave"
              @drop="onDrop"
            >
              <i class="pi pi-cloud-upload import-dropzone__icon" aria-hidden="true" />
              <p class="import-dropzone__title">{{ t('importView.dropTitle') }}</p>
              <p class="import-dropzone__hint">
                {{
                  t('importView.uploadToFolderHint', {
                    name: folderDisplayName(selectedFolder),
                  })
                }}
              </p>
              <input
                ref="fileInputRef"
                type="file"
                class="import-dropzone__input"
                multiple
                accept=".pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,text/csv,application/json,image/png,image/jpeg,image/webp"
                @change="onFileInputChange"
              />
            </div>

            <p v-if="uploadError" class="import-alert import-alert--error" role="alert">
              {{ uploadError }}
            </p>
          </section>
        </article>

        <article class="finance-panel finance-panel--table import-panel mgmt-col" aria-labelledby="import-list-heading">
          <div class="mgmt-panel-toolbar">
            <h2 id="import-list-heading" class="finance-panel__section-title finance-panel__section-title--folder">
              <i
                class="pi"
                :class="isHomeFolder(selectedFolder) ? 'pi-home' : isContextFolder(selectedFolder) ? 'pi-sparkles' : 'pi-folder-open'"
                aria-hidden="true"
              />
              {{ listColumnTitle }}
            </h2>
            <p v-if="isContextFolder(selectedFolder)" class="import-context-hint">
              {{ t('importView.contextFolderHint') }}
            </p>
          </div>

          <div v-if="loading" class="import-status import-panel-state">
            <i class="pi pi-spin pi-spinner" aria-hidden="true" />
            <span>{{ t('importView.loading') }}</span>
          </div>
          <div v-else-if="loadError" class="import-alert import-alert--error import-panel-state" role="alert">
            <i class="pi pi-exclamation-circle" aria-hidden="true" />
            <span>{{ t('importView.loadError') }}</span>
          </div>
          <div v-else-if="!visibleItems.length" class="import-empty import-panel-state">
            <i class="pi pi-inbox" aria-hidden="true" />
            <span>{{ selectedFolder ? t('importView.emptyFolder') : t('importView.empty') }}</span>
          </div>

          <div v-else class="import-groups">
            <section
              v-for="group in groupedByDate"
              :key="group.dateKey"
              class="import-date-group"
              :aria-label="group.label"
            >
              <header class="import-date-group__header">
                <h3 class="import-date-group__title">{{ group.label }}</h3>
              </header>
              <ul class="r-list" role="list">
                <li
                  v-for="file in group.items"
                  :key="file.id"
                  class="r-card"
                  :class="{ 'r-card--dragging': draggingFileId === file.id }"
                  draggable="true"
                  @dragstart="onFileDragStart($event, file)"
                  @dragend="onFileDragEnd"
                >
                  <div class="r-card__row">
                    <span class="r-card__avatar" aria-hidden="true">
                      <i class="pi pi-file" />
                    </span>
                    <div class="r-card__body">
                      <p class="r-card__name">{{ file.fileName }}</p>
                      <p class="r-card__meta">
                        {{ formatBytes(file.size) }}
                        <span
                          v-if="indexingLabel(file.indexingStatus)"
                          class="r-card__index-status"
                          :data-status="file.indexingStatus"
                        >
                          · {{ indexingLabel(file.indexingStatus) }}
                        </span>
                      </p>
                      <p class="r-card__meta r-card__doc">
                        <span>{{ documentTypeLabel(file.documentType) }}</span>
                        <span v-if="file.version"> · v{{ file.version }}</span>
                        <span
                          class="r-card__doc-status"
                          :data-status="documentStatusOf(file)"
                        >
                          · {{ documentStatusLabel(file) }}
                        </span>
                      </p>
                    </div>
                    <div class="r-card__actions">
                      <button
                        v-if="file.id"
                        type="button"
                        class="r-card__icon-btn r-card__icon-btn--link"
                        :title="t('importView.download')"
                        :disabled="downloadingId === file.id"
                        @click="onDownload(file)"
                      >
                        <i class="pi pi-download" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="r-card__icon-btn"
                        :title="t('importView.documentAction')"
                        :aria-label="t('importView.documentAction')"
                        :disabled="docSaving"
                        @click="openDocModal(file)"
                      >
                        <i class="pi pi-verified" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="r-card__icon-btn r-card__icon-btn--edit"
                        :title="t('importView.editAction')"
                        :disabled="isSavingName"
                        @click="openEditModal(file)"
                      >
                        <i class="pi pi-pencil" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="r-card__icon-btn r-card__icon-btn--danger"
                        :title="t('importView.discard')"
                        :disabled="deletingId === file.id"
                        @click="onDiscard(file.id)"
                      >
                        <i class="pi pi-trash" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </article>
      </div>

      <p class="mgmt-view-footer" role="note">
        {{ t('importView.maxSizeHint', { size: maxSizeLabel }) }}
      </p>
    </div>

    <div
      v-if="isEditModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeEditModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('importView.editModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('importView.editModalTitle') }}</h3>
        <form class="resident-modal__form" @submit.prevent="onSaveFileName">
          <label class="resident-modal__field">
            <span>{{ t('importView.fileNameLabel') }}</span>
            <input
              ref="editNameInputRef"
              v-model="editFileName"
              type="text"
              maxlength="180"
              :disabled="isSavingName"
            />
          </label>
          <p v-if="editError" class="resident-modal__error">{{ editError }}</p>
          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="isSavingName ? t('importView.savingAction') : t('importView.saveAction')"
            confirm-type="submit"
            :stagger="false"
            :loading="isSavingName"
            :disabled="isSavingName"
            :cancel-disabled="isSavingName"
            @cancel="closeEditModal"
          />
        </form>
      </section>
    </div>

    <div
      v-if="docCandidate"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeDocModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('importView.documentModalTitle')"
      >
        <h3 class="resident-modal__title">{{ t('importView.documentModalTitle') }}</h3>
        <div class="resident-modal__form">
          <p class="resident-modal__hint">
            {{ docCandidate.fileName }} · v{{ docCandidate.version || 1 }} · {{ documentStatusLabel(docCandidate) }}
          </p>
          <label class="resident-modal__field">
            <span>{{ t('importView.documentTypeLabel') }}</span>
            <select v-model="docType" :disabled="docSaving">
              <option v-for="type in DOCUMENT_TYPES" :key="type" :value="type">
                {{ documentTypeLabel(type) }}
              </option>
            </select>
          </label>
          <label v-if="supersedeOptions.length" class="resident-modal__field">
            <span>{{ t('importView.supersedesLabel') }}</span>
            <select v-model="docSupersedesId" :disabled="docSaving">
              <option value="">{{ t('importView.supersedesNone') }}</option>
              <option v-for="other in supersedeOptions" :key="other.id" :value="other.id">
                {{ other.fileName }} (v{{ other.version || 1 }})
              </option>
            </select>
          </label>
          <p class="resident-modal__hint">{{ t('importView.documentCurrentHint') }}</p>
          <p v-if="docError" class="resident-modal__error">{{ docError }}</p>
          <div class="import-doc-actions">
            <button type="button" class="bf-btn" :disabled="docSaving" @click="closeDocModal">
              {{ t('app.cancelAction') }}
            </button>
            <button type="button" class="bf-btn" :disabled="docSaving" @click="runDocAction('type')">
              {{ t('importView.saveTypeAction') }}
            </button>
            <button
              v-if="documentStatusOf(docCandidate) === 'PUBLISHED'"
              type="button"
              class="bf-btn bf-btn--danger"
              :disabled="docSaving"
              @click="runDocAction('archive')"
            >
              {{ t('importView.archiveAction') }}
            </button>
            <button
              v-if="documentStatusOf(docCandidate) !== 'PUBLISHED' || docSupersedesId"
              type="button"
              class="bf-btn bf-btn--confirm"
              :disabled="docSaving"
              @click="runDocAction('publish')"
            >
              <span v-if="docSaving" class="bf-btn__spinner" aria-hidden="true" />
              {{ docSupersedesId ? t('importView.publishVersionAction') : t('importView.publishAction') }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <div
      v-if="isFolderModalOpen"
      class="resident-modal-backdrop bf-modal-backdrop"
      role="presentation"
      @click.self="closeFolderModal"
    >
      <section
        class="resident-modal bf-modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="
          folderCandidate ? t('importView.editFolderModalTitle') : t('importView.addFolderModalTitle')
        "
      >
        <h3 class="resident-modal__title">
          {{
            folderCandidate ? t('importView.editFolderModalTitle') : t('importView.addFolderModalTitle')
          }}
        </h3>
        <form class="resident-modal__form" @submit.prevent="onSaveFolder">
          <label class="resident-modal__field">
            <span>{{ t('importView.folderNameLabel') }}</span>
            <input
              ref="folderNameInputRef"
              v-model="folderName"
              type="text"
              maxlength="80"
              :disabled="isSavingFolder"
            />
          </label>
          <p v-if="folderModalError" class="resident-modal__error">{{ folderModalError }}</p>
          <ConfirmActions
            :cancel-label="t('app.cancelAction')"
            :confirm-label="isSavingFolder ? t('importView.savingAction') : t('importView.saveAction')"
            confirm-type="submit"
            :stagger="false"
            :loading="isSavingFolder"
            :disabled="isSavingFolder"
            :cancel-disabled="isSavingFolder"
            @cancel="closeFolderModal"
          />
        </form>
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

.import-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.import-folders {
  flex: 1;
  min-height: 8rem;
  display: flex;
  flex-direction: column;
}

.import-folders__list {
  flex: 1;
  overflow-y: auto;
}

.import-folders__empty {
  flex: 1;
}

.import-ai-badge {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.1rem 0.4rem;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  vertical-align: middle;
  color: #0b3d5c;
  background: rgba(61, 143, 209, 0.18);
  border-radius: 0.25rem;
}

.import-context-hint {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  line-height: 1.35;
  color: rgba(11, 61, 92, 0.72);
}

.import-upload {
  flex-shrink: 0;
  margin-top: 1.15rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

@media (max-width: 1024px) {
  .finance-main-row {
    grid-template-columns: minmax(0, 1fr);
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

.finance-panel__section-title--folder {
  text-transform: none;
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

.app-view :deep(.import-dropzone__btn.p-button:hover) {
  background: #0066cc;
  color: #ffffff;
}

.import-dropzone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-height: 8.5rem;
  margin-top: 0.35rem;
  padding: 2rem 1.25rem;
  border-radius: 10px;
  border: 1px dashed rgba(0, 0, 0, 0.1);
  background: #fafafa;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.import-dropzone:hover,
.import-dropzone:focus-visible {
  outline: none;
  border-color: rgba(0, 113, 227, 0.45);
  background: rgba(0, 113, 227, 0.04);
}

.import-dropzone--drag {
  border-color: #0071e3;
  background: rgba(0, 113, 227, 0.08);
}

.import-dropzone--busy {
  pointer-events: none;
  opacity: 0.85;
}

.import-dropzone__icon {
  font-size: 1.75rem;
  color: #c7c7cc;
  margin-bottom: 0.25rem;
}

.import-dropzone__title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: #1d1d1f;
}

.import-dropzone__hint {
  margin: 0;
  font-size: 0.75rem;
  color: #86868b;
}

.import-dropzone__input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
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

.import-status,
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

.import-status .pi,
.import-empty .pi {
  font-size: 1.5rem;
  color: #c7c7cc;
}

.import-groups {
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
  margin-top: 0.85rem;
}

.import-date-group__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.import-date-group__title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: #86868b;
}
.import-date-group__title::first-letter {
  text-transform: uppercase;
}

.r-list {
  margin: 0;
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

.r-card--selected {
  border-color: rgba(0, 113, 227, 0.28);
  background: #f0f7ff;
}

.r-card--drop {
  border-color: #0071e3;
  background: rgba(0, 113, 227, 0.1);
}

.r-card--dragging {
  opacity: 0.45;
}

.r-card[draggable='true'] {
  cursor: grab;
}

.r-card__row--clickable {
  cursor: pointer;
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
  font-size: 0.85rem;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  text-decoration: none;
  transition: background 0.12s ease, color 0.12s ease;
}

.r-card__icon-btn--link {
  color: #34c759;
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

.resident-modal__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #1d1d1f;
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
  border-color: #0071e3;
}

.resident-modal__field select {
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  font: inherit;
  color: #1d1d1f;
  font-weight: 400;
  background: #fff;
}

.import-doc-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.r-card__doc-status[data-status='PUBLISHED'] {
  color: #1a7f37;
  font-weight: 600;
}

.r-card__doc-status[data-status='SUPERSEDED'],
.r-card__doc-status[data-status='ARCHIVED'] {
  color: #8a4b00;
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
  border-color: transparent;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):hover) {
  background: #0066cc;
  border-color: transparent;
}
</style>
