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
import { useSession } from '@/iam/application/sessionStore.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

/**
 * Vista de la junta directiva: lo que la junta necesita para fiscalizar la administración del
 * condominio (cobranza, balance, incidencias, avisos, documentos y equipo), en solo lectura.
 * El dueño o un administrador asignado también la abren para ver lo mismo que ve la junta.
 */
const { t, locale } = useI18n()
const { state: session, isReadOnly } = useSession()

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

const activeBuilding = computed(
  () => (session.buildings ?? []).find((b) => String(b.ownerAdminId) === String(session.activeBuildingId)) ?? null,
)
const loc = computed(() => (locale.value === 'es' ? 'es-PE' : 'en-US'))
const todayLong = computed(() =>
  new Intl.DateTimeFormat(loc.value, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()),
)
const monthLong = computed(() => new Intl.DateTimeFormat(loc.value, { month: 'long', year: 'numeric' }).format(new Date()))

function pen(value) {
  return new Intl.NumberFormat(loc.value, { style: 'currency', currency: 'PEN', minimumFractionDigits: 2 }).format(
    Number.isFinite(Number(value)) ? Number(value) : 0,
  )
}

function shortDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(loc.value, { day: 'numeric', month: 'short' }).format(d)
}

function daysSince(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
}

const openIncidents = computed(() =>
  incidents.value
    .filter((i) => String(i.status ?? '').toLowerCase() !== 'resolved')
    .sort((a, b) => Number(Boolean(b.escalated)) - Number(Boolean(a.escalated)) || String(a.createdAt).localeCompare(String(b.createdAt))),
)
const escalatedCount = computed(() => openIncidents.value.filter((i) => i.escalated).length)
const resolvedThisMonth = computed(() => {
  const key = new Date().toISOString().slice(0, 7)
  return incidents.value.filter((i) => String(i.status).toLowerCase() === 'resolved' && String(i.resolvedAt ?? '').startsWith(key)).length
})
const totalUnits = computed(() => kpi.value.occupiedUnits + kpi.value.emptyUnits)
const occupancyPct = computed(() => (totalUnits.value > 0 ? Math.round((kpi.value.occupiedUnits / totalUnits.value) * 100) : 0))

const upcomingReservations = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return reservations.value
    .filter((r) => String(r.date ?? '') >= today)
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
    .slice(0, 5)
})

function incidentStatusLabel(status) {
  const key = String(status ?? '').toLowerCase()
  if (key === 'in-progress' || key === 'in_progress') return t('board.statusInProgress')
  return t('board.statusOpen')
}

function memberRoleLabel(role) {
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
  if (annR.status === 'fulfilled') announcements.value = annR.value.slice(0, 4)
  if (docsR.status === 'fulfilled') {
    const rows = Array.isArray(docsR.value) ? docsR.value : []
    documents.value = rows
      .filter((d) => d.documentType && String(d.documentStatus ?? 'PUBLISHED').toUpperCase() === 'PUBLISHED')
      .slice(0, 6)
  }
  if (resR.status === 'fulfilled') reservations.value = resR.value
  if (spacesR.status === 'fulfilled') spaces.value = new Map(spacesR.value.map((s) => [s.id, s]))
  if (teamR.status === 'fulfilled') team.value = teamR.value
  isLoading.value = false
}

onMounted(load)
</script>

