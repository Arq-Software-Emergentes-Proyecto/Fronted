import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

/**
 * Service providers assigned to building incidents (mock json-server CRUD).
 */
export const serviceProvidersApi = {
  async list() {
    const { data } = await apiClient.get('/serviceProviders', { params: withOwnerParams() })
    return Array.isArray(data) ? data : []
  },

  async add({ name, phone, specialty }) {
    const cleanName = String(name ?? '').trim()
    if (!cleanName) {
      throw apiError('SERVICE_PROVIDER_NAME_REQUIRED', 'Provider name is required.')
    }

    const ownerId = getActiveDataOwnerId()
    const newRow = {
      id: `provider-${Date.now()}`,
      name: cleanName,
      phone: String(phone ?? '').trim(),
      specialty: String(specialty ?? '').trim(),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/serviceProviders', newRow)
    return created
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('SERVICE_PROVIDER_NOT_FOUND', 'Provider id is required.')
    }
    await apiClient.delete(`/serviceProviders/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
