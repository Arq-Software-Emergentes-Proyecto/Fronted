import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

/**
 * Admin team / staff directory (mock json-server CRUD).
 *
 * Payload fields: id, name, phone, dni, salary (number), photoUrl (optional data URL),
 * position (CONCIERGE | MAINTENANCE | CLEANING | SECURITY). Response adds status (ACTIVE | INACTIVE)
 * and openTasks (workload).
 */
export const STAFF_POSITIONS = Object.freeze(['CONCIERGE', 'MAINTENANCE', 'CLEANING', 'SECURITY'])

export const teamWorkersApi = {
  async list() {
    const { data } = await apiClient.get('/teamWorkers', { params: withOwnerParams() })
    return Array.isArray(data) ? data : []
  },

  async add({ name, phone, dni, salary, photoUrl, position }) {
    const cleanName = String(name ?? '').trim()
    const cleanPhone = String(phone ?? '').trim()
    const cleanDni = String(dni ?? '').trim()
    const parsedSalary =
      salary === '' || salary == null ? Number.NaN : Number(salary)

    if (!cleanName || !cleanPhone || !cleanDni || !Number.isFinite(parsedSalary)) {
      throw apiError(
        'TEAM_WORKER_FIELDS_REQUIRED',
        'Name, phone, DNI and a valid salary are required.',
      )
    }

    const ownerId = getActiveDataOwnerId()
    const newWorker = {
      id: `worker-${Date.now()}`,
      name: cleanName,
      phone: cleanPhone,
      dni: cleanDni,
      salary: parsedSalary,
      photoUrl: String(photoUrl ?? '').trim(),
      ...(position ? { position: String(position).trim().toUpperCase() } : {}),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/teamWorkers', newWorker)
    return created
  },

  async update(id, patch) {
    const cleanId = requireId(id)
    const { data } = await apiClient.patch(`/teamWorkers/${encodeURIComponent(cleanId)}`, patch ?? {})
    return data
  },

  /** DeactivateStaff: optional reassignToId moves the worker's open tasks (WorkloadPolicy applies). */
  async deactivate(id, { reassignToId } = {}) {
    const cleanId = requireId(id)
    const body = reassignToId ? { reassignToId: String(reassignToId) } : {}
    const { data } = await apiClient.patch(`/teamWorkers/${encodeURIComponent(cleanId)}/deactivate`, body)
    return data
  },

  async reactivate(id) {
    const cleanId = requireId(id)
    const { data } = await apiClient.patch(`/teamWorkers/${encodeURIComponent(cleanId)}/reactivate`)
    return data
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('TEAM_WORKER_NOT_FOUND', 'Worker id is required.')
    }
    await apiClient.delete(`/teamWorkers/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}

function requireId(id) {
  const cleanId = String(id ?? '').trim()
  if (!cleanId) {
    throw apiError('TEAM_WORKER_NOT_FOUND', 'Worker id is required.')
  }
  return cleanId
}
