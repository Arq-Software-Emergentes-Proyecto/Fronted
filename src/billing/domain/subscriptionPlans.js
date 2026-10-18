/** Plan identifiers stored from Settings → subscription UI. */
export const SubscriptionPlanId = /** @type {const} */ ({
  FREE: 'free',
  ESSENTIAL: 'essential',
  STANDARD: 'standard',
  SCALE: 'scale',
  PORTAFOLIO: 'portafolio',
})

/** Free plan = 30-day trial with Essential features (TP1 report, 1.2). */
export const FREE_TRIAL_DAYS = 30

/** Portafolio: S/ 3 per department, minimum S/ 450, from 150 departments. */
export const PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN = 3
export const PORTAFOLIO_MINIMUM_PEN = 450
export const PORTAFOLIO_MINIMUM_DEPARTMENTS = 150

/** Max resident accounts allowed per plan (must match backend SubscriptionPlans). */
export const SUBSCRIPTION_PLAN_RESIDENT_LIMITS = /** @type {Record<string, number>} */ ({
  [SubscriptionPlanId.FREE]: 15,
  [SubscriptionPlanId.ESSENTIAL]: 15,
  [SubscriptionPlanId.STANDARD]: 40,
  [SubscriptionPlanId.SCALE]: 80,
  [SubscriptionPlanId.PORTAFOLIO]: 5000,
})

/** Monthly price in PEN (must match backend SubscriptionPlans). Portafolio = minimum. */
export const SUBSCRIPTION_PLAN_PRICES_PEN = /** @type {Record<string, number>} */ ({
  [SubscriptionPlanId.FREE]: 0,
  [SubscriptionPlanId.ESSENTIAL]: 60,
  [SubscriptionPlanId.STANDARD]: 120,
  [SubscriptionPlanId.SCALE]: 200,
  [SubscriptionPlanId.PORTAFOLIO]: PORTAFOLIO_MINIMUM_PEN,
})

/** Monthly AI assistant query cap per building (must match backend SubscriptionPlans). */
export const SUBSCRIPTION_PLAN_AI_QUERY_CAPS = /** @type {Record<string, number>} */ ({
  [SubscriptionPlanId.FREE]: 150,
  [SubscriptionPlanId.ESSENTIAL]: 150,
  [SubscriptionPlanId.STANDARD]: 400,
  [SubscriptionPlanId.SCALE]: 800,
  [SubscriptionPlanId.PORTAFOLIO]: 2000,
})

function planKey(planId) {
  return planId != null && String(planId).length ? String(planId) : SubscriptionPlanId.FREE
}

/**
 * @param {string | null | undefined} planId
 * @param {number} [departmentCount] used by Portafolio (S/ 3 per department, min S/ 450)
 */
export function monthlyPriceForSubscriptionPlan(planId, departmentCount) {
  const key = planKey(planId)
  if (key === SubscriptionPlanId.PORTAFOLIO && Number.isFinite(departmentCount)) {
    return Math.max(PORTAFOLIO_MINIMUM_PEN, PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN * Math.max(0, departmentCount))
  }
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
  const n = SUBSCRIPTION_PLAN_RESIDENT_LIMITS[planKey(planId)]
  return Number.isFinite(n) && n > 0 ? n : SUBSCRIPTION_PLAN_RESIDENT_LIMITS[SubscriptionPlanId.FREE]
}

/**
 * @param {string | null | undefined} planId
 * @returns {number}
 */
export function monthlyAiQueryCapForSubscriptionPlan(planId) {
  const n = SUBSCRIPTION_PLAN_AI_QUERY_CAPS[planKey(planId)]
  return Number.isFinite(n) && n > 0 ? n : SUBSCRIPTION_PLAN_AI_QUERY_CAPS[SubscriptionPlanId.FREE]
}
