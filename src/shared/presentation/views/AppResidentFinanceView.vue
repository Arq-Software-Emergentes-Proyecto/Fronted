<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import Button from 'primevue/button'
import Toast from 'primevue/toast'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import Card from 'primevue/card'
import Message from 'primevue/message'
import { useToast } from 'primevue/usetoast'
import { useRoute, useRouter } from 'vue-router'
import {
  checkoutMaintenanceFees,
  confirmMaintenancePayment,
} from '@/finances/infrastructure/mercadoPagoService.js'
import {
  clearPendingCheckout,
  MpPendingKeys,
} from '@/shared/infrastructure/mercadoPagoCheckoutClient.js'
import { useResidentPaymentStore } from '@/finances/application/residentPaymentStore.js'

const { t, locale } = useI18n()
const { state } = useSession()
const route = useRoute()
const router = useRouter()
const { state: paymentState, loadData } = useResidentPaymentStore()

const profile = computed(() => state.profile ?? {})
const toast = useToast()

const todayIso = new Date().toISOString().slice(0, 10)

const fees = computed(() => paymentState.fees || [])
const paymentHistory = computed(() => paymentState.paymentHistory || [])

const isProcessing = ref(false)

onMounted(async () => {
  if (profile.value.id) {
    await loadData(profile.value.id)
  }
  await handlePaymentReturnFromRoute()
})

async function handlePaymentReturnFromRoute() {
  if (!profile.value.id) return

  const status = String(
    route.query.status ?? route.query.collection_status ?? route.query.payment ?? '',
  ).toLowerCase()
  const paymentRaw = route.query.payment_id ?? route.query.collection_id
  const hasReturn = Boolean(status || paymentRaw)
  if (!hasReturn) return

  const clearReturn = () => {
    clearPendingCheckout(MpPendingKeys.maintenance)
    router.replace({ path: route.path })
  }

  if (status === 'failure' || status === 'rejected' || status === 'cancelled' || status === 'null') {
    toast.add({
      severity: 'error',
      summary: t('residentFinance.paymentErrorTitle'),
      detail: t('residentFinance.paymentErrorDetail'),
      life: 5000,
    })
    clearReturn()
    return
  }

  if (status === 'pending' || status === 'in_process' || status === 'in_mediation') {
    toast.add({
      severity: 'warn',
      summary: t('residentFinance.paymentPendingTitle'),
      detail: t('residentFinance.paymentPendingDetail'),
      life: 5000,
    })
    clearReturn()
    return
  }

  if (status && status !== 'success' && status !== 'approved') return

  try {
    const paymentId = paymentRaw != null && String(paymentRaw).length ? Number(paymentRaw) : null

    if (!Number.isFinite(paymentId)) {
      toast.add({
        severity: 'warn',
        summary: t('residentFinance.paymentPendingTitle'),
        detail: t('residentFinance.paymentPendingDetail'),
        life: 5000,
      })
      clearReturn()
      return
    }

    await confirmMaintenancePayment({
      residentId: profile.value.id,
      paymentId,
    })

    await loadData(profile.value.id)
    toast.add({
      severity: 'success',
      summary: t('residentFinance.paymentSuccessTitle'),
      detail: t('residentFinance.paymentSuccessDetail'),
      life: 5000,
    })
  } catch {
    await loadData(profile.value.id)
    toast.add({
      severity: 'warn',
      summary: t('residentFinance.paymentPendingTitle'),
      detail: t('residentFinance.paymentPendingDetail'),
      life: 5000,
    })
  } finally {
    clearReturn()
  }
}

async function startMaintenanceCheckout() {
  if (isProcessing.value || pendingTotal.value === 0 || !profile.value.id) return

  isProcessing.value = true
  try {
    const checkout = await checkoutMaintenanceFees({
      residentId: profile.value.id,
      payerEmail: profile.value.email || undefined,
      amount: pendingTotal.value,
      title: t('residentFinance.payNow'),
    })

    if (checkout.initPoint) {
      window.location.assign(checkout.initPoint)
      return
    }

    throw new Error(t('residentFinance.paymentErrorDetail'))
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: t('residentFinance.paymentErrorTitle'),
      detail: err?.payload?.message || err?.message || t('residentFinance.paymentErrorDetail'),
      life: 5000,
    })
  } finally {
    isProcessing.value = false
  }
}

