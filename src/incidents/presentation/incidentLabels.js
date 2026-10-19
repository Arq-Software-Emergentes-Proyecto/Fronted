import { IncidentEventType, IncidentPriority, IncidentStatus } from '@/incidents/domain/model/incidentConstants.js'

export function incidentStatusLabel(t, status) {
  switch (status) {
    case IncidentStatus.OPEN:
      return t('incidentFlow.statusOpen')
    case IncidentStatus.IN_PROGRESS:
      return t('incidentFlow.statusInProgress')
    case IncidentStatus.RESOLVED:
      return t('incidentFlow.statusResolved')
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

function intlLocale(locale) {
  return locale === 'es' ? 'es-PE' : 'en-US'
}

/** "18 oct. 2026, 6:55 a. m." / "Oct 18, 2026, 6:55 AM" */
export function formatIncidentWhen(locale, iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  return date.toLocaleString(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' })
}

/** "18 oct. 2026" / "Oct 18, 2026" */
export function formatIncidentDate(locale, iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  return date.toLocaleDateString(intlLocale(locale), { dateStyle: 'medium' })
}

/** "hace 20 horas" / "20 hours ago" (Intl.RelativeTimeFormat). */
export function formatIncidentRelative(locale, iso, now = Date.now()) {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const diffSec = Math.round((time - now) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' })
  if (abs < 60) return rtf.format(diffSec, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day')
  if (abs < 86400 * 365) return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')
  return rtf.format(Math.round(diffSec / (86400 * 365)), 'year')
}

export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

/** Last event of the incident history (events may be absent in list payloads). */
export function lastIncidentEvent(incident) {
  const events = Array.isArray(incident?.events) ? incident.events : []
  if (!events.length) return null
  return events
    .slice()
    .sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')))
    .at(-1)
}
