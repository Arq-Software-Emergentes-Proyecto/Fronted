import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { apiError } from '@/shared/infrastructure/api/utils.js'
import {
  checkoutReturnUrl,
  readMercadoPagoPayment,
  startMercadoPagoCheckout,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'

function parseSubscription(data) {
  if (!data || typeof data !== 'object') return null
  return {
    planId: String(data.planId ?? data.PlanId ?? 'free'),
    residentLimit: Number(data.residentLimit ?? data.ResidentLimit ?? 9),
    residentsCount: Number(data.residentsCount ?? data.ResidentsCount ?? 0),
    monthlyPricePen: Number(data.monthlyPricePen ?? data.MonthlyPricePen ?? 0),
    paidUntil: data.paidUntil ?? data.PaidUntil ?? null,
    isPaid: Boolean(data.isPaid ?? data.IsPaid),
  }
}

export const subscriptionApi = {
  async getCurrent() {
    const { data } = await apiClient.get('/api/v1/subscription')
    return parseSubscription(data)
  },

  async changeToFreePlan() {
    const { data } = await apiClient.patch('/api/v1/subscription', { planId: 'free' })
    return parseSubscription(data)
  },

  async checkout(planId) {
    const frontendBaseUrl = typeof window !== 'undefined' ? window.location.origin : undefined
    try {
      const { data } = await apiClient.post('/api/v1/subscription/checkout', {
        planId,
        ...(frontendBaseUrl ? { frontendBaseUrl } : {}),
      })
      if (data?.initPoint && !data?.demo && !data?.Demo) {
        return {
          preferenceId: data?.preferenceId ?? data?.PreferenceId ?? null,
          initPoint: data.initPoint ?? data.InitPoint,
          demo: false,
          amount: Number(data?.amount ?? data?.Amount ?? 0),
          planId: String(data?.planId ?? data?.PlanId ?? planId),
        }
      }
    } catch {
      /* fall through to Checkout Pro on this app */
    }

    return startMercadoPagoCheckout({
      kind: 'subscription',
      planId,
      title: `BuildingFex ${planId}`,
      externalReference: `subscription:${planId}`,
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
    const payment = await readMercadoPagoPayment(paymentId)
    if (!payment.approved) {
      const error = new Error('PAYMENT_NOT_APPROVED')
      error.code = 'PAYMENT_NOT_APPROVED'
      throw error
    }

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
