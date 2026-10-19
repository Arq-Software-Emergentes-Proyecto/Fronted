import { isRef, reactive } from 'vue'
import i18n from '@/shared/infrastructure/i18n'

/**
 * Confirmación visual verde para lo que el admin o el residente agrega, reserva o envía.
 *
 * - `confirmSuccess(target, label)`: el botón pasa a verde, se dibuja un check y muestra `label`.
 *   Devuelve una promesa que se cumple cuando el check terminó de dibujarse, para cerrar el
 *   diálogo después. `target` puede ser el botón, un ref o el evento del submit/click.
 * - `markFresh(kind, id)` / `isFresh(kind, id)`: la fila nueva entra con un verde suave que se apaga
 *   solo (clase `bf-fresh` en la fila).
 */

const HOLD_MS = 2300
const CHECK_DRAWN_MS = 1100
const LEAVE_MS = 700
const FRESH_MS = 3400

const CHECK_SVG =
  '<svg class="bf-success__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9.5" stroke-width="1.6"/><path d="M8 12.4l2.8 2.8L16.2 9.6" stroke-width="2.4"/></svg>'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function resolveButton(target) {
  if (!target) return null
  const value = isRef(target) ? target.value : target
  if (typeof Element !== 'undefined' && value instanceof Element) {
    return value.closest('button, a') || value
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    const el = value.submitter || value.currentTarget || value.target
    if (el instanceof Element && el.tagName === 'FORM') {
      return el.querySelector('button[type="submit"]')
    }
    return el instanceof Element ? el.closest('button, a') || el : null
  }
  // Component instance (e.g. a ref on a child component).
  if (value?.$el instanceof Element) return value.$el
  return null
}

/**
 * If the green label does not fit, the button widens smoothly (unless it already fills its row,
 * like full-width buttons on phones; then the label is shortened to "Listo").
 * Returns a function that puts the original width back (animated or at once).
 */
function fitLabel(button, layer, text) {
  const noop = () => {}
  const startWidth = button.offsetWidth
  const styles = getComputedStyle(layer)
  const check = layer.querySelector('.bf-success__check')
  const needed = Math.ceil(
    text.scrollWidth +
      (check?.getBoundingClientRect().width || 0) +
      (parseFloat(styles.columnGap) || 0) +
      (parseFloat(styles.paddingLeft) || 0) +
      (parseFloat(styles.paddingRight) || 0) +
      2,
  )
  if (needed <= startWidth) return noop

  const parent = button.parentElement
  const parentInner = parent
    ? parent.clientWidth -
      (parseFloat(getComputedStyle(parent).paddingLeft) || 0) -
      (parseFloat(getComputedStyle(parent).paddingRight) || 0)
    : 0
  const fillsRow = parentInner > 0 && startWidth >= parentInner - 2
  if (fillsRow || needed > parentInner) {
    text.textContent = i18n.global.t('feedback.done')
    return noop
  }

  const original = { width: button.style.width, minWidth: button.style.minWidth, flex: button.style.flex }
  button.style.flex = '0 0 auto'
  button.style.width = `${startWidth}px`
  void button.offsetWidth
  button.style.width = `${needed}px`
  return (animated) => {
    if (animated && button.isConnected) {
      button.style.width = `${startWidth}px`
      setTimeout(() => Object.assign(button.style, original), LEAVE_MS)
    } else {
      Object.assign(button.style, original)
    }
  }
}

/**
 * @param {Element|Event|{value: Element}|null} target
 * @param {string} label  Texto que muestra el botón en verde (ej. "Residente agregado").
 * @returns {Promise<void>} se cumple cuando el check terminó de dibujarse.
 */
export function confirmSuccess(target, label) {
  const button = resolveButton(target)
  if (!button || !button.isConnected) return wait(prefersReducedMotion() ? 150 : 450)

  button.__bfSuccess?.cleanup()

  const layer = document.createElement('span')
  layer.className = 'bf-success__layer'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML = CHECK_SVG
  const text = document.createElement('span')
  text.className = 'bf-success__label'
  text.textContent = label || ''
  layer.appendChild(text)

  const live = document.createElement('span')
  live.className = 'bf-sr-only'
  live.setAttribute('role', 'status')
  live.textContent = label || ''

  button.classList.add('bf-success-host')
  button.appendChild(layer)
  const restoreWidth = fitLabel(button, layer, text)
  // Anuncio para lectores de pantalla fuera del botón, para no cambiar su nombre accesible.
  document.body.appendChild(live)
  // Two frames so the starting state paints before the transition.
  requestAnimationFrame(() => requestAnimationFrame(() => button.classList.add('is-bf-success')))

  let timer = 0
  const cleanup = () => {
    clearTimeout(timer)
    restoreWidth(false)
    button.classList.remove('is-bf-success', 'bf-success-host', 'is-bf-leaving')
    layer.remove()
    live.remove()
    delete button.__bfSuccess
  }
  button.__bfSuccess = { cleanup }
  timer = setTimeout(() => {
    button.classList.add('is-bf-leaving')
    button.classList.remove('is-bf-success')
    restoreWidth(true)
    timer = setTimeout(cleanup, LEAVE_MS)
  }, HOLD_MS)

  return wait(prefersReducedMotion() ? 200 : CHECK_DRAWN_MS)
}

const freshKeys = reactive(new Set())

export function markFresh(kind, id) {
  if (id === undefined || id === null) return
  const key = `${kind}:${id}`
  freshKeys.add(key)
  setTimeout(() => freshKeys.delete(key), FRESH_MS)
}

export function isFresh(kind, id) {
  return freshKeys.has(`${kind}:${id}`)
}
