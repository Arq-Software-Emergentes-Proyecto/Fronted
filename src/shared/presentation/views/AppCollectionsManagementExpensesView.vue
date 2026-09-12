<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import Dropdown from 'primevue/dropdown'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import {
  fixedPayoutRecipientsApi,
  addDaysYMD,
  compareYMD,
  formatLocalYYYYMMDD,
} from '@/finances/infrastructure/fixedPayoutRecipientsApi.js'
import { adminManagementExpensesApi } from '@/finances/infrastructure/adminManagementExpensesApi.js'
import { sharedUtilityServicesApi } from '@/finances/infrastructure/sharedUtilityServicesApi.js'
import { useFinancesStore } from '@/finances/application/financesStore.js'

const { t, locale } = useI18n()
const { state, loadData } = useFinancesStore()

const expenses = ref([])
const costsLoading = ref(false)
const costsLoadError = ref('')

const sharedServices = ref([])
const servicesLoading = ref(false)
const servicesLoadError = ref('')

const fixedRecipients = ref([])
const fixedLoading = ref(false)
const fixedLoadError = ref('')

const modalOpen = ref(false)
const saving = ref(false)
const submitError = ref('')
const processingPhoto = ref(false)

const serviceModalOpen = ref(false)
const serviceSaving = ref(false)
const serviceSubmitError = ref('')

const fixedModalOpen = ref(false)
const fixedSaving = ref(false)
const fixedSubmitError = ref('')
const fixedProcessingPhoto = ref(false)

const form = reactive({
  name: '',
  amount: null,
  purchaseDate: '',
  invoicePhotoUrl: '',
})

const serviceForm = reactive({
  type: 'water',
  amount: null,
})

const fixedForm = reactive({
  name: '',
  dni: '',
  phone: '',
  salary: null,
  intervalDays: 30,
  photoUrl: '',
})

const serviceTypeOptions = computed(() => [
  { label: t('sharedServices.typeWater'), value: 'water' },
  { label: t('sharedServices.typeElectricity'), value: 'electricity' },
])

const MAX_IMAGE_DIMENSION = 1024
const IMAGE_OUTPUT_QUALITY = 0.82

function receiptTotalPaid(r) {
  if (!r || r.status !== 'Paid') return 0
  if (typeof r.getTotalAmount === 'function') {
    return Number(r.getTotalAmount()) || 0
  }
  return (Number(r.amount) || 0) + (Number(r.lateFee) || 0)
}

const grossCollected = computed(() =>
  state.receipts.reduce((sum, r) => sum + receiptTotalPaid(r), 0),
)

const totalCosts = computed(() =>
  expenses.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
)

const totalFixedPaid = computed(() =>
  fixedRecipients.value.reduce((sum, r) => {
    const hist = Array.isArray(r.paymentHistory) ? r.paymentHistory : []
    return sum + hist.reduce((s, h) => s + (Number(h.amount) || 0), 0)
  }, 0),
)

const balanceAfterAll = computed(
  () => grossCollected.value - totalCosts.value - totalFixedPaid.value,
)

const fixedHistoryRows = computed(() => {
  const rows = []
  for (const r of fixedRecipients.value) {
    for (const h of r.paymentHistory || []) {
      rows.push({
        rowKey: `${r.id}_${h.id}`,
        paidOn: h.paidOn,
        amount: Number(h.amount) || 0,
        recipientName: r.name,
      })
    }
  }
  rows.sort((a, b) => compareYMD(String(b.paidOn), String(a.paidOn)))
  return rows
})

const previewFirstFixedDue = computed(() => {
  const n =
    fixedForm.intervalDays === null ||
    fixedForm.intervalDays === undefined ||
    fixedForm.intervalDays === ''
      ? Number.NaN
      : Number(fixedForm.intervalDays)
  if (!Number.isFinite(n)) return ''
  const days = Math.max(1, Math.floor(n))
  return addDaysYMD(formatLocalYYYYMMDD(), days)
})

const nfCurrency = computed(
  () => (value) =>
    new Intl.NumberFormat(locale.value === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: 'PEN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(value) ? value : 0),
)

const nfDate = computed(
  () => (isoOrYmd) => {
    const s = String(isoOrYmd ?? '').trim()
    if (!s) return '—'
    const d =
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s)
    if (!Number.isFinite(d.getTime())) return s
    return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US').format(d)
  },
)

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_ERROR'))
    reader.readAsDataURL(file)
  })
}

async function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('IMAGE_DECODE_ERROR'))
    img.src = dataUrl
  })
}

