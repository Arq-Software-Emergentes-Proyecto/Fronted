import { reactive, computed, readonly } from 'vue'
import { SessionRoles } from '@/iam/domain/sessionRoles.js'

export { SessionRoles }

const STORAGE_KEY = 'buildingfex.session'

const state = reactive(loadInitialSession())

/** Current session role; for router guards outside component setup. */
export function getSessionRole() {
  return state.role
}

/** JWT from the BuildingFex API (used by apiClient Authorization header). */
export function getAccessToken() {
  const token = state.token
  return token != null && String(token).length ? String(token) : null
}

/** Returns false when the JWT is missing, malformed, or past expiry (30s skew). */
export function isAccessTokenValid() {
  const token = getAccessToken()
  if (!token) return false
  try {
    const segment = token.split('.')[1]
    if (!segment) return false
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(base64))
    if (typeof payload.exp !== 'number') return true
    return Date.now() < payload.exp * 1000 - 30_000
  } catch {
    return false
  }
}

export function clearSession() {
  state.role = null
  state.profile = null
  state.token = null
  persist()
}

/** Module-level setters for router bootstrap (outside component setup). */
export function setAdminSession(profile = {}, token = null) {
  state.role = SessionRoles.ADMIN
  state.profile = profile
  state.token = token
  persist()
}

export function setResidentSession(profile = {}, token = null) {
  state.role = SessionRoles.RESIDENT
  state.profile = profile
  state.token = token
  persist()
}

/**
 * Active data owner for multi-tenant API queries (admin account id).
 * Always derived from session state so it cannot drift from persisted profile.
 */
export function getActiveDataOwnerId() {
  if (state.role === SessionRoles.ADMIN) {
    const id = state.profile?.id
    return id != null && String(id).length ? String(id) : null
  }
  if (state.role === SessionRoles.RESIDENT) {
    const oid = state.profile?.ownerAdminId
    return oid != null && String(oid).length ? String(oid) : null
  }
  return null
}

export function getSessionToken() {
  return state.token
}

function loadInitialSession() {
  if (typeof window === 'undefined') {
    return { role: null, profile: null, token: null }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { role: null, profile: null, token: null }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const role = parsed.role ?? null
      const profile = parsed.profile ?? null
      const token = parsed.token ?? null
      return { role, profile, token }
    }
  } catch {
    // ignore parse errors
  }
  return { role: null, profile: null, token: null }
}

function persist() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ role: state.role, profile: state.profile, token: state.token }),
    )
  } catch {
    // ignore storage errors
  }
}

export function useSession() {
  const isAdmin = computed(() => state.role === SessionRoles.ADMIN)
  const isResident = computed(() => state.role === SessionRoles.RESIDENT)

  function clearSessionFromHook() {
    clearSession()
  }

  return {
    state: readonly(state),
    isAdmin,
    isResident,
    setAdminSession,
    setResidentSession,
    clearSession: clearSessionFromHook,
  }
}
