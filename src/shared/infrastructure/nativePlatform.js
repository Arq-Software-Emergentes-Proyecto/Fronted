import { Capacitor } from '@capacitor/core'

const PREVIEW_KEY = 'bf.nativePreview'

/**
 * Dev only: `?native=1` renders the app chrome (tab bar, page titles) in a normal browser so it can be
 * reviewed without a device build. `?native=0` turns it off again. Never active in production builds.
 */
function readNativePreview() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false
  try {
    const flag = new URLSearchParams(window.location.search).get('native')
    if (flag === '1') window.sessionStorage.setItem(PREVIEW_KEY, '1')
    if (flag === '0') window.sessionStorage.removeItem(PREVIEW_KEY)
    return window.sessionStorage.getItem(PREVIEW_KEY) === '1'
  } catch {
    return false
  }
}

/** Running inside the iOS/Android app (Capacitor), not in a browser. */
export const IS_NATIVE_APP = Capacitor.isNativePlatform()

/** Native app chrome on: the real app, or the dev preview above. */
export const USE_NATIVE_CHROME = IS_NATIVE_APP || readNativePreview()

/**
 * The app is not a web page: no pinch/auto zoom (iOS zooms into inputs under 16px and stays
 * zoomed, cutting the layout on the right), no long-press link previews, native status bar and
 * keyboard. Runs once before mount.
 */
export async function setupNativeShell() {
  if (!USE_NATIVE_CHROME) return
  const root = document.documentElement
  root.classList.add('bf-native', `bf-native--${Capacitor.getPlatform()}`)

  const viewport = document.querySelector('meta[name="viewport"]')
  viewport?.setAttribute(
    'content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  )

  if (!IS_NATIVE_APP) return
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    // The ⌃ ⌄ ✓ bar above the keyboard is a Safari form helper, not part of an app.
    await Keyboard.setAccessoryBarVisible({ isVisible: false })
  } catch {
    // plugin missing on this platform (Android has no accessory bar)
  }
}

/**
 * Status bar text colour per surface: light text over the navy auth header, dark text over the
 * white app bars.
 */
export async function setStatusBarDarkContent(darkContent) {
  if (!IS_NATIVE_APP) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: darkContent ? Style.Light : Style.Dark })
  } catch {
    // web / plugin unavailable
  }
}
