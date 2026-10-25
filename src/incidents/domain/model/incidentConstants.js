/**
 * Incidents bounded context — constantes compartidas con el backend.
 *
 * Estados persistidos (strings históricos, no cambiar): open | in-progress | resolved.
 * Equivalencia con el diseño táctico (IncidentStatus): open = REPORTED,
 * in-progress = ASSIGNED / IN_PROGRESS, resolved = RESOLVED.
 * Pasar a "resolved" exige comentario de resolución (RF031, error RESOLUTION_COMMENT_REQUIRED).
 */
export const IncidentStatus = Object.freeze({
  OPEN: 'open',
  IN_PROGRESS: 'in-progress',
  RESOLVED: 'resolved',
})

export const INCIDENT_STATUS_REPORT_NAMES = Object.freeze({
  [IncidentStatus.OPEN]: 'REPORTED',
  [IncidentStatus.IN_PROGRESS]: 'IN_PROGRESS',
  [IncidentStatus.RESOLVED]: 'RESOLVED',
})

/** Prioridad opcional (diseño táctico: LOW, MEDIUM, HIGH, CRITICAL). */
export const IncidentPriority = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
})

/** Tipos de evento del historial (RNF010). */
export const IncidentEventType = Object.freeze({
  REPORTED: 'reported',
  STATUS_CHANGED: 'status_changed',
  ASSIGNED: 'assigned',
  UNASSIGNED: 'unassigned',
  RESOLVED: 'resolved',
  COMMENT: 'comment',
  ESCALATED: 'escalated',
  AI_TRIAGE_SUGGESTED: 'ai_triage_suggested',
  TRIAGE_CONFIRMED: 'triage_confirmed',
})

/** Horas sin asignar tras las que el backend escala la incidencia (EscalationPolicy). */
export const INCIDENT_ESCALATION_HOURS = 48

/** Eventos SignalR emitidos por el backend en /hubs/support. */
export const IncidentRealtimeEvent = Object.freeze({
  CREATED: 'incidentCreated',
  UPDATED: 'incidentUpdated',
})

export const INCIDENT_TITLE_MAX = 200
export const INCIDENT_DESCRIPTION_MAX = 2000
