<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Tooltip from 'primevue/tooltip'
import { plansApi } from '@/billing/infrastructure/plansApi.js'
import { SubscriptionPlanId, monthlyPriceForSubscriptionPlan } from '@/billing/domain/subscriptionPlans.js'
import { suggestPlanForDepartments } from '@/billing/domain/planCatalog.js'

/**
 * Plan cards + comparison table (RF004/RF005 — US004/US005).
 * Prices always come from GET /api/v1/plans: if it fails we show an error with retry
 * and never fall back to possibly outdated prices (US004 sc. 2).
 */
const props = defineProps({
  currentPlanId: { type: String, default: SubscriptionPlanId.FREE },
  /** Parsed subscription (subscriptionApi.getCurrent) — status, trial, billable departments. */
  subscription: { type: Object, default: null },
  busyPlanId: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  /** Plan to highlight as "recommended" (e.g. from the building's unit count, US015). */
  suggestedPlanId: { type: String, default: null },
})

const emit = defineEmits(['select'])

const vTooltip = Tooltip
const { t, locale } = useI18n()

const catalog = ref(null)
const isLoading = ref(false)
const loadError = ref('')
const showComparison = ref(true)

async function loadCatalog() {
  isLoading.value = true
  loadError.value = ''
  try {
    catalog.value = await plansApi.getCatalog()
  } catch {
    catalog.value = null
    loadError.value = t('billing.plans.loadError')
  } finally {
    isLoading.value = false
  }
}

onMounted(loadCatalog)

const plans = computed(() => catalog.value?.plans ?? [])
const modules = computed(() => catalog.value?.modules ?? [])

const billableDepartments = computed(() => Number(props.subscription?.billableDepartments ?? 0))

const recommendedPlanId = computed(() => {
  if (props.suggestedPlanId) return props.suggestedPlanId
  if (props.subscription?.suggestedPlanId) return props.subscription.suggestedPlanId
  if (billableDepartments.value > 0) return suggestPlanForDepartments(billableDepartments.value, plans.value)
  return null
})

const trialExpired = computed(() => Boolean(props.subscription?.trialExpired))

const money = computed(
  () =>
    new Intl.NumberFormat(locale.value === 'en' ? 'en-US' : 'es-PE', {
      style: 'currency',
      currency: 'PEN',
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    }),
)

function formatPen(value) {
  return money.value.format(Number(value) || 0)
}

function formatNumber(value) {
  return new Intl.NumberFormat(locale.value === 'en' ? 'en-US' : 'es-PE').format(Number(value) || 0)
}

function rangeLabel(plan) {
  if (plan.id === SubscriptionPlanId.PORTAFOLIO) {
    return t('billing.plans.rangeFrom', { min: formatNumber(plan.minDepartments) })
  }
  if (plan.minDepartments > 1) {
    return t('billing.plans.rangeBetween', { min: plan.minDepartments, max: plan.maxDepartments })
  }
  return t('billing.plans.rangeUpTo', { max: plan.maxDepartments })
}

function portafolioEstimate(plan) {
  if (plan.id !== SubscriptionPlanId.PORTAFOLIO || billableDepartments.value <= 0) return null
  return monthlyPriceForSubscriptionPlan(plan.id, billableDepartments.value)
}

/** Modules added on top of the previous plan in the list ("Everything in X, plus…"). */
function planHighlights(plan, index) {
  const previous = index > 0 ? plans.value[index - 1] : null
  if (!previous || plan.isTrial || previous.isTrial) {
    return { base: null, items: plan.modules }
  }
  const prev = new Set(previous.modules)
  return { base: previous.name, items: plan.modules.filter((m) => !prev.has(m)) }
}

function isCurrent(plan) {
  return props.currentPlanId === plan.id
}

function buttonLabel(plan) {
  if (props.busyPlanId === plan.id) return t('billing.plans.processing')
  if (plan.isTrial) {
    if (trialExpired.value) return t('billing.plans.trialEnded')
    return isCurrent(plan) ? t('billing.plans.currentTrial') : t('billing.plans.startTrial')
  }
  if (isCurrent(plan)) return t('billing.plans.renew', { name: plan.name })
  return t('billing.plans.choose', { name: plan.name })
}

