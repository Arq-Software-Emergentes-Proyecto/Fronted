import { IncidentStatus } from './incidentConstants.js'

/**
 * Incidencia. title = asunto (RF024). provider = nombre (compat); providerId/Phone/Specialty
 * vienen del proveedor asignado. events solo llega en el detalle (GET /incidents/{id}).
 * escalated: sigue abierta y sin asignar después de 48 h. aiSuggestion: triaje con IA (solo admin).
 */
export class Incident {
  constructor({
    id,
    title,
    residentId,
    residentName,
    description,
    status,
    createdAt,
    provider,
    providerId,
    providerPhone,
    providerSpecialty,
    category,
    priority,
    resolutionComment,
    resolvedAt,
    updatedAt,
    events,
    escalated,
    escalatedAt,
    aiSuggestion,
  } = {}) {
    this.id = id
    this.title = title ?? ''
    this.residentId = residentId
    this.residentName = residentName
    this.description = description
    this.status = status ?? IncidentStatus.OPEN
    this.createdAt = createdAt
    this.provider = provider ?? ''
    this.providerId = providerId ?? null
    this.providerPhone = providerPhone ?? null
    this.providerSpecialty = providerSpecialty ?? null
    this.category = category ?? null
    this.priority = priority ?? null
    this.resolutionComment = resolutionComment ?? null
    this.resolvedAt = resolvedAt ?? null
    this.updatedAt = updatedAt ?? null
    this.events = Array.isArray(events) ? events : null
    this.escalated = escalated === true
    this.escalatedAt = escalatedAt ?? null
    this.aiSuggestion = aiSuggestion ?? null
  }

  get hasPendingAiSuggestion() {
    return this.aiSuggestion?.pending === true
  }

  get isResolved() {
    return this.status === IncidentStatus.RESOLVED
  }
}
