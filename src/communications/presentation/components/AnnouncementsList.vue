<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PRIORITY_META,
  calendarDaysUntil,
  initialsOf,
  isAnnouncementExpired,
  normalizePriority,
  useAnnouncementFormat,
} from '../composables/useAnnouncementFormat.js'

const props = defineProps({
  announcements: { type: Array, required: true },
  canDelete: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
})

const emit = defineEmits(['delete', 'edit'])

const { t, formatDate, formatDateTime, priorityLabel, expiryLabel } = useAnnouncementFormat()

/** Bodies taller than the clamp get a "ver más" toggle. */
const bodyEls = new Map()
const overflowing = ref(new Set())
const expanded = ref(new Set())
let resizeObserver = null

function setBodyEl(id, el) {
  if (el) bodyEls.set(id, el)
  else bodyEls.delete(id)
}

function measure() {
  const next = new Set()
  for (const [id, el] of bodyEls) {
    if (expanded.value.has(id)) {
      if (overflowing.value.has(id)) next.add(id)
      continue
    }
    if (el.scrollHeight > el.clientHeight + 1) next.add(id)
  }
  overflowing.value = next
}

function toggle(id) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const listEl = ref(null)

onMounted(() => {
  nextTick(measure)
  if (typeof ResizeObserver !== 'undefined' && listEl.value) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(listEl.value)
  }
})

onBeforeUnmount(() => resizeObserver?.disconnect())

watch(
  () => props.announcements,
  () => nextTick(measure),
  { deep: true },
)

function expiryTone(ann) {
  if (isAnnouncementExpired(ann)) return 'expired'
  const days = calendarDaysUntil(ann.expiresAt)
  if (days != null && days <= 7) return 'soon'
  return 'ok'
}

function bodyId(ann) {
  return `ann-body-${ann.id}`
}
</script>

<template>
  <ul ref="listEl" class="annl" role="list" :aria-label="t('information.listAria')">
    <li v-for="ann in announcements" :key="ann.id" class="annl__item">
      <article
        class="annl-card"
        :class="{ 'is-expired': isAnnouncementExpired(ann) }"
        :aria-labelledby="`ann-title-${ann.id}`"
      >
        <div class="annl-card__top">
          <span class="annl-pill" :class="`annl-pill--${normalizePriority(ann.priority)}`">
            <i :class="PRIORITY_META[normalizePriority(ann.priority)].icon" aria-hidden="true" />
            {{ priorityLabel(ann.priority) }}
          </span>
          <span v-if="ann.expiresAt" class="annl-pill annl-pill--time" :class="`is-${expiryTone(ann)}`">
            <i
              class="pi"
              :class="expiryTone(ann) === 'expired' ? 'pi-history' : 'pi-clock'"
              aria-hidden="true"
            />
            {{ expiryLabel(ann) }}
          </span>
        </div>

        <h3 :id="`ann-title-${ann.id}`" class="annl-card__title">{{ ann.title }}</h3>

        <div class="annl-card__content">
          <p
            :id="bodyId(ann)"
            :ref="(el) => setBodyEl(ann.id, el)"
            class="annl-card__body"
            :class="{ 'is-clamped': !expanded.has(ann.id) }"
          >{{ ann.body }}</p>
          <button
            v-if="overflowing.has(ann.id)"
            type="button"
            class="annl-more"
            :aria-expanded="expanded.has(ann.id) ? 'true' : 'false'"
            :aria-controls="bodyId(ann)"
            @click="toggle(ann.id)"
          >
            {{ expanded.has(ann.id) ? t('information.seeLess') : t('information.seeMore') }}
            <i class="pi" :class="expanded.has(ann.id) ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true" />
          </button>
        </div>

        <footer class="annl-card__foot">
          <div class="annl-author">
            <span class="annl-avatar" aria-hidden="true">
              {{ initialsOf(ann.authorName || t('information.authorFallback')) }}
            </span>
            <div class="annl-author__text">
              <strong>{{ ann.authorName || t('information.authorFallback') }}</strong>
              <time
                v-if="ann.publishedAt || ann.createdAt"
                :datetime="ann.publishedAt || ann.createdAt"
                :title="formatDateTime(ann.publishedAt || ann.createdAt)"
              >
                {{ t('information.publishedOn', { date: formatDate(ann.publishedAt || ann.createdAt) }) }}
              </time>
            </div>
          </div>
          <div v-if="canEdit || canDelete" class="annl-actions">
            <button
              v-if="canEdit"
              type="button"
              class="annl-action"
              :aria-label="t('information.editAria', { title: ann.title })"
              :data-tip="t('information.edit')"
              @click="emit('edit', ann)"
            >
              <i class="pi pi-pencil" aria-hidden="true" />
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="annl-action annl-action--danger"
              :aria-label="t('information.deleteAria', { title: ann.title })"
              :data-tip="t('information.delete')"
              @click="emit('delete', ann)"
            >
              <i class="pi pi-trash" aria-hidden="true" />
            </button>
          </div>
        </footer>
      </article>
    </li>
  </ul>
