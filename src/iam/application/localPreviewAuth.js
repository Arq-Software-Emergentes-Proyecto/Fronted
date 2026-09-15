import { SessionRoles } from '@/iam/domain/sessionRoles.js'

/** Offline login is only for `npm run dev`, so production keeps the real API. */
export const LOCAL_PREVIEW_ENABLED = import.meta.env.DEV

function encodeJwtSegment(value) {
  const json = JSON.stringify(value)
  const base64 = btoa(json)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPreviewAccessToken({ role, email, sub }) {
  const header = encodeJwtSegment({ alg: 'none', typ: 'JWT' })
  const payload = encodeJwtSegment({
    preview: true,
    role,
    email,
    sub: sub ?? 'preview-user',
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  })
  return `${header}.${payload}.preview`
}

export function isPreviewAccessToken(token) {
  if (!token) return false
  try {
    const segment = String(token).split('.')[1]
    if (!segment) return false
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded))
    return payload?.preview === true
  } catch {
    return false
  }
}

export function resolvePreviewRole(email) {
  return /resident/i.test(String(email ?? '')) ? SessionRoles.RESIDENT : SessionRoles.ADMIN
}

export function previewAdminAuthResult({ email, name } = {}) {
  const profile = buildPreviewProfile({
    email,
    name,
    role: SessionRoles.ADMIN,
  })
  return {
    user: {
      ...profile,
      role: SessionRoles.ADMIN,
      dni: '',
      address: '',
      company: '',
      ruc: '',
    },
    token: createPreviewAccessToken({
      role: SessionRoles.ADMIN,
      email: profile.email,
      sub: profile.id,
    }),
  }
}

export function buildPreviewProfile({ email, name, role }) {
  const trimmedEmail = String(email ?? '').trim()
  const displayName =
    String(name ?? '').trim() ||
    (role === SessionRoles.RESIDENT ? 'Residente demo' : 'Admin demo')

  if (role === SessionRoles.RESIDENT) {
    return {
      id: 'preview-resident-1',
      name: displayName,
      email: trimmedEmail,
      floor: '3',
      code: '302',
      ownerAdminId: 'preview-admin-1',
    }
  }

  return {
    id: 'preview-admin-1',
    name: displayName,
    email: trimmedEmail,
  }
}
