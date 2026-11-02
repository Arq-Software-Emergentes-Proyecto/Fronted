import { apiClient } from '@/shared/infrastructure/api/apiClient.js'

const BASE = '/api/v1/import/uploads'

/**
 * Metadata en API; binario vía URL firmada (PUT). Sin downloadUrl persistido.
 */
export const importUploadsApi = {
  async list() {
    const { data } = await apiClient.get(BASE)
    return Array.isArray(data) ? data : []
  },

  async requestSignedUrl({ fileName, mimeType, size, folderId }) {
    const { data } = await apiClient.post(`${BASE}/signed-url`, {
      fileName,
      mimeType,
      size,
      folderId: folderId ? String(folderId) : null,
    })
    return data
  },

  async confirm(id) {
    const cleanId = String(id ?? '').trim()
    const { data } = await apiClient.post(`${BASE}/${encodeURIComponent(cleanId)}/confirm`)
    return data
  },

  async getDownloadUrl(id) {
    const cleanId = String(id ?? '').trim()
    const { data } = await apiClient.get(`${BASE}/${encodeURIComponent(cleanId)}/download-url`)
    return data
  },

  /**
   * Flujo completo: signed-url → PUT binario → confirm.
   */
  async add({ file, folderId }) {
    if (!file) {
      const err = new Error('FILE_REQUIRED')
      err.code = 'FILE_REQUIRED'
      throw err
    }

    const mimeType = guessMime(file)
    const signed = await this.requestSignedUrl({
      fileName: file.name,
      mimeType,
      size: file.size,
      folderId,
    })

    const putUrl = String(signed.uploadUrl ?? '')
    if (putUrl && !putUrl.startsWith('mock://')) {
      // No setear Content-Length a mano: el browser lo deriva del body y debe
      // coincidir con el valor firmado (signed.contentLength === file.size).
      const putRes = await fetch(putUrl, {
        method: signed.method || 'PUT',
        headers: {
          'Content-Type': signed.contentType || mimeType,
        },
        body: file,
      })
      if (!putRes.ok) {
        const err = new Error('STORAGE_PUT_FAILED')
        err.code = 'STORAGE_PUT_FAILED'
        err.status = putRes.status
        throw err
      }
    }

    return this.confirm(signed.id)
  },

  async updateFileName(id, fileName) {
    const cleanId = String(id ?? '').trim()
    const name = String(fileName ?? '').trim()
    if (!cleanId || !name) {
      const error = new Error('INVALID_FILE_NAME')
      error.code = 'INVALID_FILE_NAME'
      throw error
    }
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(cleanId)}`, {
      fileName: name,
    })
    return data
  },

  async setFolder(id, folderId) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return null
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(cleanId)}`, {
      folderId: folderId ? String(folderId) : null,
    })
    return data
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return
    await apiClient.delete(`${BASE}/${encodeURIComponent(cleanId)}`)
  },

  /** OfficialDocument type: REGULATION | MINUTES | OTHER. */
  async setDocumentType(id, documentType) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return null
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(cleanId)}`, {
      documentType: String(documentType ?? '').toUpperCase(),
    })
    return data
  },

  /**
   * Publica el documento (vigente). Con supersedesId, el anterior queda SUPERSEDED y el
   * asistente deja de usarlo (RF033). Respuesta: { document, superseded }.
   */
  async publish(id, { supersedesId, documentType } = {}) {
    const cleanId = String(id ?? '').trim()
    const body = {}
    if (supersedesId) body.supersedesId = String(supersedesId)
    if (documentType) body.documentType = String(documentType).toUpperCase()
    const { data } = await apiClient.post(`${BASE}/${encodeURIComponent(cleanId)}/publish`, body)
    return data
  },

  async archive(id) {
    const cleanId = String(id ?? '').trim()
    const { data } = await apiClient.post(`${BASE}/${encodeURIComponent(cleanId)}/archive`)
    return data
  },
}

export const DOCUMENT_TYPES = Object.freeze(['REGULATION', 'MINUTES', 'OTHER'])

function guessMime(file) {
  const typed = String(file?.type || '').trim().toLowerCase()
  if (typed && typed !== 'application/octet-stream') return typed
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.txt')) return 'text/plain'
  if (name.endsWith('.md')) return 'text/markdown'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.webp')) return 'image/webp'
  return typed || 'application/octet-stream'
}
