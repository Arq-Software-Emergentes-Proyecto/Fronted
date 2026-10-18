<script setup>
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

defineProps({
  announcements: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  canDelete: { type: Boolean, default: false },
})

const emit = defineEmits(['delete'])

function formatWhen(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(locale.value === 'es' ? 'es-PE' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

function formatExpiry(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(locale.value === 'es' ? 'es-PE' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function isExpired(iso) {
  if (!iso) return false
  return new Date() > new Date(iso)
}

function priorityLabel(priority) {
  const map = {
    normal: t('information.priorityNormal'),
    important: t('information.priorityImportant'),
    urgent: t('information.priorityUrgent'),
  }
  return map[priority] ?? map.normal
}

function onDelete(id) {
  if (!window.confirm(t('information.deleteConfirm'))) return
  emit('delete', id)
}
</script>

<template>
  <p v-if="loading" class="ann-status">{{ t('information.loading') }}</p>
  <p v-else-if="!announcements.length" class="ann-status">{{ t('information.empty') }}</p>
  <ul v-else class="ann-board" role="list">
    <li v-for="ann in announcements" :key="ann.id">
      <article
        class="ann-card"
        :class="[
          `ann-card--${ann.priority || 'normal'}`,
          { 'is-expired': isExpired(ann.expiresAt) },
        ]"
      >
        <header class="ann-card__head">
          <div class="ann-card__badges">
            <span class="ann-badge" :class="`ann-badge--${ann.priority || 'normal'}`">
              {{ priorityLabel(ann.priority) }}
            </span>
            <span v-if="isExpired(ann.expiresAt)" class="ann-badge ann-badge--expired">
              {{ t('information.expired') }}
            </span>
          </div>
          <button
            v-if="canDelete"
            type="button"
            class="ann-card__delete"
            :aria-label="t('information.delete')"
            @click="onDelete(ann.id)"
          >
            <i class="pi pi-trash" aria-hidden="true" />
          </button>
        </header>
        <h3 class="ann-card__title">{{ ann.title }}</h3>
        <p class="ann-card__body">{{ ann.body }}</p>
        <footer class="ann-card__meta">
          <span>
            <i class="pi pi-user" aria-hidden="true" />
            {{ ann.authorName || t('information.pageTitle') }}
          </span>
          <time v-if="ann.createdAt" :datetime="ann.createdAt">{{ formatWhen(ann.createdAt) }}</time>
          <span v-if="ann.expiresAt && !isExpired(ann.expiresAt)">
            {{ t('information.expiresOn', { date: formatExpiry(ann.expiresAt) }) }}
          </span>
        </footer>
      </article>
    </li>
  </ul>
</template>

<style scoped>
.ann-status {
  margin: 0;
  padding: 1.5rem 0.25rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.ann-board {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18.5rem, 1fr));
  gap: 0.9rem;
}

.ann-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 1.05rem 1.1rem 1.1rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.ann-card.is-expired {
  opacity: 0.72;
}

.ann-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.65rem;
}

.ann-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.ann-card__delete {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  margin: -0.25rem -0.25rem 0 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #ff3b30;
  cursor: pointer;
}

.ann-card__delete:hover {
  color: #e0352b;
  background: rgba(255, 59, 48, 0.1);
}

.ann-card__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.3;
  color: var(--apple-text, #1d1d1f);
}

.ann-card__body {
  margin: 0;
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--apple-text, #1d1d1f);
}

.ann-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.85rem;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.ann-card__meta i {
  margin-right: 0.25rem;
  font-size: 0.7rem;
}

.ann-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.ann-badge--normal {
  background: #f2f2f7;
  color: #6e6e73;
}

.ann-badge--important {
  background: #fff3e0;
  color: #e65100;
}

.ann-badge--urgent {
  background: #fdecee;
  color: #b42318;
}

.ann-badge--expired {
  background: #f2f2f7;
  color: #b42318;
}
</style>
