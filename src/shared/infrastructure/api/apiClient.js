import axios from 'axios'
import { API_BASE_URL } from '@/shared/infrastructure/envConfig.js'
import {
  isDemoSession,
  isPreviewAccessToken,
} from '@/iam/application/localPreviewAuth.js'
import { clearSession, getAccessToken } from '@/iam/application/sessionStore.js'
import { freshSessionToken, signOutFirebase } from '@/iam/infrastructure/firebaseSession.js'

/**
 * Centralized axios instance pointing at the BuildingFex API.
 *
 * Errors are normalized so the rest of the app can branch on `error.code`
 * (e.g. 'NETWORK_ERROR', 'TIMEOUT', 'EMAIL_NOT_FOUND', or 'HTTP_404').
 *
 * Open-wireframe builds use the in-browser mock (local + Vercel).
 * Otherwise production hits the real backend (Vercel rewrites → AWS API Gateway).
 */
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
})

// Wireframes or the "test" demo account: every request goes to the in-browser mock (decided per
// request, so signing out of the demo goes straight back to the real API).
const networkAdapter = axios.getAdapter(apiClient.defaults.adapter)
apiClient.defaults.adapter = async (config) => {
  if (!isDemoSession()) return networkAdapter(config)
  const { localMockAdapter } = await import('@/shared/infrastructure/mock/mockAdapter.js')
  return localMockAdapter(config)
}

apiClient.interceptors.request.use(async (config) => {
  // Sign-in flows pass the new user's token explicitly: never replace it with the stored session.
  if (config.headers?.Authorization) return config
  const token = await freshSessionToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
    config.bfSessionAuth = true
  }
  return config
})

/**
 * With `responseType: 'blob'` (PDF / template downloads) an error body arrives as a Blob,
 * so its JSON `{ code }` would be invisible. Parse it back when it is JSON.
 */
async function readErrorPayload(data) {
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return data
  const type = String(data.type || '').toLowerCase()
  if (!type.includes('json')) return data
  try {
    return JSON.parse(await data.text())
  } catch {
    return data
  }
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.code === 'ECONNABORTED') {
      const timeoutError = new Error('TIMEOUT')
      timeoutError.code = 'TIMEOUT'
      return Promise.reject(timeoutError)
    }

    if (!error.response) {
      const networkError = new Error('NETWORK_ERROR')
      networkError.code = 'NETWORK_ERROR'
      return Promise.reject(networkError)
    }

    const payload = await readErrorPayload(error.response.data)
    const apiCode =
      payload && typeof payload === 'object' && typeof payload.code === 'string'
        ? payload.code
        : null

    if (error.response.status === 401) {
      const url = String(error.config?.url ?? '')
      const isAuthRoute = url.includes('/authentication/')
      const token = getAccessToken()
      // The Firebase token may have just expired: renew it once and repeat the request.
      if (!isAuthRoute && error.config?.bfSessionAuth && !error.config.bfRetried) {
        const fresh = await freshSessionToken({ force: true })
        if (fresh && fresh !== token) {
          error.config.bfRetried = true
          error.config.headers.Authorization = `Bearer ${fresh}`
          return apiClient(error.config)
        }
      }
      if (!isAuthRoute && token && !isPreviewAccessToken(token)) {
        clearSession()
        void signOutFirebase()
        if (typeof window !== 'undefined') {
          const path = window.location.pathname
          if (!path.includes('/login') && !path.includes('/register')) {
            const redirect = encodeURIComponent(path + window.location.search)
            window.location.assign(`/login?session=expired&redirect=${redirect}`)
          }
        }
      }
    }

    // IAM: the admin deactivated this account → end the session (every request would get 403).
    if (error.response.status === 403 && apiCode === 'ACCOUNT_DEACTIVATED') {
      const url = String(error.config?.url ?? '')
      const token = getAccessToken()
      if (!url.includes('/authentication/') && token && !isPreviewAccessToken(token)) {
        clearSession()
        void signOutFirebase()
        if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
          window.location.assign('/login?session=deactivated')
        }
      }
    }

    const httpError = new Error(apiCode ?? `HTTP_${error.response.status}`)
    httpError.code = apiCode ?? `HTTP_${error.response.status}`
    httpError.status = error.response.status
    httpError.payload = payload
    return Promise.reject(httpError)
  },
)
