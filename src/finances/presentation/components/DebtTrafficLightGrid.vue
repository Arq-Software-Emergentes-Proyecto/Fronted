<script setup>
/**
 * RF029 / US029 — Semáforo de deudas: residente × mes.
 * Verde = pagado, ámbar = vence en ≤ N días, rojo = vencido, gris = pendiente, guion = sin cuota.
 * Datos: GET /api/v1/finances/payment-calendar (estado calculado por DelinquencyPolicy en el backend).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMonthLabel } from '@/finances/domain/billingCycle.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

const props = defineProps({
  months: { type: Array, default: () => [] },
  residents: { type: Array, default: () => [] },
  dueSoonDays: { type: Number, default: 5 },
  /** Vista del residente: una sola fila, sin columna de nombre. */
  compact: { type: Boolean, default: false },
  /** Solo la fila de puntos de residents[0] (celda de tabla del admin), sin leyenda. */
  inline: { type: Boolean, default: false },
  /** Solo la leyenda (más carga/error); los puntos se pintan con `inline` en cada fila. */
  legendOnly: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

/** RNF012: parent reloads the calendar. */
defineEmits(['retry'])

const { t, locale } = useI18n()

const STATUS_KEYS = {
  paid: 'statusPaid',
  dueSoon: 'statusDueSoon',
  overdue: 'statusOverdue',
  pending: 'statusPending',
  none: 'statusNone',
}

function money(value) {
  return new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: 2,
  }).format(Number(value) || 0)
}

function shortMonth(monthKey) {
  const [year, month] = String(monthKey ?? '').split('-').map(Number)
  if (!year || !month) return String(monthKey ?? '')
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  const label = new Date(year, month - 1, 1).toLocaleDateString(loc, { month: 'short' })
  return `${label.replace('.', '')} ${String(year).slice(2)}`
}

function statusLabel(status) {
  return t(`financeOps.${STATUS_KEYS[status] || STATUS_KEYS.none}`)
}

function cellFor(row, month) {
  return (row.cells || []).find((c) => c.month === month) || { month, status: 'none', amount: 0 }
}

function cellTitle(row, cell) {
  const base = t('financeOps.cellLabel', {
    month: formatMonthLabel(cell.month, locale.value),
    status: statusLabel(cell.status),
  })
  if (cell.status === 'none') return props.compact ? base : `${row.name} · ${base}`
  const amount = money(cell.amount)
  const extra = cell.daysOverdue > 0 ? ` · ${t('financeOps.daysOverdue', { n: cell.daysOverdue })}` : ''
  return `${props.compact ? '' : `${row.name} · `}${base} · ${amount}${extra}`
}

const legend = computed(() => [
  { status: 'paid', label: t('financeOps.legendPaid') },
  { status: 'dueSoon', label: t('financeOps.legendDueSoon', { n: props.dueSoonDays }) },
  { status: 'overdue', label: t('financeOps.legendOverdue') },
  { status: 'pending', label: t('financeOps.legendPending') },
  { status: 'none', label: t('financeOps.legendNone') },
])
</script>

