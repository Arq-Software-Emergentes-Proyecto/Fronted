import axios from 'axios'
import { API_BASE_URL } from '@/shared/infrastructure/envConfig.js'
import {
  isPreviewAccessToken,
  OPEN_WIREFRAME_ACCESS,
} from '@/iam/application/localPreviewAuth.js'
import { clearSession, getAccessToken } from '@/iam/application/sessionStore.js'

/**
 * Centralized axios instance pointing at the BuildingFex API.
 *
 * Errors are normalized so the rest of the app can branch on `error.code`
 * (e.g. 'NETWORK_ERROR', 'TIMEOUT', 'EMAIL_NOT_FOUND', or 'HTTP_404').
 *
 * Open-wireframe builds use the in-browser mock (local + Vercel).
 * Otherwise production hits the real backend (Vercel rewrites → Railway).
 */
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
})

if (OPEN_WIREFRAME_ACCESS) {
  apiClient.defaults.adapter = async (config) => {
    const { localMockAdapter } = await import(
      '@/shared/infrastructure/mock/mockAdapter.js'
    )
    return localMockAdapter(config)
  }
}

apiClient.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
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

    const payload = error.response.data
    const apiCode =
      payload && typeof payload === 'object' && typeof payload.code === 'string'
        ? payload.code
        : null

    if (error.response.status === 401) {
      const url = String(error.config?.url ?? '')
      const isAuthRoute = url.includes('/authentication/')
      const token = getAccessToken()
      if (!isAuthRoute && token && !isPreviewAccessToken(token)) {
        clearSession()
        if (typeof window !== 'undefined') {
          const path = window.location.pathname
          if (!path.includes('/login') && !path.includes('/register')) {
            const redirect = encodeURIComponent(path + window.location.search)
            window.location.assign(`/login?session=expired&redirect=${redirect}`)
          }
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