async function processImageFile(file) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('IMAGE_INVALID')
  }
  const originalDataUrl = await readFileAsDataUrl(file)
  const img = await loadImageElement(originalDataUrl)

  const ratio = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1),
  )
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * ratio))
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('IMAGE_CANVAS_ERROR')
  context.drawImage(img, 0, 0, width, height)
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return canvas.toDataURL(mime, IMAGE_OUTPUT_QUALITY)
}

async function loadCosts() {
  costsLoading.value = true
  costsLoadError.value = ''
  try {
    expenses.value = await adminManagementExpensesApi.list()
  } catch {
    costsLoadError.value = t('collectionsMgmt.loadCostsError')
    expenses.value = []
  } finally {
    costsLoading.value = false
  }
}

function serviceTypeLabel(type) {
  if (type === 'water') return t('sharedServices.typeWater')
  if (type === 'electricity') return t('sharedServices.typeElectricity')
  return String(type ?? '—')
}

async function loadSharedServices() {
  servicesLoading.value = true
  servicesLoadError.value = ''
  try {
    sharedServices.value = await sharedUtilityServicesApi.list()
  } catch {
    servicesLoadError.value = t('sharedServices.loadError')
    sharedServices.value = []
  } finally {
    servicesLoading.value = false
  }
}

async function loadFixedRecipients() {
  fixedLoading.value = true
  fixedLoadError.value = ''
  try {
    fixedRecipients.value = await fixedPayoutRecipientsApi.listWithDueApplied()
  } catch {
    fixedLoadError.value = t('fixedPay.loadError')
    fixedRecipients.value = []
  } finally {
    fixedLoading.value = false
  }
}

function resetForm() {
  form.name = ''
  form.amount = null
  form.purchaseDate = ''
  form.invoicePhotoUrl = ''
  submitError.value = ''
}

function openModal() {
  resetForm()
  modalOpen.value = true
}

function closeModal() {
  modalOpen.value = false
}

function resetFixedForm() {
  fixedForm.name = ''
  fixedForm.dni = ''
  fixedForm.phone = ''
  fixedForm.salary = null
  fixedForm.intervalDays = 30
  fixedForm.photoUrl = ''
  fixedSubmitError.value = ''
}

function resetServiceForm() {
  serviceForm.type = 'water'
  serviceForm.amount = null
  serviceSubmitError.value = ''
}

function openServiceModal() {
  resetServiceForm()
  serviceModalOpen.value = true
}

function closeServiceModal() {
  serviceModalOpen.value = false
}

function openFixedModal() {
  resetFixedForm()
  fixedModalOpen.value = true
}

function closeFixedModal() {
  fixedModalOpen.value = false
}

async function onInvoiceChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  processingPhoto.value = true
  submitError.value = ''
  try {
    form.invoicePhotoUrl = await processImageFile(file)
  } catch {
    submitError.value = t('collectionsMgmt.invoiceInvalid')
    form.invoicePhotoUrl = ''
  } finally {
    processingPhoto.value = false
  }
}

async function onFixedPhotoChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  fixedProcessingPhoto.value = true
  fixedSubmitError.value = ''
  try {
    fixedForm.photoUrl = await processImageFile(file)
  } catch {
    fixedSubmitError.value = t('fixedPay.photoInvalid')
    fixedForm.photoUrl = ''
  } finally {
    fixedProcessingPhoto.value = false
  }
}

async function submitCost() {
  if (saving.value) return
  submitError.value = ''

  const amt =
    form.amount === null || form.amount === undefined || form.amount === ''
      ? Number.NaN
      : Number(form.amount)

  if (!form.name.trim() || !Number.isFinite(amt) || !String(form.purchaseDate).trim()) {
    submitError.value = t('collectionsMgmt.requiredCostFields')
    return
  }

  saving.value = true
  try {
    await adminManagementExpensesApi.add({
      name: form.name,
      amount: amt,
      purchaseDate: form.purchaseDate,
      invoicePhotoUrl: form.invoicePhotoUrl,
    })
    closeModal()
    await loadCosts()
  } catch (err) {
    if (err?.code === 'ADMIN_EXPENSE_FIELDS_REQUIRED') {
      submitError.value = t('collectionsMgmt.requiredCostFields')
    } else {
      submitError.value = t('collectionsMgmt.saveCostError')
    }
  } finally {
    saving.value = false
  }
}

