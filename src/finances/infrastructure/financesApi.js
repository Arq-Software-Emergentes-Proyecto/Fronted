import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'
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
      // Billed month (yyyy-MM, from the API) wins: the due date falls in the following month
      // (e.g. October maintenance is due 7 Nov) and labelling by it shows the wrong month.
      if (/^\d{4}-\d{2}$/.test(String(receipt.billingMonth ?? ''))) {
        monthName = String(receipt.billingMonth)
      } else if (receipt.dueDate) {
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
        concept: receipt.concept || "Mantenimiento",
        billingMonth: receipt.billingMonth || '',
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

    // 5. Wireframe/mock mode only: placeholder row so screenshots are not empty.
    // With the real API an empty list means "no debt" — never invent a pending fee.
    if (combined.length === 0 && OPEN_WIREFRAME_ACCESS) {
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
    return combined.sort((a, b) => String(b.dueDate ?? '').localeCompare(String(a.dueDate ?? '')));
  },

  async getPayments(residentId) {
    const { data } = await apiClient.get('/payments', { params: withOwnerParams({ residentId }) });
    return data;
  },

  async getAllPayments() {
    const { data } = await apiClient.get('/payments', { params: withOwnerParams() })
    return Array.isArray(data) ? data : []
  },

  async getDashboardKpis() {
    const { data } = await apiClient.get('/kpi', { params: withOwnerParams() })
    const row = Array.isArray(data) ? data[0] : data
    if (!row || typeof row !== 'object') return { monthlyChart: [] }
    return row
  },

  /** TS003 / RF021: facturación idempotente del mes en el servidor (default: mes actual). */
  async generateMonthlyReceipts(month) {
    const { data } = await apiClient.post(
      '/api/v1/finances/receipts/generate',
      month ? { month } : {},
    )
    return data
  },

  /** US021: alertas de facturación (p. ej. MISSING_MONTHLY_CHARGE). */
  async getBillingAlerts() {
    const { data } = await apiClient.get('/api/v1/finances/billing-alerts')
    return Array.isArray(data) ? data : []
  },

  /** RF029: semáforo residente × mes. Residente: solo su fila (lo fuerza el backend). */
  async getPaymentCalendar({ residentId, months = 6 } = {}) {
    const params = { months }
    if (residentId) params.residentId = residentId
    const { data } = await apiClient.get('/api/v1/finances/payment-calendar', { params })
    return {
      today: data?.today ?? '',
      dueSoonDays: Number(data?.dueSoonDays) || 5,
      months: Array.isArray(data?.months) ? data.months : [],
      residents: Array.isArray(data?.residents) ? data.residents : [],
    }
  },

  /** RF030: ingresos, egresos y balance neto de un mes "yyyy-MM". */
  async getMonthlyBalance(month) {
    const { data } = await apiClient.get('/api/v1/finances/balance', {
      params: month ? { month } : {},
    })
    return {
      month: data?.month ?? month,
      income: Number(data?.income) || 0,
      expenses: Number(data?.expenses) || 0,
      net: Number(data?.net) || 0,
    }
  },

  /** RF022: comprobante PDF de un pago aprobado. */
  async downloadPaymentReceipt(paymentId) {
    await downloadPdf(
      `/api/v1/finances/payments/${encodeURIComponent(String(paymentId))}/receipt-pdf`,
      `recibo-${paymentId}.pdf`,
    )
  },

  /** RF022: comprobante PDF de un recibo pagado. */
  async downloadReceiptPdf(receiptId) {
    await downloadPdf(
      `/api/v1/finances/receipts/${encodeURIComponent(String(receiptId))}/pdf`,
      `recibo-${receiptId}.pdf`,
    )
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

/** Descarga autenticada (Bearer) de un PDF y dispara el guardado en el navegador. */
async function downloadPdf(url, fallbackName) {
  const response = await apiClient.get(url, { responseType: 'blob' })
  const disposition = String(response.headers?.['content-disposition'] ?? '')
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  const fileName = match ? decodeURIComponent(match[1]) : fallbackName
  const blob =
    response.data instanceof Blob
      ? response.data
      : new Blob([response.data], { type: 'application/pdf' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
