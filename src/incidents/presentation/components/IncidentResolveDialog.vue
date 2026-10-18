<script setup>
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * US031: elegir "Resuelto" exige documentar la solución. El botón queda bloqueado
 * y el campo se marca en rojo mientras el comentario esté vacío.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  incidentTitle: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  serverError: { type: String, default: '' },
})
const emit = defineEmits(['confirm', 'cancel'])

const { t } = useI18n()
const comment = ref('')
const touched = ref(false)
const textareaRef = ref(null)

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    comment.value = ''
    touched.value = false
    await nextTick()
    textareaRef.value?.focus()
  },
)

function confirm() {
  touched.value = true
  const text = comment.value.trim()
  if (!text || props.busy) return
  emit('confirm', text)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ird-overlay" @click.self="emit('cancel')">
      <div
        class="ird-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ird-title"
        @keydown.esc="emit('cancel')"
      >
        <header class="ird-head">
          <h2 id="ird-title" class="ird-title">{{ t('incidentFlow.resolveModalTitle') }}</h2>
          <button type="button" class="ird-close" :aria-label="t('information.close')" @click="emit('cancel')">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>
        <p v-if="incidentTitle" class="ird-subject">{{ incidentTitle }}</p>
        <p class="ird-hint">{{ t('incidentFlow.resolveModalHint') }}</p>
        <label class="ird-field" for="ird-comment">
          <span>{{ t('incidentFlow.resolutionCommentLabel') }} *</span>
          <textarea
            id="ird-comment"
            ref="textareaRef"
            v-model="comment"
            rows="4"
            maxlength="2000"
            :class="{ 'is-invalid': touched && !comment.trim() }"
            :aria-invalid="touched && !comment.trim()"
            aria-describedby="ird-comment-error"
            :placeholder="t('incidentFlow.resolutionCommentPlaceholder')"
            :disabled="busy"
            @blur="touched = true"
          />
        </label>
        <p v-if="touched && !comment.trim()" id="ird-comment-error" class="ird-error" role="alert">
          {{ t('incidentFlow.resolutionCommentRequired') }}
        </p>
        <p v-else-if="serverError" class="ird-error" role="alert">{{ serverError }}</p>
        <div class="bf-actions ird-actions">
          <button type="button" class="bf-btn bf-btn--cancel" :disabled="busy" @click="emit('cancel')">
            {{ t('app.cancelAction') }}
          </button>
          <button
            type="button"
            class="bf-btn bf-btn--confirm"
            :disabled="busy || !comment.trim()"
            @click="confirm"
          >
            {{ t('incidentFlow.resolveConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ird-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.35);
}

.ird-dialog {
  width: min(30rem, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem 1.3rem 1.3rem;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}

.ird-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ird-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.ird-close {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--apple-text-secondary, #6e6e73);
}

.ird-subject {
  margin: 0;
  font-weight: 600;
  font-size: 0.9rem;
}

.ird-hint {
  margin: 0;
  font-size: 0.82rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.ird-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
}

.ird-field textarea {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  font: inherit;
  font-weight: 400;
  font-size: 0.9rem;
  resize: vertical;
  outline: none;
}

.ird-field textarea:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.ird-field textarea.is-invalid {
  border-color: #d92d20;
  box-shadow: 0 0 0 3px rgba(217, 45, 32, 0.14);
}

.ird-error {
  margin: -0.35rem 0 0;
  font-size: 0.78rem;
  color: #b42318;
}

.ird-actions {
  justify-content: flex-end;
}
</style>
