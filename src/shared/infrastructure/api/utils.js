import { apiClient } from './apiClient.js'
import { getActiveDataOwnerId } from './ownerTenant.js'

/**
 * Cross-context HTTP/data utilities used by bounded-context APIs.
 * Each bounded context owns its own API module; these helpers stay in
 * the `shared` infrastructure because they are technical and shared by
 * several contexts (iam, residents, socialSpaces).
 */

export function apiError(code, message) {
  const error = new Error(message ?? code)
  error.code = code
  return error
}

export function normalizeEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase()
}

export function normalizeCode(code) {
  return String(code ?? '').trim()
}

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    floor: user.floor ?? null,
    code: user.code ?? null,
    ownerAdminId: user.ownerAdminId ?? null,
  }
}

export function publicResident(user) {
  const admissionMatch = String(user?.admissionDate ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return {
    id: user.id,
    name: user.name,
    floor: user.floor ?? '',
    code: user.code ?? '',
    email: user.email ?? '',
    ownerAdminId: user.ownerAdminId ?? null,
    admissionDate: admissionMatch ? admissionMatch[1] : '',
    billFromNextMonth: Boolean(user.billFromNextMonth),
    inviteToken: user.inviteToken ?? user.InviteToken ?? null,
    inviteExpiresAt: user.inviteExpiresAt ?? user.InviteExpiresAt ?? null,
    hasCredentials:
      user.hasCredentials === true ||
      user.authProvider === 'google' ||
      Boolean(user.googleSub) ||
      (user.hasCredentials !== false && Boolean(user.email && user.password)),
  }
}

export function publicSpace(space) {
  return {
    id: space.id,
    name: space.name,
    description: space.description ?? '',
    capacity: space.capacity ?? null,
    imageUrl: space.imageUrl ?? '',
  }
}

/**
 * @param {object} reservation
 * @param {{ omitInviteToken?: boolean }} [options] When true, strips `guestInviteToken` (admin space lists).
 */
export function publicReservation(reservation, options = {}) {
  const omitInviteToken = Boolean(options.omitInviteToken)
  const rawGuests = reservation.guests
  const guests = Array.isArray(rawGuests)
    ? rawGuests
        .map((g, i) => ({
          id: String(g?.id ?? `guest-${i}`),
          name: String(g?.name ?? '').trim(),
          checkedIn: Boolean(g?.checkedIn),
          checkedInAt: g?.checkedInAt ? String(g.checkedInAt) : null,
        }))
        .filter((g) => g.name.length > 0)
    : []
  const base = {
    id: reservation.id,
    spaceId: reservation.spaceId,
    residentId: reservation.residentId ?? '',
    residentName: reservation.residentName ?? '',
    residentCode: reservation.residentCode ?? '',
    date: reservation.date,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    guests,
  }
  if (!omitInviteToken) {
    base.guestInviteToken = reservation.guestInviteToken ?? null
  }
  return base
}

/** Minutes after reservation start when the guest-invite QR and link stop working. */
export const INVITE_QR_VALID_MINUTES_AFTER_START = 25

/**
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} startTimeStr HH:mm
 * @param {number} [extraMinutesAfterStart]
 * @returns {number | null} expiry instant (ms), or null if inputs invalid
 */
export function reservationInviteExpiresAtMs(
  dateStr,
  startTimeStr,
  extraMinutesAfterStart = INVITE_QR_VALID_MINUTES_AFTER_START,
) {
  const date = String(dateStr ?? '').trim()
  const time = String(startTimeStr ?? '').trim()
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null
  const start = new Date(y, mo - 1, d, h, mi, 0, 0)
  const t = start.getTime()
  if (Number.isNaN(t)) return null
  return t + extraMinutesAfterStart * 60 * 1000
}

export function timeToMinutes(value) {
  if (!value) return Number.NaN
  const [h, m] = String(value).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return Number.NaN
  return h * 60 + m
}

export function reservationsOverlap(a, b) {
  if (a.date !== b.date) return false
  const aStart = timeToMinutes(a.startTime)
  const aEnd = timeToMinutes(a.endTime)
  const bStart = timeToMinutes(b.startTime)
  const bEnd = timeToMinutes(b.endTime)
  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false
  return aStart < bEnd && bStart < aEnd
}

export async function findUserByEmail(email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  const { data } = await apiClient.get('/api/v1/users', { params: { email: normalized } })
  return Array.isArray(data) && data.length ? data[0] : null
}

/**
 * @param {string} code
 * @param {{ globalScope?: boolean }} [options] If globalScope, ignore active admin (invite flow).
 */
export async function findResidentByCode(code, options = {}) {
  const normalized = normalizeCode(code)
  if (!normalized) return null
  const params = { role: 'resident', code: normalized }
  if (!options.globalScope) {
    const ownerId = getActiveDataOwnerId()
    if (ownerId) params.ownerAdminId = ownerId
  }
  const { data } = await apiClient.get('/api/v1/users', { params })
  return Array.isArray(data) && data.length ? data[0] : null
}
