<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { financesApi } from '@/finances/infrastructure/financesApi.js'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { spacesApi } from '@/socialSpaces/infrastructure/spacesApi.js'
import { announcementsApi } from '@/communications/infrastructure/announcementsApi.js'
import { importUploadsApi } from '@/communications/infrastructure/importUploadsApi.js'
import { membersApi } from '@/iam/infrastructure/membersApi.js'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import '@/shared/presentation/assets/bf-workspace.css'

/**
 * Vista de la junta directiva: lo que la junta necesita para fiscalizar la administración del
 * condominio (cobranza, balance, incidencias, avisos, documentos y equipo), en solo lectura.
 * El dueño o un administrador asignado también la abren para ver lo mismo que ve la junta.
 */
const { t, locale } = useI18n()

const isLoading = ref(true)
const loadFailed = ref(false)
const kpi = ref({ totalDebt: 0, overdueResidents: 0, occupiedUnits: 0, emptyUnits: 0, totalResidents: 0 })
const balance = ref({ income: 0, expenses: 0, net: 0 })
const incidents = ref([])
const debtors = ref([])
const announcements = ref([])
const documents = ref([])
const reservations = ref([])
const spaces = ref(new Map())
const team = ref({ owner: null, members: [] })

const mainTab = ref('incidents')
const sideTab = ref('announcements')

const loc = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))
const monthLong = computed(() => new Intl.DateTimeFormat(loc.value, { month: 'long' }).format(new Date()))

function pen(value, digits = 2) {
  return new Intl.NumberFormat(loc.value, {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0)
}

function shortDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(loc.value, { day: 'numeric', month: 'short' }).format(d)
}

function weekdayDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(loc.value, { weekday: 'short', day: 'numeric', month: 'short' }).format(d)
}

function daysSince(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
}

function initials(value) {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(parts[0] ?? '?').slice(0, 2).toUpperCase()
}

const openIncidents = computed(() =>
  incidents.value
    .filter((i) => String(i.status ?? '').toLowerCase() !== 'resolved')
    .sort(
      (a, b) =>
        Number(Boolean(b.escalated)) - Number(Boolean(a.escalated)) || String(a.createdAt).localeCompare(String(b.createdAt)),
    ),
)
const escalatedCount = computed(() => openIncidents.value.filter((i) => i.escalated).length)
const resolvedThisMonth = computed(() => {
  const key = new Date().toISOString().slice(0, 7)
  return incidents.value.filter(
    (i) => String(i.status).toLowerCase() === 'resolved' && String(i.resolvedAt ?? '').startsWith(key),
  ).length
})
const totalUnits = computed(() => kpi.value.occupiedUnits + kpi.value.emptyUnits)
const occupancyPct = computed(() =>
  totalUnits.value > 0 ? Math.round((kpi.value.occupiedUnits / totalUnits.value) * 100) : 0,
)

const upcomingReservations = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return reservations.value
    .filter((r) => String(r.date ?? '') >= today)
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
    .slice(0, 8)
})

const teamRows = computed(() => {
  const list = []
  const owner = team.value.owner
  if (owner) {
    list.push({ key: `owner-${owner.id}`, name: owner.name, email: owner.email, role: owner.accountKind === 'board' ? 'board' : 'admin', owner: true })
  }
  for (const m of team.value.members ?? []) {
    list.push({ key: `member-${m.id}`, name: m.name, email: m.email, role: m.role === 'admin' ? 'admin' : 'board', owner: false })
  }
  return list
})

