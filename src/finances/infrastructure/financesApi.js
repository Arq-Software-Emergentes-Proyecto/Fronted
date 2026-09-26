import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { Receipt } from '../domain/receipt.js'
import { normalizeSettings, settingsToPayload } from '../domain/billingCycle.js'

export const financesApi = {
  async getSettings() {
    const { data } = await apiClient.get('/financeSettings', { params: withOwnerParams() })
    const row = Array.isArray(data) ? data[0] : data
    if (row && typeof row === 'object') return normalizeSettings(row)
    return normalizeSettings({})
  },

  async getResidents() {
    const { data } = await apiClient.get('/api/v1/users', {
      params: withOwnerParams({ role: 'resident' }),
    })
    return (Array.isArray(data) ? data : []).map((row) => {
      const admissionMatch = String(row?.admissionDate ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/)
      return {
        ...row,
        admissionDate: admissionMatch ? admissionMatch[1] : '',
        billFromNextMonth: Boolean(row.billFromNextMonth),
      }
    })
  },

  async getReceipts() {
    const { data } = await apiClient.get('/receipts', { params: withOwnerParams() })
    return (Array.isArray(data) ? data : []).map((d) => new Receipt(d))
  },

  async getReceiptsByResident(residentId) {
    const { data } = await apiClient.get('/receipts', {
      params: withOwnerParams({ residentId }),
    })
    return (Array.isArray(data) ? data : []).map((d) => new Receipt(d))
  },

  async deleteReceipt(receiptId) {
    const cleanId = String(receiptId ?? '').trim()
    if (!cleanId) return
    await apiClient.delete(`/receipts/${encodeURIComponent(cleanId)}`)
  },

  async createReceipt(receiptData) {
    const ownerId = getActiveDataOwnerId()
    const payload = {
      ...receiptData,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }
    const { data } = await apiClient.post('/receipts', payload)
    return new Receipt(data)
  },

  async updateReceipt(receiptId, updateData) {
    const { data } = await apiClient.patch(
      `/receipts/${encodeURIComponent(String(receiptId))}`,
      updateData,
    )
    return new Receipt(data)
  },

  async getFees(residentId) {
    // 1. Fetch both tables: receipts and fees
    const [receiptsRes, feesRes] = await Promise.all([
      apiClient.get('/receipts', { params: withOwnerParams({ residentId }) }),
      apiClient.get('/fees', { params: withOwnerParams({ residentId }) })
    ]);

    const receiptsData = receiptsRes.data || [];
    const feesData = feesRes.data || [];

    // 2. Map receipts to unified format
    const mappedReceipts = receiptsData.map(receipt => {
      let monthName = '';
      if (receipt.dueDate) {
        const [year, month, day] = receipt.dueDate.split('-');
        const dateObj = new Date(year, parseInt(month) - 1, day);
        const name = dateObj.toLocaleString('es-PE', { month: 'long', year: 'numeric' });
        monthName = name.charAt(0).toUpperCase() + name.slice(1);
      }
      return {
        id: `receipt-${receipt.id}`,
        originalId: receipt.id,
        type: 'receipt',
        residentId: receipt.residentId,
        month: monthName || "Mes Actual",
        amount: Number(receipt.amount) + Number(receipt.lateFee || 0) + Number(receipt.extraCharges || 0),
        dueDate: receipt.dueDate,
        status: receipt.status === 'Paid' ? 'Pagado' : 'Pendiente',
        concept: receipt.concept || "Mantenimiento"
      };
    });

    // 3. Map fees to unified format
    const mappedFees = feesData.map(fee => {
      return {
        id: `fee-${fee.id}`,
        originalId: fee.id,
        type: 'fee',
        residentId: fee.residentId,
        month: fee.month || "Mes Actual",
        amount: Number(fee.amount),
        dueDate: fee.dueDate,
        status: fee.status === 'Pagado' ? 'Pagado' : 'Pendiente',
        concept: fee.concept || "Cuota Mantenimiento"
      };
    });

    // 4. Combine both
    const combined = [...mappedReceipts, ...mappedFees];

    // 5. Fallback if totally empty
    if (combined.length === 0) {
      return [
        {
          id: `mock-1-${residentId}`,
          residentId,
          month: "Mayo 2026",
          amount: 150,
          dueDate: "2026-05-31",
          status: "Pendiente",
          concept: "Mantenimiento (Estimado)"
        }
      ];
    }
    
    // Sort by due date descending
    return combined.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  },

  async addFee(feeData) {
    const ownerId = getActiveDataOwnerId()
    const receiptData = {
      residentId: feeData.residentId,
      issueDate: new Date().toISOString().split('T')[0],
      dueDate: feeData.dueDate,
      amount: feeData.amount,
      status: feeData.status === 'Pagado' ? 'Paid' : 'Pending',
      lateFee: 0,
      ...(ownerId ? { ownerAdminId: ownerId } : {})
    };
    const { data } = await apiClient.post('/receipts', receiptData);
    return data;
  },

  async getPayments(residentId) {
    const { data } = await apiClient.get('/payments', { params: withOwnerParams({ residentId }) });
    return data;
  },

  async getAllPayments() {
    const { data } = await apiClient.get('/payments', { params: withOwnerParams() })
    return Array.isArray(data) ? data : []
  },

  async addPayment(paymentData) {
    const ownerId = getActiveDataOwnerId()
    const payload = {
      ...paymentData,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }
    const { data } = await apiClient.post('/payments', payload);
    return data;
  },

  async updateFeeStatus(feeId, status) {
    const idStr = String(feeId);
    if (idStr.startsWith('receipt-')) {
      const realId = idStr.replace('receipt-', '');
      const statusEn = status === 'Pagado' ? 'Paid' : 'Pending';
      const { data } = await apiClient.patch(`/receipts/${realId}`, { status: statusEn });
      return data;
    } else if (idStr.startsWith('fee-')) {
      const realId = idStr.replace('fee-', '');
      const statusEs = status === 'Pagado' ? 'Pagado' : 'Pendiente';
      const { data } = await apiClient.patch(`/fees/${realId}`, { status: statusEs });
      return data;
    }
    // Fallback for non-prefixed or mock
    return { id: feeId, status };
  },

  async getDashboardKpis() {
    const { data } = await apiClient.get('/kpi', { params: withOwnerParams() })
    const row = Array.isArray(data) ? data[0] : data
    if (!row || typeof row !== 'object') return { monthlyChart: [] }
    return row
  },

  async updateSettings(settings) {
    const params = withOwnerParams()
    const ownerId = getActiveDataOwnerId()
    const payload = settingsToPayload(settings)

    let data
    try {
      ;({ data } = await apiClient.patch('/financeSettings', payload, { params }))
    } catch (error) {
      if (error?.status === 404 || error?.code === 'SETTINGS_NOT_FOUND') {
        ;({ data } = await apiClient.post('/financeSettings', {
          ...payload,
          ...(ownerId ? { ownerAdminId: ownerId } : {}),
        }))
      } else {
        throw error
      }
    }

    return normalizeSettings(data)
  },
}
