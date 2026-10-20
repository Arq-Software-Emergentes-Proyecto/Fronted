const MAINTENANCE_PENDING_KEY = 'bf.mp.maintenance'
const SUBSCRIPTION_PENDING_KEY = 'bf.mp.subscription'

function writePending(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

export function readPendingCheckout(key) {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearPendingCheckout(key) {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export const MpPendingKeys = {
  maintenance: MAINTENANCE_PENDING_KEY,
  subscription: SUBSCRIPTION_PENDING_KEY,
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data?.message || `HTTP ${response.status}`)
    error.code = data?.code || `HTTP_${response.status}`
    error.payload = data
    throw error
  }
  return data
}

export async function startMercadoPagoCheckout(payload) {
  if (payload?.kind === 'subscription') {
    writePending(SUBSCRIPTION_PENDING_KEY, { planId: payload.planId })
  } else {
    writePending(MAINTENANCE_PENDING_KEY, { residentId: payload.residentId })
  }
  const response = await fetch('/mp/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  return parseResponse(response)
}

export function checkoutReturnUrl(path, params) {
  const url = new URL(path, window.location.origin)
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && String(value).length) url.searchParams.set(key, String(value))
  })
  return url.toString()
}