</template>

<style scoped>
.annl {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 21rem), 1fr));
  gap: 0.9rem;
}

.annl *,
.annl *::before,
.annl *::after {
  box-sizing: border-box;
}

.annl__item {
  min-width: 0;
}

.annl-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem 1.1rem 0.9rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.annl-card.is-expired {
  background: #fbfcfd;
}

.annl-card.is-expired .annl-card__title,
.annl-card.is-expired .annl-card__body {
  color: #64748b;
}

.annl-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.annl-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.annl-pill .pi {
  font-size: 0.68rem;
}

.annl-pill--urgent { background: #fde4e4; color: #b42318; }
.annl-pill--important { background: #fdf3dc; color: #92400e; }
.annl-pill--normal { background: #e8eefc; color: #1e3a8a; }

.annl-pill--time.is-ok { background: #e3f4e8; color: #15803d; }
.annl-pill--time.is-soon { background: #fdeee2; color: #c2410c; }
.annl-pill--time.is-expired { background: #f1f5f9; color: #64748b; }

.annl-card__title {
  margin: 0.1rem 0 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.02rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.3;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.annl-card__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  min-width: 0;
}

.annl-card__body {
  margin: 0;
  width: 100%;
  font-size: 0.86rem;
  line-height: 1.5;
  color: #334155;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.annl-card__body.is-clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
}

.annl-more {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0;
  border: none;
  background: none;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.annl-more .pi {
  font-size: 0.65rem;
}

.annl-more:hover {
  text-decoration: underline;
}

.annl-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding-top: 0.7rem;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.annl-author {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.annl-avatar {
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  background: #e8eefc;
  color: #1e3a8a;
}

.annl-author__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.annl-author__text strong {
  font-size: 0.8rem;
  font-weight: 650;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.annl-author__text time {
  font-size: 0.72rem;
  color: #6e6e73;
}

.annl-actions {
  display: inline-flex;
  gap: 0.2rem;
  flex-shrink: 0;
}

.annl-action {
  position: relative;
  width: 2.1rem;
  height: 2.1rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #1e3a8a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.85rem;
}

.annl-action:hover {
  background: #e8eefc;
}

.annl-action--danger {
  color: #b42318;
}

.annl-action--danger:hover {
  background: #fde4e4;
}

.annl-action[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 0.35rem);
  left: 50%;
  transform: translateX(-50%);
  padding: 0.25rem 0.55rem;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 2;
}

.annl-action[data-tip]:hover::after,
.annl-action[data-tip]:focus-visible::after {
  opacity: 1;
}

.annl-action:focus-visible,
.annl-more:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .annl {
    gap: 0.7rem;
  }
  .annl-card {
    padding: 0.9rem 0.95rem 0.8rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .annl-action[data-tip]::after {
    transition: none;
  }
}
</style>
