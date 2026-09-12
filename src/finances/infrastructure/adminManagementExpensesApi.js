import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'

/**
 * Gastos administrativos (mock json-server) para vista recaudaciones.
 */
export const adminManagementExpensesApi = {
  async list() {
    const { data } = await apiClient.get('/adminManagementExpenses', {
      params: withOwnerParams(),
    })
    return Array.isArray(data) ? data : []
  },

  async add({ name, amount, purchaseDate, invoicePhotoUrl }) {
    const cleanName = String(name ?? '').trim()
    const parsedAmount = amount === '' || amount == null ? Number.NaN : Number(amount)
    const dateStr = String(purchaseDate ?? '').trim()

    if (!cleanName || !Number.isFinite(parsedAmount) || parsedAmount < 0 || !dateStr) {
      throw apiError(
        'ADMIN_EXPENSE_FIELDS_REQUIRED',
        'Name, a valid amount, and purchase date are required.',
      )
    }

    const ownerId = getActiveDataOwnerId()
    const newRow = {
      id: `admin-exp-${Date.now()}`,
      name: cleanName,
      amount: parsedAmount,
      purchaseDate: dateStr,
      invoicePhotoUrl: String(invoicePhotoUrl ?? '').trim(),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/adminManagementExpenses', newRow)
    return created
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('ADMIN_EXPENSE_NOT_FOUND', 'Expense id is required.')
    }
    await apiClient.delete(`/adminManagementExpenses/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },
}
