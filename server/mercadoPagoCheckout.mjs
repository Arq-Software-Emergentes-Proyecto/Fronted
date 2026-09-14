const PLAN_PRICES_PEN = {
  essential: 40,
  standard: 80,
  scale: 120,
}

export function mercadoPagoAccessToken() {
  return String(process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim()
}

function jsonError(code, message, status = 400) {
  const error = new Error(message || code)
  error.code = code
  error.status = status
  return error
}

function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100) / 100
}

/**
 * @param {{
 *   kind: 'maintenance' | 'subscription',
 *   planId?: string,
 *   amount?: number,
 *   title?: string,
 *   payerEmail?: string,
 *   successUrl: string,
 *   failureUrl: string,
 *   pendingUrl: string,
 *   externalReference?: string,
 * }} payload
 */
export async function createMercadoPagoPreference(payload) {
  const token = mercadoPagoAccessToken()
  if (!token) throw jsonError('MP_ACCESS_TOKEN_MISSING', 'Mercado Pago is not configured', 503)

  const kind = payload?.kind === 'subscription' ? 'subscription' : 'maintenance'
  let unitPrice = 0
  let title = String(payload?.title ?? '').trim()

  if (kind === 'subscription') {
    const planId = String(payload?.planId ?? '').trim()
    unitPrice = money(PLAN_PRICES_PEN[planId])
    if (!unitPrice) throw jsonError('INVALID_PLAN', 'That plan cannot be purchased', 400)
    title = title || `BuildingFex ${planId}`
  } else {
    unitPrice = money(payload?.amount)
    if (!unitPrice) throw jsonError('INVALID_AMOUNT', 'A positive amount is required', 400)
    title = title || 'Cuotas BuildingFex'
  }

  const successUrl = String(payload?.successUrl ?? '').trim()
  const failureUrl = String(payload?.failureUrl ?? '').trim()
  const pendingUrl = String(payload?.pendingUrl ?? '').trim()
  if (!successUrl || !failureUrl || !pendingUrl) {
    throw jsonError('INVALID_RETURN_URL', 'Checkout return URLs are required', 400)
  }

  const body = {
    items: [
      {
        id: kind === 'subscription' ? `plan-${payload.planId}` : 'maintenance',
        title: title.slice(0, 120),
        quantity: 1,
        currency_id: 'PEN',
        unit_price: unitPrice,
      },
    ],
    back_urls: {
      success: successUrl,
      failure: failureUrl,
      pending: pendingUrl,
    },
    statement_descriptor: 'BUILDINGFEX',
    external_reference: String(payload?.externalReference ?? '').slice(0, 256),
    metadata: {
      kind,
      planId: kind === 'subscription' ? String(payload.planId) : '',
    },
  }
  if (/^https:\/\//i.test(successUrl) && !successUrl.includes('?')) {
    body.auto_return = 'approved'
  }

  const email = String(payload?.payerEmail ?? '').trim()
  if (email.includes('@')) body.payer = { email }

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw jsonError(
      'MP_PREFERENCE_FAILED',
      data?.message || data?.error || `Mercado Pago HTTP ${response.status}`,
      response.status,
    )
  }

  const initPoint = data.init_point || data.sandbox_init_point
  if (!initPoint) throw jsonError('MP_PREFERENCE_FAILED', 'Mercado Pago did not return a checkout URL', 502)

  return {
    preferenceId: data.id,
    initPoint,
    demo: false,
    amount: unitPrice,
    planId: kind === 'subscription' ? String(payload.planId) : undefined,
  }
}

export async function readMercadoPagoPayment(paymentId) {
  const token = mercadoPagoAccessToken()
  if (!token) throw jsonError('MP_ACCESS_TOKEN_MISSING', 'Mercado Pago is not configured', 503)
  const id = String(paymentId ?? '').trim()
  if (!id) throw jsonError('INVALID_PAYMENT', 'payment id is required', 400)

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw jsonError(
      'MP_PAYMENT_LOOKUP_FAILED',
      data?.message || `Mercado Pago HTTP ${response.status}`,
      response.status,
    )
  }
  return {
    id: data.id,
    status: data.status,
    statusDetail: data.status_detail,
    approved: data.status === 'approved',
    amount: Number(data.transaction_amount ?? 0),
    externalReference: data.external_reference ?? '',
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

export function sendError(res, error) {
  const status = Number(error?.status) || 500
  sendJson(res, status, {
    code: error?.code || 'MP_ERROR',
    message: error?.message || 'Mercado Pago request failed',
  })
}
