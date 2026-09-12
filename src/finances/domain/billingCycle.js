export function daysInMonth(year, month0) {
  return new Date(year, month0 + 1, 0).getDate()
}

export function toYmd(year, month0, day) {
  const max = daysInMonth(year, month0)
  const safeDay = Math.min(Math.max(1, Math.trunc(Number(day) || 1)), max)
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`
}

export function normalizeMonthKey(monthKey) {
  const match = String(monthKey ?? '').trim().match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/)
  if (!match) return String(monthKey ?? '').trim()
  return toMonthKey(Number(match[1]), Number(match[2]) - 1)
}

export function parseMonthKey(monthKey) {
  const normalized = normalizeMonthKey(monthKey)
  const match = normalized.match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  return { year: Number(match[1]), month0: Number(match[2]) - 1 }
}

export function toMonthKey(year, month0) {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`
}

export function addMonths(year, month0, delta) {
  const date = new Date(year, month0 + delta, 1)
  return { year: date.getFullYear(), month0: date.getMonth() }
}

export function currentMonthKey(date = new Date()) {
  return toMonthKey(date.getFullYear(), date.getMonth())
}

export function periodForMonth(monthKey) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return { billingStart: '', billingEnd: '' }
  return {
    billingStart: toYmd(parsed.year, parsed.month0, 1),
    billingEnd: toYmd(parsed.year, parsed.month0, daysInMonth(parsed.year, parsed.month0)),
  }
}

/** Period = 1st–last of the billed month. Payment opens the first week of the next month. */
export function computeChargeDates(monthKey) {
  const parsed = parseMonthKey(monthKey)
  const period = periodForMonth(monthKey)
  if (!parsed) return { ...period, paymentOpen: '', paymentDue: '' }
  const next = addMonths(parsed.year, parsed.month0, 1)
  return {
    ...period,
    paymentOpen: toYmd(next.year, next.month0, 1),
    paymentDue: toYmd(next.year, next.month0, 7),
  }
}

export function currentStatementMonthKey(date = new Date()) {
  return currentMonthKey(date)
}

export function formatMonthLabel(monthKey, locale = 'es-PE') {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return String(monthKey ?? '')
  const raw = new Date(parsed.year, parsed.month0, 1).toLocaleDateString(
    locale === 'es' || locale === 'es-PE' ? 'es-PE' : 'en-US',
    { month: 'long', year: 'numeric' },
  )
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

export function formatDayMonth(ymd, locale = 'es-PE') {
  const match = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return String(ymd ?? '')
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.toLocaleDateString(locale === 'es' || locale === 'es-PE' ? 'es-PE' : 'en-US', {
    day: 'numeric',
    month: 'short',
  })
}

export function sortCharges(charges) {
  return [...(Array.isArray(charges) ? charges : [])].sort((a, b) =>
    String(b.month ?? '').localeCompare(String(a.month ?? '')),
  )
}

export function findCharge(charges, monthKey) {
  const needle = normalizeMonthKey(monthKey)
  if (!needle) return null
  return (Array.isArray(charges) ? charges : []).find(
    (charge) => normalizeMonthKey(charge.month) === needle,
  ) ?? null
}

export function latestCharge(charges) {
  return sortCharges(charges)[0] ?? null
}

export function nextMonthKey(monthKey) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return monthKey
  const next = addMonths(parsed.year, parsed.month0, 1)
  return toMonthKey(next.year, next.month0)
}

function addDaysYmd(ymd, days) {
  const match = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return ''
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  return toYmd(date.getFullYear(), date.getMonth(), date.getDate())
}

export function normalizeCharge(charge = {}) {
  const month = normalizeMonthKey(charge.month)
  const defaults = computeChargeDates(month)
  const paymentOpen = String(charge.paymentOpen ?? '') || defaults.paymentOpen
  return {
    id: charge.id || `charge-${month}`,
    month,
    amount: Number(charge.amount) || 0,
    billingStart: defaults.billingStart,
    billingEnd: defaults.billingEnd,
    paymentOpen,
    paymentDue: String(charge.paymentDue ?? '') || addDaysYmd(paymentOpen, 6) || defaults.paymentDue,
  }
}

export function todayYmd(date = new Date()) {
  return toYmd(date.getFullYear(), date.getMonth(), date.getDate())
}