function getDaysUntilDue(dueDate) {
  const due = new Date(dueDate + 'T00:00:00')
  const now = new Date(todayIso + 'T00:00:00')
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24))
}

function feeStatusLabel(fee) {
  if (fee.status === 'Pagado') return t('residentFinance.statusPaid')
  const days = getDaysUntilDue(fee.dueDate)
  if (days < 0) return t('residentFinance.statusOverdue')
  if (days <= 5) return t('residentFinance.statusDueSoon')
  return t('residentFinance.statusPending')
}

function feeSeverity(fee) {
  if (fee.status === 'Pagado') return 'success'
  const days = getDaysUntilDue(fee.dueDate)
  if (days < 0) return 'danger'
  if (days <= 5) return 'warn'
  return 'info'
}

const pendingTotal = computed(() =>
  fees.value.filter((f) => f.status === 'Pendiente').reduce((sum, f) => sum + f.amount, 0),
)

const nextDueFee = computed(() => {
  const pending = fees.value.filter((f) => f.status === 'Pendiente')
  return pending.length ? pending[0] : null
})

const hasOverdue = computed(() =>
  fees.value.some((f) => f.status === 'Pendiente' && getDaysUntilDue(f.dueDate) < 0),
)

const totalPaid = computed(() =>
  paymentHistory.value.reduce((sum, p) => sum + p.amount, 0),
)

const activeTab = ref('0')

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
  return d.toLocaleDateString(loc, { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
}

const monthNamesEs = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const monthNamesEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function translateMonth(value) {
  if (!value) return '—'
  const str = String(value).trim()

  const dateMatch = str.match(/^(\d{4})-(\d{2})/)
  if (dateMatch) {
    const d = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, 1)
    const loc = locale.value === 'es' ? 'es-PE' : 'en-US'
    return d.toLocaleDateString(loc, { month: 'long', year: 'numeric' })
  }

  const esIdx = monthNamesEs.findIndex(m => str.includes(m))
  if (esIdx >= 0) {
    const yearMatch = str.match(/(\d{4})/)
    const year = yearMatch ? yearMatch[1] : ''
    const name = locale.value === 'es' ? monthNamesEs[esIdx] : monthNamesEn[esIdx]
    return year ? `${name} ${year}` : name
  }

  return str
}
</script>

