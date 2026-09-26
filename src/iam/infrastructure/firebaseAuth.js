import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth'
import { apiError, normalizeEmail } from '@/shared/infrastructure/api/utils.js'
import { getFirebaseAuth } from './firebaseApp.js'

function mapAuthError(error) {
  if (
    error?.code === 'INVALID_PASSWORD' ||
    error?.code === 'RESIDENT_USE_GOOGLE' ||
    error?.code === 'EMAIL_NOT_FOUND' ||
    error?.code === 'EMAIL_ALREADY_EXISTS' ||
    error?.code === 'TOO_MANY_REQUESTS'
  ) {
    return error
  }

  const code = String(error?.code ?? '')
  const details = `${code} ${error?.message ?? ''}`.toLowerCase()

  if (code === 'auth/email-already-in-use' || details.includes('email_exists')) {
    return apiError('EMAIL_ALREADY_EXISTS')
  }
  if (
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email' ||
    details.includes('email_not_found')
  ) {
    return apiError('EMAIL_NOT_FOUND')
  }
  if (
    code === 'auth/wrong-password' ||
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials' ||
    code === 'auth/missing-password' ||
    code === 'auth/weak-password' ||
    details.includes('invalid_login_credentials') ||
    details.includes('invalid-credential') ||
    details.includes('wrong-password') ||
    details.includes('missing_password')
  ) {
    return apiError('INVALID_PASSWORD')
  }
  if (code === 'auth/too-many-requests' || details.includes('too_many_attempts')) {
    return apiError('TOO_MANY_REQUESTS')
  }
  if (code === 'auth/network-request-failed') return apiError('NETWORK_ERROR')
  if (error?.code && String(error.code).startsWith('EMAIL_')) return error
  return apiError('AUTH_ERROR', error?.message)
}

/** Identidad minima desde Firebase Auth (sin perfil de negocio). */
export function adminIdentityFrom(uid, email, name = '') {
  return {
    id: uid,
    name: String(name ?? '').trim(),
    email,
    role: 'admin',
  }
}

export async function isFirebaseEmailRegistered(email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { exists: false, methods: [] }
  try {
    const methods = await fetchSignInMethodsForEmail(getFirebaseAuth(), normalized)
    return { exists: methods.length > 0, methods }
  } catch {
    return { exists: false, methods: [] }
  }
}

/**
 * Solo autenticacion. El perfil de negocio se guarda en BuildingFex.Api POST /profiles.
 */
export async function registerAdminWithFirebase(payload) {
  const email = normalizeEmail(payload.email)
  const password = String(payload.password ?? '')
  const name = String(payload.name ?? '').trim()
  if (!email || !password || !name) {
    throw apiError('RESIDENT_FIELDS_REQUIRED')
  }

  try {
    const credential = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password)
    if (name) {
      await updateProfile(credential.user, { displayName: name })
    }
    const token = await credential.user.getIdToken()
    return {
      identity: adminIdentityFrom(credential.user.uid, email, name),
      token,
      profileDraft: {
        name,
        email,
        dni: String(payload.dni ?? '').trim(),
        address: String(payload.address ?? '').trim(),
        company: String(payload.company ?? '').trim(),
        ruc: String(payload.ruc ?? '').trim(),
      },
    }
  } catch (error) {
    throw mapAuthError(error)
  }
}

/**
 * Solo autenticacion. El perfil se hidrata luego desde GET /profiles/me.
 */
export async function loginAdminWithFirebase({ email, password }) {
  const normalized = normalizeEmail(email)
  try {
    const credential = await signInWithEmailAndPassword(
      getFirebaseAuth(),
      normalized,
      String(password ?? ''),
    )
    const token = await credential.user.getIdToken()
    return {
      identity: adminIdentityFrom(
        credential.user.uid,
        credential.user.email || normalized,
        credential.user.displayName || '',
      ),
      token,
    }
  } catch (error) {
    throw mapAuthError(error)
  }
}