export function daysAfterDue(dueYmd, today = todayYmd()) {
  const dueMatch = String(dueYmd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  const todayMatch = String(today ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!dueMatch || !todayMatch) return 0
  const due = new Date(Number(dueMatch[1]), Number(dueMatch[2]) - 1, Number(dueMatch[3]))
  const now = new Date(Number(todayMatch[1]), Number(todayMatch[2]) - 1, Number(todayMatch[3]))
  const diff = Math.round((now.getTime() - due.getTime()) / 86400000)
  return diff > 0 ? diff : 0
}

export function computeDailyLateFee(dueYmd, lateFeePerDay, today = todayYmd()) {
  const days = daysAfterDue(dueYmd, today)
  const amount = Number(lateFeePerDay) || 0
  if (days <= 0 || amount <= 0) return 0
  return Number((days * amount).toFixed(2))
}

export function applyLateFeeToReceipt(receipt, lateFeePerDay, today = todayYmd()) {
  const status = String(receipt?.status ?? '')
  if (status === 'Paid' || status === 'Pagado') {
    return {
      ...receipt,
      lateDays: 0,
      lateFee: Number(receipt?.lateFee) || 0,
    }
  }
  const lateDays = daysAfterDue(receipt?.dueDate, today)
  const lateFee = computeDailyLateFee(receipt?.dueDate, lateFeePerDay, today)
  return {
    ...receipt,
    lateDays,
    lateFee,
    status: lateDays > 0 ? 'Overdue' : status || 'Pending',
  }
}

export function uniqueCharges(charges) {
  const unique = []
  const seen = new Set()
  for (const charge of Array.isArray(charges) ? charges : []) {
    const month = normalizeMonthKey(charge.month)
    if (!month || seen.has(month)) continue
    seen.add(month)
    unique.push(normalizeCharge({ ...charge, month }))
  }
  return sortCharges(unique)
}

export function clampMonthDay(value, fallback = 1) {
  const day = Math.trunc(Number(value))
  if (!Number.isFinite(day)) return fallback
  return Math.min(31, Math.max(1, day))
}

export function normalizeAdmissionPayRange(row = {}) {
  let from
  let to
  if (row.admissionPayFromDay != null || row.admissionPayToDay != null) {
    from = clampMonthDay(row.admissionPayFromDay, 1)
    to = clampMonthDay(row.admissionPayToDay, 7)
  } else if (Array.isArray(row.admissionPayDays) && row.admissionPayDays.length) {
    const days = [...new Set(
      row.admissionPayDays
        .map((item) => Math.trunc(Number(item)))
        .filter((day) => Number.isFinite(day) && day >= 1 && day <= 31),
    )].sort((a, b) => a - b)
    from = days[0] ?? 1
    to = days[days.length - 1] ?? 7
  } else {
    from = 1
    to = 7
  }
  if (from > to) {
    const swap = from
    from = to
    to = swap
  }
  return { admissionPayFromDay: from, admissionPayToDay: to }
}

export function dayOfYmd(ymd) {
  const match = String(ymd ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? Number(match[3]) : 0
}

/** Billing uses the date the admin created the resident, not Google linking. */
export function residentOwesMonth(resident, monthKey, settings = {}) {
  const month = normalizeMonthKey(monthKey)
  if (!month) return false
  const admission = String(resident?.admissionDate ?? '').trim()
  const admissionMonth = normalizeMonthKey(admission)
  if (!admissionMonth) return true
  if (admissionMonth < month) return true
  if (admissionMonth > month) return false
  if (resident?.billFromNextMonth) return false
  const { admissionPayFromDay, admissionPayToDay } = normalizeAdmissionPayRange(settings)
  const day = dayOfYmd(admission)
  return day >= admissionPayFromDay && day <= admissionPayToDay
}

export function normalizeSettings(row = {}) {
  const charges = uniqueCharges(
    Array.isArray(row.monthlyCharges)
      ? row.monthlyCharges.map((charge) => normalizeCharge(charge))
      : [],
  )
  const latest = latestCharge(charges)
  const admissionRange = normalizeAdmissionPayRange(row)
  return {
    lateFeeRate: Number(row.lateFeeRate ?? 0),
    lateFeePerDay: Number(row.lateFeePerDay ?? 0),
    admissionPayFromDay: admissionRange.admissionPayFromDay,
    admissionPayToDay: admissionRange.admissionPayToDay,
    baseMonthlyExpense: Number(latest?.amount || row.baseMonthlyExpense) || 150,
    monthlyCharges: sortCharges(charges),
  }
}

export function settingsToPayload(settings) {
  const normalized = normalizeSettings(settings)
  return {
    lateFeeRate: normalized.lateFeeRate,
    lateFeePerDay: normalized.lateFeePerDay,
    admissionPayFromDay: normalized.admissionPayFromDay,
    admissionPayToDay: normalized.admissionPayToDay,
    baseMonthlyExpense: normalized.baseMonthlyExpense,
    monthlyCharges: normalized.monthlyCharges,
  }
}
