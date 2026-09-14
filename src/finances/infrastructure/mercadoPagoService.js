/**
 * Mercado Pago Checkout Pro for resident maintenance fees.
 * Preferences are created by the local /mp/checkout server (token never reaches the browser).
 * Confirmation still goes through the BuildingFex API / local preview store.
 */

import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import {
  checkoutReturnUrl,
  readMercadoPagoPayment,
  startMercadoPagoCheckout,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'

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
  const ownerId = getActiveDataOwnerId()
  const frontendBaseUrl = typeof window !== 'undefined' ? window.location.origin : undefined

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
  } catch {
    /* fall through to Checkout Pro on this app */
  }

  return startMercadoPagoCheckout({
    kind: 'maintenance',
    residentId: String(residentId),
    amount,
    title: title || 'Cuotas BuildingFex',
    payerEmail,
    externalReference: `maintenance:${residentId}:${ownerId || ''}`,
    successUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE),
    failureUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE, { payment: 'failure' }),
    pendingUrl: checkoutReturnUrl(AppPaths.APP_RESIDENT_FINANCE, { payment: 'pending' }),
  })
}

/**
 * Confirm maintenance payment after Checkout Pro return.
 */
export async function confirmMaintenancePayment({ residentId, paymentId = null } = {}) {
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
