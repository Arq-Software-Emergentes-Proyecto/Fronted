<script setup>
import { computed, ref } from 'vue'
import { ANNOUNCEMENT_DURATIONS } from '@/communications/domain/model/announcementConstants.js'
import {
  PRIORITY_META,
  normalizePriority,
  projectedExpiry,
  useAnnouncementFormat,
} from '../composables/useAnnouncementFormat.js'

const props = defineProps({
  /** Announcement being edited; null/undefined = create a new one. */
  announcement: { type: Object, default: null },
  /** Author shown in the preview for a new announcement. */
  authorName: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  /** Server error from publish / update (shown inside the dialog). */
  error: { type: String, default: '' },
})

const emit = defineEmits(['submit'])

const { t, formatDate, priorityLabel } = useAnnouncementFormat()

const isEdit = computed(() => Boolean(props.announcement?.id))
const initialDuration = Number(props.announcement?.duration) || 7

const title = ref(props.announcement?.title ?? '')
const body = ref(props.announcement?.body ?? '')
const priority = ref(normalizePriority(props.announcement?.priority))
const duration = ref(isEdit.value ? initialDuration : 7)
/** RNF003: highlight the empty required fields after a submit attempt. */
const submitAttempted = ref(false)
const titleInvalid = computed(() => submitAttempted.value && !title.value.trim())
const bodyInvalid = computed(() => submitAttempted.value && !body.value.trim())
const TITLE_MAX = 120

const priorities = ['urgent', 'important', 'normal'].map((id) => ({ id, ...PRIORITY_META[id] }))

/** 7 / 15 / 30 days; when editing a post with another duration, keep it selectable as "current". */
const durations = computed(() => {
  const base = [...ANNOUNCEMENT_DURATIONS]
  if (isEdit.value && !base.includes(initialDuration)) base.unshift(initialDuration)
  return base
})

function durationLabel(days) {
  if (isEdit.value && days === initialDuration && !ANNOUNCEMENT_DURATIONS.includes(days)) {
    return t('information.durationCurrent', { n: days }, days)
  }
  if (days === 7) return t('information.duration7')
  if (days === 15) return t('information.duration15')
  return t('information.duration30')
}

/** Expiry start: the server counts from the original publish date when editing. */
const expiryStart = computed(() =>
  isEdit.value ? props.announcement.publishedAt || props.announcement.createdAt || null : null,
)
const previewExpiry = computed(() => projectedExpiry(expiryStart.value, duration.value))
const previewExpired = computed(() => Boolean(previewExpiry.value && previewExpiry.value <= new Date()))
const previewAuthor = computed(
  () => props.announcement?.authorName || props.authorName || t('information.authorFallback'),
)

/** The required-fields message clears as soon as both fields are filled in. */
const shownError = computed(() =>
  titleInvalid.value || bodyInvalid.value ? t('information.requiredFields') : props.error,
)

function submit() {
  if (props.saving) return
  submitAttempted.value = true
  if (!title.value.trim() || !body.value.trim()) return
  emit('submit', {
    title: title.value.trim(),
    body: body.value.trim(),
    priority: priority.value,
    duration: duration.value,
  })
}

defineExpose({ submit })
</script>