function isButtonDisabled(plan) {
  if (props.disabled || Boolean(props.busyPlanId)) return true
  if (plan.isTrial) return trialExpired.value || isCurrent(plan)
  return false
}

function onSelect(plan, event) {
  if (isButtonDisabled(plan)) return
  emit('select', plan.id, event)
}

function moduleLabel(key) {
  return t(`billing.modules.${key}.label`)
}

function moduleHelp(key) {
  return t(`billing.modules.${key}.help`)
}

function supportLabel(key) {
  return t(`billing.support.${key}`)
}

function priceCell(plan) {
  if (plan.id === SubscriptionPlanId.PORTAFOLIO) {
    return t('billing.plans.pricePerDepartment', {
      price: formatPen(plan.pricePerDepartmentPen),
      min: formatPen(plan.minimumMonthlyPricePen),
    })
  }
  if (plan.isTrial) return t('billing.plans.trialPrice', { days: plan.trialDays ?? catalog.value?.trialDays ?? 30 })
  return t('billing.plans.pricePerMonth', { price: formatPen(plan.monthlyPricePen) })
}

defineExpose({ reload: loadCatalog })
</script>

<template>
  <div class="bf-plans">
    <div v-if="isLoading" class="bf-plans__state" role="status">
      <i class="pi pi-spin pi-spinner" aria-hidden="true" />
      {{ t('billing.plans.loading') }}
    </div>

    <div v-else-if="loadError" class="bf-plans__state bf-plans__state--error" role="alert">
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      <span>{{ loadError }}</span>
      <button type="button" class="bf-plans__retry" @click="loadCatalog">
        <i class="pi pi-refresh" aria-hidden="true" />
        {{ t('billing.plans.retry') }}
      </button>
    </div>

    <template v-else-if="plans.length">
      <p class="bf-plans__currency-note">{{ t('billing.plans.currencyNote') }}</p>

      <div class="plans-grid">
        <article
          v-for="(plan, index) in plans"
          :key="plan.id"
          class="plan-card"
          :class="{
            'plan-card--free': plan.isTrial,
            'plan-card--highlighted': plan.highlighted,
            'plan-card--selected': isCurrent(plan),
            'plan-card--recommended': recommendedPlanId === plan.id && !isCurrent(plan),
          }"
          :aria-labelledby="`plan-${plan.id}-name`"
        >
          <div class="plan-card__header">
            <h3 :id="`plan-${plan.id}-name`" class="plan-card__name">{{ plan.name }}</h3>
            <span v-if="isCurrent(plan)" class="plan-card__badge plan-card__badge--current">
              <i class="pi pi-check-circle" aria-hidden="true" />
              {{ t('billing.plans.currentPlanPill') }}
            </span>
            <span v-else-if="recommendedPlanId === plan.id" class="plan-card__badge plan-card__badge--recommended">
              <i class="pi pi-star" aria-hidden="true" />
              {{ t('billing.plans.recommendedBadge') }}
            </span>
            <span v-else-if="plan.highlighted" class="plan-card__badge">
              {{ t('billing.plans.popularBadge') }}
            </span>
          </div>

          <div class="plan-card__price">
            <template v-if="plan.id === 'portafolio'">
              <span class="plan-card__amount">{{ formatPen(plan.pricePerDepartmentPen) }}</span>
              <span class="plan-card__period">{{ t('billing.plans.perDepartmentMonth') }}</span>
            </template>
            <template v-else>
              <span class="plan-card__amount">{{ formatPen(plan.monthlyPricePen) }}</span>
              <span class="plan-card__period">{{ t('billing.plans.perMonth') }}</span>
            </template>
          </div>

          <p class="plan-card__range">{{ rangeLabel(plan) }}</p>
          <p class="plan-card__billing">
            <template v-if="plan.isTrial">
              {{ t('billing.plans.trialBilling', { days: plan.trialDays ?? 30 }) }}
            </template>
            <template v-else-if="plan.id === 'portafolio'">
              {{ t('billing.plans.portafolioBilling', { min: formatPen(plan.minimumMonthlyPricePen) }) }}
              <template v-if="portafolioEstimate(plan) != null">
                <br />
                <strong>{{
                  t('billing.plans.portafolioEstimate', {
                    count: formatNumber(billableDepartments),
                    price: formatPen(portafolioEstimate(plan)),
                  })
                }}</strong>
              </template>
            </template>
            <template v-else>{{ t('billing.plans.monthlyBilling') }}</template>
          </p>

          <ul class="plan-card__features">
            <li>
              <i class="pi pi-sparkles" aria-hidden="true" />
              {{ t('billing.plans.aiQueries', { count: formatNumber(plan.monthlyAiQueries) }) }}
            </li>
            <li>
              <i class="pi pi-headphones" aria-hidden="true" />
              {{ supportLabel(plan.support) }}
            </li>
            <li v-if="planHighlights(plan, index).base" class="plan-card__features-base">
              {{ t('billing.plans.everythingIn', { name: planHighlights(plan, index).base }) }}
            </li>
            <li v-for="key in planHighlights(plan, index).items" :key="key">
              <i class="pi pi-check" aria-hidden="true" />
              {{ moduleLabel(key) }}
            </li>
          </ul>

          <button
            type="button"
            class="plan-card__btn"
            :class="!isCurrent(plan) && (plan.highlighted || recommendedPlanId === plan.id) ? 'plan-card__btn--primary' : 'plan-card__btn--ghost'"
            :disabled="isButtonDisabled(plan)"
            :aria-busy="busyPlanId === plan.id"
            @click="onSelect(plan, $event)"
          >
            <span>{{ buttonLabel(plan) }}</span>
          </button>
        </article>
      </div>

      <section class="bf-compare" aria-labelledby="bf-compare-title">
        <div class="bf-compare__head">
          <h3 id="bf-compare-title" class="bf-compare__title">{{ t('billing.compare.title') }}</h3>
          <button
            type="button"
            class="bf-compare__toggle"
            :aria-expanded="showComparison"
            aria-controls="bf-compare-table"
            @click="showComparison = !showComparison"
          >
            <i class="pi" :class="showComparison ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true" />
            {{ showComparison ? t('billing.compare.hide') : t('billing.compare.show') }}
          </button>
        </div>
        <p class="bf-compare__hint">{{ t('billing.compare.hint') }}</p>

        <div v-show="showComparison" id="bf-compare-table" class="bf-compare__scroll" tabindex="0" :aria-label="t('billing.compare.scrollLabel')">
          <table class="bf-compare__table">
            <caption class="visually-hidden">{{ t('billing.compare.caption') }}</caption>
            <thead>
              <tr>
                <th scope="col" class="bf-compare__feature-col">{{ t('billing.compare.feature') }}</th>
                <th
                  v-for="plan in plans"
                  :key="plan.id"
                  scope="col"
                  :class="{ 'is-current': isCurrent(plan), 'is-recommended': recommendedPlanId === plan.id }"
                >
                  <span class="bf-compare__plan">{{ plan.name }}</span>
                  <span v-if="isCurrent(plan)" class="bf-compare__tag bf-compare__tag--current">
                    {{ t('billing.plans.currentPlanPill') }}
                  </span>
                  <span v-else-if="recommendedPlanId === plan.id" class="bf-compare__tag bf-compare__tag--recommended">
                    {{ t('billing.plans.recommendedBadge') }}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr class="bf-compare__group">
                <th scope="row">
                  {{ t('billing.compare.price') }}
                </th>
                <td v-for="plan in plans" :key="plan.id" :class="{ 'is-current': isCurrent(plan) }">{{ priceCell(plan) }}</td>
              </tr>
              <tr>
                <th scope="row">
                  <span>{{ t('billing.compare.departments') }}</span>
                  <span
                    v-tooltip.top="t('billing.compare.departmentsHelp')"
                    class="bf-compare__help"
                    tabindex="0"
                    role="note"
                    :aria-label="t('billing.compare.departmentsHelp')"
                  ><i class="pi pi-question-circle" aria-hidden="true" /></span>
                </th>
                <td v-for="plan in plans" :key="plan.id" :class="{ 'is-current': isCurrent(plan) }">{{ rangeLabel(plan) }}</td>
              </tr>
              <tr>
                <th scope="row">
                  <span>{{ t('billing.compare.aiQueries') }}</span>
                  <span
                    v-tooltip.top="t('billing.compare.aiQueriesHelp')"
                    class="bf-compare__help"
                    tabindex="0"
                    role="note"
                    :aria-label="t('billing.compare.aiQueriesHelp')"
                  ><i class="pi pi-question-circle" aria-hidden="true" /></span>
                </th>
                <td v-for="plan in plans" :key="plan.id" :class="{ 'is-current': isCurrent(plan) }">
                  {{ t('billing.compare.aiQueriesValue', { count: formatNumber(plan.monthlyAiQueries) }) }}
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <span>{{ t('billing.compare.support') }}</span>
                  <span
                    v-tooltip.top="t('billing.compare.supportHelp')"
                    class="bf-compare__help"
                    tabindex="0"
                    role="note"
                    :aria-label="t('billing.compare.supportHelp')"
                  ><i class="pi pi-question-circle" aria-hidden="true" /></span>
                </th>
                <td v-for="plan in plans" :key="plan.id" :class="{ 'is-current': isCurrent(plan) }">{{ supportLabel(plan.support) }}</td>
              </tr>
              <tr class="bf-compare__section">
                <th scope="rowgroup" :colspan="plans.length + 1">{{ t('billing.compare.modules') }}</th>
              </tr>
              <tr v-for="key in modules" :key="key">
                <th scope="row">
                  <span>{{ moduleLabel(key) }}</span>
                  <span
                    v-tooltip.top="moduleHelp(key)"
                    class="bf-compare__help"
                    tabindex="0"
                    role="note"
                    :aria-label="moduleHelp(key)"
                  ><i class="pi pi-question-circle" aria-hidden="true" /></span>
                </th>
                <td v-for="plan in plans" :key="plan.id" class="bf-compare__mark" :class="{ 'is-current': isCurrent(plan) }">
                  <i
                    v-if="plan.modules.includes(key)"
                    class="pi pi-check bf-compare__yes"
                    :aria-label="t('billing.compare.included')"
                  />
                  <span v-else class="bf-compare__no" :aria-label="t('billing.compare.notIncluded')">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.bf-plans {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bf-plans *,
.bf-plans *::before,
.bf-plans *::after {
  box-sizing: border-box;
}

.bf-plans__state {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  font-size: 0.85rem;
  color: #6e6e73;
}

.bf-plans__state--error {
  background: #fde4e4;
  color: #7f1d1d;
}

.bf-plans__state--error > .pi {
  color: #b42318;
}

.bf-plans__retry {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  border: none;
  background: #fff;
  color: #b42318;
  font: inherit;
  font-weight: 650;
  font-size: 0.78rem;
  cursor: pointer;
}

.bf-plans__retry:hover {
  text-decoration: underline;
}

.bf-plans__currency-note {
  margin: 0 0 0.75rem;
  font-size: 0.75rem;
  color: #6e6e73;
}

.plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
  gap: 0.85rem;
  align-items: stretch;
}

