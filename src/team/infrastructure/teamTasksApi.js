import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

const BASE = '/api/v1/tasks'

export const TASK_STATUSES = Object.freeze(['PENDING', 'IN_PROGRESS', 'COMPLETED'])

function requireId(id) {
  const cleanId = String(id ?? '').trim()
  if (!cleanId) throw apiError('TASK_NOT_FOUND', 'Task id is required.')
  return cleanId
}

/**
 * Team — maintenance tasks (admin). Optional incidentId links the task to an incident.
 * Errors: WORKLOAD_EXCEEDED / WORKER_INACTIVE / INVALID_TASK_TRANSITION (409).
 */
export const teamTasksApi = {
  async list({ staffId, status, incidentId, open } = {}) {
    const params = {}
    if (staffId) params.staffId = staffId
    if (status) params.status = status
    if (incidentId) params.incidentId = incidentId
    if (open) params.open = true
    const { data } = await apiClient.get(BASE, { params })
    return Array.isArray(data) ? data : []
  },

  async create({ staffId, description, scheduledFor, incidentId }) {
    const cleanStaff = String(staffId ?? '').trim()
    const cleanDescription = String(description ?? '').trim()
    if (!cleanStaff || !cleanDescription) {
      throw apiError('TASK_FIELDS_REQUIRED', 'staffId and description are required.')
    }
    const body = { staffId: cleanStaff, description: cleanDescription }
    if (scheduledFor) body.scheduledFor = new Date(scheduledFor).toISOString()
    if (incidentId) body.incidentId = String(incidentId)
    const { data } = await apiClient.post(BASE, body)
    return data
  },

  async start(id) {
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(requireId(id))}/start`)
    return data
  },

  async complete(id) {
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(requireId(id))}/complete`)
    return data
  },

  async reassign(id, staffId) {
    const { data } = await apiClient.patch(`${BASE}/${encodeURIComponent(requireId(id))}/reassign`, {
      staffId: String(staffId ?? '').trim(),
    })
    return data
  },
}
