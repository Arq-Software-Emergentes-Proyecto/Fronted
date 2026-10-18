import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError, publicSpace } from '@/shared/infrastructure/api/utils.js'

/**
 * Social Spaces bounded-context API (spaces side).
 *
 * Owns: catalog of common areas administrators publish for residents.
 * Errors expose `error.code`: 'SPACE_NAME_REQUIRED', 'SPACE_NOT_FOUND'.
 * Spaces carry `rules`, `status` ('AVAILABLE' | 'MAINTENANCE': no new bookings) and
 * `maxReservationsPerDay` (null = no daily limit).
 */

function parseOptionalPositiveInt(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
export const spacesApi = {
  async list() {
    const { data } = await apiClient.get('/socialSpaces', { params: withOwnerParams() })
    return Array.isArray(data) ? data.map(publicSpace) : []
  },

  async add({ name, description, capacity, imageUrl, rules, status, maxReservationsPerDay }) {
    const cleanName = String(name ?? '').trim()
    const cleanDescription = String(description ?? '').trim()
    const cleanImageUrl = String(imageUrl ?? '').trim()
    const parsedCapacity = capacity !== '' && capacity != null ? Number(capacity) : null

    if (!cleanName) {
      throw apiError('SPACE_NAME_REQUIRED')
    }

    const ownerId = getActiveDataOwnerId()
    const newSpace = {
      id: `space-${Date.now()}`,
      name: cleanName,
      description: cleanDescription,
      capacity: Number.isFinite(parsedCapacity) ? parsedCapacity : null,
      imageUrl: cleanImageUrl,
      rules: String(rules ?? '').trim(),
      status: status === 'MAINTENANCE' ? 'MAINTENANCE' : 'AVAILABLE',
      maxReservationsPerDay: parseOptionalPositiveInt(maxReservationsPerDay),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/socialSpaces', newSpace)
    return publicSpace(created)
  },

  async update({ id, name, description, capacity, imageUrl, rules, status, maxReservationsPerDay }) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('SPACE_NOT_FOUND')
    }

    const cleanName = String(name ?? '').trim()
    if (!cleanName) {
      throw apiError('SPACE_NAME_REQUIRED')
    }

    const cleanDescription = String(description ?? '').trim()
    const parsedCapacity = capacity !== '' && capacity != null ? Number(capacity) : null

    const payload = {
      name: cleanName,
      description: cleanDescription,
      capacity: Number.isFinite(parsedCapacity) ? parsedCapacity : null,
    }

    if (imageUrl !== undefined) {
      payload.imageUrl = String(imageUrl ?? '').trim()
    }
    if (rules !== undefined) payload.rules = String(rules ?? '').trim()
    if (status !== undefined) payload.status = status === 'MAINTENANCE' ? 'MAINTENANCE' : 'AVAILABLE'
    if (maxReservationsPerDay !== undefined) {
      payload.maxReservationsPerDay = parseOptionalPositiveInt(maxReservationsPerDay)
    }

    const { data: updated } = await apiClient.patch(
      `/socialSpaces/${encodeURIComponent(cleanId)}`,
      payload,
    )
    return publicSpace(updated)
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('SPACE_NOT_FOUND')
    }
    await apiClient.delete(`/socialSpaces/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