.plan-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 1.1rem 1.1rem 1.05rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.1);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.plan-card:hover {
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
}

.plan-card--recommended {
  border-color: #15803d;
  box-shadow: 0 0 0 1px #15803d;
}

.plan-card--selected {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 1px #1e3a8a;
  background: #fbfcff;
}

.plan-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.4rem 0.5rem;
  margin-bottom: 0.75rem;
}

.plan-card__name {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.plan-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 650;
  background: #fdf3dc;
  color: #92400e;
  white-space: nowrap;
}

.plan-card__badge .pi {
  font-size: 0.65rem;
}

.plan-card__badge--current {
  background: #1e3a8a;
  color: #fff;
}

.plan-card__badge--recommended {
  background: #e3f4e8;
  color: #166534;
}

.plan-card__price {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.35rem;
}

.plan-card__amount {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: #0f172a;
}

.plan-card__period {
  font-size: 0.78rem;
  color: #6e6e73;
}

.plan-card__range {
  margin: 0 0 0.2rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #0f172a;
}

.plan-card__billing {
  margin: 0 0 0.9rem;
  font-size: 0.74rem;
  color: #6e6e73;
  line-height: 1.45;
}

.plan-card__billing strong {
  color: #1e3a8a;
  font-weight: 650;
}

.plan-card__features {
  flex: 1;
  list-style: none;
  margin: 0 0 1.05rem;
  padding: 0.85rem 0 0;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: #334155;
  line-height: 1.4;
}

