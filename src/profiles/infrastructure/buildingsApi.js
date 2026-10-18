import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { publicResident } from '@/shared/infrastructure/api/utils.js'

const BASE = '/api/v1/buildings'

function parseBuilding(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    id: Number(raw.id ?? raw.Id),
    name: String(raw.name ?? raw.Name ?? ''),
    address: String(raw.address ?? raw.Address ?? ''),
    departmentCount: Number(raw.departmentCount ?? raw.DepartmentCount ?? 0),
    ownerAdminId: raw.ownerAdminId ?? raw.OwnerAdminId ?? null,
    suggestedPlanId: raw.suggestedPlanId ?? raw.SuggestedPlanId ?? null,
    createdAt: raw.createdAt ?? null,
  }
}

/**
 * Field errors of a 400 ValidationProblem (TS001) → `{ name: '...', address: '...' }`.
 * @param {any} error
 */
export function buildingFieldErrors(error) {
  const errors = error?.payload?.errors
  if (!errors || typeof errors !== 'object') return {}
  const out = {}
  for (const [key, messages] of Object.entries(errors)) {
    const field = key.charAt(0).toLowerCase() + key.slice(1)
    out[field] = Array.isArray(messages) ? String(messages[0] ?? '') : String(messages ?? '')
  }
  return out
}

/** Profiles — condominium registration (RF015 / US015 / TS001 / TS002). */
export const buildingsApi = {
  async mine() {
    const { data } = await apiClient.get(`${BASE}/mine`)
    return Array.isArray(data) ? data.map(parseBuilding).filter(Boolean) : []
  },

  async create({ name, address, departmentCount }) {
    const { data } = await apiClient.post(BASE, {
      name: String(name ?? '').trim(),
      address: String(address ?? '').trim(),
      departmentCount: Number(departmentCount),
    })
    return parseBuilding(data)
  },

  async update(id, { name, address, departmentCount }) {
    const { data } = await apiClient.put(`${BASE}/${encodeURIComponent(id)}`, {
      name: String(name ?? '').trim(),
      address: String(address ?? '').trim(),
      departmentCount: Number(departmentCount),
    })
    return parseBuilding(data)
  },

  async residents(id) {
    const { data } = await apiClient.get(`${BASE}/${encodeURIComponent(id)}/residents`)
    return Array.isArray(data) ? data.map(publicResident) : []
  },
}
