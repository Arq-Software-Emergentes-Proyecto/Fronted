import { GoogleAuthProvider, getAuth, signInWithPopup } from 'firebase/auth'
import { getFirebaseApp } from './firebaseApp.js'

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
  return googleError('GOOGLE_UNAVAILABLE')
}

export async function signInWithGoogle() {
  try {
    const auth = getAuth(getFirebaseApp())
    const provider = new GoogleAuthProvider()
    provider.setCustomParameters({ prompt: 'select_account' })
    const result = await signInWithPopup(auth, provider)
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
    }
  } catch (error) {
    if (error?.code === 'GOOGLE_PROFILE' || error?.code === 'GOOGLE_CANCELLED') {
      throw error
    }
    throw mapFirebaseError(error)
  }
}