.plan-card__features li {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}

.plan-card__features .pi {
  color: #15803d;
  font-size: 0.72rem;
  margin-top: 0.18rem;
  flex-shrink: 0;
}

.plan-card__features .pi-sparkles,
.plan-card__features .pi-headphones {
  color: #1e3a8a;
}

.plan-card__features-base {
  font-weight: 650;
  color: #6e6e73;
}

.plan-card__btn {
  width: 100%;
  min-height: 2.45rem;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid rgba(15, 23, 42, 0.12);
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  margin-top: auto;
}

.plan-card__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.plan-card__btn:focus-visible,
.bf-compare__toggle:focus-visible,
.bf-plans__retry:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.plan-card__btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.plan-card__btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.plan-card__btn--ghost {
  background: #fff;
  color: #1e3a8a;
}

.plan-card__btn--ghost:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.bf-compare {
  margin-top: 1.5rem;
  min-width: 0;
}

.bf-compare__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}

.bf-compare__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.bf-compare__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.1rem;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-weight: 600;
  font-size: 0.78rem;
  cursor: pointer;
}

.bf-compare__toggle .pi {
  font-size: 0.7rem;
}

.bf-compare__toggle:hover {
  background: #e8eefc;
  border-color: transparent;
}

.bf-compare__hint {
  margin: 0.25rem 0 0.75rem;
  font-size: 0.75rem;
  color: #6e6e73;
}