<template>
  <div class="app-view board">
    <header class="board-hero">
      <div class="board-hero__text">
        <p class="board-hero__date">
          {{ todayLong }}<template v-if="activeBuilding?.name"> · {{ activeBuilding.name }}</template>
        </p>
        <h1 class="board-hero__title">{{ t('board.title') }}</h1>
        <p class="board-hero__sub">{{ isReadOnly ? t('board.subtitle') : t('board.subtitlePreview') }}</p>
        <p class="board-hero__pill">
          <i class="pi pi-eye" aria-hidden="true" />
          {{ t('board.readOnly') }}
        </p>
      </div>
    </header>

    <LoadErrorRetry v-if="!isLoading && loadFailed" :loading="isLoading" @retry="load" />

    <section class="board-kpis" :aria-label="t('board.kpisLabel')">
      <article class="board-kpi" :class="kpi.totalDebt > 0 ? 'board-kpi--red' : 'board-kpi--green'">
        <span class="board-kpi__label">{{ t('board.kpiDebt') }}</span>
        <strong class="board-kpi__value">{{ pen(kpi.totalDebt) }}</strong>
        <span class="board-kpi__hint">{{ t('board.kpiDebtHint', { count: debtors.length }) }}</span>
      </article>
      <article class="board-kpi board-kpi--blue">
        <span class="board-kpi__label">{{ t('board.kpiBalance', { month: monthLong }) }}</span>
        <strong class="board-kpi__value" :class="{ 'is-negative': balance.net < 0 }">{{ pen(balance.net) }}</strong>
        <span class="board-kpi__hint">{{ t('board.kpiBalanceHint', { income: pen(balance.income), expenses: pen(balance.expenses) }) }}</span>
      </article>
      <article class="board-kpi" :class="escalatedCount ? 'board-kpi--orange' : 'board-kpi--amber'">
        <span class="board-kpi__label">{{ t('board.kpiIncidents') }}</span>
        <strong class="board-kpi__value">{{ openIncidents.length }}</strong>
        <span class="board-kpi__hint">{{ t('board.kpiIncidentsHint', { escalated: escalatedCount, resolved: resolvedThisMonth }) }}</span>
      </article>
      <article class="board-kpi board-kpi--slate">
        <span class="board-kpi__label">{{ t('board.kpiOccupancy') }}</span>
        <strong class="board-kpi__value">{{ occupancyPct }}%</strong>
        <span class="board-kpi__hint">{{ t('board.kpiOccupancyHint', { occupied: kpi.occupiedUnits, total: totalUnits }) }}</span>
      </article>
    </section>

    <div class="board-grid">
      <section class="board-card" aria-labelledby="board-incidents">
        <header class="board-card__head">
          <h2 id="board-incidents" class="board-card__title">{{ t('board.incidentsTitle') }}</h2>
          <p class="board-card__hint">{{ t('board.incidentsHint') }}</p>
        </header>
        <ul v-if="openIncidents.length" class="board-list" role="list">
          <li v-for="item in openIncidents.slice(0, 6)" :key="item.id" class="board-row">
            <div class="board-row__main">
              <strong>{{ item.title }}</strong>
              <span>
                {{ item.provider || t('board.unassigned') }} · {{ t('board.daysOpen', { days: daysSince(item.createdAt) }) }}
              </span>
            </div>
            <span v-if="item.escalated" class="board-chip board-chip--red">{{ t('board.escalated') }}</span>
            <span v-else class="board-chip">{{ incidentStatusLabel(item.status) }}</span>
          </li>
        </ul>
        <p v-else class="board-empty">{{ isLoading ? t('board.loading') : t('board.noIncidents') }}</p>
      </section>

      <section class="board-card" aria-labelledby="board-debtors">
        <header class="board-card__head">
          <h2 id="board-debtors" class="board-card__title">{{ t('board.debtorsTitle') }}</h2>
          <p class="board-card__hint">{{ t('board.debtorsHint') }}</p>
        </header>
        <ul v-if="debtors.length" class="board-list" role="list">
          <li v-for="row in debtors.slice(0, 6)" :key="row.residentId" class="board-row">
            <div class="board-row__main">
              <strong>{{ t('board.unit', { code: row.code || '—' }) }} · {{ row.name }}</strong>
              <span>{{ t('board.overdueMonths', { count: row.overdueMonths }) }}</span>
            </div>
            <span class="board-amount">{{ pen(row.overdueAmount) }}</span>
          </li>
        </ul>
        <p v-else class="board-empty">{{ isLoading ? t('board.loading') : t('board.noDebtors') }}</p>
      </section>

      <section class="board-card" aria-labelledby="board-announcements">
        <header class="board-card__head">
          <h2 id="board-announcements" class="board-card__title">{{ t('board.announcementsTitle') }}</h2>
        </header>
        <ul v-if="announcements.length" class="board-list" role="list">
          <li v-for="item in announcements" :key="item.id" class="board-row board-row--stack">
            <div class="board-row__main">
              <strong>
                <span v-if="item.priority === 'urgent'" class="board-chip board-chip--red">{{ t('board.urgent') }}</span>
                {{ item.title }}
              </strong>
              <span class="board-row__body">{{ item.body }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="board-empty">{{ isLoading ? t('board.loading') : t('board.noAnnouncements') }}</p>
      </section>

      <section class="board-card" aria-labelledby="board-documents">
        <header class="board-card__head">
          <h2 id="board-documents" class="board-card__title">{{ t('board.documentsTitle') }}</h2>
          <p class="board-card__hint">{{ t('board.documentsHint') }}</p>
        </header>
        <ul v-if="documents.length" class="board-list" role="list">
          <li v-for="doc in documents" :key="doc.id" class="board-row">
            <div class="board-row__main">
              <strong>{{ doc.fileName }}</strong>
              <span>{{ t('board.documentVersion', { version: doc.version ?? 1, date: shortDate(doc.publishedAt ?? doc.uploadedAt) }) }}</span>
            </div>
            <button type="button" class="board-link" @click="openDocument(doc)">
              <i class="pi pi-download" aria-hidden="true" />
              <span>{{ t('board.open') }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="board-empty">{{ isLoading ? t('board.loading') : t('board.noDocuments') }}</p>
      </section>

      <section class="board-card" aria-labelledby="board-reservations">
        <header class="board-card__head">
          <h2 id="board-reservations" class="board-card__title">{{ t('board.reservationsTitle') }}</h2>
        </header>
        <ul v-if="upcomingReservations.length" class="board-list" role="list">
          <li v-for="r in upcomingReservations" :key="r.id" class="board-row">
            <div class="board-row__main">
              <strong>{{ spaces.get(r.spaceId)?.name ?? t('app.spaceFallbackName') }}</strong>
              <span>{{ shortDate(`${r.date}T12:00:00`) }} · {{ r.startTime }}–{{ r.endTime }}</span>
            </div>
            <span class="board-chip">{{ t('board.unit', { code: r.residentCode || '—' }) }}</span>
          </li>
        </ul>
        <p v-else class="board-empty">{{ isLoading ? t('board.loading') : t('board.noReservations') }}</p>
      </section>

      <section class="board-card" aria-labelledby="board-team">
        <header class="board-card__head">
          <h2 id="board-team" class="board-card__title">{{ t('board.teamTitle') }}</h2>
          <p class="board-card__hint">{{ t('board.teamHint') }}</p>
        </header>
        <ul class="board-list" role="list">
          <li v-if="team.owner" class="board-row">
            <div class="board-row__main">
              <strong>{{ team.owner.name }}</strong>
              <span>{{ team.owner.email }}</span>
            </div>
            <span class="board-chip board-chip--navy">
              {{ team.owner.accountKind === 'board' ? t('access.ownerBoard') : t('access.ownerAdministrator') }}
            </span>
          </li>
          <li v-for="m in team.members" :key="m.id" class="board-row">
            <div class="board-row__main">
              <strong>{{ m.name }}</strong>
              <span>{{ m.email }}</span>
            </div>
            <span class="board-chip">{{ memberRoleLabel(m.role) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  max-width: 88rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.board-hero {
  padding: 1.5rem 1.6rem;
  border-radius: 20px;
  color: #fff;
  background: #1e3a8a;
}

.board-hero__date {
  margin: 0 0 0.35rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.72);
}

.board-hero__date::first-letter {
  text-transform: uppercase;
}

.board-hero__title {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 650;
  letter-spacing: -0.03em;
}

.board-hero__sub {
  margin: 0.3rem 0 0;
  max-width: 44rem;
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.8);
}

.board-hero__pill {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0.9rem 0 0;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font-size: 0.78rem;
  font-weight: 600;
}

.board-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.9rem;
}

.board-kpi {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 1.05rem 1.1rem;
  border-radius: 16px;
  background: var(--kpi-bg, #f1f5f9);
  min-width: 0;
}

.board-kpi--blue { --kpi-bg: #e8eefc; }
.board-kpi--green { --kpi-bg: #e3f4e8; }
.board-kpi--red { --kpi-bg: #fde4e4; }
.board-kpi--orange { --kpi-bg: #fdeee2; }
.board-kpi--amber { --kpi-bg: #fdf3dc; }
.board-kpi--slate { --kpi-bg: #eef1f5; }

.board-kpi__label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #334155;
}

.board-kpi__label::first-letter {
  text-transform: uppercase;
}

.board-kpi__value {
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.board-kpi__value.is-negative {
  color: #b42318;
}

.board-kpi__hint {
  font-size: 0.76rem;
  color: #475569;
}

.board-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem;
}

.board-card {
  padding: 1.2rem 1.25rem 1.3rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.board-card__head {
  margin-bottom: 0.75rem;
}

.board-card__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  color: #0f172a;
}

.board-card__hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: #64748b;
}

.board-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.board-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.board-row:first-child {
  border-top: 0;
  padding-top: 0;
}

.board-row__main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.board-row__main strong {
  font-size: 0.86rem;
  font-weight: 600;
  color: #0f172a;
}

.board-row__main span {
  font-size: 0.77rem;
  color: #64748b;
}

.board-row__body {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.board-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.board-chip--red {
  background: #fde4e4;
  color: #b42318;
}

.board-chip--navy {
  background: #e8eefc;
  color: #1e3a8a;
}

.board-row__main strong .board-chip {
  margin-right: 0.35rem;
}

.board-amount {
  flex-shrink: 0;
  font-size: 0.86rem;
  font-weight: 700;
  color: #b42318;
}

.board-link {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
}

.board-link:hover {
  background: #eef2ff;
}

.board-link:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.board-empty {
  margin: 0;
  font-size: 0.82rem;
  color: #64748b;
}

@media (max-width: 1100px) {
  .board-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }

  .board-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 480px) {
  .board-kpis {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
