import { apiClient } from '@/shared/infrastructure/api/apiClient.js'

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

/**
 * Equipo de gestión del condominio (dueño, administradores asignados y junta directiva) y
 * edificios a los que tiene acceso la sesión (Portafolio / administrador asignado / junta).
 */
export const membersApi = {
  /** GET /api/v1/me/buildings: { activeOwnerAdminId, canAddBuildings, accountKind, planId, buildings[] } */
  async myBuildings(token) {
    const { data } = await apiClient.get('/api/v1/me/buildings', { headers: authHeaders(token) })
    return {
      activeOwnerAdminId: data?.activeOwnerAdminId ?? null,
      canAddBuildings: Boolean(data?.canAddBuildings),
      accountKind: data?.accountKind ?? null,
      planId: data?.planId ?? null,
      buildings: Array.isArray(data?.buildings) ? data.buildings : [],
    }
  },

  /** GET /api/v1/members: dueño, miembros e invitaciones pendientes del edificio activo. */
  async list() {
    const { data } = await apiClient.get('/api/v1/members')
    return {
      owner: data?.owner ?? null,
      myRole: data?.myRole ?? null,
      canManage: Boolean(data?.canManage),
      members: Array.isArray(data?.members) ? data.members : [],
      invitations: Array.isArray(data?.invitations) ? data.invitations : [],
    }
  },

  /** Invita a un administrador ("admin") o a la junta ("board"). Devuelve el token del enlace. */
  async invite({ email, role, name }) {
    const { data } = await apiClient.post('/api/v1/members/invitations', { email, role, name })
    return data
  },

  async revokeInvitation(id) {
    await apiClient.delete(`/api/v1/members/invitations/${encodeURIComponent(id)}`)
  },

  async remove(userId) {
    await apiClient.delete(`/api/v1/members/${encodeURIComponent(userId)}`)
  },

  /** Público: datos del enlace de invitación (edificio, rol, correo, estado). */
  async getInvitation(token) {
    const { data } = await apiClient.get(`/api/v1/member-invitations/${encodeURIComponent(token)}`)
    return data
  },

  /** Acepta la invitación con la cuenta de Firebase recién iniciada (su token va explícito). */
  async acceptInvitation(inviteToken, { name } = {}, idToken = null) {
    const { data } = await apiClient.post(
      `/api/v1/member-invitations/${encodeURIComponent(inviteToken)}/accept`,
      { name },
      { headers: authHeaders(idToken) },
    )
    return data
  },

  /** Consola Portafolio: resumen de cada edificio (residentes e incidencias abiertas). */
  async portfolioSummary() {
    const { data } = await apiClient.get('/api/v1/portfolio/buildings')
    return Array.isArray(data) ? data : []
  },

  /** Portafolio: registra otro edificio de la cuenta (queda como condominio aparte). */
  async addBuilding({ name, address, departmentCount }) {
    const { data } = await apiClient.post('/api/v1/portfolio/buildings', {
      name,
      address,
      departmentCount: Number(departmentCount),
    })
    return data
  },
}