<template>
  <div class="view-container">
    <Toast position="top-right" />

    <div class="page-header">
      <h1 class="page-title">{{ t('resident.financeTitle') }}</h1>
      <p class="page-subtitle">
        {{ t('resident.financeSubtitle', { name: profile.name || '' }) }}
      </p>
    </div>

    <Message v-if="paymentState.error" severity="error" :closable="false" class="error-msg">
      {{ paymentState.error }}
    </Message>

    <!-- KPI CARDS GRID (Pure CSS Layout) -->
    <div class="kpi-grid custom-scrollbar">
      <!-- Card 1: Total Paid -->
      <div class="kpi-card">
        <div class="kpi-header">
          <div class="kpi-icon icon-purple">
            <i class="pi pi-wallet" aria-hidden="true"></i>
          </div>
          <span class="kpi-label">{{ t('residentFinance.kpiTotalPaid') }}</span>
        </div>
        <div class="kpi-value">S/ {{ totalPaid.toLocaleString('es-PE', { minimumFractionDigits: 2 }) }}</div>
        <span class="kpi-subtext subtext-green">
          <i class="pi pi-arrow-up" aria-hidden="true"></i> {{ t('residentFinance.kpiTotalPaidCount', { n: paymentHistory.length }) }}
        </span>
      </div>

      <!-- Card 2: Pending Payments -->
      <div class="kpi-card" :class="{ 'card-danger': hasOverdue }">
        <div class="kpi-header">
          <div class="kpi-icon" :class="hasOverdue ? 'icon-red' : 'icon-orange'">
            <i class="pi pi-clock" aria-hidden="true"></i>
          </div>
          <span class="kpi-label">{{ t('residentFinance.kpiPending') }}</span>
        </div>
        <div class="kpi-value" :class="{ 'text-red': hasOverdue }">S/ {{ pendingTotal.toLocaleString('es-PE', { minimumFractionDigits: 2 }) }}</div>
        <span v-if="hasOverdue" class="kpi-subtext subtext-red">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ t('residentFinance.kpiOverdueWarning') }}
        </span>
        <span v-else class="kpi-subtext">
          <i class="pi pi-check" aria-hidden="true"></i> {{ t('residentFinance.kpiUpToDate') }}
        </span>
      </div>

      <!-- Card 3: Next Fee Month -->
      <div class="kpi-card relative-overflow">
        <div class="kpi-header">
          <div class="kpi-icon icon-blue">
            <i class="pi pi-calendar" aria-hidden="true"></i>
          </div>
          <span class="kpi-label">{{ t('residentFinance.kpiNextFee') }}</span>
        </div>
        <div class="kpi-value">{{ translateMonth(nextDueFee?.month) }}</div>
        <span class="kpi-subtext">
          {{ nextDueFee?.dueDate ? t('residentFinance.kpiNextFeeDue', { date: nextDueFee.dueDate }) : t('residentFinance.kpiNextFeeNoDebt') }}
        </span>
      </div>

      <!-- Card 4: Action / Pay Now -->
      <div class="kpi-card kpi-action-card">
        <Button
          :label="isProcessing ? t('residentFinance.processing') : t('residentFinance.payNow')"
          icon="pi pi-credit-card"
          :severity="hasOverdue ? 'danger' : 'primary'"
          size="large"
          class="pay-btn"
          :disabled="pendingTotal === 0 || paymentState.isLoading || isProcessing"
          :loading="isProcessing"
          @click="startMaintenanceCheckout"
        />
        <span class="kpi-subtext text-center mt-2">
          {{ t('residentFinance.securePayment') }}
        </span>
      </div>
    </div>

    <Card>
      <template #content>
        <Tabs v-model:value="activeTab">
          <TabList>
            <Tab value="0">
              <i class="pi pi-list mr-2" aria-hidden="true"></i>
              {{ t('residentFinance.feeHistory') }}
            </Tab>
            <Tab value="1">
              <i class="pi pi-check-circle mr-2" aria-hidden="true"></i>
              {{ t('residentFinance.paymentHistoryTab') }}
            </Tab>
          </TabList>

          <TabPanels>
            <TabPanel value="0">
              <DataTable :value="fees" responsiveLayout="scroll" :loading="paymentState.isLoading" class="premium-table">
                <Column field="concept" :header="t('residentFinance.colConcept', 'Concepto')" />
                <Column :header="t('residentFinance.colMonth')">
                  <template #body="{ data }">
                    {{ translateMonth(data.month) }}
                  </template>
                </Column>
                <Column :header="t('residentFinance.colAmount')">
                  <template #body="{ data }">
                    <span class="font-semibold text-900">S/ {{ data.amount.toFixed(2) }}</span>
                  </template>
                </Column>
                <Column field="dueDate" :header="t('residentFinance.colDueDate')" />
                <Column :header="t('residentFinance.colBillingStatus')">
                  <template #body="{ data }">
                    <Tag :value="feeStatusLabel(data)" :severity="feeSeverity(data)" rounded class="px-3" />
                  </template>
                </Column>
              </DataTable>
            </TabPanel>

            <TabPanel value="1">
              <p v-if="!paymentHistory.length && !paymentState.isLoading" class="text-center text-color-secondary my-4">
                {{ t('residentFinance.noPaymentsYet') }}
              </p>
              <DataTable v-else :value="paymentHistory" responsiveLayout="scroll" :loading="paymentState.isLoading" class="premium-table">
                <Column field="concept" :header="t('residentFinance.colConcept', 'Concepto')" />
                <Column field="feeMonth" :header="t('residentFinance.colMonth')" />
                <Column :header="t('residentFinance.colAmount')">
                  <template #body="{ data }">
                    <span class="font-semibold text-900">S/ {{ data.amount.toFixed(2) }}</span>
                  </template>
                </Column>
                <Column :header="t('residentFinance.colPaidAt')">
                  <template #body="{ data }">
                    <span class="text-500">{{ formatDateTime(data.paidAt) }}</span>
                  </template>
                </Column>
                <Column field="method" :header="t('residentFinance.colMethod')">
                  <template #body="{ data }">
                    <span class="text-primary font-semibold"><i class="pi pi-wallet mr-1" aria-hidden="true"></i> {{ data.method }}</span>
                  </template>
                </Column>
                <Column field="reference" :header="t('residentFinance.colReference')">
                  <template #body="{ data }">
                     <span class="text-500">{{ data.reference }}</span>
                  </template>
                </Column>
              </DataTable>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.view-container {
  padding: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

/* Page Header */
.page-header {
  margin-bottom: 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.page-title {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0;
  color: var(--surface-900);
  letter-spacing: -0.02em;
}
.page-subtitle {
  margin: 0;
  font-size: 1.125rem;
  color: var(--surface-500);
}
.error-msg {
  margin-bottom: 1.5rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

/* KPI GRID CSS */
.kpi-grid {
  display: flex;
  flex-direction: row;
  gap: 1.25rem;
  margin-bottom: 2rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}

.kpi-card {
  flex: 1;
  min-width: 250px;
  background: var(--surface-0, #ffffff);
  border: 1px solid var(--surface-200, #e2e8f0);
  border-radius: 16px;
  padding: 1.5rem;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
  display: flex;
  flex-direction: column;
}

.kpi-header {
  display: flex;
  align-items: center;
  margin-bottom: 1rem;
}

.kpi-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 1rem;
  font-size: 1.2rem;
}

.icon-purple {
  background: #f3e8ff;
  color: #9333ea;
}

.icon-orange {
  background: #ffedd5;
  color: #ea580c;
}

.icon-red {
  background: #fee2e2;
  color: #dc2626;
}

.icon-blue {
  background: #e0f2fe;
  color: #0284c7;
}

.kpi-label {
  color: var(--surface-500, #64748b);
  font-weight: 500;
  font-size: 0.9rem;
}

.kpi-value {
  color: var(--surface-900, #0f172a);
  font-weight: 700;
  font-size: 1.8rem;
  margin-bottom: 0.5rem;
}

.kpi-subtext {
  color: var(--surface-500, #64748b);
  font-size: 0.8rem;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.subtext-green { color: #16a34a; }
.subtext-red { color: #dc2626; }
.text-red { color: #dc2626 !important; }
.card-danger { background: #fff5f5; border-color: #fecaca; }

.kpi-action-card {
  background: linear-gradient(135deg, rgba(10, 132, 255, 0.05) 0%, transparent 100%);
  justify-content: center;
  align-items: center;
}

.pay-btn {
  width: 100%;
  padding: 1rem;
  border-radius: 12px;
  font-weight: 600;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s ease;
}

.pay-btn:not(:disabled):hover {
  transform: translateY(-2px);
}

.custom-scrollbar::-webkit-scrollbar {
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--surface-300);
  border-radius: 10px;
}

/* Premium DataTable Styling matching reference image */
.premium-table :deep(.p-datatable-header) {
  background: transparent;
  border: none;
}
.premium-table :deep(.p-datatable-thead > tr > th) {
  background: transparent;
  color: var(--surface-500);
  font-weight: 500;
  font-size: 0.85rem;
  text-transform: capitalize;
  border: none;
  border-bottom: 1px solid var(--surface-200);
  padding: 1rem;
}
.premium-table :deep(.p-datatable-tbody > tr) {
  background: transparent;
}
.premium-table :deep(.p-datatable-tbody > tr:hover) {
  background: var(--surface-50);
}
.premium-table :deep(.p-datatable-tbody > tr > td) {
  border: none;
  border-bottom: 1px solid var(--surface-100);
  padding: 1rem;
  vertical-align: middle;
}
.premium-table :deep(.p-datatable-wrapper) {
  border-radius: 12px;
}
</style>

