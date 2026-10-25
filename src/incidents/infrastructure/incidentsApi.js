import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'

function incidentPath(id, suffix = '') {
  return `/incidents/${encodeURIComponent(String(id))}${suffix}`
}

export const incidentsApi = {
  /**
   * Admin: incidencias del condominio. Residente: el backend devuelve solo las suyas.
   * @param {{ residentId?: string, status?: string }} [filters] filtro server-side (RF018)
   */
  async list(filters = {}) {
    const extra = {}
    if (filters.residentId) extra.residentId = String(filters.residentId)
    if (filters.status) extra.status = String(filters.status)
    const { data } = await apiClient.get('/incidents', { params: withOwnerParams(extra) })
    return Array.isArray(data) ? data : []
  },

  /** Incidencias del residente indicado, filtradas en el servidor. */
  async listByResident(residentId) {
    if (!residentId) return []
    return this.list({ residentId })
  },

  /** Detalle con historial (events) — timeline RNF010. */
  async get(id) {
    const { data } = await apiClient.get(incidentPath(id))
    return data
  },

  async add(incident) {
    const { ownerAdminId: ownerFromPayload, ...rest } = incident
    const ownerId =
      getActiveDataOwnerId() ||
      (ownerFromPayload != null && ownerFromPayload !== ''
        ? String(ownerFromPayload)
        : null)
    const payload = {
      ...rest,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }
    const { data } = await apiClient.post('/incidents', payload)
    return data
  },

  /** PUT compat. status "resolved" requiere resolutionComment (400 RESOLUTION_COMMENT_REQUIRED). */
  async update(id, incident) {
    const {
      id: _id,
      ownerAdminId: ownerFromPayload,
      createdAt,
      ...fields
    } = incident
    const ownerId = getActiveDataOwnerId() || ownerFromPayload
    const payload = {
      title: fields.title ?? null,
      description: fields.description ?? '',
      status: fields.status ?? 'open',
      provider: fields.provider ?? '',
      providerId: fields.providerId ?? null,
      category: fields.category ?? null,
      priority: fields.priority ?? null,
      resolutionComment: fields.resolutionComment ?? null,
      residentId: fields.residentId ?? null,
      residentName: fields.residentName ?? '',
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }
    const { data } = await apiClient.put(incidentPath(id), payload)
    return data
  },

  /** PATCH /incidents/{id}/assign — providerId vacío desasigna. Abierta → en proceso. */
  async assign(id, providerId, status = null) {
    const { data } = await apiClient.patch(incidentPath(id, '/assign'), {
      providerId: providerId || '',
      ...(status ? { status } : {}),
    })
    return data
  },

  /** PATCH /incidents/{id}/resolve — exige comentario de resolución. */
  async resolve(id, resolutionComment) {
    const { data } = await apiClient.patch(incidentPath(id, '/resolve'), {
      resolutionComment: String(resolutionComment ?? '').trim(),
    })
    return data
  },

  /** Comentario de seguimiento (admin o residente que reportó). */
  async addComment(id, comment) {
    const { data } = await apiClient.post(incidentPath(id, '/comments'), {
      comment: String(comment ?? '').trim(),
    })
    return data
  },

  /** POST /incidents/{id}/triage-suggestion — la IA sugiere categoría y prioridad (plan Standard+). */
  async requestTriageSuggestion(id) {
    const { data } = await apiClient.post(incidentPath(id, '/triage-suggestion'))
    return data
  },

  /** PATCH /incidents/{id}/triage — sin valores aplica la sugerencia de la IA; con valores la corrige. */
  async confirmTriage(id, { category = null, priority = null } = {}) {
    const { data } = await apiClient.patch(incidentPath(id, '/triage'), {
      category: category || null,
      priority: priority || null,
    })
    return data
  },

  async remove(id) {
    await apiClient.delete(incidentPath(id))
  },
}
