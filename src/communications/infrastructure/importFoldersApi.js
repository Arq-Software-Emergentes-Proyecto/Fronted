import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'

export function isHomeFolder(folder) {
  return Boolean(folder?.isHome) || String(folder?.kind ?? '') === 'home'
}

export function isContextFolder(folder) {
  return (
    Boolean(folder?.isContext) ||
    String(folder?.kind ?? '') === 'context' ||
    String(folder?.name ?? '').trim().toLowerCase() === 'contexto ia'
  )
}

export function isSystemFolder(folder) {
  return isHomeFolder(folder) || isContextFolder(folder)
}

const BASE = '/api/v1/import/folders'

export const importFoldersApi = {
  async list() {
    const { data } = await apiClient.get(BASE)
    return Array.isArray(data) ? data : []
  },

  async add({ name, isHome = false, isContext = false }) {
    const ownerId = getActiveDataOwnerId()
    const home = Boolean(isHome)
    const context = Boolean(isContext)
    const payload = {
      id: home
        ? ownerId
          ? `folder-home-${ownerId}`
          : 'folder-home'
        : context
          ? ownerId
            ? `folder-context-${ownerId}`
            : 'folder-context'
          : `folder-${Date.now()}`,
      name: home ? 'Home' : context ? 'Contexto IA' : String(name ?? '').trim() || 'Carpeta',
      isHome: home,
      isContext: context,
    }
    const { data: created } = await apiClient.post(BASE, payload)
    return created
  },

  async ensureHome(existing) {
    const rows = Array.isArray(existing) ? existing : await this.list()
    const found =
      rows.find((folder) => isHomeFolder(folder)) ||
      rows.find((folder) => String(folder?.name ?? '').trim().toLowerCase() === 'home')
    if (!found) return this.add({ name: 'Home', isHome: true })
    if (found.isHome) return found
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(found.id)}`, {
      isHome: true,
      name: 'Home',
    })
    return data
  },

  async ensureContext(existing) {
    const rows = Array.isArray(existing) ? existing : await this.list()
    const found =
      rows.find((folder) => isContextFolder(folder)) ||
      rows.find((folder) => {
        const n = String(folder?.name ?? '').trim().toLowerCase()
        return n === 'contexto ia' || n === 'contexto' || n === 'ai context'
      })
    if (!found) return this.add({ name: 'Contexto IA', isContext: true })
    if (found.isContext) return found
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(found.id)}`, {
      isContext: true,
      name: 'Contexto IA',
    })
    return data
  },

  async updateName(id, name) {
    const cleanId = String(id ?? '').trim()
    const nextName = String(name ?? '').trim()
    if (!cleanId || !nextName) {
      const error = new Error('INVALID_FOLDER_NAME')
      error.code = 'INVALID_FOLDER_NAME'
      throw error
    }
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(cleanId)}`, {
      name: nextName,
    })
    return data
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return
    const current = (await this.list()).find((folder) => String(folder.id) === cleanId)
    if (isSystemFolder(current)) {
      const error = new Error(isHomeFolder(current) ? 'HOME_FOLDER_LOCKED' : 'CONTEXT_FOLDER_LOCKED')
      error.code = error.message
      throw error
    }
    await apiClient.delete(`${BASE}/${encodeURIComponent(cleanId)}`)
  },
}
