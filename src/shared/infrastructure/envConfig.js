/** Default deployed API (use in VITE_API_BASE_URL on hosts without API rewrites). */
export const DEFAULT_PRODUCTION_API_URL =
  'https://backend-production-5e544.up.railway.app'

/**
 * Ensures the API base URL is absolute. Hostnames without a scheme (common in
 * Vercel env vars) would otherwise be treated as relative paths on the
 * frontend origin → POST /api/... returns 405 from the static host.
 */
function normalizeApiBaseUrl(raw) {
  let base = String(raw ?? '').trim()
  if (!base) return ''

  if (!/^https?:\/\//i.test(base) && /[a-z0-9.-]+\.[a-z]{2,}/i.test(base)) {
    base = `https://${base.replace(/^\/+/, '')}`
  }

  if (base.includes('localhost:7001')) {
    base = 'http://localhost:5001'
  }

  if (import.meta.env.DEV && base.startsWith('https://localhost')) {
    return ''
  }

  return base.replace(/\/$/, '')
}

/**
 * Base URL of the BuildingFex API (no trailing slash).
 *
 * Development: empty → Vite proxy (see VITE_API_PROXY_TARGET).
 * Production: empty → same-origin; Vercel rewrites in vercel.json proxy to Railway.
 * Production: set VITE_API_BASE_URL=https://... when the host has no API rewrites.
 */
function resolveApiBaseUrl() {
  const configured = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL)

  if (import.meta.env.DEV) {
    if (!configured || configured.startsWith('https://localhost')) {
      return ''
    }
    return configured
  }

  return configured
}

export const API_BASE_URL = resolveApiBaseUrl()
