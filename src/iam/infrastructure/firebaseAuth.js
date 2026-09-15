import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { apiError, normalizeEmail } from '@/shared/infrastructure/api/utils.js'
import { getFirebaseAuth, getFirebaseDb } from './firebaseApp.js'

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

function adminUserFrom(uid, email, profile = {}) {
  return {
    id: uid,
    name: String(profile.name ?? '').trim(),
    email,
    role: 'admin',
    dni: String(profile.dni ?? '').trim(),
    address: String(profile.address ?? '').trim(),
    company: String(profile.company ?? '').trim(),
    ruc: String(profile.ruc ?? '').trim(),
  }
}

async function saveAdminProfile(uid, profile) {
  await setDoc(
    doc(getFirebaseDb(), 'users', uid),
    {
      role: 'admin',
      name: profile.name,
      email: profile.email,
      dni: profile.dni,
      address: profile.address,
      company: profile.company,
      ruc: profile.ruc,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  )
}

async function readAdminProfile(uid) {
  const snap = await getDoc(doc(getFirebaseDb(), 'users', uid))
  if (!snap.exists()) return null
  return snap.data()
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
    const user = adminUserFrom(credential.user.uid, email, {
      name,
      dni: payload.dni,
      address: payload.address,
      company: payload.company,
      ruc: payload.ruc,
    })
    try {
      await saveAdminProfile(credential.user.uid, user)
    } catch {
      // Auth succeeded even if Firestore rules/index are not ready yet.
    }
    const token = await credential.user.getIdToken()
    return { user, token }
  } catch (error) {
    throw mapAuthError(error)
  }
}

export async function loginAdminWithFirebase({ email, password }) {
  const normalized = normalizeEmail(email)
  try {
    const credential = await signInWithEmailAndPassword(
      getFirebaseAuth(),
      normalized,
      String(password ?? ''),
    )
    const token = await credential.user.getIdToken()
    let stored = null
    try {
      stored = await readAdminProfile(credential.user.uid)
    } catch {
      stored = null
    }
    if (stored?.role === 'resident') {
      throw apiError('RESIDENT_USE_GOOGLE')
    }
    const user = adminUserFrom(credential.user.uid, credential.user.email || normalized, {
      name: stored?.name || credential.user.displayName || '',
      dni: stored?.dni,
      address: stored?.address,
      company: stored?.company,
      ruc: stored?.ruc,
    })
    if (!stored) {
      try {
        await saveAdminProfile(credential.user.uid, user)
      } catch {
        // ignore
      }
    }
    return { user, token }
  } catch (error) {
    throw mapAuthError(error)
  }
}

export async function getFirebaseAdminProfile(userId) {
  if (!userId) return null
  try {
    const stored = await readAdminProfile(userId)
    if (!stored) return null
    return adminUserFrom(userId, stored.email, stored)
  } catch {
    return null
  }
}
