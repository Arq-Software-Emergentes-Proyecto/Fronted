/**
 * Mercado Pago Checkout Pro for resident maintenance fees.
 * Preferences are created by the local /mp/checkout server (token never reaches the browser).
 * Confirmation still goes through the BuildingFex API / local preview store.
 */

import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import {
  checkoutReturnUrl,
  startMercadoPagoCheckout,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'
import { isDemoSession } from '@/iam/application/localPreviewAuth.js'

/**
 * Start Checkout Pro for pending maintenance fees (resident).
 * @param {{ residentId: string, payerEmail?: string, amount: number, title?: string }} params
 */
export async function checkoutMaintenanceFees({
  residentId,
  payerEmail,
  amount,
  title,
} = {}) {
  // Demo account: no real Mercado Pago. Comes back as an approved payment and the mock confirms it.
  if (isDemoSession()) {
    return {
      preferenceId: 'DEMO',
      initPoint: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE, {
        status: 'approved',
        payment_id: String(Date.now()),
      }),
      demo: true,
    }
  }

  const ownerId = getActiveDataOwnerId()
  const frontendBaseUrl = typeof window !== 'undefined' ? window.location.origin : undefined

  // The API snapshots the pending items + total (checkoutId). Reconciliation only pays
  // those items and requires the approved amount to match, so the fallback below must
  // reuse the server amount and reference instead of the client-side total.
  let serverCheckout = null
  try {
    const { data } = await apiClient.post('/api/v1/payments/checkout', {
      residentId: String(residentId),
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
      ...(payerEmail ? { payerEmail } : {}),
      ...(frontendBaseUrl ? { frontendBaseUrl } : {}),
    })
    if (data?.initPoint && !data?.demo) {
      return {
        preferenceId: data.preferenceId,
        initPoint: data.initPoint,
        demo: false,
      }
    }
    if (data?.checkoutId) serverCheckout = data
  } catch (error) {
    // Nothing pending / forbidden: do not open a payment the server cannot reconcile.
    if (error?.status === 400 || error?.status === 403) throw error
    /* network error: fall through to Checkout Pro on this app */
  }

  const fallbackAmount =
    serverCheckout?.amount != null ? Number(serverCheckout.amount) : amount
  const externalReference =
    serverCheckout?.externalReference ||
    `maintenance:${residentId}:${ownerId || ''}`

  return startMercadoPagoCheckout({
    kind: 'maintenance',
    residentId: String(residentId),
    amount: fallbackAmount,
    title: title || 'Cuotas BuildingFex',
    payerEmail,
    externalReference,
    successUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE),
    failureUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE, { payment: 'failure' }),
    pendingUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE, { payment: 'pending' }),
  })
}

/**
 * Confirm maintenance payment after Checkout Pro return. The API reads the payment from
 * Mercado Pago itself (status, amount, reference), so there is no browser-side pre-check:
 * it needed its own token on Vercel and, without it, the payment was never confirmed.
 */
export async function confirmMaintenancePayment({ residentId, paymentId = null } = {}) {
  if (paymentId == null || !String(paymentId).length) {
    const error = new Error('PAYMENT_REQUIRED')
    error.code = 'PAYMENT_REQUIRED'
    throw error
  }

  const ownerId = getActiveDataOwnerId()
  const { data } = await apiClient.post('/api/v1/payments/confirm', {
    residentId: String(residentId),
    ...(ownerId ? { ownerAdminId: ownerId } : {}),
    paymentId,
    demo: false,
  })

  return {
    reconciled: Boolean(data.reconciled),
    itemsPaid: Number(data.itemsPaid ?? 0),
    paidAt: data.paidAt ?? null,
  }
}

/**
 * Create a MercadoPago payment preference for a single receipt (legacy).
 */
export async function createPaymentPreference(receiptId) {
  const ownerId = getActiveDataOwnerId()
  const { data } = await apiClient.post('/api/v1/payments/preference', {
    receiptId: String(receiptId),
    ...(ownerId ? { ownerAdminId: ownerId } : {}),
  })
  return {
    preferenceId: data.preferenceId,
    initPoint: data.initPoint ?? null,
  }
}

export function isPaymentApproved(result) {
  return result?.status === 'approved'
}
