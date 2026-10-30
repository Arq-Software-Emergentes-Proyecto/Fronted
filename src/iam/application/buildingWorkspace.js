import { membersApi } from '@/iam/infrastructure/membersApi.js'
import { setAccessibleBuildings, setActiveBuilding } from '@/iam/application/sessionStore.js'

/**
 * Carga los edificios a los que tiene acceso la sesión (dueño, Portafolio, administrador asignado o
 * junta) y fija el activo. Si la API no responde, la sesión sigue con su edificio guardado.
 * @param {string|null} [token] token explícito (justo después de iniciar sesión)
 */
export async function loadAccessibleBuildings(token = null) {
  try {
    const result = await membersApi.myBuildings(token)
    setAccessibleBuildings(result.buildings, {
      canAddBuildings: result.canAddBuildings,
      accountKind: result.accountKind,
    })
    return result
  } catch {
    return null
  }
}

/**
 * Cambia el edificio activo. Recarga la aplicación para que cada vista vuelva a pedir sus datos con
 * el nuevo edificio (nunca se mezclan datos de dos edificios en pantalla).
 */
export function switchBuilding(ownerAdminId, { reloadTo = null } = {}) {
  setActiveBuilding(ownerAdminId)
  if (typeof window !== 'undefined') {
    if (reloadTo) window.location.assign(reloadTo)
    else window.location.reload()
  }
}
