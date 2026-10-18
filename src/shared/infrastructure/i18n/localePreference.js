import { isSupportedLocale } from '@/shared/domain/locale.js'

/** RF011 / RNF005: the selected UI language survives reloads and new sessions. */
export const LOCALE_STORAGE_KEY = 'buildingfex.locale'

/** Report §UX: English (en_US) is the default; Spanish (es_419) is the alternative. */
export const DEFAULT_LOCALE = 'en'

/** @returns {import('@/shared/domain/locale.js').SupportedLocaleCode | null} */
export function readStoredLocale() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return raw && isSupportedLocale(raw) ? raw : null
  } catch {
    return null
  }
}

/** @param {string} code */
export function storeLocale(code) {
  if (typeof window === 'undefined' || !isSupportedLocale(code)) return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, code)
  } catch {
    /* private mode / blocked storage: keep the in-memory choice only */
  }
}

/** @returns {import('@/shared/domain/locale.js').SupportedLocaleCode | null} */
function browserLocale() {
  if (typeof navigator === 'undefined') return null
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  for (const tag of candidates) {
    const base = String(tag).toLowerCase().split('-')[0]
    if (isSupportedLocale(base)) return base
  }
  return null
}

/** Stored choice → browser language (es* / en*) → default. */
export function resolveInitialLocale() {
  return readStoredLocale() ?? browserLocale() ?? DEFAULT_LOCALE
}
