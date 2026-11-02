<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import { incidentsApi } from '@/incidents/infrastructure/incidentsApi.js'
import { Incident } from '@/incidents/domain/model/incident.entity.js'
import IncidentTimeline from './IncidentTimeline.vue'
import { confirmSuccess, markFresh } from '@/shared/presentation/feedback/successFeedback.js'
import {
  formatIncidentWhen,
  incidentPriorityLabel,
  incidentStatusLabel,
} from '../incidentLabels.js'
import '../incidentDialog.css'

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
  if (incident.value && String(incident.value.id) !== String(props.incidentId)) {
    incident.value = null
    comment.value = ''
  }
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

async function sendComment(event) {
  const text = comment.value.trim()
  if (!text || sending.value || !incident.value) return
  sending.value = true
  error.value = ''
  const before = new Set(events.value.map((ev) => String(ev?.id)))
  try {
    incident.value = new Incident(await incidentsApi.addComment(incident.value.id, text))
    comment.value = ''
    // Como un mensaje: el comentario aparece al instante (sin esperar la animación del botón).
    void confirmSuccess(event, t('feedback.commentSent'))
    for (const ev of events.value) {
      if (ev?.id != null && !before.has(String(ev.id))) markFresh('incidentEvent', ev.id)
    }
    emit('updated', incident.value)
  } catch (err) {
    error.value = err?.payload?.message || t('app.incidentsSaveError')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="open"
    modal
    :header="incident?.title || t('incidentFlow.detailTitle')"
    class="inc-dialog"
    :style="{ width: 'min(36rem, 94vw)' }"
    :draggable="false"
    :dismissable-mask="true"
    @update:visible="(v) => { if (!v) emit('close') }"
  >
    <p v-if="loading && !incident" class="incd-muted" role="status">{{ t('app.incidentsLoading') }}</p>
    <p v-if="error" class="incd-alert" role="alert">{{ error }}</p>

    <div v-if="incident" class="incd-body">
      <div class="incd-meta">
        <span class="inc-pill" :class="`inc-pill--${incident.status}`">
          <span class="inc-pill__dot" aria-hidden="true" />
          {{ incidentStatusLabel(t, incident.status) }}
        </span>
        <span v-if="incident.priority" class="inc-pill" :class="`inc-pill--${incident.priority}`">
          {{ t('incidentFlow.priorityLabel') }}: {{ incidentPriorityLabel(t, incident.priority) }}
        </span>
        <span v-if="incident.category" class="inc-pill inc-pill--soft">{{ incident.category }}</span>
        <time v-if="incident.createdAt" class="incd-muted" :datetime="incident.createdAt">
          {{ t('incidentFlow.reportedOn', { date: formatIncidentWhen(locale, incident.createdAt) }) }}
        </time>
      </div>

      <p class="incd-text">{{ incident.description }}</p>

      <section class="incd-block" aria-labelledby="idd-provider">
        <h3 id="idd-provider" class="incd-block__title">{{ t('incidentFlow.assignedTech') }}</h3>
        <div class="incd-provider">
          <span class="incd-provider__icon" aria-hidden="true"><i class="pi pi-wrench" /></span>
          <div v-if="incident.provider" class="incd-provider__text">
            <p class="incd-provider__name">{{ incident.provider }}</p>
            <p v-if="incident.providerSpecialty" class="incd-muted">
              {{ t('incidentFlow.providerSpecialty') }}: {{ incident.providerSpecialty }}
            </p>
            <p v-if="incident.providerPhone" class="incd-muted">
              {{ t('incidentFlow.providerPhone') }}:
              <a
                :href="`tel:${incident.providerPhone}`"
                :aria-label="t('incidentFlow.callProvider', { name: incident.provider })"
              >{{ incident.providerPhone }}</a>
            </p>
          </div>
          <p v-else class="incd-muted">{{ t('incidentFlow.techPending') }}</p>
        </div>
      </section>

      <section
        v-if="incident.resolutionComment"
        class="incd-block incd-block--resolved"
        aria-labelledby="idd-resolution"
      >
        <h3 id="idd-resolution" class="incd-block__title">{{ t('incidentFlow.resolutionTitle') }}</h3>
        <p class="incd-text">{{ incident.resolutionComment }}</p>
        <p v-if="incident.resolvedAt" class="incd-muted">
          {{ t('incidentFlow.resolvedAt', { date: formatIncidentWhen(locale, incident.resolvedAt) }) }}
        </p>
      </section>

      <section class="incd-block" aria-labelledby="idd-timeline">
        <h3 id="idd-timeline" class="incd-block__title">{{ t('incidentFlow.timelineTitle') }}</h3>
        <IncidentTimeline :events="events" />
      </section>

      <form class="incd-field" @submit.prevent="sendComment">
        <label for="idd-comment-input">{{ t('incidentFlow.commentLabel') }}</label>
        <textarea
          id="idd-comment-input"
          v-model="comment"
          class="incd-textarea--compact"
          rows="2"
          maxlength="2000"
          :placeholder="t('incidentFlow.commentPlaceholder')"
          :disabled="sending"
        />
        <div class="incd-footer incd-footer--end">
          <button
            type="submit"
            class="incd-btn incd-btn--primary"
            :disabled="sending || !comment.trim()"
          >
            <i class="pi" :class="sending ? 'pi-spin pi-spinner' : 'pi-send'" aria-hidden="true" />
            {{ t('incidentFlow.commentSend') }}
          </button>
        </div>
      </form>
    </div>
  </Dialog>
</template>
