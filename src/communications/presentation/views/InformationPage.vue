<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Dialog from 'primevue/dialog'
import { useSession } from '@/iam/application/sessionStore.js'
import { announcementsApi } from '@/communications/infrastructure/announcementsApi.js'
import AnnouncementForm from '../components/AnnouncementForm.vue'
import AnnouncementsList from '../components/AnnouncementsList.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import { confirmSuccess, markFresh } from '@/shared/presentation/feedback/successFeedback.js'
import {
  expiresWithinWeek,
  isAnnouncementExpired,
  normalizePriority,
  useAnnouncementFormat,
} from '../composables/useAnnouncementFormat.js'

const { t } = useAnnouncementFormat()
const { isAdmin, state: session } = useSession()

const announcements = ref([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref(false)

/* ---------- Summary + filters ---------- */
const activeRows = computed(() => announcements.value.filter((a) => !isAnnouncementExpired(a)))
const expiredRows = computed(() => announcements.value.filter((a) => isAnnouncementExpired(a)))

const stats = computed(() => [
  {
    key: 'active',
    tone: 'blue',
    icon: 'pi-megaphone',
    label: t('information.statActive'),
    hint: t('information.statActiveHint'),
    value: activeRows.value.length,
  },
  {
    key: 'urgent',
    tone: 'red',
    icon: 'pi-exclamation-triangle',
    label: t('information.statUrgent'),
    hint: t('information.statUrgentHint'),
    value: activeRows.value.filter((a) => normalizePriority(a.priority) === 'urgent').length,
  },
  {
    key: 'week',
    tone: 'amber',
    icon: 'pi-clock',
    label: t('information.statExpiringWeek'),
    hint: t('information.statExpiringWeekHint'),
    value: activeRows.value.filter((a) => expiresWithinWeek(a)).length,
  },
  {
    key: 'expired',
    tone: 'orange',
    icon: 'pi-history',
    label: t('information.statExpired'),
    hint: t('information.statExpiredHint'),
    value: expiredRows.value.length,
  },
])

const statusFilter = ref('active')
const priorityFilter = ref('all')

const statusRows = computed(() => {
  if (statusFilter.value === 'active') return activeRows.value
  if (statusFilter.value === 'expired') return expiredRows.value
  // "Todos": server order (priority, then date) with active ones first.
  return [...activeRows.value, ...expiredRows.value]
})

const statusFilters = computed(() => [
  { id: 'active', label: t('information.filterActive'), count: activeRows.value.length },
  { id: 'expired', label: t('information.filterExpired'), count: expiredRows.value.length },
  { id: 'all', label: t('information.filterAll'), count: announcements.value.length },
])

const priorityFilters = computed(() => [
  { id: 'all', label: t('information.priorityAllShort'), count: statusRows.value.length },
  ...['urgent', 'important', 'normal'].map((id) => ({
    id,
    label: t(`information.priority${id[0].toUpperCase()}${id.slice(1)}`),
    count: statusRows.value.filter((a) => normalizePriority(a.priority) === id).length,
  })),
])

const filteredAnnouncements = computed(() => {
  if (priorityFilter.value === 'all') return statusRows.value
  return statusRows.value.filter((row) => normalizePriority(row.priority) === priorityFilter.value)
})

const emptyText = computed(() => {
  if (!announcements.value.length) return t('information.empty')
  if (priorityFilter.value !== 'all') return t('information.emptyFiltered')
  if (statusFilter.value === 'active') return t('information.emptyActive')
  if (statusFilter.value === 'expired') return t('information.emptyExpired')
  return t('information.empty')
})

const canShowAll = computed(
  () => announcements.value.length > 0 && (statusFilter.value !== 'all' || priorityFilter.value !== 'all'),
)

function showAll() {
  statusFilter.value = 'all'
  priorityFilter.value = 'all'
}

/* ---------- Data ---------- */
async function fetchAnnouncements() {
  loading.value = true
  loadError.value = false
  try {
    announcements.value = await announcementsApi.list()
    loaded.value = true
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

/* ---------- Success notice ---------- */
const notice = ref('')
let noticeTimer = null
function flash(message) {
  notice.value = message
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 4000)
}
onBeforeUnmount(() => clearTimeout(noticeTimer))

/* ---------- Create / edit dialog ---------- */
const formOpen = ref(false)
const formKey = ref(0)
const editing = ref(null)
const saving = ref(false)
const formError = ref('')
const formRef = ref(null)
/** Pie del diálogo: su botón "Publicar" / "Guardar cambios" se pone verde al guardar. */
const formActionsRef = ref(null)

const authorName = computed(() => session.profile?.name ?? 'Admin')

function openCreate() {
  editing.value = null
  formError.value = ''
  formKey.value += 1
  formOpen.value = true
}

function openEdit(announcement) {
  editing.value = announcement
  formError.value = ''
  formKey.value += 1
  formOpen.value = true
}

function closeForm() {
  if (saving.value) return
  formOpen.value = false
}

async function handleSubmit(payload) {
  formError.value = ''
  saving.value = true
  const isEdit = Boolean(editing.value?.id)
  let saved = null
  try {
    if (isEdit) {
      saved = await announcementsApi.update(editing.value.id, payload)
    } else {
      saved = await announcementsApi.add({
        ...payload,
        authorId: session.profile?.id ?? '',
        authorName: authorName.value,
      })
    }
  } catch {
    formError.value = isEdit ? t('information.updateError') : t('information.publishError')
    saving.value = false
    return
  }
  await confirmSuccess(
    formActionsRef.value?.$el?.querySelector('.bf-btn--confirm'),
    isEdit ? t('feedback.changesSaved') : t('feedback.announcementPublished'),
  )
  saving.value = false
  formOpen.value = false
  // Server recomputes expiresAt and the priority ordering: reload.
  await fetchAnnouncements()
  if (!isEdit && statusFilter.value === 'expired') statusFilter.value = 'active'
  markFresh('announcement', isEdit ? editing.value.id : saved?.id)
}

/* ---------- Delete ---------- */
const pendingDelete = ref(null)
const deleting = ref(false)
const deleteError = ref('')

function askDelete(announcement) {
  deleteError.value = ''
  pendingDelete.value = announcement
}

function closeDelete() {
  if (deleting.value) return
  pendingDelete.value = null
}

async function confirmDelete() {
  const target = pendingDelete.value
  if (!target) return
  deleteError.value = ''
  deleting.value = true
  try {
    await announcementsApi.remove(target.id)
    announcements.value = announcements.value.filter((a) => a.id !== target.id)
    pendingDelete.value = null
    flash(t('information.deleted'))
  } catch {
    deleteError.value = t('information.deleteError')
  } finally {
    deleting.value = false
  }
}

onMounted(fetchAnnouncements)
</script>

<template>
  <div class="app-view inf">
    <header class="inf-head">
      <h1 class="bf-sr-only">{{ t('information.announcementsPanelTitle') }}</h1>
      <div class="inf-head__actions">
        <button
          type="button"
          class="inf-icon-btn"
          :aria-label="t('information.refresh')"
          :title="t('information.refresh')"
          :disabled="loading"
          @click="fetchAnnouncements"
        >
          <i class="pi" :class="loading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
        </button>
        <button v-if="isAdmin" type="button" class="inf-btn inf-btn--primary" @click="openCreate">
          <i class="pi pi-plus" aria-hidden="true" />
          {{ t('information.newAnnouncement') }}
        </button>
      </div>
    </header>

    <p class="inf-notice" :class="{ 'is-visible': notice }" role="status" aria-live="polite">
      <template v-if="notice">
        <i class="pi pi-check-circle" aria-hidden="true" />
        {{ notice }}
      </template>
    </p>

    <LoadErrorRetry
      v-if="loadError"
      :message="t('information.loadError')"
      :loading="loading"
      @retry="fetchAnnouncements"
    />

    <p v-else-if="loading && !loaded" class="inf-status" role="status">{{ t('information.loading') }}</p>

    <template v-else-if="loaded">
      <KpiPills :items="stats" :aria-label="t('information.summaryAria')" />

      <section class="inf-card">
        <div class="inf-toolbar">
          <div class="inf-filters" v-bf-seg role="group" :aria-label="t('information.statusFilterAria')">
            <button
              v-for="filter in statusFilters"
              :key="filter.id"
              type="button"
              class="inf-filter"
              :class="[`inf-filter--${filter.id}`, { 'is-active': statusFilter === filter.id }]"
              :aria-pressed="statusFilter === filter.id ? 'true' : 'false'"
              @click="statusFilter = filter.id"
            >
              {{ filter.label }}
              <span class="inf-filter__count">{{ filter.count }}</span>
            </button>
          </div>
          <div class="inf-priority" v-bf-seg role="group" :aria-label="t('information.priorityFilterAria')">
            <span class="inf-priority__label" aria-hidden="true">{{ t('information.priorityFilterLabel') }}</span>
            <button
              v-for="filter in priorityFilters"
              :key="filter.id"
              type="button"
              class="inf-seg"
              :class="[`inf-seg--${filter.id}`, { 'is-active': priorityFilter === filter.id }]"
              :aria-pressed="priorityFilter === filter.id ? 'true' : 'false'"
              @click="priorityFilter = filter.id"
            >
              <span v-if="filter.id !== 'all'" class="inf-seg__dot" aria-hidden="true" />
              {{ filter.label }}
              <span class="inf-seg__count">{{ filter.count }}</span>
            </button>
          </div>
        </div>

        <AnnouncementsList
          v-if="filteredAnnouncements.length"
          :announcements="filteredAnnouncements"
          :can-delete="isAdmin"
          :can-edit="isAdmin"
          @edit="openEdit"
          @delete="askDelete"
        />
        <div v-else class="inf-empty">
          <span class="inf-empty__icon"><i class="pi pi-megaphone" aria-hidden="true" /></span>
          <p class="inf-empty__text">{{ emptyText }}</p>
          <div class="inf-empty__actions">
            <button v-if="canShowAll" type="button" class="inf-btn" @click="showAll">
              {{ t('information.seeAll') }}
            </button>
            <button v-if="isAdmin" type="button" class="inf-btn inf-btn--primary" @click="openCreate">
              <i class="pi pi-plus" aria-hidden="true" />
              {{ t('information.newAnnouncement') }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- Nuevo / editar comunicado -->
    <Dialog
      :visible="formOpen"
      modal
      :header="editing ? t('information.editAnnouncement') : t('information.newAnnouncement')"
      class="inf-dialog"
      :style="{ width: 'min(54rem, 94vw)' }"
      :draggable="false"
      :closable="!saving"
      @update:visible="(open) => { if (!open) closeForm() }"
    >
      <AnnouncementForm
        v-if="formOpen"
        ref="formRef"
        :key="formKey"
        :announcement="editing"
        :author-name="authorName"
        :saving="saving"
        :error="formError"
        @submit="handleSubmit"
      />
      <template #footer>
        <ConfirmActions
          ref="formActionsRef"
          :cancel-label="t('information.cancel')"
          :confirm-label="
            saving
              ? editing ? t('information.saving') : t('information.sending')
              : editing ? t('information.saveChanges') : t('information.send')
          "
          :loading="saving"
          @cancel="closeForm"
          @confirm="formRef?.submit()"
        />
      </template>
    </Dialog>

    <!-- Confirmar eliminación -->
    <Dialog
      :visible="pendingDelete != null"
      modal
      :header="t('information.deleteTitle')"
      class="inf-dialog"
      :style="{ width: 'min(25rem, 94vw)' }"
      :draggable="false"
      :closable="!deleting"
      @update:visible="(open) => { if (!open) closeDelete() }"
    >
      <p class="inf-delete__text">
        {{ t('information.deleteConfirmNamed', { title: pendingDelete?.title ?? '' }) }}
      </p>
      <p v-if="deleteError" class="inf-delete__error" role="alert">{{ deleteError }}</p>
      <template #footer>
        <ConfirmActions
          :cancel-label="t('information.cancel')"
          :confirm-label="t('information.delete')"
          confirm-variant="danger"
          :loading="deleting"
          @cancel="closeDelete"
          @confirm="confirmDelete"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.25rem 1.5rem 2.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.inf {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.inf *,
.inf *::before,
.inf *::after {
  box-sizing: border-box;
}

/* ---------- Header ---------- */
.inf-head {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}

.inf-head__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.45rem;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.inf-btn .pi {
  font-size: 0.78rem;
}

.inf-btn:hover:not(:disabled) {
  background: #e8eefc;
  border-color: transparent;
}

.inf-btn--primary {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.inf-btn--primary:hover:not(:disabled) {
  background: #172554;
  border-color: #172554;
}

.inf-icon-btn {
  width: 2.45rem;
  height: 2.45rem;
  border-radius: 50%;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.inf-icon-btn:hover:not(:disabled) {
  background: #e8eefc;
}

.inf-icon-btn:disabled {
  cursor: progress;
  opacity: 0.75;
}

.inf-btn:focus-visible,
.inf-icon-btn:focus-visible,
.inf-filter:focus-visible,
.inf-seg:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.inf-status {
  margin: 0;
  font-size: 0.85rem;
  color: #6e6e73;
}

.inf-notice {
  margin: 0;
  display: none;
}

.inf-notice.is-visible {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  align-self: flex-start;
  padding: 0.5rem 0.85rem;
  border-radius: 12px;
  background: #e3f4e8;
  color: #15803d;
  font-size: 0.82rem;
  font-weight: 600;
}

/* ---------- Content card ---------- */
.inf-card {
  padding: 1.1rem 1.15rem 1.2rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.inf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.inf-filters {
  display: flex;
  flex-wrap: wrap;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.inf-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.5rem 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.28s ease;
}

.inf-filter:hover:not(.is-active) {
  color: #0f172a;
}

.inf-filter__count {
  min-width: 1.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.7rem;
  font-weight: 700;
  text-align: center;
}

.inf-filter.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.inf-filter.is-active .inf-filter__count {
  background: #f1f5f9;
  color: #0f172a;
}

.inf-filter--active:not(.is-active) .inf-filter__count {
  background: #e3f4e8;
  color: #15803d;
}

.inf-filter--expired:not(.is-active) .inf-filter__count {
  background: #fdeee2;
  color: #c2410c;
}

/* Priority segmented filter */
.inf-priority {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  flex-wrap: wrap;
  padding: 0.2rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
}

.inf-priority__label {
  padding: 0 0.5rem 0 0.6rem;
  font-size: 0.74rem;
  font-weight: 600;
  color: #64748b;
}

.inf-seg {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.7rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #475569;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.inf-seg:hover:not(.is-active) {
  color: #0f172a;
}

.inf-seg.is-active {
  background: transparent;
  color: #0f172a;
}

.inf-seg__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #94a3b8;
}

.inf-seg--urgent .inf-seg__dot { background: #dc2626; }
.inf-seg--important .inf-seg__dot { background: #d97706; }
.inf-seg--normal .inf-seg__dot { background: #1e3a8a; }

.inf-seg__count {
  font-size: 0.7rem;
  font-weight: 700;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.inf-seg.is-active .inf-seg__count {
  color: #1e3a8a;
}

/* Empty state */
.inf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 2rem 1rem;
  border-radius: 14px;
  background: #f8fafc;
  text-align: center;
}

.inf-empty__icon {
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  background: #fff;
  color: #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05rem;
}

.inf-empty__text {
  margin: 0;
  max-width: 28rem;
  font-size: 0.85rem;
  line-height: 1.45;
  color: #475569;
}

.inf-empty__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* ---------- Responsive ---------- */

@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }
  .inf-head,
  .inf-head__actions {
    width: 100%;
  }
  .inf-head__actions .inf-btn--primary {
    flex: 1;
  }
  .inf-card {
    padding: 0.9rem 0.8rem 1rem;
  }
  .inf-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .inf-filters {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .inf-filter {
    justify-content: center;
    padding-inline: 0.5rem;
  }
  .inf-priority {
    max-width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inf-btn {
    transition: none;
  }
}
</style>

<style>
/* PrimeVue Dialog shell is teleported to <body>: style it by class (unscoped). */
.inf-dialog.p-dialog {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.07);
  max-height: 92vh;
}

.inf-dialog .p-dialog-header {
  padding: 1.1rem 1.25rem 0.6rem;
}

.inf-dialog .p-dialog-title {
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.inf-dialog .p-dialog-content {
  padding: 0.25rem 1.25rem 0.5rem;
}

.inf-dialog .p-dialog-footer {
  padding: 0.75rem 1.25rem 1.1rem;
  gap: 0.5rem;
}

.inf-dialog .inf-delete__text {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  color: #0f172a;
}

.inf-dialog .inf-delete__error {
  margin: 0.75rem 0 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}
</style>
