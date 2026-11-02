import { getActiveDataOwnerId } from './ownerTenant.js'

/** Merge API query params with owner scope when a data owner is active. */
export function withOwnerParams(params = {}) {
  const ownerId = getActiveDataOwnerId()
  if (!ownerId) return { ...params }
  return { ...params, ownerAdminId: ownerId }
}
