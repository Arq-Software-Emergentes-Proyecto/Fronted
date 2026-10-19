/** Small presentation helpers shared by the Team view and its panels. */

export function localeTag(locale) {
  return String(locale ?? '').startsWith('en') ? 'en-US' : 'es-PE'
}

export function initialsOf(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase()
}

/** Soft tint per staff position (class suffix). */
export const POSITION_TONES = Object.freeze({
  CONCIERGE: 'blue',
  MAINTENANCE: 'orange',
  CLEANING: 'green',
  SECURITY: 'amber',
})

export function positionTone(position) {
  return POSITION_TONES[position] ?? 'neutral'
}

export function toDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateTime(value, locale) {
  const d = toDate(value)
  if (!d) return ''
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text
}

/** "Hoy", "Mañana" or the weekday — plus the day/month, e.g. "Mañana · martes, 20 oct.". */
export function dayHeading(d, locale) {
  const tag = localeTag(locale)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
  const diff = Math.round((day - today) / 86400000)
  const dateLabel = new Intl.DateTimeFormat(tag, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  }).format(d)
  if (diff === 0 || diff === 1) {
    const rel = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(diff, 'day')
    return { title: capitalize(rel), subtitle: capitalize(dateLabel) }
  }
  return { title: capitalize(dateLabel), subtitle: '' }
}

/** Time range of a shift; includes the date when it ends on another day. */
export function formatTimeRange(start, end, locale) {
  const s = toDate(start)
  const e = toDate(end)
  if (!s || !e) return ''
  const sameDay = isSameDay(s, e)
  const fmt = new Intl.DateTimeFormat(localeTag(locale), {
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  })
  return typeof fmt.formatRange === 'function' ? fmt.formatRange(s, e) : `${fmt.format(s)} – ${fmt.format(e)}`
}
