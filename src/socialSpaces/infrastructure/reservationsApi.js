import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import {
  apiError,
  publicReservation,
  reservationInviteExpiresAtMs,
  reservationsOverlap,
  timeToMinutes,
} from '@/shared/infrastructure/api/utils.js'

/**
 * Social Spaces bounded-context API (reservations side).
 *
 * Owns: time-bounded reservations residents make against published spaces.
 * Errors expose `error.code`: 'RESERVATION_FIELDS_REQUIRED',
 * 'RESERVATION_TIME_INVALID', 'RESERVATION_OVERLAP' (HTTP 409), 'RESERVATION_CAPACITY_EXCEEDED' (409),
 * 'RESERVATION_DAY_FULL' (409), 'SPACE_UNDER_MAINTENANCE' (409), 'RESERVATION_CANCELLED' (409),
 * 'RESERVATION_TOO_MANY_GUESTS', 'RESERVATION_NOT_FOUND', 'GUEST_NOT_FOUND',
 * 'GUEST_PASS_EXPIRED' / 'GUEST_PASS_CANCELLED' (HTTP 410), 'GUEST_PASS_NOT_FOUND'.
 *
 * Reservations carry `status` ('CONFIRMED' | 'CANCELLED'); cancelled ones no longer block the slot.
 */
const MAX_RESERVATION_GUESTS = 5

const isActive = (r) => String(r?.status ?? 'CONFIRMED').toUpperCase() !== 'CANCELLED'

/** Server-side pass status, recomputed locally for the offline mock (no guest-passes endpoint). */
function localPassStatus(r) {
  if (!isActive(r)) return 'CANCELLED'
  const exp = reservationInviteExpiresAtMs(r)
  if (exp == null || Date.now() >= exp) return 'EXPIRED'
  return 'VALID'
}

