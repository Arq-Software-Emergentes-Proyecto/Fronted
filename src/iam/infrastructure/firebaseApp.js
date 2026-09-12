import { initializeApp, getApps } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB1bVNPlPOSdN6_D5mnrnMFE-U1wGFXG-w',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'emergentes-36306.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'emergentes-36306',
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'emergentes-36306.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '461455825481',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:461455825481:web:8b95d6f82be7406b1abd98',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-D9G80Q09KT',
}

export function getFirebaseApp() {
  return getApps()[0] ?? initializeApp(firebaseConfig)
}

export function getFirebaseAuth() {
  return getAuth(getFirebaseApp())
}

export function getFirebaseDb() {
  return getFirestore(getFirebaseApp())
}

export async function startFirebaseAnalytics() {
  if (typeof window === 'undefined') return null
  try {
    if (!(await isSupported())) return null
    return getAnalytics(getFirebaseApp())
  } catch {
    return null
  }
}
