import { reactive, watch } from 'vue'
import {
  joinSupportOwner,
  onSupportHubEvent,
  realtimeAvailable,
} from '@/residentCare/infrastructure/supportRealtime.js'
import { onSessionIdentityChange } from '@/iam/application/sessionStore.js'
import { IncidentRealtimeEvent } from '@/incidents/domain/model/incidentConstants.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'

/**
 * Tiempo real de incidencias (RF024): reutiliza la conexión SignalR de soporte (/hubs/support).
 * - Admin: "incidentCreated" incrementa el contador de no vistas (badge del menú) y dispara toasts.
 * - Admin y residente: "incidentUpdated" permite refrescar vistas abiertas.
 * Sin hub (API en AWS Lambda) el admin consulta la lista cada minuto y emite los mismos eventos.
 */
const POLL_MS = 60_000
const state = reactive({
  unseenCount: 0,
  lastCreated: null,
  ownerId: null,
  connected: false,
})

const listeners = new Set()
let unsubscribers = []
let startingFor = null
let generation = 0
let pollTimer = 0
/** id → updatedAt de la última consulta (null = todavía sin línea base). */
let knownIncidents = null

/** Respaldo sin SignalR: detecta incidencias nuevas o cambiadas comparando con la consulta anterior. */
async function pollIncidents(countUnseen) {
  if (realtimeAvailable.value) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const gen = generation
  let list
  try {
    list = await incidentsApi.list()
  } catch {
    return
  }
  if (gen !== generation) return
  const next = new Map(list.map((row) => [String(row.id), String(row.updatedAt ?? row.createdAt ?? '')]))
  if (knownIncidents) {
    const created = list.filter((row) => !knownIncidents.has(String(row.id)))
    const updated = list.filter(
      (row) => knownIncidents.has(String(row.id)) && knownIncidents.get(String(row.id)) !== next.get(String(row.id)),
    )
    if (created.length) {
      if (countUnseen) state.unseenCount += created.length
      state.lastCreated = created[0]
      created.forEach((row) => emit(IncidentRealtimeEvent.CREATED, row))
    }
    updated.forEach((row) => emit(IncidentRealtimeEvent.UPDATED, row))
  }
  knownIncidents = next
}

function startPolling(countUnseen) {
  stopPolling()
  if (!countUnseen) return
  void pollIncidents(countUnseen)
  pollTimer = setInterval(() => void pollIncidents(countUnseen), POLL_MS)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = 0
  knownIncidents = null
}

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
  if (state.ownerId === owner && unsubscribers.length) return
  if (startingFor === owner) return
  startingFor = owner
  const gen = generation
  try {
    // Listeners are kept by supportRealtime across (re)connections, so they are bound even
    // if the hub is not up yet; it joins the owner group whenever it connects.
    await joinSupportOwner(owner)
    // Logged out / user changed while joining: don't bind listeners for the old tenant.
    if (gen !== generation) return
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
    state.connected = realtimeAvailable.value
    startPolling(countUnseen)
  } finally {
    if (gen === generation) startingFor = null
  }
}

export function stopIncidentRealtime() {
  generation += 1
  startingFor = null
  stopPolling()
  unsubscribers.forEach((off) => off())
  unsubscribers = []
  state.connected = false
  state.ownerId = null
  state.unseenCount = 0
  state.lastCreated = null
}

// Listeners survive hub reconnections; just mirror availability for the UI.
watch(realtimeAvailable, (ok) => {
  state.connected = !!ok && !!state.ownerId
})

// Logout / forced logout / different user: never keep the previous tenant's listeners.
onSessionIdentityChange(() => stopIncidentRealtime())

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
