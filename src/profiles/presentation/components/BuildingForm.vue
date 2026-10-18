<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildingFieldErrors, buildingsApi } from '@/profiles/infrastructure/buildingsApi.js'

/**
 * Condominium registration form (US015). Name and address are required: empty fields are
 * highlighted in red and the form is not sent (US015 sc. 2). Server-side 400 field errors (TS001)
 * are mapped back onto the same fields.
 */
const props = defineProps({
  /** Existing building to edit; null = create. */
  building: { type: Object, default: null },
  submitLabel: { type: String, default: '' },
  showSkip: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['saved', 'skip'])
const { t } = useI18n()

const MAX_DEPARTMENTS = 5000
const uid = `bf-building-${Math.random().toString(36).slice(2, 8)}`

const form = reactive({ name: '', address: '', departmentCount: '' })
const touched = reactive({ name: false, address: false, departmentCount: false })
const serverErrors = ref({})
const submitError = ref('')
const isSaving = ref(false)
const nameInput = ref(null)
const addressInput = ref(null)
const countInput = ref(null)

watch(
  () => props.building,
  (b) => {
    form.name = b?.name ?? ''
    form.address = b?.address ?? ''
    form.departmentCount = b?.departmentCount ? String(b.departmentCount) : ''
  },
  { immediate: true },
)

const clientErrors = computed(() => {
  const errors = {}
  if (!form.name.trim()) errors.name = t('buildings.errors.nameRequired')
  else if (form.name.trim().length > 200) errors.name = t('buildings.errors.nameTooLong')
  if (!form.address.trim()) errors.address = t('buildings.errors.addressRequired')
  else if (form.address.trim().length > 500) errors.address = t('buildings.errors.addressTooLong')
  const count = Number(form.departmentCount)
  if (String(form.departmentCount).trim() === '') errors.departmentCount = t('buildings.errors.departmentsRequired')
  else if (!Number.isInteger(count) || count < 1 || count > MAX_DEPARTMENTS) {
    errors.departmentCount = t('buildings.errors.departmentsRange', { max: MAX_DEPARTMENTS })
  }
  return errors
})

const isValid = computed(() => Object.keys(clientErrors.value).length === 0)

function fieldError(field) {
  if (serverErrors.value[field]) return serverErrors.value[field]
  return touched[field] ? clientErrors.value[field] ?? '' : ''
}

function onInput(field) {
  touched[field] = true
  if (serverErrors.value[field]) {
    const next = { ...serverErrors.value }
    delete next[field]
    serverErrors.value = next
  }
}

async function focusFirstInvalid() {
  await nextTick()
  const order = [
    ['name', nameInput],
    ['address', addressInput],
    ['departmentCount', countInput],
  ]
  for (const [field, el] of order) {
    if (fieldError(field)) {
      el.value?.focus()
      return
    }
  }
}

async function onSubmit() {
  if (isSaving.value) return
  submitError.value = ''
  touched.name = true
  touched.address = true
  touched.departmentCount = true
  if (!isValid.value) {
    await focusFirstInvalid()
    return
  }

  isSaving.value = true
  serverErrors.value = {}
  try {
    const payload = {
      name: form.name,
      address: form.address,
      departmentCount: Number(form.departmentCount),
    }
    const saved = props.building?.id
      ? await buildingsApi.update(props.building.id, payload)
      : await buildingsApi.create(payload)
    emit('saved', saved)
  } catch (error) {
    if (error?.status === 400) {
      serverErrors.value = buildingFieldErrors(error)
      if (!Object.keys(serverErrors.value).length) submitError.value = t('buildings.errors.generic')
      await focusFirstInvalid()
    } else if (error?.code === 'BUILDING_ALREADY_REGISTERED') {
      submitError.value = t('buildings.errors.alreadyRegistered')
    } else if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      submitError.value = t('buildings.errors.network')
    } else {
      submitError.value = t('buildings.errors.generic')
    }
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <form class="bf-building-form" :class="{ 'bf-building-form--compact': compact }" novalidate @submit.prevent="onSubmit">
    <div class="bf-building-form__field" :class="{ 'is-invalid': fieldError('name') }">
      <label :for="`${uid}-name`">
        {{ t('buildings.form.name') }} <span class="bf-building-form__req" aria-hidden="true">*</span>
      </label>
      <input
        :id="`${uid}-name`"
        ref="nameInput"
        v-model="form.name"
        type="text"
        maxlength="200"
        autocomplete="organization"
        required
        :placeholder="t('buildings.form.namePlaceholder')"
        :aria-invalid="Boolean(fieldError('name'))"
        :aria-describedby="fieldError('name') ? `${uid}-name-error` : undefined"
        :disabled="isSaving"
        @input="onInput('name')"
        @blur="touched.name = true"
      />
      <p v-if="fieldError('name')" :id="`${uid}-name-error`" class="bf-building-form__error" role="alert">
        {{ fieldError('name') }}
      </p>
    </div>

    <div class="bf-building-form__field" :class="{ 'is-invalid': fieldError('address') }">
      <label :for="`${uid}-address`">
        {{ t('buildings.form.address') }} <span class="bf-building-form__req" aria-hidden="true">*</span>
      </label>
      <input
        :id="`${uid}-address`"
        ref="addressInput"
        v-model="form.address"
        type="text"
        maxlength="500"
        autocomplete="street-address"
        required
        :placeholder="t('buildings.form.addressPlaceholder')"
        :aria-invalid="Boolean(fieldError('address'))"
        :aria-describedby="fieldError('address') ? `${uid}-address-error` : undefined"
        :disabled="isSaving"
        @input="onInput('address')"
        @blur="touched.address = true"
      />
      <p v-if="fieldError('address')" :id="`${uid}-address-error`" class="bf-building-form__error" role="alert">
        {{ fieldError('address') }}
      </p>
    </div>

    <div class="bf-building-form__field" :class="{ 'is-invalid': fieldError('departmentCount') }">
      <label :for="`${uid}-count`">
        {{ t('buildings.form.departmentCount') }} <span class="bf-building-form__req" aria-hidden="true">*</span>
      </label>
      <input
        :id="`${uid}-count`"
        ref="countInput"
        v-model="form.departmentCount"
        type="number"
        inputmode="numeric"
        min="1"
        :max="MAX_DEPARTMENTS"
        step="1"
        required
        :placeholder="t('buildings.form.departmentCountPlaceholder')"
        :aria-invalid="Boolean(fieldError('departmentCount'))"
        :aria-describedby="fieldError('departmentCount') ? `${uid}-count-error` : `${uid}-count-hint`"
        :disabled="isSaving"
        @input="onInput('departmentCount')"
        @blur="touched.departmentCount = true"
      />
      <p v-if="fieldError('departmentCount')" :id="`${uid}-count-error`" class="bf-building-form__error" role="alert">
        {{ fieldError('departmentCount') }}
      </p>
      <p v-else :id="`${uid}-count-hint`" class="bf-building-form__hint">{{ t('buildings.form.departmentCountHint') }}</p>
    </div>

    <p class="bf-building-form__required-note">{{ t('buildings.form.requiredNote') }}</p>
    <p v-if="submitError" class="bf-building-form__submit-error" role="alert">{{ submitError }}</p>

    <div class="bf-building-form__actions">
      <button
        v-if="showSkip"
        type="button"
        class="bf-building-form__skip"
        :disabled="isSaving"
        @click="emit('skip')"
      >
        {{ t('buildings.form.skip') }}
      </button>
      <button
        type="submit"
        class="bf-building-form__submit"
        :class="{ 'is-blocked': !isValid }"
        :aria-disabled="!isValid || isSaving"
        :disabled="isSaving"
      >
        <i v-if="isSaving" class="pi pi-spin pi-spinner" aria-hidden="true" />
        {{ isSaving ? t('buildings.form.saving') : submitLabel || t('buildings.form.submit') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.bf-building-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  text-align: left;
}

.bf-building-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.bf-building-form__field label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
}

.bf-building-form__req {
  color: #d70015;
}

.bf-building-form__field input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.65rem 0.8rem;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.16);
  font-size: 0.9375rem;
  background: #fff;
  color: var(--apple-text, #1d1d1f);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.bf-building-form__field input:focus {
  outline: none;
  border-color: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.18);
}

