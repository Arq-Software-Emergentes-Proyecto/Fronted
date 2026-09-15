import { MOCK_DB_STORAGE_KEY } from './mockDb.js'

/**
 * Pushes this browser's previous local mock DB into the shared Vite mock
 * so invites created before the shared-server change still resolve.
 */
export async function hydratePreviewMockFromBrowser() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(MOCK_DB_STORAGE_KEY)
    if (!raw) return
    await fetch('/__preview/hydrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: raw,
    })
  } catch {
    // Vite preview mock not running
  }
}
