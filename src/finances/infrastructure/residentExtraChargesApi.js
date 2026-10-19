import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'
import { currentStatementMonthKey, computeChargeDates, todayYmd } from '../domain/billingCycle.js'

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function isPaid(status) {
  return status === 'Paid' || status === 'Pagado'
}

function pickTargetReceipt(receipts, monthKey) {
  const pending = (receipts || []).filter((row) => !isPaid(row.status))
  const current = pending.filter((row) => String(row.billingMonth || '') === String(monthKey))
  const pool = current.length ? current : pending
  if (!pool.length) return null
  return pool.reduce((latest, row) =>
    String(row.dueDate ?? '') > String(latest.dueDate ?? '') ? row : latest,
  )
}

async function applyExtraToReceipt(residentId, amount, title) {
  const monthKey = currentStatementMonthKey()
  const dates = computeChargeDates(monthKey)
  const { data } = await apiClient.get('/receipts', {
    params: withOwnerParams({ residentId }),
  })
  const receipts = Array.isArray(data) ? data : []
  const target = pickTargetReceipt(receipts, monthKey)

  if (target) {
    const extraCharges = round2((Number(target.extraCharges) || 0) + amount)
    await apiClient.patch(`/receipts/${target.id}`, {
      extraCharges,
      concept: title,
    })
    return
  }

  const ownerId = getActiveDataOwnerId()
  // kind 'extra': a standalone extra-charge receipt never counts as (or collides with) the monthly fee receipt.
  await apiClient.post('/receipts', {
    id: `extra-${Date.now()}`,
    kind: 'extra',
    residentId,
    issueDate: todayYmd(),
    dueDate: dates.paymentDue || dates.billingEnd,
    amount: 0,
    extraCharges: amount,
    status: 'Pending',
    lateFee: 0,
    billingMonth: monthKey,
    paymentOpen: dates.paymentOpen,
    concept: title,
    ...(ownerId ? { ownerAdminId: ownerId } : {}),
  })
}

export const residentExtraChargesApi = {
  async list() {
    const { data } = await apiClient.get('/residentExtraCharges', {
      params: withOwnerParams(),
    })
    return Array.isArray(data) ? data : []
  },

  async add({ residentId, title, amount, description }) {
    const cleanResidentId = String(residentId ?? '').trim()
    const cleanTitle = String(title ?? '').trim()
    const cleanDescription = String(description ?? '').trim()
    const parsedAmount = amount === '' || amount == null ? Number.NaN : Number(amount)

    if (!cleanResidentId || !cleanTitle || !cleanDescription || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw apiError(
        'EXTRA_CHARGE_FIELDS_REQUIRED',
        'Resident, title, amount, and description are required.',
      )
    }

    await applyExtraToReceipt(cleanResidentId, round2(parsedAmount), cleanTitle)

    const ownerId = getActiveDataOwnerId()
    const { data: created } = await apiClient.post('/residentExtraCharges', {
      id: `extra-charge-${Date.now()}`,
      residentId: cleanResidentId,
      title: cleanTitle,
      amount: round2(parsedAmount),
      description: cleanDescription,
      createdAt: new Date().toISOString(),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    })
    return created
  },
}
