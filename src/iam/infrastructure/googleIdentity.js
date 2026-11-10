import { GoogleAuthProvider, signInWithCredential, signInWithPopup } from 'firebase/auth'
import { Capacitor } from '@capacitor/core'
import { getFirebaseAuth } from './firebaseApp.js'

function googleError(code, message) {
  const error = new Error(message ?? code)
  error.code = code
  return error
}

function mapFirebaseError(error) {
  const code = String(error?.code ?? '')
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return googleError('GOOGLE_CANCELLED')
  }
  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
    return googleError('GOOGLE_NOT_CONFIGURED')
  }
  if (code === 'auth/unauthorized-domain') {
    return googleError('GOOGLE_NOT_CONFIGURED')
  }
  if (code === 'auth/popup-blocked') return googleError('GOOGLE_POPUP_BLOCKED')
  // Navegadores dentro de apps (Instagram, Facebook…) o sin almacenamiento: Google no deja entrar.
  if (
    code === 'auth/operation-not-supported-in-this-environment' ||
    code === 'auth/web-storage-unsupported'
  ) {
    return googleError('GOOGLE_BROWSER_UNSUPPORTED')
  }
  if (code === 'auth/user-disabled') return googleError('ACCOUNT_DEACTIVATED')
  if (code === 'auth/network-request-failed') return googleError('NETWORK_ERROR')
  if (code === 'auth/too-many-requests') return googleError('TOO_MANY_REQUESTS')
  return googleError('GOOGLE_UNAVAILABLE')
}

/** Fuerza refresh para incluir custom claims recién escritos por el Admin SDK. */
export async function refreshFirebaseIdToken() {
  const auth = getFirebaseAuth()
  const user = auth.currentUser
  if (!user) {
    throw googleError('GOOGLE_UNAVAILABLE', 'No hay sesión Firebase activa.')
  }
  return user.getIdToken(true)
}

function selectAccountProvider() {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  return provider
}

/**
 * Native app (Capacitor): popups don't exist in the WebView, so the native Google sheet signs in
 * and its ID token is handed to the Firebase JS SDK. The JS user then works as on the web
 * (getIdToken, refresh, sign-out).
 */
async function signInWithNativeGoogle(auth) {
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication')
  let native
  try {
    native = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true })
  } catch (error) {
    // iOS: "The user canceled the sign-in flow." · Android: GetCredentialCancellationException
    if (/cancel/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)) {
      throw googleError('GOOGLE_CANCELLED')
    }
    throw error
  }
  const idToken = native?.credential?.idToken
  if (!idToken) throw googleError('GOOGLE_UNAVAILABLE', 'Google no devolvió un ID token.')
  return signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
}

export async function signInWithGoogle() {
  try {
    const auth = getFirebaseAuth()
    const result = Capacitor.isNativePlatform()
      ? await signInWithNativeGoogle(auth)
      : await signInWithPopup(auth, selectAccountProvider())
    const email = String(result.user?.email ?? '').trim()
    if (!email) {
      throw googleError('GOOGLE_PROFILE')
    }
    const idToken = await result.user.getIdToken()
    return {
      idToken,
      email,
      name: String(result.user.displayName ?? '').trim(),
      googleSub: String(result.user.uid ?? '').trim(),
      user: result.user,
    }
  } catch (error) {
    if (error?.code === 'GOOGLE_PROFILE' || error?.code === 'GOOGLE_CANCELLED') {
      throw error
    }
    throw mapFirebaseError(error)
  }
}
