import { apiClient } from '@/shared/infrastructure/api/apiClient.js'

function num(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parsePlan(raw) {
  return {
    id: String(raw.id ?? raw.Id ?? ''),
    name: String(raw.name ?? raw.Name ?? ''),
    monthlyPricePen: num(raw.monthlyPricePen ?? raw.MonthlyPricePen, 0),
    pricePerDepartmentPen: num(raw.pricePerDepartmentPen ?? raw.PricePerDepartmentPen),
    minimumMonthlyPricePen: num(raw.minimumMonthlyPricePen ?? raw.MinimumMonthlyPricePen),
    minDepartments: num(raw.minDepartments ?? raw.MinDepartments, 1),
    maxDepartments: num(raw.maxDepartments ?? raw.MaxDepartments, 0),
    monthlyAiQueries: num(raw.monthlyAiQueries ?? raw.MonthlyAiQueries, 0),
    trialDays: num(raw.trialDays ?? raw.TrialDays),
    isTrial: Boolean(raw.isTrial ?? raw.IsTrial),
    isPaid: Boolean(raw.isPaid ?? raw.IsPaid),
    support: String(raw.support ?? raw.Support ?? ''),
    modules: Array.isArray(raw.modules ?? raw.Modules) ? [...(raw.modules ?? raw.Modules)] : [],
    highlighted: Boolean(raw.highlighted ?? raw.Highlighted),
  }
}

/** Public plan catalog — GET /api/v1/plans (anonymous). */
export const plansApi = {
  async getCatalog() {
    const { data } = await apiClient.get('/api/v1/plans')
    const plans = Array.isArray(data?.plans ?? data?.Plans) ? (data.plans ?? data.Plans).map(parsePlan) : []
    if (!plans.length) {
      const error = new Error('PLANS_UNAVAILABLE')
      error.code = 'PLANS_UNAVAILABLE'
      throw error
    }
    return {
      currency: String(data?.currency ?? 'PEN'),
      trialDays: num(data?.trialDays, 30),
      modules: Array.isArray(data?.modules) ? [...data.modules] : [],
      plans,
    }
  },
}
