import { initializeApp, getApps } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth } from 'firebase/auth'
import { getDatabase } from 'firebase/database'
import { getFirestore } from 'firebase/firestore'

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'emergentes-36306'
const databaseURL = normalizeDatabaseUrl(
  import.meta.env.VITE_FIREBASE_DATABASE_URL ||
    `https://${projectId}-default-rtdb.firebaseio.com`,
)

function normalizeDatabaseUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
}

function clearStaleRtdbHostCache() {
  if (typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    const stale = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (!key) continue
      if (key.startsWith('firebase:host:') && (key.includes('firebaseio.com') || key.includes('firebasedatabase.app'))) {
        stale.push(key)
      }
    }
    stale.forEach((key) => storage.removeItem(key))
  } catch {
    /* private mode / blocked storage */
  }
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB1bVNPlPOSdN6_D5mnrnMFE-U1wGFXG-w',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'emergentes-36306.firebaseapp.com',
  projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'emergentes-36306.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '461455825481',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:461455825481:web:8b95d6f82be7406b1abd98',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-D9G80Q09KT',
  databaseURL,
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

let rtdb
export function getFirebaseRtdb() {
  if (rtdb) return rtdb
  clearStaleRtdbHostCache()
  const app = getFirebaseApp()
  rtdb = app.options.databaseURL ? getDatabase(app) : getDatabase(app, databaseURL)
  return rtdb
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