/* US005: horizontal scroll on mobile instead of squeezing columns. */
.bf-compare__scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
}

.bf-compare__scroll:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.bf-compare__table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 0.8rem;
  color: #0f172a;
}

.bf-compare__table th,
.bf-compare__table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  text-align: center;
  vertical-align: middle;
}

.bf-compare__table tbody tr:last-child th,
.bf-compare__table tbody tr:last-child td {
  border-bottom: none;
}

.bf-compare__table thead th {
  position: sticky;
  top: 0;
  background: #f8fafc;
  font-size: 0.8rem;
  font-weight: 700;
  vertical-align: top;
}

.bf-compare__plan {
  display: block;
}

.bf-compare__tag {
  display: inline-block;
  margin-top: 0.3rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.64rem;
  font-weight: 650;
  white-space: nowrap;
}

.bf-compare__tag--current {
  background: #1e3a8a;
  color: #fff;
}

.bf-compare__tag--recommended {
  background: #e3f4e8;
  color: #166534;
}

.bf-compare__table thead th.is-current,
.bf-compare__table td.is-current {
  background: #eef3fd;
}

.bf-compare__table thead th.is-current {
  color: #1e3a8a;
}

.bf-compare__table tbody th {
  text-align: left;
  font-weight: 500;
  white-space: nowrap;
}

.bf-compare__feature-col,
.bf-compare__table tbody th[scope='row'] {
  position: sticky;
  left: 0;
  background: #fff;
  z-index: 1;
  text-align: left;
}

.bf-compare__table thead .bf-compare__feature-col {
  background: #f8fafc;
  z-index: 2;
  font-weight: 600;
  color: #6e6e73;
}

.bf-compare__section th {
  background: #f8fafc;
  font-size: 0.74rem;
  font-weight: 650;
  color: #475569;
  text-align: left;
}

.bf-compare__help {
  display: inline-flex;
  margin-left: 0.35rem;
  color: #94a3b8;
  cursor: help;
  border-radius: 50%;
}

.bf-compare__help:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.bf-compare__yes {
  color: #15803d;
}

.bf-compare__no {
  color: #cbd5e1;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 720px) {
  .plans-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  /* Keep the sticky feature column narrow so plan columns stay visible while swiping. */
  .bf-compare__table tbody th[scope='row'],
  .bf-compare__feature-col {
    min-width: 8.5rem;
    max-width: 9.5rem;
    white-space: normal;
  }
}

@media (prefers-reduced-motion: reduce) {
  .plan-card,
  .plan-card__btn {
    transition: none;
  }
}
</style>
