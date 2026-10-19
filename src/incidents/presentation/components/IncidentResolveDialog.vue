<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import '../incidentDialog.css'

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

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    comment.value = ''
    touched.value = false
  },
)

function onVisible(open) {
  if (!open && !props.busy) emit('cancel')
}

function confirm() {
  touched.value = true
  const text = comment.value.trim()
  if (!text || props.busy) return
  emit('confirm', text)
}
</script>

<template>
  <Dialog
    :visible="open"
    modal
    :header="t('incidentFlow.resolveModalTitle')"
    class="inc-dialog"
    :style="{ width: 'min(30rem, 94vw)' }"
    :draggable="false"
    :closable="!busy"
    @update:visible="onVisible"
  >
    <div class="incd-form">
      <p v-if="incidentTitle" class="incd-note">
        <i class="pi pi-flag" aria-hidden="true" />
        <span>{{ incidentTitle }}</span>
      </p>
      <p class="incd-hint">{{ t('incidentFlow.resolveModalHint') }}</p>
      <div class="incd-field">
        <label for="ird-comment">{{ t('incidentFlow.resolutionCommentLabel') }} *</label>
        <textarea
          id="ird-comment"
          autofocus
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
        <p v-if="touched && !comment.trim()" id="ird-comment-error" class="incd-field__error" role="alert">
          {{ t('incidentFlow.resolutionCommentRequired') }}
        </p>
      </div>
      <p v-if="serverError" class="incd-alert" role="alert">{{ serverError }}</p>
    </div>
    <template #footer>
      <ConfirmActions
        :cancel-label="t('app.cancelAction')"
        :confirm-label="t('incidentFlow.resolveConfirm')"
        confirm-icon="pi pi-check"
        :loading="busy"
        :disabled="!comment.trim()"
        @cancel="emit('cancel')"
        @confirm="confirm"
      />
    </template>
  </Dialog>
</template>
