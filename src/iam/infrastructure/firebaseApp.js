import { initializeApp, getApps } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth } from 'firebase/auth'
import { getDatabase } from 'firebase/database'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'emergentes-cb39f'
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
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDbzmls1Eox0CaGlAQwo-cNoIG9WMa4qv0',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'emergentes-cb39f.firebaseapp.com',
  projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'emergentes-cb39f.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '796311071365',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:796311071365:web:a8ce3464bf54a875d017ec',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-4ZDT7Y5JQZ',
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

export function getFirebaseStorage() {
  return getStorage(getFirebaseApp())
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
