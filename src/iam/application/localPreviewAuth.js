import { SessionRoles } from '@/iam/domain/sessionRoles.js'
import {
  getAccessToken,
  getSessionRole,
  isAccessTokenValid,
  setAdminSession,
  setResidentSession,
} from '@/iam/application/sessionStore.js'

/**
 * Demo / wireframe mode (local + Vercel): any login/register lets you in,
 * and the browser mock API serves hardcoded data (no Firebase/Railway required).
 *
 * On by default in `npm run dev`. Set VITE_OPEN_WIREFRAMES=true in production
 * builds when the team needs open capture access. Set false to require real auth.
 */
export const OPEN_WIREFRAME_ACCESS =
  String(
    import.meta.env.VITE_OPEN_WIREFRAMES ?? (import.meta.env.DEV ? 'true' : 'false'),
  ) === 'true'

/** Preview auth + mock API (same flag as open wireframes). */
export const LOCAL_PREVIEW_ENABLED = OPEN_WIREFRAME_ACCESS

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
    email: email || 'admin@demo.test',
    name: name || 'Admin demo',
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

export function previewResidentAuthResult({ email, name } = {}) {
  const profile = buildPreviewProfile({
    email: email || 'resident@demo.test',
    name: name || 'Residente demo',
    role: SessionRoles.RESIDENT,
  })
  return {
    user: {
      ...profile,
      role: SessionRoles.RESIDENT,
    },
    token: createPreviewAccessToken({
      role: SessionRoles.RESIDENT,
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
      email: trimmedEmail || 'resident@demo.test',
      floor: '3',
      code: '302',
      ownerAdminId: 'preview-admin-1',
    }
  }

  return {
    id: 'preview-admin-1',
    name: displayName,
    email: trimmedEmail || 'admin@demo.test',
  }
}

/**
 * Ensures a demo session for wireframe capture.
 * @param {'admin' | 'resident'} [role]
 * @returns {boolean} true when a preview session is active after the call
 */
export function ensureOpenAccessSession(role = SessionRoles.ADMIN) {
  if (!OPEN_WIREFRAME_ACCESS) return false

  const wanted =
    role === SessionRoles.RESIDENT ? SessionRoles.RESIDENT : SessionRoles.ADMIN
  const currentRole = getSessionRole()
  const token = getAccessToken()

  if (
    currentRole === wanted &&
    token &&
    isAccessTokenValid() &&
    isPreviewAccessToken(token)
  ) {
    return true
  }

  if (wanted === SessionRoles.RESIDENT) {
    const { user, token: previewToken } = previewResidentAuthResult()
    setResidentSession(
      {
        id: user.id,
        name: user.name,
        floor: user.floor,
        code: user.code,
        email: user.email,
        ownerAdminId: user.ownerAdminId ?? null,
      },
      previewToken,
    )
  } else {
    const { user, token: previewToken } = previewAdminAuthResult()
    setAdminSession(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        role: SessionRoles.ADMIN,
        dni: '',
        address: '',
        company: '',
        ruc: '',
      },
      previewToken,
    )
  }

  return true
}