async function submitSharedService() {
  if (serviceSaving.value) return
  serviceSubmitError.value = ''

  const amt =
    serviceForm.amount === null || serviceForm.amount === undefined || serviceForm.amount === ''
      ? Number.NaN
      : Number(serviceForm.amount)

  if (!serviceForm.type || !Number.isFinite(amt) || amt < 0) {
    serviceSubmitError.value = t('sharedServices.requiredFields')
    return
  }

  serviceSaving.value = true
  try {
    await sharedUtilityServicesApi.add({
      type: serviceForm.type,
      amount: amt,
    })
    closeServiceModal()
    await Promise.all([loadSharedServices(), loadData()])
  } catch (err) {
    if (err?.code === 'SHARED_SERVICE_FIELDS_REQUIRED') {
      serviceSubmitError.value = t('sharedServices.requiredFields')
    } else {
      serviceSubmitError.value = t('sharedServices.saveError')
    }
  } finally {
    serviceSaving.value = false
  }
}

async function submitFixedRecipient() {
  if (fixedSaving.value) return
  fixedSubmitError.value = ''

  const salaryNum =
    fixedForm.salary === null || fixedForm.salary === undefined || fixedForm.salary === ''
      ? Number.NaN
      : Number(fixedForm.salary)

  const intervalRaw = Number(fixedForm.intervalDays)
  const interval = Number.isFinite(intervalRaw) ? Math.floor(intervalRaw) : Number.NaN

  if (
    !fixedForm.name.trim() ||
    !fixedForm.dni.trim() ||
    !fixedForm.phone.trim() ||
    !Number.isFinite(salaryNum) ||
    salaryNum < 0 ||
    !Number.isFinite(interval) ||
    interval < 1
  ) {
    fixedSubmitError.value = t('fixedPay.requiredFields')
    return
  }

  fixedSaving.value = true
  try {
    await fixedPayoutRecipientsApi.add({
      name: fixedForm.name,
      dni: fixedForm.dni,
      phone: fixedForm.phone,
      salary: salaryNum,
      intervalDays: interval,
      photoUrl: fixedForm.photoUrl,
    })
    closeFixedModal()
    await loadFixedRecipients()
  } catch (err) {
    if (err?.code === 'FIXED_PAYOUT_FIELDS_REQUIRED') {
      fixedSubmitError.value = t('fixedPay.requiredFields')
    } else {
      fixedSubmitError.value = t('fixedPay.saveError')
    }
  } finally {
    fixedSaving.value = false
  }
}

const pendingDelete = ref(null)
const deleting = ref(false)

function deleteCandidateLabel(item) {
  if (!item) return ''
  if (item.kind === 'expense') return String(item.row?.name ?? '')
  if (item.kind === 'fixed') return String(item.row?.name ?? '')
  if (item.kind === 'service') return serviceTypeLabel(item.row?.type)
  return ''
}

function askDelete(kind, row) {
  pendingDelete.value = { kind, row }
}

function closeDelete() {
  if (deleting.value) return
  pendingDelete.value = null
}

async function confirmDelete() {
  const current = pendingDelete.value
  if (!current || deleting.value) return

  deleting.value = true
  try {
    if (current.kind === 'expense') {
      await adminManagementExpensesApi.remove(current.row.id)
      await loadCosts()
    } else if (current.kind === 'service') {
      await sharedUtilityServicesApi.remove(current.row.id)
      await Promise.all([loadSharedServices(), loadData()])
    } else if (current.kind === 'fixed') {
      await fixedPayoutRecipientsApi.remove(current.row.id)
      await loadFixedRecipients()
    }
    pendingDelete.value = null
  } catch {
    if (current.kind === 'expense') costsLoadError.value = t('collectionsMgmt.deleteError')
    else if (current.kind === 'service') servicesLoadError.value = t('sharedServices.deleteError')
    else fixedLoadError.value = t('fixedPay.deleteError')
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  loadData()
  loadCosts()
  loadSharedServices()
  loadFixedRecipients()
})
</script>

