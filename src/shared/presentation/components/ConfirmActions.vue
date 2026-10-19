<script setup>
defineProps({
  cancelLabel: { type: String, default: '' },
  confirmLabel: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  cancelDisabled: { type: Boolean, default: false },
  showCancel: { type: Boolean, default: true },
  showConfirm: { type: Boolean, default: true },
  confirmVariant: {
    type: String,
    default: 'primary',
    validator: (value) => ['primary', 'danger'].includes(value),
  },
  confirmType: { type: String, default: 'button' },
  confirmIcon: { type: String, default: '' },
  cancelIcon: { type: String, default: '' },
  align: {
    type: String,
    default: 'end',
    validator: (value) => ['end', 'center'].includes(value),
  },
  stagger: { type: Boolean, default: true },
})

const emit = defineEmits(['cancel', 'confirm'])
</script>

<template>
  <div
    class="bf-actions"
    :class="{
      'bf-actions--center': align === 'center',
      'bf-actions--stagger': stagger,
    }"
    role="group"
  >
    <button
      v-if="showCancel"
      type="button"
      class="bf-btn bf-btn--cancel"
      :disabled="cancelDisabled || loading"
      @click="emit('cancel')"
    >
      <i v-if="cancelIcon" :class="cancelIcon" aria-hidden="true" />
      <span>{{ cancelLabel }}</span>
    </button>

    <slot v-if="showConfirm" name="confirm">
      <button
        :type="confirmType"
        class="bf-btn"
        :class="confirmVariant === 'danger' ? 'bf-btn--danger' : 'bf-btn--confirm'"
        :disabled="disabled || loading"
        @click="emit('confirm', $event)"
      >
        <span v-if="loading" class="bf-btn__spinner" aria-hidden="true" />
        <i v-else-if="confirmIcon" :class="confirmIcon" aria-hidden="true" />
        <span>{{ confirmLabel }}</span>
      </button>
    </slot>
  </div>
</template>
