import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'

/**
 * Information bounded-context API.
 *
 * Owns: announcements CRUD (comunicados oficiales).
 * Scoped by ownerAdminId: each admin only sees/edits their building's posts;
 * residents see their building admin's announcements.
 */
export const announcementsApi = {
  /**
   * Fetch announcements for the active data owner, newest first.
   */
  async list() {
    const { data } = await apiClient.get('/announcements', {
      params: withOwnerParams({ _sort: 'createdAt', _order: 'desc' }),
    })
    return Array.isArray(data) ? data : []
  },

  /**
   * Create a new announcement.
   * @param {{ title: string, body: string, priority: string, duration: number, authorId: string, authorName: string }} announcement
   */
  async add(announcement) {
    const createdAt = new Date().toISOString()
    const duration = announcement.duration ?? 7
    const expires = new Date(createdAt)
    expires.setDate(expires.getDate() + duration)

    const ownerAdminId = getActiveDataOwnerId()
    const payload = {
      ...announcement,
      id: `ann-${Date.now()}`,
      createdAt,
      duration,
      expiresAt: expires.toISOString(),
      ...(ownerAdminId ? { ownerAdminId } : {}),
    }
    const { data } = await apiClient.post('/announcements', payload)
    return data
  },

  /**
   * Delete an announcement by id.
   * @param {string} id
   */
  async remove(id) {
    await apiClient.delete(`/announcements/${encodeURIComponent(id)}`)
  },
}
