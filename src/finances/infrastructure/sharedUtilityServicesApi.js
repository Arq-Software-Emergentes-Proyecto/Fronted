import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

const VALID_TYPES = new Set(['water', 'electricity'])

/** YYYY-MM for the current local month. */
function currentMonthPrefix() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Pick the receipt that should carry the current-month service charge for a resident. */
function pickTargetReceipt(receipts, monthPrefix) {
  const pending = receipts.filter((r) => r.status !== 'Paid')

  const currentMonth = pending.filter(
    (r) =>
      String(r.dueDate ?? '').startsWith(monthPrefix) ||
      String(r.issueDate ?? '').startsWith(monthPrefix),
  )
  const pool = currentMonth.length ? currentMonth : pending
  if (!pool.length) return null

  return pool.reduce((latest, r) =>
    String(r.dueDate ?? '') > String(latest.dueDate ?? '') ? r : latest,
  )
}

/**
 * Split a shared-service amount equally across every department (resident) and add
 * each share to that resident's current-month receipt so it is reflected in what
 * they pay this month.
 * @returns {{ residentCount: number, perResidentShare: number }}
 */
async function distributeAcrossDepartments(amount) {
  const monthPrefix = currentMonthPrefix()
  const ownerId = getActiveDataOwnerId()

  const [{ data: residentsData }, { data: receiptsData }] = await Promise.all([
    apiClient.get('/api/v1/users', { params: withOwnerParams({ role: 'resident' }) }),
    apiClient.get('/receipts', { params: withOwnerParams() }),
  ])

  const residents = Array.isArray(residentsData) ? residentsData : []
  const receipts = Array.isArray(receiptsData) ? receiptsData : []
  const residentCount = residents.length
  if (residentCount === 0) return { residentCount: 0, perResidentShare: 0 }

  const perResidentShare = round2(amount / residentCount)
  const dueDate = `${monthPrefix}-28`
  const issueDate = new Date().toISOString().split('T')[0]

  await Promise.all(
    residents.map(async (resident) => {
      const resReceipts = receipts.filter((r) => r.residentId === resident.id)
      const target = pickTargetReceipt(resReceipts, monthPrefix)

      if (target) {
        const newExtra = round2((Number(target.extraCharges) || 0) + perResidentShare)
        await apiClient.patch(`/receipts/${target.id}`, {
          extraCharges: newExtra,
          concept: 'Mantenimiento + Servicios compartidos',
        })
      } else {
        await apiClient.post('/receipts', {
          id: Date.now() + Math.floor(Math.random() * 1000),
          residentId: resident.id,
          issueDate,
          dueDate,
          amount: 0,
          extraCharges: perResidentShare,
          status: 'Pending',
          lateFee: 0,
          concept: 'Servicios compartidos',
          ...(ownerId ? { ownerAdminId: ownerId } : {}),
        })
      }
    }),
  )

  return { residentCount, perResidentShare }
}

/** Undo a shared-service split on unpaid receipts for the same month. */
async function withdrawFromDepartments(perResidentShare, monthPrefix) {
  const share = round2(perResidentShare)
  const month = String(monthPrefix ?? '').trim() || currentMonthPrefix()
  if (!(share > 0)) return

  const [{ data: residentsData }, { data: receiptsData }] = await Promise.all([
    apiClient.get('/api/v1/users', { params: withOwnerParams({ role: 'resident' }) }),
    apiClient.get('/receipts', { params: withOwnerParams() }),
  ])

  const residents = Array.isArray(residentsData) ? residentsData : []
  const receipts = Array.isArray(receiptsData) ? receiptsData : []

  await Promise.all(
    residents.map(async (resident) => {
      const unpaid = receipts.filter(
        (row) => row.residentId === resident.id && row.status !== 'Paid',
      )
      if (!unpaid.length) return

      const monthMatches = unpaid.filter(
        (row) =>
          String(row.dueDate ?? '').startsWith(month) ||
          String(row.issueDate ?? '').startsWith(month),
      )
      const pool = (monthMatches.length ? monthMatches : unpaid).filter(
        (row) => Number(row.extraCharges) > 0,
      )
      if (!pool.length) return

      const target = pool.reduce((latest, row) =>
        String(row.dueDate ?? '') > String(latest.dueDate ?? '') ? row : latest,
      )

      const nextExtra = round2(Math.max(0, (Number(target.extraCharges) || 0) - share))
      const serviceOnly =
        (Number(target.amount) || 0) === 0 &&
        (Number(target.lateFee) || 0) === 0 &&
        nextExtra === 0 &&
        String(target.concept ?? '').includes('Servicios compartidos')

      if (serviceOnly) {
        await apiClient.delete(`/receipts/${target.id}`)
        return
      }

      const patch = { extraCharges: nextExtra }
      if (nextExtra === 0 && String(target.concept ?? '').includes('Servicios compartidos')) {
        patch.concept = 'Mantenimiento'
      }
      await apiClient.patch(`/receipts/${target.id}`, patch)
    }),
  )
}

/**
 * Servicios compartidos (agua, luz) para vista recaudaciones.
 */
export const sharedUtilityServicesApi = {
  async list() {
    const { data } = await apiClient.get('/sharedUtilityServices', {
      params: withOwnerParams(),
    })
    return Array.isArray(data) ? data : []
  },

  async add({ type, amount }) {
    const cleanType = String(type ?? '').trim()
    const parsedAmount = amount === '' || amount == null ? Number.NaN : Number(amount)

    if (!VALID_TYPES.has(cleanType) || !Number.isFinite(parsedAmount) || parsedAmount < 0) {
      throw apiError(
        'SHARED_SERVICE_FIELDS_REQUIRED',
        'A valid service type and amount are required.',
      )
    }

    const { residentCount, perResidentShare } = await distributeAcrossDepartments(parsedAmount)

    const ownerId = getActiveDataOwnerId()
    const newRow = {
      id: `shared-svc-${Date.now()}`,
      type: cleanType,
      amount: parsedAmount,
      month: currentMonthPrefix(),
      residentCount,
      perResidentShare,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/sharedUtilityServices', newRow)
    return created
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('SHARED_SERVICE_NOT_FOUND', 'Service id is required.')
    }

    let row = null
    try {
      ;({ data: row } = await apiClient.get(`/sharedUtilityServices/${encodeURIComponent(cleanId)}`))
    } catch (error) {
      if (error?.status === 404 || error?.code === 'HTTP_404') {
        throw apiError('SHARED_SERVICE_NOT_FOUND', 'Service not found.')
      }
      throw error
    }

    await withdrawFromDepartments(Number(row?.perResidentShare) || 0, String(row?.month ?? ''))
    await apiClient.delete(`/sharedUtilityServices/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
