/**
 * v-bf-seg: segmented switch with a white pill that slides under the active option
 * (same motion as the sidebar and the ES/EN switch). Put it on the group element; the
 * active option is found with the default selector below, or with the one passed as value.
 */
const DEFAULT_ACTIVE = '.is-active, [aria-selected="true"], [aria-pressed="true"]'

function offsetWithin(node, root) {
  let x = 0
  let y = 0
  let current = node
  while (current && current !== root) {
    x += current.offsetLeft
    y += current.offsetTop
    current = current.offsetParent
  }
  return current === root ? { x, y } : null
}

function place(el) {
  const state = el.__bfSeg
  if (!state) return
  const { pill } = state
  const active = [...el.querySelectorAll(state.selector)].find((node) => node !== pill)
  const pos = active && active.offsetWidth ? offsetWithin(active, el) : null
  if (!pos) {
    pill.style.opacity = '0'
    return
  }
  pill.style.width = `${active.offsetWidth}px`
  pill.style.height = `${active.offsetHeight}px`
  pill.style.transform = `translate(${pos.x}px, ${pos.y}px)`
  pill.style.borderRadius = getComputedStyle(active).borderRadius
  pill.style.opacity = '1'
  // Scrollable row (phones): keep the active option in view when it changes.
  if (active !== state.active && el.scrollWidth > el.clientWidth) {
    const left = pos.x - (el.clientWidth - active.offsetWidth) / 2
    el.scrollTo({ left: Math.max(0, left), behavior: state.ready ? 'smooth' : 'auto' })
  }
  state.active = active
  if (!state.ready) {
    // Snap on first paint; animate only later changes.
    state.ready = true
    requestAnimationFrame(() => el.classList.add('bf-seg--ready'))
  }
}

export const vBfSeg = {
  mounted(el, binding) {
    const pill = document.createElement('span')
    pill.className = 'bf-seg__pill'
    pill.setAttribute('aria-hidden', 'true')
    el.classList.add('bf-seg')
    el.prepend(pill)

    const state = { pill, selector: binding.value || DEFAULT_ACTIVE, ready: false, frame: 0 }
    el.__bfSeg = state
    const schedule = () => {
      cancelAnimationFrame(state.frame)
      state.frame = requestAnimationFrame(() => place(el))
    }
    state.schedule = schedule
    state.mutations = new MutationObserver(schedule)
    state.mutations.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected', 'aria-pressed'],
    })
    if (typeof ResizeObserver !== 'undefined') {
      state.resize = new ResizeObserver(schedule)
      state.resize.observe(el)
    }
    window.addEventListener('resize', schedule)
    document.fonts?.ready?.then(schedule)
    place(el)
  },
  updated(el, binding) {
    const state = el.__bfSeg
    if (!state) return
    if (binding.value && binding.value !== state.selector) state.selector = binding.value
    state.schedule()
  },
  beforeUnmount(el) {
    const state = el.__bfSeg
    if (!state) return
    cancelAnimationFrame(state.frame)
    state.mutations.disconnect()
    state.resize?.disconnect()
    window.removeEventListener('resize', state.schedule)
    delete el.__bfSeg
  },
}
