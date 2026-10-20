import * as signalR from '@microsoft/signalr'
import { ref } from 'vue'
import { API_BASE_URL } from '@/shared/infrastructure/envConfig.js'
import {
  getAccessToken,
  getSessionIdentityKey,
  onSessionIdentityChange,
} from '@/iam/application/sessionStore.js'
import {
  isPreviewAccessToken,
  OPEN_WIREFRAME_ACCESS,
} from '@/iam/application/localPreviewAuth.js'
import { freshSessionToken } from '@/iam/infrastructure/firebaseSession.js'

function hubUrl() {
  const base = String(API_BASE_URL || '').replace(/\/$/, '')
  // Same-origin (Vite proxy / Vercel) when base is empty.
  return `${base}/hubs/support`
}

/** Delay before trying to rebuild the hub after automatic reconnect gave up. */
const RETRY_AFTER_CLOSE_MS = 30_000

/**
 * True while the hub is connected and its groups are joined. Views watch it to pause
 * / resume their fallback polling (it turns false on reconnecting and on close).
 */
export const realtimeAvailable = ref(false)

let connection = null
/** Session identity ("role:id") the cached connection was opened for. */
let connectionKey = null
let starting = null
/** Bumped on every teardown so in-flight starts for a previous user are discarded. */
let generation = 0
let retryTimer = 0
/** Groups to (re-)join on every (re)connection of the current user. */
const joinedOwners = new Set()
const joinedChats = new Set()
/** eventName → Set<handler>; survives connection rebuilds (one dispatcher per event). */
const handlers = new Map()
const boundDispatchers = new Map()

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = 0
}

function dispatcherFor(eventName) {
  let fn = boundDispatchers.get(eventName)
  if (!fn) {
    fn = (...args) => {
      const set = handlers.get(eventName)
      if (!set) return
      set.forEach((h) => {
        try {
          h(...args)
        } catch (e) {
          console.warn(e)
        }
      })
    }
    boundDispatchers.set(eventName, fn)
  }
  return fn
}

function bindDispatchers(conn) {
  handlers.forEach((_set, eventName) => {
    conn.off(eventName, dispatcherFor(eventName))
    conn.on(eventName, dispatcherFor(eventName))
  })
}

async function rejoinGroups(conn) {
  for (const owner of joinedOwners) {
    try {
      await conn.invoke('JoinOwner', owner)
    } catch (e) {
      console.warn(e)
    }
  }
  for (const chat of joinedChats) {
    try {
      await conn.invoke('JoinChat', chat)
    } catch (e) {
      console.warn(e)
    }
  }
}

function scheduleRetry() {
  clearRetry()
  if (!joinedOwners.size && !joinedChats.size) return
  const gen = generation
  retryTimer = setTimeout(() => {
    retryTimer = 0
    if (gen !== generation || connection) return
    void ensureSupportHub()
  }, RETRY_AFTER_CLOSE_MS)
}

/**
 * Tears down the hub connection and forgets joined groups. Called on logout, forced
 * logout (401 / ACCOUNT_DEACTIVATED) and whenever the signed-in user changes, so the
 * next user in the same tab never reuses the previous user's authenticated connection.
 */
export async function stopSupportHub() {
  generation += 1
  clearRetry()
  const conn = connection
  connection = null
  connectionKey = null
  starting = null
  joinedOwners.clear()
  joinedChats.clear()
  realtimeAvailable.value = false
  if (conn) {
    boundDispatchers.forEach((fn, eventName) => {
      try {
        conn.off(eventName, fn)
      } catch {
        // ignore
      }
    })
    try {
      await conn.stop()
    } catch {
      // ignore
    }
  }
}

onSessionIdentityChange(() => {
  void stopSupportHub()
})

/**
 * SignalR para Support. Fallback: el caller puede seguir con polling ?since=
 * cuando la pestaña está visible y no hay conexión (ver `realtimeAvailable`).
 */