const kpiPills = computed(() => [
  {
    key: 'debt',
    tone: kpi.value.totalDebt > 0 ? 'red' : 'green',
    icon: 'pi-wallet',
    label: t('board.kpiDebt'),
    short: t('board.kpiDebtShort'),
    value: pen(kpi.value.totalDebt, 0),
    hint: t('board.kpiDebtHint', { count: debtors.value.length }),
    alert: kpi.value.totalDebt > 0,
  },
  {
    key: 'balance',
    tone: 'blue',
    icon: 'pi-chart-line',
    label: t('board.kpiBalance', { month: monthLong.value }),
    short: t('board.kpiBalanceShort'),
    value: pen(balance.value.net, 0),
    hint: t('board.kpiBalanceHint', { income: pen(balance.value.income), expenses: pen(balance.value.expenses) }),
    alert: balance.value.net < 0,
  },
  {
    key: 'incidents',
    tone: escalatedCount.value ? 'orange' : 'amber',
    icon: 'pi-flag',
    label: t('board.kpiIncidents'),
    short: t('board.tabIncidents'),
    value: openIncidents.value.length,
    hint: t('board.kpiIncidentsHint', { escalated: escalatedCount.value, resolved: resolvedThisMonth.value }),
  },
  {
    key: 'occupancy',
    tone: 'green',
    icon: 'pi-home',
    label: t('board.kpiOccupancy'),
    value: `${occupancyPct.value}%`,
    hint: t('board.kpiOccupancyHint', { occupied: kpi.value.occupiedUnits, total: totalUnits.value }),
  },
])

const mainTabs = computed(() => [
  { id: 'incidents', tone: escalatedCount.value ? 'red' : 'amber', label: t('board.tabIncidents'), count: openIncidents.value.length },
  { id: 'debtors', tone: debtors.value.length ? 'red' : 'green', label: t('board.tabDebtors'), count: debtors.value.length },
  { id: 'reservations', tone: 'blue', label: t('board.tabReservations'), count: upcomingReservations.value.length },
])

const sideTabs = computed(() => [
  { id: 'announcements', tone: 'blue', label: t('board.tabAnnouncements'), count: announcements.value.length },
  { id: 'documents', tone: 'green', label: t('board.tabDocuments'), count: documents.value.length },
  { id: 'team', tone: '', label: t('board.tabTeam'), count: teamRows.value.length },
])

function incidentState(item) {
  if (item.escalated) return { tone: 'ws-pill--red', icon: 'pi-exclamation-triangle', label: t('board.escalated') }
  const key = String(item.status ?? '').toLowerCase()
  if (key === 'in-progress' || key === 'in_progress') return { tone: 'ws-pill--blue', icon: 'pi-spinner', label: t('board.statusInProgress') }
  return { tone: 'ws-pill--orange', icon: 'pi-circle', label: t('board.statusOpen') }
}

function roleLabel(role) {
  return role === 'admin' ? t('access.roleAdmin') : t('access.roleBoard')
}

async function openDocument(doc) {
  try {
    const { downloadUrl } = await importUploadsApi.getDownloadUrl(doc.id)
    if (!downloadUrl) return
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = doc.fileName || 'documento'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.click()
  } catch {
    // Sin enlace: el documento sigue listado.
  }
}

async function load() {
  isLoading.value = true
  loadFailed.value = false
  const month = new Date().toISOString().slice(0, 7)
  const results = await Promise.allSettled([
    financesApi.getDashboardKpis(),
    financesApi.getMonthlyBalance(month),
    incidentsApi.list(),
    financesApi.getPaymentCalendar({ months: 6 }),
    announcementsApi.listActive(),
    importUploadsApi.list(),
    reservationsApi.listAllForAdmin(),
    spacesApi.list(),
    membersApi.list(),
  ])
  const [kpiR, balanceR, incidentsR, calendarR, annR, docsR, resR, spacesR, teamR] = results
  loadFailed.value = [kpiR, incidentsR, calendarR].some((r) => r.status === 'rejected')

  if (kpiR.status === 'fulfilled') {
    const k = kpiR.value ?? {}
    kpi.value = {
      totalDebt: Number(k.totalDebt ?? k.totalPendingDebt) || 0,
      overdueResidents: Number(k.delinquency?.overdueResidents) || 0,
      occupiedUnits: Number(k.occupiedUnits) || 0,
      emptyUnits: Number(k.emptyUnits) || 0,
      totalResidents: Number(k.totalResidents) || 0,
    }
  }
  if (balanceR.status === 'fulfilled') balance.value = balanceR.value
  if (incidentsR.status === 'fulfilled') incidents.value = Array.isArray(incidentsR.value) ? incidentsR.value : []
  if (calendarR.status === 'fulfilled') {
    debtors.value = calendarR.value.residents
      .filter((r) => r.hasOverdue)
      .map((r) => ({
        ...r,
        overdueMonths: (r.cells ?? []).filter((c) => c.status === 'overdue').length,
      }))
      .sort((a, b) => b.overdueAmount - a.overdueAmount)
  }
  if (annR.status === 'fulfilled') announcements.value = annR.value.slice(0, 6)
  if (docsR.status === 'fulfilled') {
    const rows = Array.isArray(docsR.value) ? docsR.value : []
    documents.value = rows
      .filter((d) => d.documentType && String(d.documentStatus ?? 'PUBLISHED').toUpperCase() === 'PUBLISHED')
      .slice(0, 8)
  }
  if (resR.status === 'fulfilled') reservations.value = resR.value
  if (spacesR.status === 'fulfilled') spaces.value = new Map(spacesR.value.map((s) => [s.id, s]))
  if (teamR.status === 'fulfilled') team.value = teamR.value
  isLoading.value = false
}

