import { reactive } from 'vue'
import { financesApi } from '@/finances/infrastructure/financesApi.js'

const state = reactive({
  fees: [],
  paymentHistory: [],
  settings: null,
  isLoading: false,
  error: null
})

export function useResidentPaymentStore() {
  async function loadData(residentId) {
    if (!residentId) return
    state.isLoading = true
    state.error = null
    try {
      const [fees, history, settings] = await Promise.all([
        financesApi.getFees(residentId),
        financesApi.getPayments(residentId),
        financesApi.getSettings()
      ])
      state.fees = fees
      state.paymentHistory = history
      state.settings = settings
    } catch (err) {
      console.error(err)
      state.error = err.message || 'Failed to load finances data'
    } finally {
      state.isLoading = false
    }
  }

  // Paying is server-side only: Mercado Pago checkout + webhook/confirm reconcile the debt.
  // (The old local recordPayment marked fees paid fire-and-forget from the browser.)
  return { state, loadData }
}
