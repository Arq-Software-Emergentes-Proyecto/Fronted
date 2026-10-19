import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  signInWithEmailAndPassword,
  updatePassword,
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

/**
 * Multirole login (US014): email/password sign-in for any role. The role is resolved
 * afterwards by the API (GET /api/v1/authentication/me).
 */
export const signInWithPasswordFirebase = loginAdminWithFirebase

/**
 * Resident accepting an invite with email + password instead of Google.
 * Creates the Firebase email/password account (or signs into it if it already exists
 * with that same password, e.g. a retried invite) and returns its idToken.
 */
export async function createResidentPasswordAccount({ email, password, name }) {
  const normalized = normalizeEmail(email)
  const secret = String(password ?? '')
  if (!normalized || !secret) throw apiError('RESIDENT_FIELDS_REQUIRED')

  const auth = getFirebaseAuth()
  try {
    const credential = await createUserWithEmailAndPassword(auth, normalized, secret)
    if (String(name ?? '').trim()) {
      await updateProfile(credential.user, { displayName: String(name).trim() }).catch(() => {})
    }
    // A verified email keeps Firebase from dropping this password credential if the
    // resident later signs in with Google using the same address. Best effort.
    sendEmailVerification(credential.user).catch(() => {})
    return {
      uid: credential.user.uid,
      email: normalized,
      token: await credential.user.getIdToken(),
      // Lets the caller roll the account back if the API then rejects the invite.
      created: true,
    }
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'auth/weak-password') throw apiError('PASSWORD_TOO_SHORT')
    if (code !== 'auth/email-already-in-use') throw mapAuthError(error)
  }

  try {
    const credential = await signInWithEmailAndPassword(auth, normalized, secret)
    return {
      uid: credential.user.uid,
      email: normalized,
      token: await credential.user.getIdToken(),
      created: false,
    }
  } catch {
    throw apiError('EMAIL_ALREADY_EXISTS')
  }
}

/**
 * Best-effort rollback of a Firebase account created a moment ago by
 * createResidentPasswordAccount when the API then rejected the invite; otherwise a
 * retry (e.g. with another password) would fail with EMAIL_ALREADY_EXISTS.
 * Only deletes the signed-in user with that uid.
 */
export async function deleteJustCreatedFirebaseUser(uid) {
  try {
    const user = getFirebaseAuth().currentUser
    if (!user || (uid && user.uid !== uid)) return false
    await deleteUser(user)
    return true
  } catch (e) {
    console.warn('Could not roll back the Firebase account', e)
    return false
  }
}

function hasProvider(user, providerId) {
  return (user?.providerData ?? []).some((p) => p?.providerId === providerId)
}

/**
 * Signed-in resident (Google) adds an email/password credential to the SAME Firebase
 * account (same uid), or changes it if it already has one. Afterwards they can sign in
 * with Google or with email + password.
 * Throws REAUTH_REQUIRED when there is no Firebase session in this browser.
 */
export async function setPasswordForCurrentUser(password) {
  const secret = String(password ?? '')
  if (secret.length < 6) throw apiError('PASSWORD_TOO_SHORT')

  const auth = getFirebaseAuth()
  if (typeof auth.authStateReady === 'function') await auth.authStateReady()
  const user = auth.currentUser
  if (!user) throw apiError('REAUTH_REQUIRED')
  const email = normalizeEmail(user.email)
  if (!email) throw apiError('EMAIL_NOT_FOUND')

  const alreadyHasPassword = hasProvider(user, 'password')
  const run = () =>
    alreadyHasPassword
      ? updatePassword(user, secret)
      : linkWithCredential(user, EmailAuthProvider.credential(email, secret))

  try {
    await run()
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'auth/requires-recent-login' && hasProvider(user, 'google.com')) {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account', login_hint: email })
      await reauthenticateWithPopup(user, provider)
      await run()
    } else if (code === 'auth/requires-recent-login') {
      throw apiError('REAUTH_REQUIRED')
    } else if (code === 'auth/provider-already-linked') {
      await updatePassword(user, secret)
    } else if (code === 'auth/weak-password') {
      throw apiError('PASSWORD_TOO_SHORT')
    } else if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use') {
      throw apiError('EMAIL_ALREADY_EXISTS')
    } else {
      throw mapAuthError(error)
    }
  }

  return { email, changed: alreadyHasPassword }
}
