import { useConfirm } from 'primevue/useconfirm'

/** ConfirmDialog group rendered once by BfConfirmDialog (mounted in AppShellView). */
export const BF_CONFIRM_GROUP = 'bf-confirm'

/**
 * Promise-based replacement for `window.confirm` that renders the BuildingFex confirm dialog.
 *
 *   const askConfirm = useConfirmDialog()
 *   if (!(await askConfirm({ header, message, acceptLabel, danger: true }))) return
 *
 * Options: header, message, acceptLabel, rejectLabel, icon (PrimeIcons class),
 * severity ('warn' | 'info' | 'success' | 'error'), danger (red confirm button).
 * Resolves `true` on accept and `false` on cancel / Escape / close.
 */
export function useConfirmDialog() {
  const confirm = useConfirm()
  return function askConfirm(options = {}) {
    return new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      confirm.require({
        ...options,
        group: BF_CONFIRM_GROUP,
        accept: () => settle(true),
        reject: () => settle(false),
        onHide: () => settle(false),
      })
    })
  }
}
