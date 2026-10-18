import { getActiveDataOwnerId } from '@/iam/application/sessionStore.js'
import { maxResidentsForSubscriptionPlan } from '@/billing/domain/subscriptionPlans.js'
import { subscriptionApi } from '@/billing/infrastructure/subscriptionApi.js'

const STORAGE_KEY = 'buildingfex.subscriptionPlanByOwner'
const CACHE_KEY = 'buildingfex.subscriptionCacheByOwner'

/** @type {Record<string, { planId: string, residentLimit: number, residentsCount: number, updatedAt: string }>} */
let memoryCache = {}

function readAll() {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(map) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

function readCacheAll() {
  if (typeof window === 'undefined') return {}
  if (Object.keys(memoryCache).length) return memoryCache
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    memoryCache = parsed && typeof parsed === 'object' ? parsed : {}
    return memoryCache
  } catch {
    return {}
  }
}

function writeCache(ownerId, payload) {
  if (!ownerId) return
  const all = readCacheAll()
  all[ownerId] = {
    ...payload,
    updatedAt: new Date().toISOString(),
  }
  memoryCache = all
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(all))
    } catch {
      // ignore
    }
  }
}

/**
 * Fetch subscription from API and refresh local cache.
 * @returns {Promise<{ planId: string, residentLimit: number, residentsCount: number } | null>}
 */
export async function refreshSubscriptionFromApi() {
  const ownerId = getActiveDataOwnerId()
  if (!ownerId) return null

  try {
    const sub = await subscriptionApi.getCurrent()
    if (!sub) return null

    saveSubscriptionPlanForOwner(ownerId, sub.planId)
    writeCache(ownerId, {
      planId: sub.planId,
      residentLimit: sub.residentLimit,
      residentsCount: sub.residentsCount,
    })

    return sub
  } catch {
    return null
  }
}

/**
 * @param {string} ownerAdminId
 * @param {string} planId
 */
export function saveSubscriptionPlanForOwner(ownerAdminId, planId) {
  const id = ownerAdminId != null ? String(ownerAdminId) : ''
  if (!id) return
  const all = readAll()
  all[id] = {
    planId: String(planId),
    updatedAt: new Date().toISOString(),
  }
  writeAll(all)
}

/**
 * @param {string} [ownerAdminId] defaults to active session owner
 * @returns {string} plan id
 */
export function getSubscriptionPlanIdForOwner(ownerAdminId) {
  const oid =
    ownerAdminId != null && String(ownerAdminId).length
      ? String(ownerAdminId)
      : getActiveDataOwnerId()
  if (!oid) return 'free'

  const cached = readCacheAll()[oid]
  if (cached?.planId) return String(cached.planId)

  const row = readAll()[oid]
  return row?.planId && String(row.planId).length ? String(row.planId) : 'free'
}

/** Max residents for the active admin (or given owner), from cache/API fallback. */
export function getResidentLimitForActiveOwner() {
  const oid = getActiveDataOwnerId()
  if (oid) {
    const cached = readCacheAll()[oid]
    if (cached?.residentLimit != null && Number.isFinite(Number(cached.residentLimit))) {
      return Number(cached.residentLimit)
    }
  }
  return maxResidentsForSubscriptionPlan(getSubscriptionPlanIdForOwner())
}

/** Cached resident count from last API sync. */
export function getCachedResidentsCount() {
  const oid = getActiveDataOwnerId()
  if (!oid) return null
  const cached = readCacheAll()[oid]
  return cached?.residentsCount != null ? Number(cached.residentsCount) : null
}

export function applySubscriptionSnapshot(sub) {
  const ownerId = getActiveDataOwnerId()
  if (!ownerId || !sub) return
  saveSubscriptionPlanForOwner(ownerId, sub.planId)
  writeCache(ownerId, {
    planId: sub.planId,
    residentLimit: sub.residentLimit,
    residentsCount: sub.residentsCount,
  })
}