<template>
  <form class="annf" novalidate @submit.prevent="submit">
    <div class="annf__fields">
      <div class="annf__field" :class="{ 'is-invalid': titleInvalid }">
        <div class="annf__label-row">
          <label for="input-announcement-title">{{ t('information.titleLabel') }}</label>
          <span class="annf__count" aria-hidden="true">{{ title.length }}/{{ TITLE_MAX }}</span>
        </div>
        <input
          id="input-announcement-title"
          v-model="title"
          type="text"
          class="annf__input"
          :placeholder="t('information.titlePlaceholder')"
          :maxlength="TITLE_MAX"
          required
          autocomplete="off"
          :disabled="saving"
          :aria-invalid="titleInvalid ? 'true' : 'false'"
          :aria-describedby="titleInvalid ? 'announcement-title-error' : undefined"
        />
        <small v-if="titleInvalid" id="announcement-title-error" class="annf__error-text">
          {{ t('common.fieldRequired') }}
        </small>
      </div>

      <div class="annf__field" :class="{ 'is-invalid': bodyInvalid }">
        <label for="input-announcement-body">{{ t('information.bodyLabel') }}</label>
        <textarea
          id="input-announcement-body"
          v-model="body"
          class="annf__input annf__textarea"
          rows="6"
          :placeholder="t('information.bodyPlaceholder')"
          required
          :disabled="saving"
          :aria-invalid="bodyInvalid ? 'true' : 'false'"
          :aria-describedby="bodyInvalid ? 'announcement-body-error' : undefined"
        />
        <small v-if="bodyInvalid" id="announcement-body-error" class="annf__error-text">
          {{ t('common.fieldRequired') }}
        </small>
      </div>

      <fieldset class="annf__group">
        <legend>{{ t('information.priorityLabel') }}</legend>
        <div class="annf__chips">
          <button
            v-for="item in priorities"
            :key="item.id"
            type="button"
            class="annf-chip"
            :class="[`annf-chip--${item.id}`, { 'is-active': priority === item.id }]"
            :aria-pressed="priority === item.id ? 'true' : 'false'"
            :disabled="saving"
            @click="priority = item.id"
          >
            <i :class="item.icon" aria-hidden="true" />
            {{ t(item.labelKey) }}
          </button>
        </div>
      </fieldset>

      <fieldset class="annf__group">
        <legend>{{ t('information.durationLabel') }}</legend>
        <div class="annf__chips">
          <button
            v-for="days in durations"
            :key="days"
            type="button"
            class="annf-chip"
            :class="{ 'is-active': duration === days }"
            :aria-pressed="duration === days ? 'true' : 'false'"
            :disabled="saving"
            @click="duration = days"
          >
            <i class="pi pi-clock" aria-hidden="true" />
            {{ durationLabel(days) }}
          </button>
        </div>
        <p class="annf__hint">
          {{
            isEdit && expiryStart
              ? t('information.editDurationHint', { date: formatDate(expiryStart) })
              : t('information.durationHint')
          }}
        </p>
      </fieldset>

      <p v-if="shownError" class="annf__error" role="alert">{{ shownError }}</p>
    </div>

    <aside class="annf__preview" :aria-label="t('information.previewTitle')">
      <div class="annf__preview-head">
        <span class="annf__preview-title">
          <i class="pi pi-eye" aria-hidden="true" />
          {{ t('information.previewTitle') }}
        </span>
        <span class="annf__preview-hint">{{ t('information.previewHint') }}</span>
      </div>

      <article class="annf-card" aria-live="polite">
        <span class="annf-pill" :class="`annf-pill--${priority}`">
          <i :class="PRIORITY_META[priority].icon" aria-hidden="true" />
          {{ priorityLabel(priority) }}
        </span>
        <h3 class="annf-card__title" :class="{ 'is-placeholder': !title.trim() }">
          {{ title.trim() || t('information.titlePlaceholder') }}
        </h3>
        <p class="annf-card__body" :class="{ 'is-placeholder': !body.trim() }">{{ body.trim() || t('information.previewBodyPlaceholder') }}</p>
        <footer class="annf-card__meta">
          <span><i class="pi pi-user" aria-hidden="true" />{{ previewAuthor }}</span>
          <span v-if="previewExpiry" :class="{ 'is-expired': previewExpired }">
            <i class="pi pi-calendar" aria-hidden="true" />
            {{
              previewExpired
                ? t('information.expiredOn', { date: formatDate(previewExpiry) })
                : t('information.expiresOnDate', { date: formatDate(previewExpiry) })
            }}
          </span>
        </footer>
      </article>

      <p v-if="previewExpired" class="annf__warn">
        <i class="pi pi-info-circle" aria-hidden="true" />
        {{ t('information.previewExpiredNote') }}
      </p>
    </aside>
  </form>
</template>

<style scoped>
.annf {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
}

.annf *,
.annf *::before,
.annf *::after {
  box-sizing: border-box;
}

