/** Plan identifiers stored from Settings → subscription UI. */
export const SubscriptionPlanId = /** @type {const} */ ({
  FREE: 'free',
  ESSENTIAL: 'essential',
  STANDARD: 'standard',
  SCALE: 'scale',
})

/** Max resident accounts allowed per plan (aligned with pricing copy). */
export const SUBSCRIPTION_PLAN_RESIDENT_LIMITS = /** @type {Record<string, number>} */ ({
  [SubscriptionPlanId.FREE]: 9,
  [SubscriptionPlanId.ESSENTIAL]: 15,
  [SubscriptionPlanId.STANDARD]: 40,
  [SubscriptionPlanId.SCALE]: 80,
})

/** Monthly price in PEN (must match backend SubscriptionPlans). */
export const SUBSCRIPTION_PLAN_PRICES_PEN = /** @type {Record<string, number>} */ ({
  [SubscriptionPlanId.FREE]: 0,
  [SubscriptionPlanId.ESSENTIAL]: 40,
  [SubscriptionPlanId.STANDARD]: 80,
  [SubscriptionPlanId.SCALE]: 120,
})

export function monthlyPriceForSubscriptionPlan(planId) {
  const key = planId != null && String(planId).length ? String(planId) : SubscriptionPlanId.FREE
  const n = SUBSCRIPTION_PLAN_PRICES_PEN[key]
  return Number.isFinite(n) ? n : 0
}

export function isPaidSubscriptionPlan(planId) {
  return monthlyPriceForSubscriptionPlan(planId) > 0
}

/**
 * @param {string | null | undefined} planId
 * @returns {number}
 */
export function maxResidentsForSubscriptionPlan(planId) {
  const key = planId != null && String(planId).length ? String(planId) : SubscriptionPlanId.FREE
  const n = SUBSCRIPTION_PLAN_RESIDENT_LIMITS[key]
  return Number.isFinite(n) && n > 0 ? n : SUBSCRIPTION_PLAN_RESIDENT_LIMITS[SubscriptionPlanId.FREE]
}
