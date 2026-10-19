<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { residentInviteLink, residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'

/**
 * US016 — Excel/CSV roster import. The server validates every row; if any is invalid the whole file
 * is rejected and we show the per-row report. On success we show the generated invite links:
 * there is no email provider, so the admin must share them (copy / export).
 */
const emit = defineEmits(['imported'])
const { t, te, locale } = useI18n()

const ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv'
const MAX_BYTES = 2 * 1024 * 1024

const fileInput = ref(null)
const selectedFile = ref(null)
const isDragging = ref(false)
const isUploading = ref(false)
const isDownloading = ref('')
const failure = ref(null)
const result = ref(null)
const copiedId = ref('')
const copiedAll = ref(false)

const PLAN_CODES = new Set(['RESIDENT_PLAN_LIMIT_REACHED', 'SUBSCRIPTION_TRIAL_EXPIRED', 'SUBSCRIPTION_INACTIVE'])

const rowErrors = computed(() => (failure.value?.errors ?? []).filter((e) => Number(e.row) > 0))
const fileErrors = computed(() => (failure.value?.errors ?? []).filter((e) => !Number(e.row)))
const needsUpgrade = computed(
  () => PLAN_CODES.has(failure.value?.code) || fileErrors.value.some((e) => PLAN_CODES.has(e.code)),
)

const createdRows = computed(() =>
  (result.value?.residents ?? []).map((r) => ({ ...r, link: residentInviteLink(r) })),
)

function errorText(error) {
  const key = `rosterImport.errors.${error.code}`
  if (String(locale.value).startsWith('es') && error.message) return error.message
  return te(key) ? t(key) : error.message || error.code
}

function setFile(file) {
  failure.value = null
  result.value = null
  if (!file) {
    selectedFile.value = null
    return
  }
  const name = String(file.name || '').toLowerCase()
  if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
    selectedFile.value = null
    failure.value = { code: 'UNSUPPORTED_FILE_TYPE', message: '', errors: [{ row: 0, code: 'UNSUPPORTED_FILE_TYPE', message: t('rosterImport.errors.UNSUPPORTED_FILE_TYPE') }] }
    return
  }
  if (file.size > MAX_BYTES) {
    selectedFile.value = null
    failure.value = { code: 'FILE_TOO_LARGE', message: '', errors: [{ row: 0, code: 'FILE_TOO_LARGE', message: t('rosterImport.errors.FILE_TOO_LARGE') }] }
    return
  }
  selectedFile.value = file
}

function onFileChange(event) {
  setFile(event.target.files?.[0] ?? null)
}

function onDrop(event) {
  isDragging.value = false
  setFile(event.dataTransfer?.files?.[0] ?? null)
}

function resetFile() {
  selectedFile.value = null
  if (fileInput.value) fileInput.value.value = ''
}