export async function ensureSupportHub() {
  // Local wireframe / preview mock: no real hubs — views poll the mock API.
  if (!realtimeEnabled()) return null

  const key = getSessionIdentityKey()
  if (connection && connectionKey !== key) await stopSupportHub()

  if (connection) {
    const st = connection.state
    if (st === signalR.HubConnectionState.Connected) return connection
    if (st === signalR.HubConnectionState.Connecting && starting) return starting
    // Reconnecting: keep the same connection (listeners stay bound; groups are
    // re-joined in onreconnected) instead of building a second one.
    if (
      st === signalR.HubConnectionState.Reconnecting ||
      st === signalR.HubConnectionState.Connecting ||
      st === signalR.HubConnectionState.Disconnecting
    ) {
      return connection
    }
    // Disconnected without onclose having run yet: rebuild below.
    connection = null
  }

  if (starting) return starting

  clearRetry()
  const gen = generation
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl(), {
      accessTokenFactory: async () => (await freshSessionToken()) || '',
      // Token travels via accessTokenFactory; the API's CORS policy has no AllowCredentials.
      withCredentials: false,
    })
    .withAutomaticReconnect()
    .build()

  conn.onreconnecting(() => {
    if (connection === conn) realtimeAvailable.value = false
  })
  conn.onreconnected(async () => {
    if (connection !== conn) return
    await rejoinGroups(conn)
    if (connection === conn) realtimeAvailable.value = true
  })
  conn.onclose(() => {
    if (connection !== conn) return
    connection = null
    connectionKey = null
    realtimeAvailable.value = false
    scheduleRetry()
  })
  bindDispatchers(conn)

  connection = conn
  connectionKey = key

  const startPromise = conn
    .start()
    .then(async () => {
      if (gen !== generation || connection !== conn) {
        // The user changed (or logged out) while connecting: discard.
        try {
          await conn.stop()
        } catch {
          // ignore
        }
        return null
      }
      await rejoinGroups(conn)
      realtimeAvailable.value = true
      return conn
    })
    .catch((err) => {
      console.warn('Support SignalR unavailable', err)
      if (connection === conn) {
        connection = null
        connectionKey = null
        realtimeAvailable.value = false
        scheduleRetry()
      }
      return null
    })
    .finally(() => {
      if (starting === startPromise) starting = null
    })
  starting = startPromise

  return startPromise
}

/** VITE_REALTIME=false: the API has no SignalR hub (AWS Lambda); views keep polling. */
const REALTIME_CONFIGURED = String(import.meta.env.VITE_REALTIME ?? 'true') !== 'false'

function realtimeEnabled() {
  const token = getAccessToken()
  return REALTIME_CONFIGURED && !!token && !OPEN_WIREFRAME_ACCESS && !isPreviewAccessToken(token)
}

async function joinGroup(method, set, id) {
  if (!id || !realtimeEnabled()) return null
  if (connection && connectionKey !== getSessionIdentityKey()) await stopSupportHub()
  const key = String(id)
  const isNew = !set.has(key)
  // Remember the group first: every (re)connection — start, onreconnected, the retry
  // after close — joins all remembered groups, even if this first attempt fails.
  set.add(key)
  const wasConnected = connection?.state === signalR.HubConnectionState.Connected
  const hub = await ensureSupportHub()
  if (!hub) return null
  if (isNew && wasConnected && hub.state === signalR.HubConnectionState.Connected) {
    try {
      await hub.invoke(method, key)
    } catch (e) {
      console.warn(e)
    }
  }
  return hub
}

export async function joinSupportOwner(ownerAdminId) {
  return joinGroup('JoinOwner', joinedOwners, ownerAdminId)
}

export async function joinSupportChat(chatId) {
  return joinGroup('JoinChat', joinedChats, chatId)
}

/**
 * Suscripción genérica a un evento del hub de soporte (lo reutiliza Incidents:
 * "incidentCreated" / "incidentUpdated") para no abrir otra conexión SignalR.
 * The handler stays registered across reconnections / connection rebuilds;
 * devuelve la función para desuscribirse.
 */
export function onSupportHubEvent(eventName, handler) {
  if (!eventName || typeof handler !== 'function') return () => {}
  let set = handlers.get(eventName)
  if (!set) {
    set = new Set()
    handlers.set(eventName, set)
    if (connection) connection.on(eventName, dispatcherFor(eventName))
  }
  set.add(handler)
  return () => {
    set.delete(handler)
  }
}

export function onSupportChatUpdated(handler) {
  return onSupportHubEvent('chatUpdated', handler)
}

export function isDocumentVisible() {
  return typeof document === 'undefined' ? true : document.visibilityState === 'visible'
}

/** Test/diagnostic snapshot of the hub state. */
export function getSupportHubDebugState() {
  return {
    hasConnection: !!connection,
    connectionKey,
    state: connection?.state ?? null,
    joinedOwners: [...joinedOwners],
    joinedChats: [...joinedChats],
    realtimeAvailable: realtimeAvailable.value,
  }
}
