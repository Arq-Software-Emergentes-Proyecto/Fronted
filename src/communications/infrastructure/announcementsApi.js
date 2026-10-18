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
   * Comunicados del condominio, ordenados por prioridad (urgent > important > normal) y fecha.
   * Residentes: el servidor devuelve SOLO los vigentes (RF019). Admin: todos, salvo activeOnly.
   * @param {{ activeOnly?: boolean }} [options]
   */
  async list({ activeOnly = false } = {}) {
    const { data } = await apiClient.get('/announcements', {
      params: withOwnerParams({
        _sort: 'createdAt',
        _order: 'desc',
        ...(activeOnly ? { activeOnly: true } : {}),
      }),
    })
    return Array.isArray(data) ? data : []
  },

  /** GetActiveAnnouncements: vigentes, filtrados en el servidor. */
  async listActive() {
    return this.list({ activeOnly: true })
  },

  /**
   * Create a new announcement.
   * @param {{ title: string, body: string, priority: string, duration: number, authorId: string, authorName: string }} announcement
   */
  async add(announcement) {
    // RF019: createdAt y expiresAt (= createdAt + duration días) los calcula el servidor.
    const duration = announcement.duration ?? 7
    const ownerAdminId = getActiveDataOwnerId()
    const { createdAt: _createdAt, expiresAt: _expiresAt, ...fields } = announcement
    const payload = {
      ...fields,
      id: `ann-${Date.now()}`,
      duration,
      ...(ownerAdminId ? { ownerAdminId } : {}),
    }
    const { data } = await apiClient.post('/announcements', payload)
    return data
  },

  /**
   * Edit an announcement; the server recomputes expiresAt from createdAt + duration.
   * @param {string} id
   * @param {{ title: string, body: string, priority: string, duration: number }} announcement
   */
  async update(id, announcement) {
    const { data } = await apiClient.put(`/announcements/${encodeURIComponent(id)}`, {
      title: announcement.title ?? '',
      body: announcement.body ?? '',
      priority: announcement.priority ?? 'normal',
      duration: announcement.duration ?? 0,
    })
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
