<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { Incident } from '@/incidents/domain/model/incident.entity.js'
import IncidentTimeline from './IncidentTimeline.vue'
import {
  formatIncidentWhen,
  incidentPriorityLabel,
  incidentStatusLabel,
} from '../incidentLabels.js'

/**
 * Detalle de una incidencia para el residente (RNF010 / US031): estado, técnico asignado
 * (nombre, teléfono, especialidad), detalle de cierre y timeline con comentarios de seguimiento.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  incidentId: { type: String, default: '' },
  /** Versión del registro (updatedAt) para recargar cuando llega un evento en tiempo real. */
  refreshKey: { type: [String, Number], default: '' },
})
const emit = defineEmits(['close', 'updated'])

const { t, locale } = useI18n()
const incident = ref(null)
const loading = ref(false)
const error = ref('')
const comment = ref('')
const sending = ref(false)

const events = computed(() => incident.value?.events ?? [])

async function load() {
  if (!props.open || !props.incidentId) return
  loading.value = true
  error.value = ''
  try {
    incident.value = new Incident(await incidentsApi.get(props.incidentId))
  } catch {
    error.value = t('incidentFlow.detailLoadError')
  } finally {
    loading.value = false
  }
}

watch(() => [props.open, props.incidentId, props.refreshKey], load, { immediate: true })

/** Move focus into the dialog so Escape / Tab work right after opening (a11y). */
const closeBtnRef = ref(null)
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    await nextTick()
    closeBtnRef.value?.focus()
  },
  { immediate: true },
)

async function sendComment() {
  const text = comment.value.trim()
  if (!text || sending.value || !incident.value) return
  sending.value = true
  error.value = ''
  try {
    incident.value = new Incident(await incidentsApi.addComment(incident.value.id, text))
    comment.value = ''
    emit('updated', incident.value)
  } catch (err) {
    error.value = err?.payload?.message || t('app.incidentsSaveError')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="idd-overlay" @click.self="emit('close')">
      <div
        class="idd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="idd-title"
        @keydown.esc="emit('close')"
      >
        <header class="idd-head">
          <h2 id="idd-title" class="idd-title">{{ incident?.title || t('incidentFlow.detailTitle') }}</h2>
          <button ref="closeBtnRef" type="button" class="idd-close" :aria-label="t('information.close')" @click="emit('close')">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>

        <p v-if="loading && !incident" class="idd-muted">{{ t('app.incidentsLoading') }}</p>
        <p v-if="error" class="idd-error" role="alert">{{ error }}</p>

        <div v-if="incident" class="idd-body">
          <div class="idd-badges">
            <span class="inc-badge" :class="`inc-badge--${incident.status}`">
              {{ incidentStatusLabel(t, incident.status) }}
            </span>
            <span v-if="incident.priority" class="idd-chip">
              {{ incidentPriorityLabel(t, incident.priority) }}
            </span>
            <span v-if="incident.category" class="idd-chip">{{ incident.category }}</span>
            <time v-if="incident.createdAt" class="idd-muted" :datetime="incident.createdAt">
              {{ formatIncidentWhen(locale, incident.createdAt) }}
            </time>
          </div>

          <p class="idd-description">{{ incident.description }}</p>

          <section class="idd-block" aria-labelledby="idd-provider">
            <h3 id="idd-provider" class="idd-block__title">{{ t('incidentFlow.assignedTech') }}</h3>
            <template v-if="incident.provider">
              <p class="idd-provider__name"><i class="pi pi-wrench" aria-hidden="true" /> {{ incident.provider }}</p>
              <p v-if="incident.providerSpecialty" class="idd-muted">
                {{ t('incidentFlow.providerSpecialty') }}: {{ incident.providerSpecialty }}
              </p>
              <p v-if="incident.providerPhone" class="idd-muted">
                {{ t('incidentFlow.providerPhone') }}:
                <a :href="`tel:${incident.providerPhone}`">{{ incident.providerPhone }}</a>
              </p>
            </template>
            <p v-else class="idd-muted">{{ t('app.noProviderAssigned') }}</p>
          </section>

          <section v-if="incident.resolutionComment" class="idd-block idd-block--resolved" aria-labelledby="idd-resolution">
            <h3 id="idd-resolution" class="idd-block__title">{{ t('incidentFlow.resolutionTitle') }}</h3>
            <p class="idd-description">{{ incident.resolutionComment }}</p>
            <p v-if="incident.resolvedAt" class="idd-muted">
              {{ t('incidentFlow.resolvedAt', { date: formatIncidentWhen(locale, incident.resolvedAt) }) }}
            </p>
          </section>

          <section class="idd-block" aria-labelledby="idd-timeline">
            <h3 id="idd-timeline" class="idd-block__title">{{ t('incidentFlow.timelineTitle') }}</h3>
            <IncidentTimeline :events="events" />
          </section>

          <form class="idd-comment" @submit.prevent="sendComment">
            <label class="idd-comment__label" for="idd-comment-input">{{ t('incidentFlow.commentLabel') }}</label>
            <textarea
              id="idd-comment-input"
              v-model="comment"
              rows="2"
              maxlength="2000"
              :placeholder="t('incidentFlow.commentPlaceholder')"
              :disabled="sending"
            />
            <div class="bf-actions idd-comment__actions">
              <button type="submit" class="bf-btn bf-btn--confirm" :disabled="sending || !comment.trim()">
                {{ t('incidentFlow.commentSend') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.idd-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.35);
}

.idd-dialog {
  width: min(36rem, 100%);
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding: 1.25rem 1.3rem 1.3rem;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}

.idd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.idd-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--apple-text, #1d1d1f);
  word-break: break-word;
}

.idd-close {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--apple-text-secondary, #6e6e73);
}

.idd-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.idd-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.idd-chip {
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  background: #f2f2f7;
  font-size: 0.7rem;
  font-weight: 600;
  color: #3a3a3c;
}

.idd-description {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.idd-muted {
  margin: 0;
  font-size: 0.78rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.idd-error {
  margin: 0;
  font-size: 0.82rem;
  color: #b42318;
}

.idd-block {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.75rem 0.85rem;
  border-radius: 12px;
  background: #f9f9fb;
  border: 1px solid rgba(0, 0, 0, 0.05);
}

.idd-block--resolved {
  background: #f1f8f2;
}

.idd-block__title {
  margin: 0 0 0.2rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--apple-text-secondary, #6e6e73);
}

.idd-provider__name {
  margin: 0;
  font-weight: 600;
  font-size: 0.9rem;
}

.idd-comment {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.idd-comment__label {
  font-size: 0.8125rem;
  font-weight: 600;
}

.idd-comment textarea {
  width: 100%;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 12px;
  font: inherit;
  font-size: 0.88rem;
  resize: vertical;
  outline: none;
}

.idd-comment textarea:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
}

.idd-comment__actions {
  justify-content: flex-end;
}

.inc-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 980px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.inc-badge--open { background: #fff3e0; color: #e65100; }
.inc-badge--in-progress { background: #e8f1fc; color: #0071e3; }
.inc-badge--resolved { background: #e8f5e9; color: #1b7a3d; }
</style>
