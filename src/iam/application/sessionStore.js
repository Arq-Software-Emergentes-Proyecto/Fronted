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

/**
 * Identity of the signed-in user ("role:id"), or null when signed out. Used to key
 * per-user resources (e.g. the SignalR connection) so they never leak across logins.
 */
export function getSessionIdentityKey() {
  return identityKeyOf(state.role, state.profile)
}

function identityKeyOf(role, profile) {
  if (!role) return null
  const id = profile?.id ?? profile?.email ?? ''
  return `${role}:${String(id)}`
}

const identityListeners = new Set()

/**
 * Registers a callback fired when the signed-in identity ends or changes (logout,
 * forced logout on 401 / ACCOUNT_DEACTIVATED, or a different user signing in).
 * Returns an unsubscribe function.
 */
export function onSessionIdentityChange(listener) {
  identityListeners.add(listener)
  return () => identityListeners.delete(listener)
}

function applySession(role, profile, token) {
  const before = getSessionIdentityKey()
  state.role = role
  state.profile = profile
  state.token = token
  if (identityKeyOf(role, profile) !== before) {
    // Otra persona (o cierre de sesión): el edificio elegido no se hereda.
    state.activeBuildingId = null
    state.buildings = []
  }
  persist()
  const after = getSessionIdentityKey()
  if (before !== null && before !== after) {
    identityListeners.forEach((fn) => {
      try {
        fn({ previous: before, next: after })
      } catch (e) {
        console.warn(e)
      }
    })
  }
}

export function clearSession() {
  applySession(null, null, null)
}

/** Renewed token for the SAME signed-in user (no identity change, listeners are not fired). */
export function updateSessionToken(token) {
  if (!state.role || !token) return
  // Una sesión demo nunca adopta el token de una cuenta real de Firebase (y al revés).
  if (isDemoProfile(state.profile) !== isPreviewToken(token)) return
  state.token = token
  persist()
}

/** Module-level setters for router bootstrap (outside component setup). */
export function setAdminSession(profile = {}, token = null) {
  applySession(SessionRoles.ADMIN, profile, token)
}

export function setResidentSession(profile = {}, token = null) {
  applySession(SessionRoles.RESIDENT, profile, token)
}

/** Miembro de la junta directiva (solo lectura). */
export function setBoardSession(profile = {}, token = null) {
  applySession(SessionRoles.BOARD, profile, token)
}

/**
 * Edificios a los que tiene acceso la sesión (GET /api/v1/me/buildings) y el edificio activo.
 * El edificio activo viaja en la cabecera X-Building-Id y define el ownerAdminId de las consultas.
 */
export function setAccessibleBuildings(buildings = [], { canAddBuildings = false, accountKind = null } = {}) {
  state.buildings = Array.isArray(buildings) ? buildings : []
  state.canAddBuildings = Boolean(canAddBuildings)
  state.accountKind = accountKind ?? null
  const ids = state.buildings.map((b) => String(b.ownerAdminId))
  if (!state.activeBuildingId || !ids.includes(String(state.activeBuildingId))) {
    const active = state.buildings.find((b) => b.isActive) ?? state.buildings[0] ?? null
    state.activeBuildingId = active ? String(active.ownerAdminId) : null
  }
  persist()
}

export function setActiveBuilding(ownerAdminId) {
  state.activeBuildingId = ownerAdminId ? String(ownerAdminId) : null
  persist()
}

/** Edificio activo para la cabecera X-Building-Id (solo gestión: admin o junta). */
export function getActiveBuildingId() {
  if (state.role !== SessionRoles.ADMIN && state.role !== SessionRoles.BOARD) return null
  return state.activeBuildingId ? String(state.activeBuildingId) : null
}

/** Rol de la sesión en el edificio activo: owner | admin | board_member | resident. */
export function getActiveBuildingRole() {
  if (state.role === SessionRoles.RESIDENT) return 'resident'
  const active = (state.buildings ?? []).find((b) => String(b.ownerAdminId) === String(state.activeBuildingId))
  if (active?.role) return active.role
  return state.role === SessionRoles.BOARD ? SessionRoles.BOARD : 'owner'
}

/**
 * Active data owner for multi-tenant API queries (admin account id).
 * Always derived from session state so it cannot drift from persisted profile.
 */
export function getActiveDataOwnerId() {
  if (state.role === SessionRoles.ADMIN || state.role === SessionRoles.BOARD) {
    // Edificio activo (Portafolio, administrador asignado o junta); si no hay, la propia cuenta del admin.
    if (state.activeBuildingId) return String(state.activeBuildingId)
    if (state.role === SessionRoles.BOARD) return null
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

/** Perfil de la cuenta demo / wireframes (ids "preview-…", datos de ejemplo del navegador). */
function isDemoProfile(profile) {
  return String(profile?.id ?? '').startsWith('preview-')
}

function isPreviewToken(token) {
  try {
    const segment = String(token ?? '').split('.')[1]
    if (!segment) return false
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)))?.preview === true
  } catch {
    return false
  }
}

function emptySession() {
  return { role: null, profile: null, token: null, activeBuildingId: null, buildings: [], canAddBuildings: false, accountKind: null }
}

function loadInitialSession() {
  if (typeof window === 'undefined') return emptySession()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptySession()
    const parsed = JSON.parse(raw)
    // Sesión mezclada (perfil demo con token real de Firebase): sus consultas irían a la API real con
    // ownerAdminId=preview-admin-1 y fallarían con 403. Se descarta y la persona vuelve a entrar.
    if (parsed?.token && isDemoProfile(parsed.profile) !== isPreviewToken(parsed.token)) return emptySession()
    if (parsed && typeof parsed === 'object') {
      return {
        ...emptySession(),
        role: parsed.role ?? null,
        profile: parsed.profile ?? null,
        token: parsed.token ?? null,
        activeBuildingId: parsed.activeBuildingId ?? null,
        buildings: Array.isArray(parsed.buildings) ? parsed.buildings : [],
        canAddBuildings: Boolean(parsed.canAddBuildings),
        accountKind: parsed.accountKind ?? null,
      }
    }
  } catch {
    // ignore parse errors
  }
  return emptySession()
}

function persist() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        role: state.role,
        profile: state.profile,
        token: state.token,
        activeBuildingId: state.activeBuildingId,
        buildings: state.buildings,
        canAddBuildings: state.canAddBuildings,
        accountKind: state.accountKind,
      }),
    )
  } catch {
    // ignore storage errors
  }
}

export function useSession() {
  const isAdmin = computed(() => state.role === SessionRoles.ADMIN)
  const isResident = computed(() => state.role === SessionRoles.RESIDENT)
  const isBoard = computed(() => state.role === SessionRoles.BOARD)
  /** Solo lectura en el edificio activo: usuario de junta o administrador invitado como junta. */
  const isReadOnly = computed(() => isBoard.value || getActiveBuildingRole() === SessionRoles.BOARD)

  function clearSessionFromHook() {
    clearSession()
  }

  return {
    state: readonly(state),
    isAdmin,
    isResident,
    isBoard,
    isReadOnly,
    setAdminSession,
    setResidentSession,
    setBoardSession,
    clearSession: clearSessionFromHook,
  }
}
