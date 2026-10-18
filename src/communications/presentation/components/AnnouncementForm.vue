<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const emit = defineEmits(['submit', 'cancel'])

const title = ref('')
const body = ref('')
const priority = ref('normal')
const duration = ref(7)
const submitting = ref(false)
const error = ref('')

const priorities = [
  { id: 'normal', icon: 'pi pi-megaphone', labelKey: 'information.priorityNormal' },
  { id: 'important', icon: 'pi pi-exclamation-circle', labelKey: 'information.priorityImportant' },
  { id: 'urgent', icon: 'pi pi-exclamation-triangle', labelKey: 'information.priorityUrgent' },
]

const durations = [7, 15, 30]

function durationLabel(days) {
  if (days === 7) return t('information.duration7')
  if (days === 15) return t('information.duration15')
  return t('information.duration30')
}

async function handleSubmit() {
  if (!title.value.trim() || !body.value.trim()) {
    error.value = t('information.requiredFields')
    return
  }
  error.value = ''
  submitting.value = true
  emit('submit', {
    title: title.value.trim(),
    body: body.value.trim(),
    priority: priority.value,
    duration: duration.value,
  })
  submitting.value = false
}
</script>

<template>
  <section class="ann-form" aria-labelledby="ann-form-heading">
    <h2 id="ann-form-heading" class="ann-form__title">{{ t('information.newAnnouncement') }}</h2>

    <label class="ann-form__field" for="input-announcement-title">
      <span>{{ t('information.titleLabel') }}</span>
      <input
        id="input-announcement-title"
        v-model="title"
        type="text"
        :placeholder="t('information.titlePlaceholder')"
        maxlength="120"
        :disabled="submitting"
      />
    </label>

    <label class="ann-form__field" for="input-announcement-body">
      <span>{{ t('information.bodyLabel') }}</span>
      <textarea
        id="input-announcement-body"
        v-model="body"
        rows="6"
        :placeholder="t('information.bodyPlaceholder')"
        :disabled="submitting"
      />
    </label>

    <fieldset class="ann-form__group">
      <legend>{{ t('information.priorityLabel') }}</legend>
      <div class="ann-form__chips" role="group">
        <button
          v-for="item in priorities"
          :key="item.id"
          type="button"
          class="ann-chip"
          :class="{ 'is-active': priority === item.id, [`ann-chip--${item.id}`]: true }"
          @click="priority = item.id"
        >
          <i :class="item.icon" aria-hidden="true" />
          {{ t(item.labelKey) }}
        </button>
      </div>
    </fieldset>

    <fieldset class="ann-form__group">
      <legend>{{ t('information.durationLabel') }}</legend>
      <p class="ann-form__hint">{{ t('information.durationHint') }}</p>
      <div class="ann-form__chips" role="group">
        <button
          v-for="days in durations"
          :key="days"
          type="button"
          class="ann-chip"
          :class="{ 'is-active': duration === days }"
          @click="duration = days"
        >
          <i class="pi pi-clock" aria-hidden="true" />
          {{ durationLabel(days) }}
        </button>
      </div>
    </fieldset>

    <p v-if="error" class="ann-form__error" role="alert">{{ error }}</p>

    <div class="bf-actions">
      <button type="button" class="bf-btn bf-btn--cancel" :disabled="submitting" @click="emit('cancel')">
        {{ t('information.cancel') }}
      </button>
      <button
        type="button"
        class="bf-btn bf-btn--confirm"
        :disabled="submitting || !title.trim() || !body.trim()"
        @click="handleSubmit"
      >
        {{ submitting ? t('information.sending') : t('information.send') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ann-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.ann-form__title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--apple-text, #1d1d1f);
}

.ann-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.ann-form__field input,
.ann-form__field textarea {
  width: 100%;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 0.9375rem;
  font-weight: 400;
  color: var(--apple-text, #1d1d1f);
  outline: none;
}

.ann-form__field textarea {
  min-height: 8rem;
  resize: vertical;
  line-height: 1.5;
}

.ann-form__field input:focus,
.ann-form__field textarea:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.ann-form__group {
  margin: 0;
  padding: 0;
  border: none;
}

.ann-form__group legend {
  padding: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.ann-form__hint {
  margin: 0.3rem 0 0.55rem;
  font-size: 0.78rem;
  font-weight: 400;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.ann-form__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.ann-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.42rem 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 980px;
  background: #f5f5f7;
  color: #4b5563;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.ann-chip:hover {
  color: var(--apple-text, #1d1d1f);
}

.ann-chip.is-active {
  background: #fff;
  color: #0071e3;
  border-color: rgba(0, 113, 227, 0.28);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.ann-chip--urgent.is-active {
  color: #b42318;
  border-color: rgba(180, 35, 24, 0.28);
}

.ann-chip--important.is-active {
  color: #e65100;
  border-color: rgba(230, 81, 0, 0.28);
}

.ann-form__error {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #b42318;
}
</style>
