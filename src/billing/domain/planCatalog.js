import {
  FREE_TRIAL_DAYS,
  PORTAFOLIO_MINIMUM_DEPARTMENTS,
  PORTAFOLIO_MINIMUM_PEN,
  PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN,
  SUBSCRIPTION_PLAN_AI_QUERY_CAPS,
  SUBSCRIPTION_PLAN_PRICES_PEN,
  SUBSCRIPTION_PLAN_RESIDENT_LIMITS,
  SubscriptionPlanId,
} from '@/billing/domain/subscriptionPlans.js'

/**
 * Module keys of the plan comparison (must match backend PlanModules).
 * Labels/tooltips live in i18n under `billing.modules.*`.
 */
export const PLAN_MODULES = /** @type {const} */ ([
  'webConsole',
  'commonAreas',
  'collections',
  'announcements',
  'documents',
  'visits',
  'aiAssistant',
  'debtVisibility',
  'aiIncidentClassification',
  'implementationAssistance',
  'multiBuildingConsole',
])

const ESSENTIAL = PLAN_MODULES.slice(0, 8)
const STANDARD = PLAN_MODULES.slice(0, 9)
const SCALE = PLAN_MODULES.slice(0, 10)

function plan(id, name, minDepartments, support, modules, extra = {}) {
  return {
    id,
    name,
    monthlyPricePen: SUBSCRIPTION_PLAN_PRICES_PEN[id],
    pricePerDepartmentPen: null,
    minimumMonthlyPricePen: null,
    minDepartments,
    maxDepartments: SUBSCRIPTION_PLAN_RESIDENT_LIMITS[id],
    monthlyAiQueries: SUBSCRIPTION_PLAN_AI_QUERY_CAPS[id],
    trialDays: null,
    isTrial: false,
    isPaid: SUBSCRIPTION_PLAN_PRICES_PEN[id] > 0,
    support,
    modules,
    highlighted: false,
    ...extra,
  }
}

/**
 * Local mirror of GET /api/v1/plans. Only used by the preview mock adapter:
 * the UI must not show possibly stale prices when the API fails (US004 sc. 2).
 */
export function buildLocalPlanCatalog() {
  return {
    currency: 'PEN',
    trialDays: FREE_TRIAL_DAYS,
    modules: [...PLAN_MODULES],
    plans: [
      plan(SubscriptionPlanId.FREE, 'Free', 1, 'emailBusinessDays', ESSENTIAL, {
        trialDays: FREE_TRIAL_DAYS,
        isTrial: true,
      }),
      plan(SubscriptionPlanId.ESSENTIAL, 'Essential', 1, 'emailBusinessDays', ESSENTIAL),
      plan(SubscriptionPlanId.STANDARD, 'Standard', 16, 'priority', STANDARD, { highlighted: true }),
      plan(SubscriptionPlanId.SCALE, 'Scale', 41, 'agreedResponseTimes', SCALE),
      plan(SubscriptionPlanId.PORTAFOLIO, 'Portafolio', PORTAFOLIO_MINIMUM_DEPARTMENTS, 'sla', [...PLAN_MODULES], {
        pricePerDepartmentPen: PORTAFOLIO_PRICE_PER_DEPARTMENT_PEN,
        minimumMonthlyPricePen: PORTAFOLIO_MINIMUM_PEN,
      }),
    ],
  }
}

/**
 * Suggested paid plan for a unit count (US015): smallest of Essential / Standard / Scale
 * that fits, otherwise Portafolio. Mirrors backend PlanCatalog.SuggestForDepartments.
 * @param {number} departmentCount
 * @param {Array<{ id: string, isPaid: boolean, maxDepartments: number }>} [plans]
 */
export function suggestPlanForDepartments(departmentCount, plans) {
  const count = Math.max(1, Number(departmentCount) || 1)
  const list = Array.isArray(plans) && plans.length ? plans : buildLocalPlanCatalog().plans
  const fit = list.find(
    (p) => p.isPaid && p.id !== SubscriptionPlanId.PORTAFOLIO && count <= Number(p.maxDepartments),
  )
  return fit ? fit.id : SubscriptionPlanId.PORTAFOLIO
}
