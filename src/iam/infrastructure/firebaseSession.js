import { signOut } from 'firebase/auth'
import {
  getAccessToken,
  updateSessionToken,
} from '@/iam/application/sessionStore.js'
import {
  isPreviewAccessToken,
  OPEN_WIREFRAME_ACCESS,
} from '@/iam/application/localPreviewAuth.js'
import { getFirebaseAuth } from './firebaseApp.js'

/**
 * La sesión guarda el ID token de Firebase, que vence a la hora. Firebase mantiene la sesión
 * (refresh token) en el navegador, así que antes de que venza pedimos uno nuevo en lugar de
 * mandar al usuario al login.
 */
const REFRESH_MARGIN_MS = 5 * 60_000

function tokenClaims(token) {
  try {
    const segment = String(token).split('.')[1]
    if (!segment) return null
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

function usesFirebaseToken(token) {
  return !OPEN_WIREFRAME_ACCESS && Boolean(token) && !isPreviewAccessToken(token)
}

async function readyAuth() {
  const auth = getFirebaseAuth()
  if (typeof auth.authStateReady === 'function') await auth.authStateReady()
  return auth
}

/** uid de Firebase al que pertenece la sesión guardada (null en modo demo o sin sesión). */
export function sessionFirebaseUid() {
  const token = getAccessToken()
  if (!usesFirebaseToken(token)) return null
  const claims = tokenClaims(token)
  return String(claims?.user_id ?? claims?.sub ?? '') || null
}

let pending = null

/**
 * Token de la sesión, renovado si está por vencer (o siempre con `force`). Solo renueva si el
 * usuario de Firebase de este navegador es el mismo de la sesión; si no, devuelve el guardado.
 */
export function freshSessionToken({ force = false } = {}) {
  const current = getAccessToken()
  if (!usesFirebaseToken(current)) return Promise.resolve(current)
  const exp = Number(tokenClaims(current)?.exp) * 1000
  if (!force && exp && Date.now() < exp - REFRESH_MARGIN_MS) return Promise.resolve(current)

  if (!pending) {
    pending = (async () => {
      try {
        const user = (await readyAuth()).currentUser
        const uid = sessionFirebaseUid()
        if (!user || (uid && user.uid !== uid)) return current
        const next = await user.getIdToken(force)
        // Otro login pudo cambiar la sesión mientras esperábamos: no pisarla.
        if (next && getAccessToken() === current) updateSessionToken(next)
        return getAccessToken()
      } catch {
        return current
      } finally {
        pending = null
      }
    })()
  }
  return pending
}

/** ID token vigente del usuario de Firebase de este navegador (o `fallback` si no hay ninguno). */
export async function currentFirebaseIdToken(fallback = null) {
  if (OPEN_WIREFRAME_ACCESS) return fallback
  try {
    const user = (await readyAuth()).currentUser
    return user ? await user.getIdToken() : fallback
  } catch {
    return fallback
  }
}

/** Cierra también la sesión de Firebase, para que el próximo usuario del navegador no la herede. */
export async function signOutFirebase() {
  if (OPEN_WIREFRAME_ACCESS) return
  try {
    await signOut(getFirebaseAuth())
  } catch {
    // sin sesión de Firebase o sin red: la sesión local ya se borró
  }
}
