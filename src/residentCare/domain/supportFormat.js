/** Presentation helpers shared by the resident and admin support views. */

export function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] || ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : ''
  return (first + last).toUpperCase()
}

function intlLocale(locale) {
  return String(locale).startsWith('en') ? 'en-US' : 'es-PE'
}

/** "hace 5 min" / "5 min ago"; older than a week → short date. `nowLabel` for < 1 min. */
export function relativeTime(iso, locale, nowLabel = '') {
  if (!iso) return ''
  const date = new Date(iso)
  const ms = date.getTime()
  if (Number.isNaN(ms)) return ''
  const diffSec = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return nowLabel
  try {
    const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto', style: 'short' })
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), 'day')
    return date.toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'short' })
  } catch {
    return date.toLocaleDateString()
  }
}

export function formatClock(iso, locale) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleTimeString(intlLocale(locale), { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Grows a textarea with its content up to `max` px (composer). */
export function autosizeTextarea(el, max = 140) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
}