<template>
  <div class="app-view">
    <div class="header-with-actions">
      <div>
        <h1 class="app-view__title">{{ t('app.collectionsManagementExpenses') }}</h1>
      </div>
      <Button
        icon="pi pi-refresh"
        rounded
        text
        severity="secondary"
        :loading="state.isLoading"
        @click="loadData(); loadCosts(); loadSharedServices(); loadFixedRecipients();"
      />
    </div>

    <p v-if="state.isLoading" class="app-view__status">{{ t('collectionsMgmt.loading') }}</p>
    <p v-else-if="state.error" class="app-view__error" role="alert">
      {{ t('collectionsMgmt.loadError') }}
    </p>

    <template v-else>
      <div class="collections-page">
        <section
          class="collections-hero"
          aria-labelledby="collections-balance-heading"
        >
          <h2 id="collections-balance-heading" class="collections-hero__title">
            {{ t('collectionsMgmt.netAfterExpenses') }}
          </h2>
          <p class="collections-hero__amount">{{ nfCurrency(balanceAfterAll) }}</p>
          <ul class="collections-hero__rows" aria-describedby="collections-balance-heading">
            <li class="collections-hero__row">
              <span class="collections-hero__row-label">{{
                t('collectionsMgmt.grossCollectedShort')
              }}</span>
              <span class="collections-hero__row-value">{{ nfCurrency(grossCollected) }}</span>
            </li>
            <li class="collections-hero__row">
              <span class="collections-hero__row-label">{{
                t('collectionsMgmt.expensesTotalShort')
              }}</span>
              <span class="collections-hero__row-value">{{ nfCurrency(totalCosts) }}</span>
            </li>
            <li class="collections-hero__row">
              <span class="collections-hero__row-label">{{
                t('collectionsMgmt.fixedPaidShort')
              }}</span>
              <span class="collections-hero__row-value">{{ nfCurrency(totalFixedPaid) }}</span>
            </li>
          </ul>
          <p class="collections-hero__hint">{{ t('collectionsMgmt.amountHint') }}</p>
        </section>

        <section class="collections-panel" aria-labelledby="collections-costs-heading">
          <header class="collections-panel__head">
            <h2 id="collections-costs-heading" class="collections-panel__title">
              {{ t('collectionsMgmt.expensesSectionTitle') }}
            </h2>
            <Button
              type="button"
              rounded
              :label="t('collectionsMgmt.addCost')"
              severity="secondary"
              class="collections-panel__btn"
              @click="openModal"
            />
          </header>

        <Dialog
          v-model:visible="modalOpen"
          modal
          :header="t('collectionsMgmt.modalTitle')"
          class="collections-cost-dialog"
          :style="{ width: 'min(26rem, 92vw)' }"
          :draggable="false"
        >
          <div class="collections-form">
            <div class="collections-form__field">
              <label for="collections-cost-name">{{ t('collectionsMgmt.nameLabel') }}</label>
              <InputText
                id="collections-cost-name"
                v-model="form.name"
                class="collections-form__input"
                autocomplete="off"
                fluid
              />
            </div>
            <div class="collections-form__field">
              <label for="collections-cost-amount">{{ t('collectionsMgmt.priceLabel') }}</label>
              <InputNumber
                id="collections-cost-amount"
                v-model="form.amount"
                class="collections-form__input-num w-full"
                :min="0"
                mode="decimal"
                :maxFractionDigits="2"
                fluid
              />
            </div>
            <div class="collections-form__field">
              <label for="collections-cost-date">{{ t('collectionsMgmt.purchaseDateLabel') }}</label>
              <InputText
                id="collections-cost-date"
                v-model="form.purchaseDate"
                class="collections-form__input collections-form__input--date"
                type="date"
                fluid
              />
            </div>
            <div class="collections-form__field collections-form__field--photo">
              <span class="collections-form__photo-label">{{ t('collectionsMgmt.invoiceLabel') }}</span>
              <p class="collections-form__hint">{{ t('collectionsMgmt.invoiceHint') }}</p>
              <label class="collections-form__file">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  class="collections-form__file-input"
                  :disabled="processingPhoto || saving"
                  @change="onInvoiceChange"
                />
                <span class="collections-form__file-trigger">{{
                  processingPhoto ? t('collectionsMgmt.processingPhoto') : t('collectionsMgmt.invoiceChoose')
                }}</span>
              </label>
              <div v-if="form.invoicePhotoUrl" class="collections-form__preview-row">
                <img
                  :src="form.invoicePhotoUrl"
                  :alt="
                    form.name.trim() ? form.name.trim() : t('collectionsMgmt.invoiceLabel')
                  "
                  class="collections-form__preview"
                  width="80"
                  height="80"
                />
                <Button
                  type="button"
                  :label="t('collectionsMgmt.removePhoto')"
                  variant="text"
                  text
                  @click="form.invoicePhotoUrl = ''"
                />
              </div>
            </div>
            <p v-if="submitError" class="collections-form__error" role="alert">{{ submitError }}</p>
          </div>
          <template #footer>
            <ConfirmActions
              :cancel-label="t('app.cancelAction')"
              :confirm-label="t('collectionsMgmt.accept')"
              :loading="saving"
              @cancel="closeModal"
              @confirm="submitCost"
            />
          </template>
        </Dialog>

        <p v-if="costsLoading && !costsLoadError" class="collections-panel__loading">
          {{ t('collectionsMgmt.loading') }}
        </p>

        <DataTable :value="expenses" class="collections-data collections-table">
          <template #empty>
            <p class="collections-table__empty">{{ t('collectionsMgmt.emptyCosts') }}</p>
          </template>
          <Column :header="t('collectionsMgmt.tableInvoice')" class="collections-col-photo">
            <template #body="{ data }">
              <img
                v-if="data.invoicePhotoUrl"
                :src="data.invoicePhotoUrl"
                :alt="data.name"
                class="collections-thumb"
                width="44"
                height="44"
              />
              <span v-else class="collections-thumb-placeholder">—</span>
            </template>
          </Column>
          <Column field="name" :header="t('collectionsMgmt.tableName')" />
          <Column :header="t('collectionsMgmt.tableAmount')">
            <template #body="{ data }">
              {{ nfCurrency(Number(data.amount) || 0) }}
            </template>
          </Column>
          <Column :header="t('collectionsMgmt.tableDate')">
            <template #body="{ data }">
              {{ nfDate(data.purchaseDate) }}
            </template>
          </Column>
          <Column :header="t('app.deleteAction')" class="collections-col-actions">
            <template #body="{ data }">
              <Button
                type="button"
                text
                rounded
                class="collections-row-delete"
                icon="pi pi-trash"
                :aria-label="t('app.deleteAction')"
                @click="askDelete('expense', data)"
              />
            </template>
          </Column>
        </DataTable>

        <p v-if="costsLoadError" class="collections-panel__error" role="alert">
          {{ costsLoadError }}
        </p>
        </section>

        <section class="collections-panel" aria-labelledby="collections-services-heading">
          <header class="collections-panel__head">
            <h2 id="collections-services-heading" class="collections-panel__title">
              {{ t('sharedServices.sectionTitle') }}
            </h2>
            <Button
              type="button"
              rounded
              :label="t('sharedServices.addService')"
              severity="secondary"
              class="collections-panel__btn"
              @click="openServiceModal"
            />
          </header>

          <Dialog
            v-model:visible="serviceModalOpen"
            modal
            :header="t('sharedServices.modalTitle')"
            class="collections-service-dialog"
            :style="{ width: 'min(26rem, 92vw)' }"
            :draggable="false"
          >
            <div class="collections-form">
              <div class="collections-form__field">
                <label for="shared-service-type">{{ t('sharedServices.typeLabel') }}</label>
                <Dropdown
                  id="shared-service-type"
                  v-model="serviceForm.type"
                  :options="serviceTypeOptions"
                  option-label="label"
                  option-value="value"
                  class="collections-form__input w-full"
                  fluid
                />
              </div>
              <div class="collections-form__field">
                <label for="shared-service-amount">{{ t('sharedServices.totalLabel') }}</label>
                <InputNumber
                  id="shared-service-amount"
                  v-model="serviceForm.amount"
                  class="collections-form__input-num w-full"
                  :min="0"
                  mode="decimal"
                  :maxFractionDigits="2"
                  fluid
                />
              </div>
              <p v-if="serviceSubmitError" class="collections-form__error" role="alert">
                {{ serviceSubmitError }}
              </p>
            </div>
            <template #footer>
              <ConfirmActions
                :cancel-label="t('app.cancelAction')"
                :confirm-label="t('sharedServices.save')"
                :loading="serviceSaving"
                @cancel="closeServiceModal"
                @confirm="submitSharedService"
              />
            </template>
          </Dialog>

          <p v-if="servicesLoading && !servicesLoadError" class="collections-panel__loading">
            {{ t('collectionsMgmt.loading') }}
          </p>

          <DataTable :value="sharedServices" class="collections-data collections-table">
            <template #empty>
              <p class="collections-table__empty">{{ t('sharedServices.emptyServices') }}</p>
            </template>
            <Column :header="t('sharedServices.tableType')">
              <template #body="{ data }">
                {{ serviceTypeLabel(data.type) }}
              </template>
            </Column>
            <Column :header="t('sharedServices.tableAmount')">
              <template #body="{ data }">
                {{ nfCurrency(Number(data.amount) || 0) }}
              </template>
            </Column>
            <Column :header="t('sharedServices.tableShare')">
              <template #body="{ data }">
                <template v-if="Number(data.residentCount) > 0">
                  {{ nfCurrency(Number(data.perResidentShare) || 0) }}
                  <span class="collections-share-hint">
                    {{ t('sharedServices.shareUnits', { count: data.residentCount }) }}
                  </span>
                </template>
                <span v-else>—</span>
              </template>
            </Column>
            <Column :header="t('app.deleteAction')" class="collections-col-actions">
              <template #body="{ data }">
                <Button
                  type="button"
                  text
                  rounded
                  class="collections-row-delete"
                  icon="pi pi-trash"
                  :aria-label="t('app.deleteAction')"
                  @click="askDelete('service', data)"
                />
              </template>
            </Column>
          </DataTable>
          <p class="collections-panel__hint">{{ t('sharedServices.splitHint') }}</p>

          <p v-if="servicesLoadError" class="collections-panel__error" role="alert">
            {{ servicesLoadError }}
          </p>
        </section>

        <section class="collections-panel" aria-labelledby="collections-fixed-heading">
          <header class="collections-panel__head">
            <h2 id="collections-fixed-heading" class="collections-panel__title">
              {{ t('fixedPay.sectionTitle') }}
            </h2>
            <Button
              type="button"
              rounded
              :label="t('fixedPay.openButton')"
              severity="secondary"
              class="collections-panel__btn"
              @click="openFixedModal"
            />
          </header>

        <Dialog
          v-model:visible="fixedModalOpen"
          modal
          :header="t('fixedPay.modalTitle')"
          class="collections-fixed-dialog"
          :style="{ width: 'min(26rem, 92vw)' }"
          :draggable="false"
        >
          <div class="collections-form">
            <div class="collections-form__field">
              <label for="fixed-pay-name">{{ t('fixedPay.nameLabel') }}</label>
              <InputText
                id="fixed-pay-name"
                v-model="fixedForm.name"
                class="collections-form__input"
                autocomplete="name"
                fluid
              />
            </div>
            <div class="collections-form__field">
              <label for="fixed-pay-dni">{{ t('fixedPay.dniLabel') }}</label>
              <InputText id="fixed-pay-dni" v-model="fixedForm.dni" class="collections-form__input" fluid />
            </div>
            <div class="collections-form__field">
              <label for="fixed-pay-phone">{{ t('fixedPay.phoneLabel') }}</label>
              <InputText
                id="fixed-pay-phone"
                v-model="fixedForm.phone"
                class="collections-form__input"
                inputmode="tel"
                autocomplete="tel"
                fluid
              />
            </div>
            <div class="collections-form__field">
              <label for="fixed-pay-salary">{{ t('fixedPay.salaryLabel') }}</label>
              <InputNumber
                id="fixed-pay-salary"
                v-model="fixedForm.salary"
                class="collections-form__input-num w-full"
                :min="0"
                mode="decimal"
                :maxFractionDigits="2"
                fluid
              />
            </div>
            <div class="collections-form__field">
              <label for="fixed-pay-interval">{{ t('fixedPay.intervalDaysLabel') }}</label>
              <InputNumber
                id="fixed-pay-interval"
                v-model="fixedForm.intervalDays"
                class="collections-form__input-num w-full"
                :min="1"
                :max="365"
                fluid
              />
              <p v-if="previewFirstFixedDue" class="collections-form__hint collections-form__hint--strong">
                {{ t('fixedPay.firstDueHint', { date: nfDate(previewFirstFixedDue) }) }}
              </p>
            </div>
            <div class="collections-form__field collections-form__field--photo">
              <span class="collections-form__photo-label">{{ t('fixedPay.photoLabel') }}</span>
              <p class="collections-form__hint">{{ t('fixedPay.photoHint') }}</p>
              <label class="collections-form__file">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  class="collections-form__file-input"
                  :disabled="fixedProcessingPhoto || fixedSaving"
                  @change="onFixedPhotoChange"
                />
                <span class="collections-form__file-trigger">{{
                  fixedProcessingPhoto
                    ? t('fixedPay.processingPhoto')
                    : t('fixedPay.photoChoose')
                }}</span>
              </label>
              <div v-if="fixedForm.photoUrl" class="collections-form__preview-row">
                <img
                  :src="fixedForm.photoUrl"
                  :alt="fixedForm.name.trim() ? fixedForm.name.trim() : t('fixedPay.photoLabel')"
                  class="collections-form__preview"
                  width="80"
                  height="80"
                />
                <Button
                  type="button"
                  :label="t('fixedPay.removePhoto')"
                  variant="text"
                  text
                  @click="fixedForm.photoUrl = ''"
                />
              </div>
            </div>
            <p v-if="fixedSubmitError" class="collections-form__error" role="alert">
              {{ fixedSubmitError }}
            </p>
          </div>
          <template #footer>
            <ConfirmActions
              :cancel-label="t('app.cancelAction')"
              :confirm-label="t('fixedPay.save')"
              :loading="fixedSaving"
              @cancel="closeFixedModal"
              @confirm="submitFixedRecipient"
            />
          </template>
        </Dialog>

        <p v-if="fixedLoading && !fixedLoadError" class="collections-panel__loading">
          {{ t('collectionsMgmt.loading') }}
        </p>

        <h3 class="collections-panel__sub">{{ t('fixedPay.recipientsHeading') }}</h3>
        <DataTable :value="fixedRecipients" class="collections-data collections-table">
          <template #empty>
            <p class="collections-table__empty">{{ t('fixedPay.emptyRecipients') }}</p>
          </template>
          <Column :header="t('fixedPay.tablePhoto')" class="collections-col-photo">
            <template #body="{ data }">
              <img
                v-if="data.photoUrl"
                :src="data.photoUrl"
                :alt="data.name"
                class="collections-thumb"
                width="44"
                height="44"
              />
              <span v-else class="collections-thumb-placeholder">—</span>
            </template>
          </Column>
          <Column field="name" :header="t('collectionsMgmt.tableName')" />
          <Column field="dni" :header="t('fixedPay.dniLabel')" />
          <Column field="phone" :header="t('fixedPay.phoneLabel')" />
          <Column :header="t('collectionsMgmt.tableAmount')">
            <template #body="{ data }">
              {{ nfCurrency(Number(data.salary) || 0) }}
            </template>
          </Column>
          <Column :header="t('fixedPay.tableInterval')">
            <template #body="{ data }">{{ Math.max(1, Math.floor(Number(data.intervalDays) || 0)) }}</template>
          </Column>
          <Column :header="t('fixedPay.tableNext')">
            <template #body="{ data }">{{ nfDate(data.nextPaymentDate) }}</template>
          </Column>
          <Column :header="t('app.deleteAction')" class="collections-col-actions">
            <template #body="{ data }">
              <Button
                type="button"
                text
                rounded
                class="collections-row-delete"
                icon="pi pi-trash"
                :aria-label="t('app.deleteAction')"
                @click="askDelete('fixed', data)"
              />
            </template>
          </Column>
        </DataTable>

        <h3 class="collections-panel__sub collections-panel__sub--divider">
          {{ t('fixedPay.historyHeading') }}
        </h3>
        <DataTable
          :value="fixedHistoryRows"
          class="collections-data collections-table collections-table--history"
        >
          <template #empty>
            <p class="collections-table__empty">{{ t('fixedPay.emptyHistory') }}</p>
          </template>
          <Column field="paidOn" :header="t('collectionsMgmt.tableDate')">
            <template #body="{ data }">{{ nfDate(data.paidOn) }}</template>
          </Column>
          <Column field="recipientName" :header="t('collectionsMgmt.tableName')" />
          <Column :header="t('collectionsMgmt.tableAmount')">
            <template #body="{ data }">{{ nfCurrency(data.amount) }}</template>
          </Column>
        </DataTable>

        <p v-if="fixedLoadError" class="collections-panel__error" role="alert">
          {{ fixedLoadError }}
        </p>
        </section>

        <Dialog
          :visible="pendingDelete != null"
          modal
          :header="t('collectionsMgmt.deleteModalTitle')"
          class="collections-delete-dialog"
          :style="{ width: 'min(24rem, 92vw)' }"
          :draggable="false"
          :closable="!deleting"
          @update:visible="(open) => { if (!open) closeDelete() }"
        >
          <p class="collections-delete-dialog__text">
            {{
              pendingDelete?.kind === 'service'
                ? t('sharedServices.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
                : pendingDelete?.kind === 'fixed'
                  ? t('fixedPay.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
                  : t('collectionsMgmt.deleteConfirm', { name: deleteCandidateLabel(pendingDelete) })
            }}
          </p>
          <p
            v-if="pendingDelete?.kind === 'service'"
            class="collections-delete-dialog__hint"
          >
            {{ t('sharedServices.deleteHint') }}
          </p>
          <template #footer>
            <ConfirmActions
              :cancel-label="t('app.cancelAction')"
              :confirm-label="t('app.deleteAction')"
              confirm-variant="danger"
              :loading="deleting"
              @cancel="closeDelete"
              @confirm="confirmDelete"
            />
          </template>
        </Dialog>
      </div>
    </template>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.header-with-actions {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.5rem;
}

.app-view__title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--apple-text, #1d1d1f);
}

.app-view__status {
  margin: 1rem 0 0;
  font-size: 0.9375rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.app-view__error {
  margin: 1rem 0 0;
  font-size: 0.9375rem;
  color: #b42318;
}

.collections-page {
  margin-top: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.collections-hero {
  max-width: 26rem;
  padding: 1.35rem 1.4rem 1.3rem;
  border-radius: 16px;
  background: #f5f5f7;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.04),
    0 4px 16px rgba(0, 0, 0, 0.03);
}

.collections-hero__title {
  margin: 0;
  max-width: 22rem;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.015em;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-hero__amount {
  margin: 0.65rem 0 0;
  font-size: 2rem;
  font-weight: 600;
  letter-spacing: -0.045em;
  font-variant-numeric: tabular-nums;
  color: var(--apple-text, #1d1d1f);
}

.collections-hero__rows {
  list-style: none;
  margin: 1.1rem 0 0;
  padding: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.07);
}

.collections-hero__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding: 0.62rem 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  font-size: 0.8125rem;
  line-height: 1.35;
}

.collections-hero__row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.collections-hero__row-label {
  flex: 1;
  min-width: 0;
  color: #86868b;
}

.collections-hero__row-value {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--apple-text, #1d1d1f);
}

.collections-hero__hint {
  margin: 1rem 0 0;
  font-size: 0.75rem;
  line-height: 1.45;
  color: #aeaeb2;
}

.collections-panel {
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.collections-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.85rem 1rem;
  margin-bottom: 0.85rem;
}

.collections-panel__title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--apple-text, #1d1d1f);
  max-width: min(100%, 18rem);
}

.collections-panel__btn {
  flex-shrink: 0;
}

.collections-panel__btn :deep(.p-button) {
  font-weight: 500;
  font-size: 0.8125rem;
  padding-block: 0.5rem;
  padding-inline: 1rem;
}

.collections-panel__loading {
  margin: 0 0 0.65rem;
  font-size: 0.8125rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-panel__hint {
  margin: 0.75rem 0 0;
  font-size: 0.75rem;
  line-height: 1.45;
  color: #aeaeb2;
}

.collections-share-hint {
  margin-left: 0.35rem;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-panel__error {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: #b42318;
}

.collections-panel__sub {
  margin: 1.35rem 0 0.55rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #86868b;
}

.collections-panel__sub:first-of-type {
  margin-top: 0.35rem;
}

.collections-panel__sub--divider {
  margin-top: 1.5rem;
  padding-top: 1.15rem;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.collections-table {
  margin-top: 0.15rem;
}

.collections-table--history {
  margin-bottom: 0.15rem;
}

.collections-data :deep(.p-datatable) {
  font-size: 0.875rem;
  border: none;
  border-radius: 12px;
  overflow: hidden;
}

.collections-data :deep(.p-datatable-wrapper) {
  border-radius: 12px;
}

.collections-data :deep(.p-datatable-thead > tr > th) {
  background: rgba(0, 0, 0, 0.02);
  color: #86868b;
  font-weight: 600;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.055em;
  border: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding: 0.6rem 0.75rem;
}

.collections-data :deep(.p-datatable-tbody > tr) {
  background: transparent;
  transition: background 0.12s ease;
}

.collections-data :deep(.p-datatable-tbody > tr:hover) {
  background: rgba(0, 0, 0, 0.02);
}

.collections-data :deep(.p-datatable-tbody > tr > td) {
  border: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  padding: 0.7rem 0.75rem;
  vertical-align: middle;
  color: var(--apple-text, #1d1d1f);
}

.collections-data :deep(.p-datatable-tbody > tr:last-child > td) {
  border-bottom: none;
}

.collections-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.collections-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.collections-form__field label,
.collections-form__photo-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.collections-form__hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-form__hint--strong {
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.collections-form__input,
.collections-form__input-num {
  width: 100%;
}

.collections-form__input--date {
  min-height: 2.75rem;
}

.collections-form__file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  overflow: hidden;
}

.collections-form__file {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.collections-form__file-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.85rem;
  border-radius: 10px;
  border: 1px solid #e8e8ed;
  background: #f5f5f7;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.collections-form__file-trigger:hover {
  background: #ececf0;
}

.collections-form__preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.35rem;
}

.collections-form__preview {
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid #e8e8ed;
}

.collections-form__error {
  margin: 0;
  font-size: 0.8125rem;
  color: #b42318;
}

.collections-table__empty {
  margin: 0;
  padding: 1rem 0;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-thumb {
  border-radius: 8px;
  object-fit: cover;
  vertical-align: middle;
  border: 1px solid #e8e8ed;
}

.collections-thumb-placeholder {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.875rem;
}

.collections-col-actions {
  width: 5.5rem;
  text-align: right;
}

.collections-row-delete :deep(.p-button) {
  color: #ff3b30;
}

.collections-delete-dialog__text {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.45;
  color: var(--apple-text, #1d1d1f);
}

.collections-delete-dialog__hint {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.collections-cost-dialog :deep(.p-dialog-footer),
.collections-service-dialog :deep(.p-dialog-footer),
.collections-fixed-dialog :deep(.p-dialog-footer),
.collections-delete-dialog :deep(.p-dialog-footer) {
  gap: 0.5rem;
}

.collections-cost-dialog :deep(.p-inputnumber),
.collections-service-dialog :deep(.p-inputnumber),
.collections-service-dialog :deep(.p-dropdown),
.collections-fixed-dialog :deep(.p-inputnumber) {
  width: 100%;
}
</style>
