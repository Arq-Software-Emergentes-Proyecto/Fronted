import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'
import {
  checkoutReturnUrl,
  startMercadoPagoCheckout,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'

function optionalNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseSubscription(data) {
  if (!data || typeof data !== 'object') return null
  const residentLimit = Number(data.residentLimit ?? data.ResidentLimit ?? 15)
  const residentsCount = Number(data.residentsCount ?? data.ResidentsCount ?? 0)
  return {
    planId: String(data.planId ?? data.PlanId ?? 'free'),
    residentLimit,
    residentsCount,
    monthlyPricePen: Number(data.monthlyPricePen ?? data.MonthlyPricePen ?? 0),
    paidUntil: data.paidUntil ?? data.PaidUntil ?? null,
    isPaid: Boolean(data.isPaid ?? data.IsPaid),
    /** TRIAL | ACTIVE | PAYMENT_FAILED | SUSPENDED | CANCELLED (Billing Subscription aggregate). */
    status: String(data.status ?? data.Status ?? 'TRIAL'),
    trialEndsAt: data.trialEndsAt ?? data.TrialEndsAt ?? null,
    trialDaysLeft: optionalNumber(data.trialDaysLeft ?? data.TrialDaysLeft),
    trialExpired: Boolean(data.trialExpired ?? data.TrialExpired),
    requiresPlanSelection: Boolean(data.requiresPlanSelection ?? data.RequiresPlanSelection),
    canAddResidents:
      data.canAddResidents != null || data.CanAddResidents != null
        ? Boolean(data.canAddResidents ?? data.CanAddResidents)
        : residentsCount < residentLimit,
    maxDepartments: Number(data.maxDepartments ?? data.MaxDepartments ?? residentLimit),
    monthlyAiQueries: optionalNumber(data.monthlyAiQueries ?? data.MonthlyAiQueries),
    billableDepartments: Number(data.billableDepartments ?? data.BillableDepartments ?? residentsCount),
    buildingId: optionalNumber(data.buildingId ?? data.BuildingId),
    suggestedPlanId: data.suggestedPlanId ?? data.SuggestedPlanId ?? null,
  }
}

function parseLimits(data) {
  if (!data || typeof data !== 'object') return null
  return {
    planId: String(data.planId ?? 'free'),
    status: String(data.status ?? 'TRIAL'),
    maxDepartments: Number(data.maxDepartments ?? 0),
    departmentsUsed: Number(data.departmentsUsed ?? 0),
    departmentsAvailable: Number(data.departmentsAvailable ?? 0),
    monthlyAiQueries: Number(data.monthlyAiQueries ?? 0),
    aiQueriesUsed: optionalNumber(data.aiQueriesUsed),
    canAddResidents: Boolean(data.canAddResidents),
  }
}

export const subscriptionApi = {
  async getCurrent() {
    const { data } = await apiClient.get('/api/v1/subscription')
    return parseSubscription(data)
  },

  /** Plan caps of the caller's condominium (admin or resident). */
  async getLimits() {
    const { data } = await apiClient.get('/api/v1/subscription/limits')
    return parseLimits(data)
  },

  async changeToFreePlan() {
    const { data } = await apiClient.patch('/api/v1/subscription', { planId: 'free' })
    return parseSubscription(data)
  },

  async checkout(planId) {
    const frontendBaseUrl = typeof window !== 'undefined' ? window.location.origin : undefined
    let serverCheckout = null
    try {
      const { data } = await apiClient.post('/api/v1/subscription/checkout', {
        planId,
        ...(frontendBaseUrl ? { frontendBaseUrl } : {}),
      })
      serverCheckout = data
      if (data?.initPoint && !data?.demo && !data?.Demo) {
        return {
          preferenceId: data?.preferenceId ?? data?.PreferenceId ?? null,
          initPoint: data.initPoint ?? data.InitPoint,
          demo: false,
          amount: Number(data?.amount ?? data?.Amount ?? 0),
          planId: String(data?.planId ?? data?.PlanId ?? planId),
        }
      }
    } catch (error) {
      // Business rejections (e.g. too many residents for the plan) must reach the UI.
      if (error?.status === 400 && error?.code && error.code !== 'CHECKOUT_ERROR') throw error
      /* otherwise fall through to Checkout Pro on this app */
    }

    const departmentCount = Number(serverCheckout?.departmentCount ?? serverCheckout?.DepartmentCount)
    return startMercadoPagoCheckout({
      kind: 'subscription',
      planId,
      title: `BuildingFex ${planId}`,
      ...(Number.isFinite(departmentCount) && departmentCount > 0 ? { departmentCount } : {}),
      // Same format the API verifies on confirm: SUBSCRIPTION:{adminId}:{planId}[:{departments}] (Portafolio)
      externalReference:
        serverCheckout?.externalReference ??
        `subscription:${getActiveDataOwnerId() || ''}:${planId}`,
      successUrl: checkoutReturnUrl(AppPaths.APP_SETTINGS),
      failureUrl: checkoutReturnUrl(AppPaths.APP_SETTINGS, { subscription: 'failure' }),
      pendingUrl: checkoutReturnUrl(AppPaths.APP_SETTINGS, { subscription: 'pending' }),
    })
  },

  async confirm({ planId, paymentId = null }) {
    if (paymentId == null || !String(paymentId).length) {
      const error = new Error('PAYMENT_REQUIRED')
      error.code = 'PAYMENT_REQUIRED'
      throw error
    }
    // The API verifies the payment with Mercado Pago (status, amount, plan): no browser pre-check.
    const { data } = await apiClient.post('/api/v1/subscription/confirm', {
      planId,
      paymentId,
      demo: false,
    })
    const subscription = parseSubscription(data?.subscription ?? data?.Subscription)
    return {
      activated: Boolean(data?.activated ?? data?.Activated),
      planId: String(data?.planId ?? data?.PlanId ?? planId),
      paidUntil: data?.paidUntil ?? data?.PaidUntil ?? null,
      subscription,
    }
  },
}

export function subscriptionApiError(error) {
  if (error?.code === 'PLAN_DOWNGRADE_RESIDENTS_EXCEEDED') {
    throw apiError(error.code, error.payload?.message)
  }
  if (error?.code === 'PAID_PLAN_REQUIRES_CHECKOUT') {
    throw apiError(error.code, error.payload?.message)
  }
  throw error
}
