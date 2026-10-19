<script setup>
import { useI18n } from 'vue-i18n'
import ConfirmDialog from 'primevue/confirmdialog'
import ConfirmActions from './ConfirmActions.vue'
import { BF_CONFIRM_GROUP } from '../composables/useConfirmDialog.js'

const { t } = useI18n()

const defaultIcon = {
  info: 'pi pi-info-circle',
  success: 'pi pi-check',
  warn: 'pi pi-exclamation-triangle',
  error: 'pi pi-exclamation-circle',
}

function iconFor(message) {
  if (message?.icon) return message.icon
  if (message?.danger) return 'pi pi-trash'
  return defaultIcon[message?.severity] ?? defaultIcon.warn
}

// With a custom container PrimeVue does not move focus into the dialog: start on the safe choice.
const vFocusCancel = {
  mounted: (el) => requestAnimationFrame(() => el.querySelector('.bf-btn--cancel')?.focus()),
}

function toneFor(message) {
  if (message?.danger) return 'danger'
  return message?.severity in defaultIcon ? message.severity : 'warn'
}
</script>

<template>
  <ConfirmDialog
    :group="BF_CONFIRM_GROUP"
    :pt="{ root: { 'aria-labelledby': 'bf-confirm-title', 'aria-describedby': 'bf-confirm-message' } }"
  >
    <template #container="{ message, acceptCallback, rejectCallback }">
      <div v-focus-cancel class="bf-confirm" :class="`bf-confirm--${toneFor(message)}`">
        <div class="bf-confirm__head">
          <span class="bf-confirm__icon" aria-hidden="true"><i :class="iconFor(message)" /></span>
          <div class="bf-confirm__text">
            <h2 id="bf-confirm-title" class="bf-confirm__title">
              {{ message.header || t('common.confirmTitle') }}
            </h2>
            <p v-if="message.message" id="bf-confirm-message" class="bf-confirm__message">
              {{ message.message }}
            </p>
          </div>
        </div>
        <ConfirmActions
          :cancel-label="message.rejectLabel || t('common.confirmCancel')"
          :confirm-label="message.acceptLabel || t('common.confirmAccept')"
          :confirm-variant="message.danger ? 'danger' : 'primary'"
          @cancel="rejectCallback"
          @confirm="acceptCallback"
        />
      </div>
    </template>
  </ConfirmDialog>
</template>
