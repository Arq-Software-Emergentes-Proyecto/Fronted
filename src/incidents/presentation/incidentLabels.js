import { IncidentEventType, IncidentPriority, IncidentStatus } from '@/incidents/domain/model/incidentConstants.js'

export function incidentStatusLabel(t, status) {
  switch (status) {
    case IncidentStatus.OPEN:
      return t('incidentStatusOpen')
    case IncidentStatus.IN_PROGRESS:
      return t('incidentStatusInProgress')
    case IncidentStatus.RESOLVED:
      return t('incidentStatusResolved')
    default:
      return String(status ?? '—')
  }
}

export function incidentPriorityOptions(t) {
  return [
    { value: IncidentPriority.LOW, label: t('incidentFlow.priorityLow') },
    { value: IncidentPriority.MEDIUM, label: t('incidentFlow.priorityMedium') },
    { value: IncidentPriority.HIGH, label: t('incidentFlow.priorityHigh') },
    { value: IncidentPriority.CRITICAL, label: t('incidentFlow.priorityCritical') },
  ]
}

export function incidentPriorityLabel(t, priority) {
  return incidentPriorityOptions(t).find((o) => o.value === priority)?.label ?? ''
}

export function incidentEventLabel(t, event) {
  switch (event?.type) {
    case IncidentEventType.REPORTED:
      return t('incidentFlow.eventReported')
    case IncidentEventType.STATUS_CHANGED:
      return t('incidentFlow.eventStatusChanged', { status: incidentStatusLabel(t, event.status) })
    case IncidentEventType.ASSIGNED:
      return t('incidentFlow.eventAssigned', { provider: event.comment || '—' })
    case IncidentEventType.UNASSIGNED:
      return t('incidentFlow.eventUnassigned')
    case IncidentEventType.RESOLVED:
      return t('incidentFlow.eventResolved')
    case IncidentEventType.COMMENT:
      return t('incidentFlow.eventComment')
    default:
      return String(event?.type ?? '')
  }
}

export function formatIncidentWhen(locale, iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(locale === 'es' ? 'es-PE' : 'en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}
