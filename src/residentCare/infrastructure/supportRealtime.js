import * as signalR from '@microsoft/signalr'
import { API_BASE_URL } from '@/shared/infrastructure/envConfig.js'
import { getAccessToken } from '@/iam/application/sessionStore.js'
import {
  isPreviewAccessToken,
  OPEN_WIREFRAME_ACCESS,
} from '@/iam/application/localPreviewAuth.js'

function hubUrl() {
  const base = String(API_BASE_URL || '').replace(/\/$/, '')
  // Same-origin (Vite proxy / Vercel) when base is empty.
  return `${base}/hubs/support`
}

let connection = null
let starting = null

/**
 * SignalR para Support. Fallback: el caller puede seguir con polling ?since=
 * cuando la pestaña está visible y no hay conexión.
 */
export async function ensureSupportHub() {
  const token = getAccessToken()
  if (!token) return null
  // Local wireframe / preview mock: no real hubs — views poll the mock API.
  if (OPEN_WIREFRAME_ACCESS || isPreviewAccessToken(token)) return null

  if (connection?.state === signalR.HubConnectionState.Connected) {
    return connection
  }

  if (starting) return starting

  connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl(), {
      accessTokenFactory: () => getAccessToken() || '',
    })
    .withAutomaticReconnect()
    .build()

  starting = connection
    .start()
    .then(() => connection)
    .catch((err) => {
      console.warn('Support SignalR unavailable', err)
      connection = null
      return null
    })
    .finally(() => {
      starting = null
    })

  return starting
}

export async function joinSupportOwner(ownerAdminId) {
  const hub = await ensureSupportHub()
  if (!hub || !ownerAdminId) return null
  try {
    await hub.invoke('JoinOwner', String(ownerAdminId))
  } catch (e) {
    console.warn(e)
  }
  return hub
}

export async function joinSupportChat(chatId) {
  const hub = await ensureSupportHub()
  if (!hub || !chatId) return null
  try {
    await hub.invoke('JoinChat', String(chatId))
  } catch (e) {
    console.warn(e)
  }
  return hub
}

export function onSupportChatUpdated(handler) {
  if (!connection) return () => {}
  connection.on('chatUpdated', handler)
  return () => {
    try {
      connection?.off('chatUpdated', handler)
    } catch {
      // ignore
    }
  }
}

export function isDocumentVisible() {
  return typeof document === 'undefined' ? true : document.visibilityState === 'visible'
}

/**
 * Suscripción genérica a un evento del hub de soporte (lo reutiliza Incidents:
 * "incidentCreated" / "incidentUpdated") para no abrir otra conexión SignalR.
 * Requiere haber llamado antes a joinSupportOwner(); devuelve la función para desuscribirse.
 */
export function onSupportHubEvent(eventName, handler) {
  if (!connection || !eventName) return () => {}
  const conn = connection
  conn.on(eventName, handler)
  return () => {
    try {
      conn.off(eventName, handler)
    } catch {
      // ignore
    }
  }
}