<template>
  <ul
    v-if="inline"
    class="tl-inline"
    role="list"
    :aria-label="t('financeOps.trafficTitle')"
  >
    <template v-if="residents.length">
      <li
        v-for="month in months"
        :key="month"
        class="tl-inline__cell"
        :title="cellTitle(residents[0], cellFor(residents[0], month))"
      >
        <span class="tl-dot" :class="`tl-dot--${cellFor(residents[0], month).status}`" aria-hidden="true" />
        <span class="visually-hidden">{{ cellTitle(residents[0], cellFor(residents[0], month)) }}</span>
      </li>
    </template>
    <li v-else class="tl-inline__empty">—</li>
  </ul>

  <div v-else class="tl">
    <ul class="tl-legend" role="list" :aria-label="t('financeOps.legendTitle')">
      <li v-for="item in legend" :key="item.status" class="tl-legend__item">
        <span class="tl-dot" :class="`tl-dot--${item.status}`" aria-hidden="true" />
        {{ item.label }}
      </li>
    </ul>

    <p v-if="loading && !legendOnly" class="tl-empty">…</p>
    <LoadErrorRetry v-else-if="error" compact :message="error" @retry="$emit('retry')" />
    <template v-else-if="legendOnly" />
    <p v-else-if="!residents.length" class="tl-empty">{{ t('financeOps.trafficEmpty') }}</p>

    <div v-else-if="compact" class="tl-strip" role="list">
      <div
        v-for="month in months"
        :key="month"
        class="tl-strip__cell"
        role="listitem"
        :title="cellTitle(residents[0], cellFor(residents[0], month))"
      >
        <span
          class="tl-dot tl-dot--lg"
          :class="`tl-dot--${cellFor(residents[0], month).status}`"
          aria-hidden="true"
        />
        <span class="tl-strip__month">{{ shortMonth(month) }}</span>
        <span class="tl-strip__status">{{ statusLabel(cellFor(residents[0], month).status) }}</span>
        <span class="visually-hidden">{{ cellTitle(residents[0], cellFor(residents[0], month)) }}</span>
      </div>
    </div>

    <div v-else class="tl-scroll">
      <table class="tl-table">
        <thead>
          <tr>
            <th scope="col" class="tl-table__resident">{{ t('financeOps.trafficResident') }}</th>
            <th v-for="month in months" :key="month" scope="col" class="tl-table__month">
              {{ shortMonth(month) }}
            </th>
            <th scope="col" class="tl-table__amount">{{ t('financeOps.trafficOverdue') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in residents" :key="row.residentId" :class="{ 'tl-row--danger': row.hasOverdue }">
            <th scope="row" class="tl-table__resident">
              <strong>{{ row.name }}</strong>
              <small v-if="row.floor || row.code">
                {{ t('financeAdmin.residentFloorApt', { floor: row.floor || '—', code: row.code || '—' }) }}
              </small>
            </th>
            <td v-for="month in months" :key="month" class="tl-table__cell">
              <span
                class="tl-dot"
                :class="`tl-dot--${cellFor(row, month).status}`"
                :title="cellTitle(row, cellFor(row, month))"
                role="img"
                :aria-label="cellTitle(row, cellFor(row, month))"
              />
            </td>
            <td class="tl-table__amount" :class="{ 'tl-amount--danger': row.overdueAmount > 0 }">
              {{ row.overdueAmount > 0 ? money(row.overdueAmount) : '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.tl-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.75rem;
  color: #6e6e73;
}

.tl-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.tl-dot {
  display: inline-block;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: #e5e5ea;
}

.tl-dot--lg {
  width: 1.1rem;
  height: 1.1rem;
}

.tl-dot--paid { background: #34c759; }
.tl-dot--dueSoon { background: #ff9500; }
.tl-dot--overdue { background: #ff3b30; box-shadow: 0 0 0 3px rgba(255, 59, 48, 0.18); }
.tl-dot--pending { background: #fff; border: 2px solid #aeaeb2; }
.tl-dot--none {
  background: transparent;
  border: 1px dashed #c7c7cc;
}

.tl-empty {
  margin: 0;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.tl-empty--error {
  color: #b42318;
}

.tl-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
}

.tl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
  min-width: 34rem;
}

.tl-table th,
.tl-table td {
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  text-align: center;
  white-space: nowrap;
}

.tl-table thead th {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #86868b;
  background: #fafafa;
}

.tl-table__resident {
  text-align: left !important;
  position: sticky;
  left: 0;
  background: #fff;
  min-width: 10rem;
}

thead .tl-table__resident {
  background: #fafafa;
}

.tl-table__resident strong {
  display: block;
  font-weight: 600;
  color: #1d1d1f;
}

.tl-table__resident small {
  color: #86868b;
  font-size: 0.72rem;
}

.tl-table__amount {
  text-align: right !important;
  font-weight: 600;
  color: #6e6e73;
}

.tl-amount--danger {
  color: #b42318;
}

.tl-row--danger .tl-table__resident strong {
  color: #b42318;
}

.tl-inline {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tl-inline__cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.95rem;
  height: 0.95rem;
}

.tl-inline__empty {
  color: #94a3b8;
}

.tl-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(4.5rem, 1fr));
  gap: 0.5rem;
}

.tl-strip__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 0.6rem 0.25rem;
  border-radius: 12px;
  background: #f5f5f7;
  text-align: center;
}

.tl-strip__month {
  font-size: 0.75rem;
  font-weight: 600;
  color: #1d1d1f;
  text-transform: capitalize;
}

.tl-strip__status {
  font-size: 0.68rem;
  color: #6e6e73;
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
</style>