onMounted(load)
</script>

<template>
  <div class="ws-view bd">
    <header class="ws-head">
      <h1 class="bf-sr-only">{{ t('board.title') }}</h1>
      <KpiPills inline :items="kpiPills" :aria-label="t('board.kpisLabel')" :busy="isLoading" />
      <div class="ws-head__actions">
        <span class="ws-tag" :title="t('board.readOnlyHint')">
          <i class="pi pi-eye" aria-hidden="true" />
          {{ t('board.readOnly') }}
        </span>
        <button
          type="button"
          class="ws-icon-btn"
          :aria-label="t('access.refresh')"
          :title="t('access.refresh')"
          :disabled="isLoading"
          @click="load"
        >
          <i class="pi" :class="isLoading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
        </button>
      </div>
    </header>

    <LoadErrorRetry v-if="!isLoading && loadFailed" :loading="isLoading" @retry="load" />

    <div class="bd-grid">
      <!-- Lo que hay que vigilar: incidencias, morosidad y reservas. -->
      <section class="ws-card bd-card" :aria-label="t('board.mainAria')">
        <div class="ws-toolbar">
          <div class="ws-filters" v-bf-seg role="group" :aria-label="t('board.mainAria')">
            <button
              v-for="tab in mainTabs"
              :key="tab.id"
              type="button"
              class="ws-filter"
              :class="[tab.tone && `ws-filter--${tab.tone}`, { 'is-active': mainTab === tab.id }]"
              :aria-pressed="mainTab === tab.id ? 'true' : 'false'"
              @click="mainTab = tab.id"
            >
              {{ tab.label }}
              <span class="ws-filter__count">{{ tab.count }}</span>
            </button>
          </div>
        </div>

        <p v-if="isLoading" class="ws-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('board.loading') }}
        </p>

        <template v-else-if="mainTab === 'incidents'">
          <div v-if="!openIncidents.length" class="ws-empty">
            <span class="ws-empty__icon bd-ok"><i class="pi pi-check" aria-hidden="true" /></span>
            <span>{{ t('board.noIncidents') }}</span>
          </div>
          <div v-else class="ws-table-wrap">
            <table class="ws-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('board.colIncident') }}</th>
                  <th scope="col">{{ t('board.colStatus') }}</th>
                  <th scope="col" class="is-num">{{ t('board.colAge') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in openIncidents" :key="item.id">
                  <td class="c-main">
                    <div class="ws-who__text">
                      <strong>{{ item.title || item.description }}</strong>
                      <small :class="{ 'bd-warn': !item.provider }">
                        <i class="pi" :class="item.provider ? 'pi-wrench' : 'pi-exclamation-circle'" aria-hidden="true" />
                        {{ item.provider || t('board.unassigned') }}
                      </small>
                    </div>
                  </td>
                  <td :data-label="t('board.colStatus')">
                    <span class="ws-pill" :class="incidentState(item).tone">
                      <i class="pi" :class="incidentState(item).icon" aria-hidden="true" />
                      {{ incidentState(item).label }}
                    </span>
                  </td>
                  <td class="is-num bd-age" :data-label="t('board.colAge')">
                    {{ t('board.daysShort', { days: daysSince(item.createdAt) }) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else-if="mainTab === 'debtors'">
          <div v-if="!debtors.length" class="ws-empty">
            <span class="ws-empty__icon bd-ok"><i class="pi pi-check" aria-hidden="true" /></span>
            <span>{{ t('board.noDebtors') }}</span>
          </div>
          <div v-else class="ws-table-wrap">
            <table class="ws-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('board.colUnit') }}</th>
                  <th scope="col">{{ t('board.colOverdue') }}</th>
                  <th scope="col" class="is-num">{{ t('board.colAmount') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in debtors" :key="row.residentId">
                  <td class="c-main">
                    <div class="ws-who">
                      <span class="ws-avatar ws-avatar--square bd-unit" aria-hidden="true">{{ row.code || '—' }}</span>
                      <div class="ws-who__text">
                        <strong>{{ row.name }}</strong>
                        <small>{{ t('board.unit', { code: row.code || '—' }) }}</small>
                      </div>
                    </div>
                  </td>
                  <td :data-label="t('board.colOverdue')">
                    <span class="bd-months" :aria-label="t('board.overdueMonths', { count: row.overdueMonths })">
                      <span v-for="n in 6" :key="n" class="bd-months__cell" :class="{ 'is-overdue': n <= row.overdueMonths }" />
                      <small>{{ row.overdueMonths }}/6</small>
                    </span>
                  </td>
                  <td class="is-num bd-amount" :data-label="t('board.colAmount')">{{ pen(row.overdueAmount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else>
          <div v-if="!upcomingReservations.length" class="ws-empty">
            <span class="ws-empty__icon"><i class="pi pi-calendar" aria-hidden="true" /></span>
            <span>{{ t('board.noReservations') }}</span>
          </div>
          <div v-else class="ws-table-wrap">
            <table class="ws-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('board.colSpace') }}</th>
                  <th scope="col">{{ t('board.colWhen') }}</th>
                  <th scope="col">{{ t('board.colUnit') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in upcomingReservations" :key="r.id">
                  <td class="c-main">
                    <div class="ws-who">
                      <span class="ws-avatar ws-avatar--square" aria-hidden="true"><i class="pi pi-calendar" /></span>
                      <div class="ws-who__text">
                        <strong>{{ spaces.get(r.spaceId)?.name ?? t('app.spaceFallbackName') }}</strong>
                      </div>
                    </div>
                  </td>
                  <td :data-label="t('board.colWhen')">
                    <div class="ws-who__text">
                      <strong class="bd-when">{{ weekdayDate(`${r.date}T12:00:00`) }}</strong>
                      <small>{{ r.startTime }}–{{ r.endTime }}</small>
                    </div>
                  </td>
                  <td :data-label="t('board.colUnit')">
                    <span class="ws-pill">{{ t('board.unit', { code: r.residentCode || '—' }) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <!-- Lo que se consulta: avisos, documentos y quién gestiona. -->
      <section class="ws-card bd-card" :aria-label="t('board.sideAria')">
        <div class="ws-toolbar">
          <div class="ws-filters" v-bf-seg role="group" :aria-label="t('board.sideAria')">
            <button
              v-for="tab in sideTabs"
              :key="tab.id"
              type="button"
              class="ws-filter"
              :class="[tab.tone && `ws-filter--${tab.tone}`, { 'is-active': sideTab === tab.id }]"
              :aria-pressed="sideTab === tab.id ? 'true' : 'false'"
              @click="sideTab = tab.id"
            >
              {{ tab.label }}
              <span class="ws-filter__count">{{ tab.count }}</span>
            </button>
          </div>
        </div>

        <p v-if="isLoading" class="ws-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true" />
          {{ t('board.loading') }}
        </p>

        <template v-else-if="sideTab === 'announcements'">
          <div v-if="!announcements.length" class="ws-empty">
            <span class="ws-empty__icon"><i class="pi pi-megaphone" aria-hidden="true" /></span>
            <span>{{ t('board.noAnnouncements') }}</span>
          </div>
          <ul v-else class="bd-list" role="list">
            <li v-for="item in announcements" :key="item.id" class="bd-item bd-item--stack">
              <div class="bd-item__top">
                <span class="ws-avatar ws-avatar--square" :class="item.priority === 'urgent' ? 'bd-urgent' : ''" aria-hidden="true">
                  <i class="pi pi-megaphone" />
                </span>
                <div class="ws-who__text">
                  <strong>{{ item.title }}</strong>
                  <small v-if="item.publishedAt || item.createdAt">{{ shortDate(item.publishedAt || item.createdAt) }}</small>
                </div>
                <span v-if="item.priority === 'urgent'" class="ws-pill ws-pill--red">{{ t('board.urgent') }}</span>
              </div>
              <span v-if="item.body" class="bd-item__body">{{ item.body }}</span>
            </li>
          </ul>
        </template>

        <template v-else-if="sideTab === 'documents'">
          <div v-if="!documents.length" class="ws-empty">
            <span class="ws-empty__icon"><i class="pi pi-file" aria-hidden="true" /></span>
            <span>{{ t('board.noDocuments') }}</span>
          </div>
          <ul v-else class="bd-list" role="list">
            <li v-for="doc in documents" :key="doc.id" class="bd-item">
              <span class="ws-avatar ws-avatar--square ws-avatar--green" aria-hidden="true"><i class="pi pi-file-pdf" /></span>
              <div class="ws-who__text">
                <strong>{{ doc.fileName }}</strong>
                <small>{{ t('board.documentVersion', { version: doc.version ?? 1, date: shortDate(doc.publishedAt ?? doc.uploadedAt) }) }}</small>
              </div>
              <button
                type="button"
                class="ws-icon-btn"
                :aria-label="t('board.openFor', { name: doc.fileName })"
                :title="t('board.open')"
                @click="openDocument(doc)"
              >
                <i class="pi pi-download" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>

        <ul v-else class="bd-list" role="list">
          <li v-for="m in teamRows" :key="m.key" class="bd-item">
            <span class="ws-avatar" :class="{ 'ws-avatar--green': m.role === 'admin' }" aria-hidden="true">{{ initials(m.name) }}</span>
            <div class="ws-who__text">
              <strong>
                {{ m.name }}
                <i v-if="m.owner" class="pi pi-star-fill bd-owner" :title="t('access.statusOwner')" aria-hidden="true" />
              </strong>
              <small>{{ m.email }}</small>
            </div>
            <span class="ws-pill" :class="m.role === 'admin' ? 'ws-pill--green' : 'ws-pill--blue'">{{ roleLabel(m.role) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.bd-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: stretch;
}

.bd-card {
  min-height: 22rem;
}

.ws-who__text small .pi {
  font-size: 0.66rem;
  margin-right: 0.15rem;
}

.ws-who__text small.bd-warn {
  color: #b45309;
  font-weight: 600;
}

.bd-age {
  font-variant-numeric: tabular-nums;
  font-size: 0.8rem;
  color: #475569;
  white-space: nowrap;
}

.bd-unit {
  font-size: 0.72rem;
  background: #fde4e4;
  color: #b42318;
}

.bd-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: #b42318;
  white-space: nowrap;
}

.bd-months {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.bd-months__cell {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 3px;
  background: #e2e8f0;
}

.bd-months__cell.is-overdue {
  background: #ef4444;
}

.bd-months small {
  margin-left: 0.4rem;
  font-size: 0.74rem;
  font-weight: 600;
  color: #475569;
}

.bd-when {
  text-transform: capitalize;
}

.bd-ok {
  background: #e3f4e8;
  color: #15803d;
}

.bd-urgent {
  background: #fde4e4;
  color: #b42318;
}

.bd-owner {
  margin-left: 0.25rem;
  font-size: 0.62rem;
  color: #d97706;
}

.bd-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.bd-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.7rem 0.25rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.bd-item:first-child {
  border-top: 0;
  padding-top: 0.2rem;
}

.bd-item .ws-who__text {
  flex: 1;
}

.bd-item--stack {
  flex-direction: column;
  align-items: stretch;
  gap: 0.45rem;
}

.bd-item__top {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.bd-item__body {
  padding-left: 2.95rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #475569;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

@media (max-width: 1100px) {
  .bd-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .bd-card {
    min-height: 0;
  }
}

@media (max-width: 900px) {
  .bd-item__body {
    padding-left: 0;
  }
}
</style>