async function onUpload() {
  if (!selectedFile.value || isUploading.value) return
  isUploading.value = true
  failure.value = null
  result.value = null
  try {
    result.value = await residentsApi.importFile(selectedFile.value)
    resetFile()
    emit('imported', result.value.residents)
  } catch (error) {
    const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null
    if (payload?.errors) {
      failure.value = {
        code: payload.code ?? error.code,
        message: payload.message ?? '',
        totalRows: payload.totalRows ?? 0,
        invalidRows: payload.invalidRows ?? 0,
        errors: payload.errors,
      }
    } else {
      const code = error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT' ? 'NETWORK_ERROR' : error?.code || 'GENERIC'
      failure.value = {
        code,
        message: '',
        errors: [{ row: 0, code, message: te(`rosterImport.errors.${code}`) ? t(`rosterImport.errors.${code}`) : t('rosterImport.errors.GENERIC') }],
      }
    }
  } finally {
    isUploading.value = false
  }
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const LOCAL_CSV_TEMPLATE =
  'nombre;departamento;piso;email;fecha_ingreso;facturar_desde_mes_siguiente\n' +
  'Ana Torres;304;3;ana.torres@correo.com;2026-01-15;no\n' +
  'Luis Ramos;1201;;;;\n'

async function downloadTemplate(format) {
  if (isDownloading.value) return
  isDownloading.value = format
  try {
    const blob = await residentsApi.downloadImportTemplate(format)
    saveBlob(blob, `plantilla-residentes.${format}`)
  } catch (error) {
    const code = error?.code
    if (OPEN_WIREFRAME_ACCESS || code === 'NETWORK_ERROR' || code === 'TIMEOUT') {
      // Offline / preview: the CSV template can still be generated locally.
      saveBlob(new Blob(['﻿' + LOCAL_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }), 'plantilla-residentes.csv')
    } else {
      // Real API error (e.g. plan / session): surface it instead of silently serving a local file.
      const errCode = code || 'GENERIC'
      failure.value = {
        code: errCode,
        message: '',
        errors: [{
          row: 0,
          code: errCode,
          message: te(`rosterImport.errors.${errCode}`) ? t(`rosterImport.errors.${errCode}`) : t('rosterImport.errors.GENERIC'),
        }],
      }
    }
  } finally {
    isDownloading.value = ''
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

async function copyLink(row) {
  if (await copyText(row.link)) {
    copiedId.value = row.id
    window.setTimeout(() => {
      if (copiedId.value === row.id) copiedId.value = ''
    }, 2000)
  }
}

async function copyAll() {
  const text = createdRows.value
    .map((r) => `${r.name} (${t('rosterImport.department')} ${r.code}): ${r.link}`)
    .join('\n')
  if (await copyText(text)) {
    copiedAll.value = true
    window.setTimeout(() => (copiedAll.value = false), 2000)
  }
}

function csvCell(value) {
  const s = String(value ?? '')
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function exportLinks() {
  const header = ['nombre', 'departamento', 'piso', 'enlace_invitacion', 'vence']
  const lines = createdRows.value.map((r) =>
    [r.name, r.code, r.floor, r.link, r.inviteExpiresAt ? String(r.inviteExpiresAt).slice(0, 10) : ''].map(csvCell).join(';'),
  )
  saveBlob(
    new Blob(['﻿' + [header.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }),
    'invitaciones-residentes.csv',
  )
}

function columnLabel(column) {
  if (!column) return '—'
  const key = `rosterImport.columns.${column}`
  return te(key) ? t(key) : column
}
</script>

<template>
  <div class="bf-import">
    <p class="bf-import__intro">{{ t('rosterImport.intro') }}</p>

    <div class="bf-import__templates">
      <span>{{ t('rosterImport.templateLabel') }}</span>
      <button type="button" class="bf-import__link-btn" :disabled="Boolean(isDownloading)" @click="downloadTemplate('xlsx')">
        <i :class="isDownloading === 'xlsx' ? 'pi pi-spin pi-spinner' : 'pi pi-file-excel'" aria-hidden="true" />
        {{ t('rosterImport.templateXlsx') }}
      </button>
      <button type="button" class="bf-import__link-btn" :disabled="Boolean(isDownloading)" @click="downloadTemplate('csv')">
        <i :class="isDownloading === 'csv' ? 'pi pi-spin pi-spinner' : 'pi pi-download'" aria-hidden="true" />
        {{ t('rosterImport.templateCsv') }}
      </button>
    </div>
    <p class="bf-import__columns">{{ t('rosterImport.columnsHint') }}</p>

    <label
      class="bf-import__drop"
      :class="{ 'is-dragging': isDragging, 'has-file': selectedFile }"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="onDrop"
    >
      <input ref="fileInput" type="file" :accept="ACCEPT" class="bf-import__input" :disabled="isUploading" @change="onFileChange" />
      <i class="pi pi-upload" aria-hidden="true" />
      <span v-if="selectedFile" class="bf-import__file-name">{{ selectedFile.name }}</span>
      <span v-else>{{ t('rosterImport.dropHint') }}</span>
      <small>{{ t('rosterImport.fileLimits') }}</small>
    </label>

    <div class="bf-import__actions">
      <button type="button" class="bf-import__primary" :disabled="!selectedFile || isUploading" @click="onUpload">
        <i v-if="isUploading" class="pi pi-spin pi-spinner" aria-hidden="true" />
        {{ isUploading ? t('rosterImport.uploading') : t('rosterImport.upload') }}
      </button>
    </div>

    <div v-if="failure" class="bf-import__report bf-import__report--error" role="alert">
      <p class="bf-import__report-title">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <template v-if="rowErrors.length">
          {{ t('rosterImport.rejectedTitle', { rows: failure.invalidRows || new Set(rowErrors.map((e) => e.row)).size }) }}
        </template>
        <template v-else>{{ t('rosterImport.fileRejectedTitle') }}</template>
      </p>
      <p v-for="(error, i) in fileErrors" :key="`f-${i}`" class="bf-import__file-error">{{ errorText(error) }}</p>
      <RouterLink
        v-if="needsUpgrade"
        class="bf-import__upgrade"
        :to="{ name: AppRouteNames.APP_SETTINGS, query: { tab: 'plans' } }"
      >
        <i class="pi pi-arrow-up-right" aria-hidden="true" />
        {{ t('billing.upgradeCta') }}
      </RouterLink>

      <div v-if="rowErrors.length" class="bf-import__table-wrap" tabindex="0">
        <table class="bf-import__table">
          <caption class="visually-hidden">{{ t('rosterImport.errorTableCaption') }}</caption>
          <thead>
            <tr>
              <th scope="col">{{ t('rosterImport.row') }}</th>
              <th scope="col">{{ t('rosterImport.column') }}</th>
              <th scope="col">{{ t('rosterImport.error') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(error, i) in rowErrors" :key="`r-${i}`">
              <td class="bf-import__row-num">{{ error.row }}</td>
              <td>{{ columnLabel(error.column) }}</td>
              <td>{{ errorText(error) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="rowErrors.length" class="bf-import__fix-hint">{{ t('rosterImport.fixHint') }}</p>
    </div>

    <div v-if="result" class="bf-import__report bf-import__report--ok" role="status">
      <p class="bf-import__report-title">
        <i class="pi pi-check-circle" aria-hidden="true" />
        {{ t('rosterImport.successTitle', { count: result.created }) }}
      </p>
      <p class="bf-import__invite-note">
        <i class="pi pi-info-circle" aria-hidden="true" />
        {{ t('rosterImport.inviteNote') }}
      </p>
      <div class="bf-import__invite-actions">
        <button type="button" class="bf-import__link-btn" @click="copyAll">
          <i class="pi pi-copy" aria-hidden="true" />
          {{ copiedAll ? t('rosterImport.copied') : t('rosterImport.copyAll') }}
        </button>
        <button type="button" class="bf-import__link-btn" @click="exportLinks">
          <i class="pi pi-download" aria-hidden="true" />
          {{ t('rosterImport.exportLinks') }}
        </button>
      </div>
      <ul class="bf-import__invites" role="list">
        <li v-for="row in createdRows" :key="row.id" class="bf-import__invite">
          <div class="bf-import__invite-who">
            <strong>{{ row.name }}</strong>
            <span>{{ t('app.residentFloorApt', { floor: row.floor, code: row.code }) }}</span>
          </div>
          <input class="bf-import__invite-link" type="text" readonly :value="row.link" :aria-label="t('rosterImport.inviteLinkFor', { name: row.name })" @focus="$event.target.select()" />
          <button type="button" class="bf-import__copy" :aria-label="t('rosterImport.copyLinkFor', { name: row.name })" @click="copyLink(row)">
            <i :class="copiedId === row.id ? 'pi pi-check' : 'pi pi-copy'" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.bf-import {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-size: 0.875rem;
  color: var(--apple-text, #1d1d1f);
}

.bf-import__intro,
.bf-import__columns {
  margin: 0;
  color: var(--apple-text-secondary, #6e6e73);
  line-height: 1.45;
}

.bf-import__columns {
  font-size: 0.75rem;
}

.bf-import__templates,
.bf-import__invite-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.bf-import__link-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.bf-import__link-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.bf-import__link-btn:focus-visible,
.bf-import__primary:focus-visible,
.bf-import__copy:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.bf-import__link-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.bf-import__drop {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 1.25rem 1rem;
  border: 1px dashed rgba(15, 23, 42, 0.22);
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.bf-import__drop:focus-within,
.bf-import__drop.is-dragging {
  border-color: #1e3a8a;
  background: #e8eefc;
}

.bf-import__drop.has-file {
  border-style: solid;
  border-color: #15803d;
  background: #e3f4e8;
}

.bf-import__drop .pi-upload {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  color: #1e3a8a;
}

.bf-import__drop small {
  color: var(--apple-text-secondary, #6e6e73);
}

.bf-import__input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.bf-import__file-name {
  font-weight: 600;
  word-break: break-all;
}

.bf-import__actions {
  display: flex;
  justify-content: flex-end;
}

.bf-import__primary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.45rem;
  padding: 0.5rem 1.1rem;
  border-radius: 999px;
  border: 1px solid #1e3a8a;
  background: #1e3a8a;
  color: #fff;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.bf-import__primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.bf-import__primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.bf-import__report {
  border-radius: 14px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.bf-import__report--error {
  background: #fde4e4;
}

.bf-import__report--ok {
  background: #e3f4e8;
}

.bf-import__report-title {
  margin: 0;
  display: flex;
  gap: 0.45rem;
  align-items: center;
  font-weight: 600;
}

.bf-import__report--error .bf-import__report-title,
.bf-import__file-error {
  color: #b42318;
}

.bf-import__report--ok .bf-import__report-title {
  color: #14532d;
}

.bf-import__file-error,
.bf-import__fix-hint,
.bf-import__invite-note {
  margin: 0;
  font-size: 0.8125rem;
}

.bf-import__invite-note {
  display: flex;
  gap: 0.4rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.bf-import__upgrade {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  background: #1e3a8a;
  color: #fff;
  font-weight: 600;
  font-size: 0.8125rem;
  text-decoration: none;
}

.bf-import__table-wrap {
  max-height: 260px;
  overflow: auto;
  border-radius: 12px;
  background: #fff;
}

.bf-import__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.bf-import__table th,
.bf-import__table td {
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  text-align: left;
  vertical-align: top;
}

.bf-import__table thead th {
  position: sticky;
  top: 0;
  background: #f8fafc;
  font-size: 0.72rem;
  font-weight: 600;
  color: #6e6e73;
}

.bf-import__row-num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.bf-import__invites {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  max-height: 280px;
  overflow-y: auto;
}

.bf-import__invite {
  display: grid;
  grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}

.bf-import__invite-who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bf-import__invite-who strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bf-import__invite-who span {
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.bf-import__invite-link {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.4rem 0.7rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  font: inherit;
  font-size: 0.75rem;
  color: #334155;
  background: #fff;
}

.bf-import__copy {
  width: 2.1rem;
  height: 2.1rem;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.bf-import__copy:hover {
  background: #e8eefc;
}

@media (max-width: 520px) {
  .bf-import__invite {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .bf-import__invite-who {
    grid-column: 1 / -1;
  }
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
</style>
