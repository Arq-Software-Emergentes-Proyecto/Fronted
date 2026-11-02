import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

const BASE = '/api/v1/shifts'

/** Team — work shifts (admin). Overlapping shifts of the same worker → 409 SHIFT_OVERLAP. */
export const teamShiftsApi = {
  async list({ staffId, from, to } = {}) {
    const params = {}
    if (staffId) params.staffId = staffId
    if (from) params.from = new Date(from).toISOString()
    if (to) params.to = new Date(to).toISOString()
    const { data } = await apiClient.get(BASE, { params })
    return Array.isArray(data) ? data : []
  },

  async create({ staffId, start, end, notes }) {
    if (!staffId || !start || !end) {
      throw apiError('SHIFT_FIELDS_REQUIRED', 'staffId, start and end are required.')
    }
    const { data } = await apiClient.post(BASE, {
      staffId: String(staffId),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      notes: notes ? String(notes).trim() : null,
    })
    return data
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('SHIFT_NOT_FOUND', 'Shift id is required.')
    await apiClient.delete(`${BASE}/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
