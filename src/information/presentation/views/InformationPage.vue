<script setup>
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/iam/application/sessionStore.js'
import { announcementsApi } from '@/information/infrastructure/announcementsApi.js'
import AnnouncementForm from '../components/AnnouncementForm.vue'
import AnnouncementsList from '../components/AnnouncementsList.vue'

const { t } = useI18n()
const { isAdmin, state: session } = useSession()

const announcements = ref([])
const loading = ref(false)
const loadError = ref(false)
const composing = ref(false)
const priorityFilter = ref('all')

const filters = computed(() => [
  { id: 'all', label: t('information.filterAll') },
  { id: 'urgent', label: t('information.priorityUrgent') },
  { id: 'important', label: t('information.priorityImportant') },
  { id: 'normal', label: t('information.priorityNormal') },
])

const filteredAnnouncements = computed(() => {
  if (priorityFilter.value === 'all') return announcements.value
  return announcements.value.filter((row) => (row.priority || 'normal') === priorityFilter.value)
})

function startCompose() {
  composing.value = true
}

function cancelCompose() {
  composing.value = false
}

async function fetchAnnouncements() {
  loading.value = true
  loadError.value = false
  try {
    announcements.value = await announcementsApi.list()
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function handleCreate(payload) {
  await announcementsApi.add({
    ...payload,
    authorId: session.profile?.id ?? '',
    authorName: session.profile?.name ?? 'Admin',
  })
  await fetchAnnouncements()
  composing.value = false
}

async function handleDelete(id) {
  try {
    await announcementsApi.remove(id)
    announcements.value = announcements.value.filter((a) => a.id !== id)
  } catch {
    loadError.value = true
  }
}

onMounted(fetchAnnouncements)
</script>

<template>
  <div class="app-view info-page">
    <header class="info-head">
      <h1 class="visually-hidden">{{ t('information.pageTitle') }}</h1>
    </header>

    <p v-if="loadError" class="info-alert" role="alert">{{ t('information.loadError') }}</p>

    <AnnouncementForm v-if="isAdmin && composing" @submit="handleCreate" @cancel="cancelCompose" />

    <div class="info-toolbar">
      <div
        v-if="announcements.length"
        class="info-filters"
        role="group"
        :aria-label="t('information.announcementsPanelTitle')"
      >
        <button
          v-for="filter in filters"
          :key="filter.id"
          type="button"
          class="info-filter"
          :class="{ 'is-active': priorityFilter === filter.id }"
          :aria-pressed="priorityFilter === filter.id"
          @click="priorityFilter = filter.id"
        >
          {{ filter.label }}
        </button>
      </div>
      <button
        v-if="isAdmin && !composing"
        type="button"
        class="info-new"
        @click="startCompose"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        {{ t('information.newAnnouncement') }}
      </button>
    </div>

    <AnnouncementsList
      :announcements="filteredAnnouncements"
      :loading="loading"
      :can-delete="isAdmin"
      @delete="handleDelete"
    />
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.info-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.info-head {
  display: contents;
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

.info-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.info-toolbar .info-new {
  margin-left: auto;
}

.info-new {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border: none;
  border-radius: 8px;
  background: #0071e3;
  color: #fff;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  box-shadow: none;
}

.info-new:hover {
  background: #0066cc;
}

.info-new:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
}

.info-alert {
  margin: 0;
  font-size: 0.875rem;
  color: #b42318;
}

.info-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  width: fit-content;
  max-width: 100%;
  padding: 0.3rem;
  border-radius: 999px;
  background: #eef0f3;
}

.info-filter {
  padding: 0.45rem 0.95rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #4b5563;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.info-filter:hover:not(.is-active) {
  color: #1d1d1f;
}

.info-filter.is-active {
  background: #fff;
  color: #1d1d1f;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.info-filter:focus-visible {
  outline: 2px solid #0071e3;
  outline-offset: 2px;
}

.app-view :deep(.bf-btn) {
  min-height: 1.7rem;
  padding: 0.22rem 0.85rem;
  border-radius: 8px;
  box-shadow: none;
  transform: none;
}

.app-view :deep(.bf-btn--confirm) {
  background: #0071e3;
  color: #ffffff;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):hover) {
  background: #0066cc;
  border-color: transparent;
  box-shadow: none;
}

.app-view :deep(.bf-btn--confirm:not(:disabled):focus-visible) {
  animation: none;
  box-shadow: none;
}
</style>