.bf-building-form__field.is-invalid input {
  border-color: #d70015;
  background: #fff6f6;
  box-shadow: 0 0 0 3px rgba(215, 0, 21, 0.12);
}

.bf-building-form__field.is-invalid label {
  color: #b42318;
}

.bf-building-form__error {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 500;
  color: #b42318;
}

.bf-building-form__hint,
.bf-building-form__required-note {
  margin: 0;
  font-size: 0.75rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.bf-building-form__submit-error {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 10px;
  background: #fff4f2;
  color: #b42318;
  font-size: 0.8125rem;
}

.bf-building-form__actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.bf-building-form__submit,
.bf-building-form__skip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.65rem 1.25rem;
  border-radius: 980px;
  font-size: 0.875rem;
  font-weight: 600;
  border: none;
  cursor: pointer;
}

.bf-building-form__submit {
  background: #0a84ff;
  color: #fff;
}

.bf-building-form__submit.is-blocked {
  opacity: 0.55;
}

.bf-building-form__submit:disabled {
  opacity: 0.55;
  cursor: progress;
}

.bf-building-form__skip {
  background: rgba(0, 0, 0, 0.05);
  color: var(--apple-text, #1d1d1f);
}

@media (max-width: 480px) {
  .bf-building-form__actions {
    flex-direction: column-reverse;
  }

  .bf-building-form__submit,
  .bf-building-form__skip {
    width: 100%;
  }
}
</style>
