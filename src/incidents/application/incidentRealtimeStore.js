import { reactive } from 'vue'
import {
  joinSupportOwner,
  onSupportHubEvent,
} from '@/residentCare/infrastructure/supportRealtime.js'
import { IncidentRealtimeEvent } from '@/incidents/domain/model/incidentConstants.js'

/**
 * Tiempo real de incidencias (RF024): reutiliza la conexión SignalR de soporte (/hubs/support).
 * - Admin: "incidentCreated" incrementa el contador de no vistas (badge del menú) y dispara toasts.
 * - Admin y residente: "incidentUpdated" permite refrescar vistas abiertas.
 */
const state = reactive({
  unseenCount: 0,
  lastCreated: null,
  ownerId: null,
  connected: false,
})

const listeners = new Set()
let unsubscribers = []
let startingFor = null

function emit(type, payload) {
  listeners.forEach((fn) => {
    try {
      fn(type, payload)
    } catch (e) {
      console.warn(e)
    }
  })
}

/** Conecta (una vez por tenant) y escucha los eventos de incidencias. */
export async function startIncidentRealtime(ownerAdminId, { countUnseen = false } = {}) {
  const owner = ownerAdminId ? String(ownerAdminId) : null
  if (!owner) return
  if (state.ownerId === owner && state.connected) return
  if (startingFor === owner) return
  startingFor = owner
  try {
    const hub = await joinSupportOwner(owner)
    if (!hub) return
    unsubscribers.forEach((off) => off())
    unsubscribers = [
      onSupportHubEvent(IncidentRealtimeEvent.CREATED, (payload) => {
        if (countUnseen) state.unseenCount += 1
        state.lastCreated = payload ?? null
        emit(IncidentRealtimeEvent.CREATED, payload)
      }),
      onSupportHubEvent(IncidentRealtimeEvent.UPDATED, (payload) => {
        emit(IncidentRealtimeEvent.UPDATED, payload)
      }),
    ]
    state.ownerId = owner
    state.connected = true
  } finally {
    startingFor = null
  }
}

export function stopIncidentRealtime() {
  unsubscribers.forEach((off) => off())
  unsubscribers = []
  state.connected = false
  state.ownerId = null
  state.unseenCount = 0
}

/** handler(type, payload); devuelve función para desuscribirse. */
export function onIncidentRealtime(handler) {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

export function markIncidentsSeen() {
  state.unseenCount = 0
}

export function useIncidentRealtime() {
  return { state }
}
