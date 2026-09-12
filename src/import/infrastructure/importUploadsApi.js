import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'

/**
 * Archivos subidos en la vista Importación (json-server).
 * Incluye data URL para permitir descarga local; tamaño razonable en cliente.
 */
export const importUploadsApi = {
  async list() {
    const { data } = await apiClient.get('/importUploads', {
      params: withOwnerParams({ _sort: 'uploadedAt', _order: 'desc' }),
    })
    return Array.isArray(data) ? data : []
  },

  async add({ fileName, mimeType, size, dataUrl, folderId }) {
    const ownerId = getActiveDataOwnerId()
    const payload = {
      id: `import-${Date.now()}`,
      fileName: String(fileName ?? '').trim() || 'archivo',
      mimeType: String(mimeType ?? 'application/octet-stream'),
      size: Number(size) || 0,
      uploadedAt: new Date().toISOString(),
      dataUrl: String(dataUrl ?? ''),
      folderId: folderId ? String(folderId) : null,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }
    const { data: created } = await apiClient.post('/importUploads', payload)
    return created
  },

  async updateFileName(id, fileName) {
    const cleanId = String(id ?? '').trim()
    const name = String(fileName ?? '').trim()
    if (!cleanId || !name) {
      const error = new Error('INVALID_FILE_NAME')
      error.code = 'INVALID_FILE_NAME'
      throw error
    }
    const { data } = await apiClient.patch(`/importUploads/${encodeURIComponent(cleanId)}`, {
      fileName: name,
    })
    return data
  },

  async setFolder(id, folderId) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return null
    const { data } = await apiClient.patch(`/importUploads/${encodeURIComponent(cleanId)}`, {
      folderId: folderId ? String(folderId) : null,
    })
    return data
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return
    await apiClient.delete(`/importUploads/${encodeURIComponent(cleanId)}`)
  },
}