export const reservationsApi = {
  /** Active (non-cancelled) reservations of a space — used for availability. */
  async listBySpace(spaceId) {
    const { data } = await apiClient.get('/reservations', {
      params: withOwnerParams({ spaceId }),
    })
    return Array.isArray(data)
      ? data.filter(isActive).map((r) => publicReservation(r, { omitInviteToken: true }))
      : []
  },

  /**
   * @param {string} residentId
   * @param {{ includeCancelled?: boolean }} [options] includeCancelled → full history (US018).
   */
  async listByResident(residentId, options = {}) {
    const includeCancelled = Boolean(options.includeCancelled)
    const { data } = await apiClient.get('/reservations', {
      params: withOwnerParams({ residentId, ...(includeCancelled ? { includeCancelled: true } : {}) }),
    })
    const rows = Array.isArray(data) ? data : []
    return (includeCancelled ? rows : rows.filter(isActive)).map(publicReservation)
  },

  /** All active reservations for the active admin (Generation / oversight). */
  async listAllForAdmin() {
    const { data } = await apiClient.get('/reservations', { params: withOwnerParams() })
    return Array.isArray(data)
      ? data.filter(isActive).map((r) => publicReservation(r, { omitInviteToken: true }))
      : []
  },

  /** Cancels (soft) a reservation: it stays in the history and frees the slot. */
  async cancel(reservationId) {
    const cleanId = String(reservationId ?? '').trim()
    if (!cleanId) throw apiError('RESERVATION_NOT_FOUND')
    await apiClient.delete(`/reservations/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },

  async removeBySpace(spaceId) {
    const cleanSpaceId = String(spaceId ?? '').trim()
    if (!cleanSpaceId) return { removed: 0 }
    const { data } = await apiClient.get('/reservations', {
      // includeCancelled: purge also the cancelled (soft-deleted) rows, or they are orphaned.
      params: withOwnerParams({ spaceId: cleanSpaceId, includeCancelled: true }),
    })
    const items = Array.isArray(data) ? data : []
    await Promise.all(
      items.map((reservation) =>
        apiClient.delete(`/reservations/${encodeURIComponent(reservation.id)}`, {
          params: { purge: true },
        }),
      ),
    )
    return { removed: items.length }
  },

  async removeByResident(residentId) {
    const cleanResidentId = String(residentId ?? '').trim()
    if (!cleanResidentId) return { removed: 0 }
    const { data } = await apiClient.get('/reservations', {
      // includeCancelled: purge also the cancelled (soft-deleted) rows, or they are orphaned.
      params: withOwnerParams({ residentId: cleanResidentId, includeCancelled: true }),
    })
    const items = Array.isArray(data) ? data : []
    await Promise.all(
      items.map((reservation) =>
        apiClient.delete(`/reservations/${encodeURIComponent(reservation.id)}`, {
          params: { purge: true },
        }),
      ),
    )
    return { removed: items.length }
  },

  async add({ spaceId, residentId, residentName, residentCode, date, startTime, endTime }) {
    const cleanSpaceId = String(spaceId ?? '').trim()
    const cleanResidentId = String(residentId ?? '').trim()
    const cleanDate = String(date ?? '').trim()
    const cleanStart = String(startTime ?? '').trim()
    const cleanEnd = String(endTime ?? '').trim()

    if (!cleanSpaceId || !cleanResidentId || !cleanDate || !cleanStart || !cleanEnd) {
      throw apiError('RESERVATION_FIELDS_REQUIRED')
    }

    const startMin = timeToMinutes(cleanStart)
    const endMin = timeToMinutes(cleanEnd)
    if (Number.isNaN(startMin) || Number.isNaN(endMin) || startMin >= endMin) {
      throw apiError('RESERVATION_TIME_INVALID')
    }

    const { data: existing } = await apiClient.get('/reservations', {
      params: withOwnerParams({ spaceId: cleanSpaceId, date: cleanDate }),
    })

    const candidate = { date: cleanDate, startTime: cleanStart, endTime: cleanEnd }
    const overlapping = (existing ?? []).filter(isActive).some((reservation) =>
      reservationsOverlap(reservation, candidate),
    )

    if (overlapping) {
      throw apiError('RESERVATION_OVERLAP')
    }

    const ownerId = getActiveDataOwnerId()
    const newReservation = {
      id: `reservation-${Date.now()}`,
      spaceId: cleanSpaceId,
      residentId: cleanResidentId,
      residentName: String(residentName ?? '').trim(),
      residentCode: String(residentCode ?? '').trim(),
      date: cleanDate,
      startTime: cleanStart,
      endTime: cleanEnd,
      guests: [],
      guestInviteToken: null,
      status: 'CONFIRMED',
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }

    const { data: created } = await apiClient.post('/reservations', newReservation)
    return publicReservation(created)
  },

  /**
   * Replace guest list for a reservation (max 5 names). Preserves `checkedIn` / `checkedInAt` by guest `id`.
   * @param {string} reservationId
   * @param {Array<{ id?: string, name: string }>} guests
   */
  async updateGuests(reservationId, guests) {
    const cleanId = String(reservationId ?? '').trim()
    if (!cleanId) {
      throw apiError('RESERVATION_NOT_FOUND')
    }

    const { data: current } = await apiClient.get(`/reservations/${encodeURIComponent(cleanId)}`, {
      params: withOwnerParams(),
    })
    const currentGuests = Array.isArray(current?.guests) ? current.guests : []

    const normalized = (Array.isArray(guests) ? guests : [])
      .map((g, i) => {
        const name = String(g?.name ?? '').trim()
        if (!name.length) return null
        const incomingId = String(g?.id ?? '').trim()
        const prev = incomingId ? currentGuests.find((x) => String(x.id) === incomingId) : null
        const id = incomingId || `guest-${Date.now()}-${i}`
        return {
          id,
          name,
          checkedIn: Boolean(prev?.checkedIn),
          checkedInAt: prev?.checkedInAt ?? null,
        }
      })
      .filter(Boolean)
      .slice(0, MAX_RESERVATION_GUESTS)

    // The real API issues the token server-side (and ignores this value); kept for the offline mock.
    let guestInviteToken = current?.guestInviteToken ?? null
    if (normalized.length > 0) {
      if (!guestInviteToken) {
        guestInviteToken = `invite-${crypto.randomUUID()}`
      }
    } else {
      guestInviteToken = null
    }

    const { data: updated } = await apiClient.patch(
      `/reservations/${encodeURIComponent(cleanId)}`,
      { guests: normalized, guestInviteToken },
    )
    return publicReservation(updated)
  },

  /**
   * Admin marks whether a guest has physically entered (concierge / reception).
   * @param {string} reservationId
   * @param {string} guestId
   * @param {boolean} checkedIn
   */
  async setGuestCheckedIn(reservationId, guestId, checkedIn) {
    const rid = String(reservationId ?? '').trim()
    const gid = String(guestId ?? '').trim()
    if (!rid || !gid) {
      throw apiError('RESERVATION_NOT_FOUND')
    }
    const { data: current } = await apiClient.get(`/reservations/${encodeURIComponent(rid)}`, {
      params: withOwnerParams(),
    })
    const list = Array.isArray(current?.guests) ? current.guests : []
    let found = false
    const nextGuests = list.map((g) => {
      if (String(g.id) !== gid) {
        return {
          id: String(g.id),
          name: String(g.name ?? '').trim(),
          checkedIn: Boolean(g.checkedIn),
          checkedInAt: g.checkedInAt ?? null,
        }
      }
      found = true
      const on = Boolean(checkedIn)
      return {
        id: String(g.id),
        name: String(g.name ?? '').trim(),
        checkedIn: on,
        checkedInAt: on ? (g.checkedInAt || new Date().toISOString()) : null,
      }
    })
    if (!found) {
      throw apiError('GUEST_NOT_FOUND')
    }
    const { data: updated } = await apiClient.patch(`/reservations/${encodeURIComponent(rid)}`, {
      guests: nextGuests,
    })
    return publicReservation(updated, { omitInviteToken: true })
  },

  /**
   * Public guest-pass validation (US027): `{ valid, status: 'VALID'|'EXPIRED'|'CANCELLED', expiresAt,
   * reservation: { spaceName, date, startTime, endTime, status, hostName }, guests }`.
   * Falls back to the legacy `/reservations?guestInviteToken=` lookup when the endpoint is unavailable (mock).
   */
  async getGuestPass(rawToken) {
    const token = String(rawToken ?? '').trim()
    if (!token) throw apiError('INVITE_NOT_FOUND')
    try {
      const { data } = await apiClient.get(`/api/v1/guest-passes/${encodeURIComponent(token)}`)
      return data
    } catch (error) {
      if (error?.code === 'GUEST_PASS_NOT_FOUND') throw apiError('INVITE_NOT_FOUND')
      if (error?.code !== 'HTTP_404') throw error
    }
    const { data } = await apiClient.get('/reservations', { params: { guestInviteToken: token } })
    const r = Array.isArray(data) ? data[0] : null
    if (!r) throw apiError('INVITE_NOT_FOUND')
    const pub = publicReservation(r, { omitInviteToken: true })
    const status = localPassStatus(pub)
    return {
      valid: status === 'VALID',
      status,
      expiresAt: new Date(reservationInviteExpiresAtMs(pub) ?? Date.now()).toISOString(),
      reservation: {
        id: pub.id,
        spaceId: pub.spaceId,
        spaceName: '',
        date: pub.date,
        startTime: pub.startTime,
        endTime: pub.endTime,
        status: pub.status,
        hostName: String(r.residentName ?? '').trim(),
      },
      guests: pub.guests,
    }
  },

  /**
   * Concierge check-in through the guest pass (admin). Refused with 410 `GUEST_PASS_EXPIRED` once the
   * event ended more than 2 h ago. Without guestId all guests of the pass are checked in.
   */
  async checkInGuestPass(rawToken, guestId, checkedIn = true) {
    const token = String(rawToken ?? '').trim()
    if (!token) throw apiError('INVITE_NOT_FOUND')
    const { data } = await apiClient.post(
      `/api/v1/guest-passes/${encodeURIComponent(token)}/check-in`,
      { ...(guestId ? { guestId: String(guestId) } : {}), checkedIn: Boolean(checkedIn) },
    )
    return data
  },

  /**
   * Public lookup by invite token (no tenant scope). Used by guest invite page.
   * @returns {{ guests: Array<{id:string,name:string,checkedIn:boolean}>, date: string, startTime: string, endTime: string, spaceName: string, residentName: string, status: string, expiresAt: string|null }}
   */
  async getPublicInviteByToken(rawToken) {
    const pass = await this.getGuestPass(rawToken)
    const res = pass?.reservation ?? {}
    return {
      guests: Array.isArray(pass?.guests) ? pass.guests : [],
      date: res.date ?? '',
      startTime: res.startTime ?? '',
      endTime: res.endTime ?? '',
      spaceName: String(res.spaceName ?? '').trim() || '—',
      residentName: String(res.hostName ?? '').trim(),
      status: pass?.status ?? 'VALID',
      expiresAt: pass?.expiresAt ?? null,
    }
  },
}
