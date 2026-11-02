import { useI18n } from 'vue-i18n'

const DAY_MS = 86_400_000

/** Calendar-day difference (local time) between today and `iso`; negative when already past. */
export function calendarDaysUntil(iso, now = new Date()) {
  if (!iso) return null
  const target = new Date(iso)
  if (Number.isNaN(target.getTime())) return null
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate())
  return Math.round((b - a) / DAY_MS)
}

/** Expired when the server says so, or when expiresAt is in the past (admins also get expired rows). */
export function isAnnouncementExpired(announcement, now = new Date()) {
  if (!announcement) return false
  if (announcement.status === 'expired') return true
  if (announcement.isActive === false && announcement.expiresAt) return true
  if (!announcement.expiresAt) return false
  return now >= new Date(announcement.expiresAt)
}

/** Still active but stops showing within the next 7 days. */
export function expiresWithinWeek(announcement, now = new Date()) {
  if (!announcement?.expiresAt || isAnnouncementExpired(announcement, now)) return false
  return new Date(announcement.expiresAt) - now <= 7 * DAY_MS
}

/** Same rule as Announcement.RecalculateExpiration(): (publishedAt ?? createdAt ?? now) + duration days. */
export function projectedExpiry(start, durationDays) {
  const d = start ? new Date(start) : new Date()
  if (Number.isNaN(d.getTime())) return null
  d.setDate(d.getDate() + Number(durationDays || 0))
  return d
}

export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '·'
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}

export const PRIORITY_META = Object.freeze({
  urgent: { icon: 'pi pi-exclamation-triangle', labelKey: 'information.priorityUrgent' },
  important: { icon: 'pi pi-exclamation-circle', labelKey: 'information.priorityImportant' },
  normal: { icon: 'pi pi-megaphone', labelKey: 'information.priorityNormal' },
})

export function normalizePriority(priority) {
  return PRIORITY_META[priority] ? priority : 'normal'
}

export function useAnnouncementFormat() {
  const { t, locale } = useI18n()
  const intlLocale = () => (String(locale.value).startsWith('es') ? 'es-PE' : 'en-US')

  function formatDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' })
  }

  function formatDateTime(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  }

  function priorityLabel(priority) {
    return t(PRIORITY_META[normalizePriority(priority)].labelKey)
  }

  /** "Vence hoy / mañana / en N días" or "Venció el …". */
  function expiryLabel(announcement, now = new Date()) {
    if (!announcement?.expiresAt) return ''
    if (isAnnouncementExpired(announcement, now)) {
      return t('information.expiredOn', { date: formatDate(announcement.expiresAt) })
    }
    const days = Math.max(0, calendarDaysUntil(announcement.expiresAt, now) ?? 0)
    return t('information.expiresIn', { n: days }, days)
  }

  return { t, locale, formatDate, formatDateTime, priorityLabel, expiryLabel }
}
