import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

/** YYYY-MM-DD in local timezone */
export function formatLocalYYYYMMDD(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function compareYMD(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Add whole days to a calendar date given as YYYY-MM-DD */
export function addDaysYMD(ymd, daysToAdd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + Number(daysToAdd))
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function flushDuePaymentsForRow(row, todayStr) {
  let next = String(row.nextPaymentDate ?? '').trim()
  if (!next) return null

  const interval = Math.max(1, Math.floor(Number(row.intervalDays) || 30))
  const salary = Number(row.salary) || 0
  const hist = Array.isArray(row.paymentHistory) ? [...row.paymentHistory] : []
  let changed = false

  let guard = 0
  while (compareYMD(next, todayStr) <= 0 && guard < 5000) {
    guard += 1
    hist.push({
      id: `pay-${row.id}-${hist.length}-${Date.now()}`,
      paidOn: next,
      amount: salary,
    })
    next = addDaysYMD(next, interval)
    changed = true
  }

  return changed ? { ...row, paymentHistory: hist, nextPaymentDate: next } : null
}

/**
 * Periodic fixed payouts (salary-style), persisted on json-server.
 */
export const fixedPayoutRecipientsApi = {
  async list() {
    const { data } = await apiClient.get('/fixedPayoutRecipients', {
      params: withOwnerParams(),
    })
    return Array.isArray(data) ? data : []
  },

  async listWithDueApplied() {
    const todayStr = formatLocalYYYYMMDD()
    const rows = await this.list()
    const patched = []

    for (const row of rows) {
      const updated = flushDuePaymentsForRow(row, todayStr)
      if (updated) patched.push(updated)
    }

    for (const row of patched) {
      await apiClient.put(`/fixedPayoutRecipients/${encodeURIComponent(row.id)}`, row)
    }

    return patched.length ? fixedPayoutRecipientsApi.list() : rows
  },

  async add({ name, dni, phone, salary, intervalDays, photoUrl }) {
    const cleanName = String(name ?? '').trim()
    const cleanDni = String(dni ?? '').trim()
    const cleanPhone = String(phone ?? '').trim()
    const parsedSalary = salary === '' || salary == null ? Number.NaN : Number(salary)
    const interval = Math.floor(Number(intervalDays))
    const intervalResolved = Number.isFinite(interval) && interval >= 1 ? interval : Number.NaN

    if (
      !cleanName ||
      !cleanDni ||
      !cleanPhone ||
      !Number.isFinite(parsedSalary) ||
      parsedSalary < 0 ||
      !Number.isFinite(intervalResolved)
    ) {
      throw apiError(
        'FIXED_PAYOUT_FIELDS_REQUIRED',
        'Name, DNI, phone, valid salary and interval days are required.',
      )
    }

    const todayStr = formatLocalYYYYMMDD()
    const ownerId = getActiveDataOwnerId()
    const newRow = {
      id: `fp-${Date.now()}`,
      name: cleanName,
      dni: cleanDni,
      phone: cleanPhone,
      salary: parsedSalary,
      intervalDays: intervalResolved,
      nextPaymentDate: addDaysYMD(todayStr, intervalResolved),
      photoUrl: String(photoUrl ?? '').trim(),
      paymentHistory: [],
      createdAt: new Date().toISOString(),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/fixedPayoutRecipients', newRow)
    return created
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('FIXED_PAYOUT_NOT_FOUND', 'Recipient id is required.')
    }
    await apiClient.delete(`/fixedPayoutRecipients/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