.annf__fields {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  min-width: 0;
}

.annf__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.annf__label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.annf__field label,
.annf__group legend {
  padding: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
}

.annf__count {
  font-size: 0.7rem;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.annf__input {
  width: 100%;
  min-height: 2.6rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.9rem;
  color: #0f172a;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.annf__textarea {
  min-height: 8.5rem;
  resize: vertical;
  line-height: 1.5;
}

.annf__input::placeholder {
  color: #94a3b8;
}

.annf__input:focus {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.annf__input:disabled {
  background: #f8fafc;
}

.annf__field.is-invalid .annf__input {
  border-color: #b42318;
}

.annf__error-text {
  font-size: 0.75rem;
  color: #b42318;
}

.annf__group {
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}

.annf__group legend {
  margin-bottom: 0.45rem;
}

.annf__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.annf-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.2rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 999px;
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.annf-chip .pi {
  font-size: 0.75rem;
}

.annf-chip:hover:not(.is-active):not(:disabled) {
  background: #f1f5f9;
}

.annf-chip.is-active {
  background: #1e3a8a;
  border-color: #1e3a8a;
  color: #fff;
}

.annf-chip--urgent.is-active {
  background: #fde4e4;
  border-color: #b42318;
  color: #b42318;
}

.annf-chip--important.is-active {
  background: #fdf3dc;
  border-color: #b45309;
  color: #92400e;
}

.annf-chip--normal.is-active {
  background: #e8eefc;
  border-color: #1e3a8a;
  color: #1e3a8a;
}

.annf-chip:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.annf-chip:disabled {
  cursor: default;
  opacity: 0.7;
}

.annf__hint {
  margin: 0.45rem 0 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: #6e6e73;
}

.annf__error {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-radius: 12px;
  background: #fde4e4;
  color: #7f1d1d;
  font-size: 0.8rem;
}

/* ---------- Live preview ---------- */
.annf__preview {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.9rem;
  border-radius: 16px;
  background: #f8fafc;
  border: 1px solid rgba(15, 23, 42, 0.06);
  min-width: 0;
  position: sticky;
  top: 0;
}

.annf__preview-head {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.annf__preview-title {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  font-weight: 650;
  color: #0f172a;
}

.annf__preview-title .pi {
  font-size: 0.78rem;
  color: #1e3a8a;
}

.annf__preview-hint {
  font-size: 0.74rem;
  color: #6e6e73;
}

.annf-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 1rem 1.05rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  min-width: 0;
}

.annf-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.65rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.annf-pill .pi {
  font-size: 0.68rem;
}

.annf-pill--urgent { background: #fde4e4; color: #b42318; }
.annf-pill--important { background: #fdf3dc; color: #92400e; }
.annf-pill--normal { background: #e8eefc; color: #1e3a8a; }

.annf-card__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.3;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.annf-card__body {
  margin: 0;
  max-height: 12rem;
  overflow: auto;
  font-size: 0.85rem;
  line-height: 1.5;
  color: #334155;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.annf-card__title.is-placeholder,
.annf-card__body.is-placeholder {
  color: #94a3b8;
}

.annf-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.9rem;
  padding-top: 0.55rem;
  width: 100%;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  font-size: 0.74rem;
  color: #6e6e73;
}

.annf-card__meta span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.annf-card__meta .pi {
  font-size: 0.7rem;
}

.annf-card__meta .is-expired {
  color: #b42318;
  font-weight: 600;
}

.annf__warn {
  display: flex;
  gap: 0.45rem;
  margin: 0;
  padding: 0.55rem 0.7rem;
  border-radius: 12px;
  background: #fdf3dc;
  color: #92400e;
  font-size: 0.76rem;
  line-height: 1.4;
}

.annf__warn .pi {
  margin-top: 0.12rem;
  font-size: 0.75rem;
}

@media (max-width: 760px) {
  .annf {
    grid-template-columns: minmax(0, 1fr);
  }
  .annf__preview {
    position: static;
  }
}

@media (prefers-reduced-motion: reduce) {
  .annf__input {
    transition: none;
  }
}
</style>
