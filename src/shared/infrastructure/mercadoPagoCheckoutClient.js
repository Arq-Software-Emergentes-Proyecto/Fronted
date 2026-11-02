const MAINTENANCE_PENDING_KEY = 'bf.mp.maintenance'
const SUBSCRIPTION_PENDING_KEY = 'bf.mp.subscription'

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

export function checkoutReturnUrl(path, params) {
  const url = new URL(path, window.location.origin)
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && String(value).length) url.searchParams.set(key, String(value))
  })
  return url.toString()
}
