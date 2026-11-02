<script setup>
import { useI18n } from 'vue-i18n'

/**
 * RNF012: clear message + "Retry" when a main data load fails.
 * Emits `retry`; pass `loading` while the reload is in flight to disable the button.
 */
defineProps({
  /** Message shown under the title (defaults to the generic load error). */
  message: { type: String, default: '' },
  /** Optional heading; set `compact` to hide it in tight cards. */
  title: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['retry'])
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <div class="bf-load-error" :class="{ 'bf-load-error--compact': compact }" role="alert">
    <i class="pi pi-exclamation-circle bf-load-error__icon" aria-hidden="true" />
    <div class="bf-load-error__text">
      <p v-if="!compact" class="bf-load-error__title">{{ title || t('common.loadErrorTitle') }}</p>
      <p class="bf-load-error__body">{{ message || t('common.loadErrorBody') }}</p>
    </div>
    <button type="button" class="bf-load-error__retry" :disabled="loading" @click="emit('retry')">
      <i class="pi pi-refresh" :class="{ 'pi-spin': loading }" aria-hidden="true" />
      {{ loading ? t('common.retrying') : t('common.retry') }}
    </button>
  </div>
</template>

<style scoped>
.bf-load-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.65rem 0.85rem;
  margin: 0 0 1rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  border: 1px solid rgba(180, 35, 24, 0.22);
  background: #fef3f2;
  color: #7a271a;
  text-align: left;
}

.bf-load-error--compact {
  padding: 0.6rem 0.8rem;
  border-radius: 12px;
}

.bf-load-error__icon {
  flex-shrink: 0;
  font-size: 1.15rem;
  color: #b42318;
}

.bf-load-error__text {
  flex: 1 1 12rem;
  min-width: 0;
}

.bf-load-error__title {
  margin: 0 0 0.15rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: #7a271a;
}

.bf-load-error__body {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #912018;
}

.bf-load-error__retry {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
  min-height: 2.25rem;
  padding: 0.4rem 0.95rem;
  border: 1px solid #b42318;
  border-radius: 999px;
  background: #ffffff;
  color: #b42318;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.bf-load-error__retry:hover:not(:disabled) {
  background: #b42318;
  color: #ffffff;
}

.bf-load-error__retry:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.bf-load-error__retry:disabled {
  opacity: 0.6;
  cursor: progress;
}
</style>
