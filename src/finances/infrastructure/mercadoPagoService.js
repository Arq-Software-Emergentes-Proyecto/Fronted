/**
 * Mercado Pago Checkout Pro for resident maintenance fees.
 * Only BuildingFex.Api creates the preference (server-side amount and reference) and confirms it;
 * the browser never builds a payment on its own.
 */

import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { checkoutReturnUrl } from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'
import { isDemoSession } from '@/iam/application/localPreviewAuth.js'

/**
 * Start Checkout Pro for pending maintenance fees (resident).
 * The amount comes from the API (pending fees), never from the browser.
 * @param {{ residentId: string, payerEmail?: string }} params
 */
export async function checkoutMaintenanceFees({ residentId, payerEmail } = {}) {
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

  // The API snapshots the pending items + total and builds the reference; 400/403 (nothing pending,
  // forbidden) reach the UI as they are.
  const { data } = await apiClient.post('/api/v1/payments/checkout', {
    residentId: String(residentId),
    ...(ownerId ? { ownerAdminId: ownerId } : {}),
    ...(payerEmail ? { payerEmail } : {}),
    ...(frontendBaseUrl ? { frontendBaseUrl } : {}),
  })
  if (!data?.initPoint || data?.demo) {
    const error = new Error('No se pudo iniciar el pago con Mercado Pago. Intenta de nuevo en unos minutos.')
    error.code = 'CHECKOUT_UNAVAILABLE'
    throw error
  }
  return {
    preferenceId: data.preferenceId,
    initPoint: data.initPoint,
    demo: false,
  }
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
