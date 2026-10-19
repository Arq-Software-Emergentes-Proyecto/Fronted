<script setup>
import { useI18n } from 'vue-i18n'
import { formatIncidentWhen, incidentEventLabel } from '../incidentLabels.js'
import { IncidentEventType } from '@/incidents/domain/model/incidentConstants.js'
import { isFresh } from '@/shared/presentation/feedback/successFeedback.js'

/** Historial de la incidencia (RNF010): estado, asignaciones, comentarios y cierre. */
defineProps({
  events: { type: Array, default: () => [] },
})

const { t, locale } = useI18n()

function authorLabel(ev) {
  if (ev.authorName) return ev.authorName
  if (ev.authorRole === 'admin') return t('incidentFlow.authorAdmin')
  if (ev.authorRole === 'resident') return t('incidentFlow.authorResident')
  return t('incidentFlow.authorSystem')
}

function showComment(ev) {
  return ev.comment && ev.type !== IncidentEventType.ASSIGNED
}
</script>

<template>
  <p v-if="!events.length" class="itl__empty">{{ t('incidentFlow.noEventsYet') }}</p>
  <ol v-else class="itl" role="list">
    <li
      v-for="ev in events"
      :key="ev.id"
      class="itl__item"
      :class="[`itl__item--${ev.type}`, { 'bf-fresh': isFresh('incidentEvent', ev.id) }]"
    >
      <span class="itl__dot" aria-hidden="true" />
      <div class="itl__content">
        <p class="itl__label">{{ incidentEventLabel(t, ev) }}</p>
        <p v-if="showComment(ev)" class="itl__comment">{{ ev.comment }}</p>
        <p class="itl__meta">
          <span>{{ authorLabel(ev) }}</span>
          <time :datetime="ev.createdAt">{{ formatIncidentWhen(locale, ev.createdAt) }}</time>
        </p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.itl {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.itl__item {
  position: relative;
  display: flex;
  gap: 0.7rem;
  padding: 0 0 0.85rem;
}

.itl__item:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 0.3rem;
  top: 0.9rem;
  bottom: 0;
  width: 2px;
  background: #e2e8f0;
}

.itl__dot {
  flex: none;
  width: 0.65rem;
  height: 0.65rem;
  margin-top: 0.3rem;
  border-radius: 50%;
  background: #94a3b8;
  box-shadow: 0 0 0 3px #fff;
}

.itl__item--reported .itl__dot { background: #c2410c; }
.itl__item--assigned .itl__dot,
.itl__item--status_changed .itl__dot { background: #1e3a8a; }
.itl__item--unassigned .itl__dot { background: #b45309; }
.itl__item--resolved .itl__dot { background: #15803d; }
.itl__item--comment .itl__dot { background: #64748b; }

.itl__empty {
  margin: 0;
  font-size: 0.8rem;
  color: #6e6e73;
}

.itl__content {
  min-width: 0;
}

.itl__label {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
}

.itl__comment {
  margin: 0.3rem 0 0;
  padding: 0.45rem 0.65rem;
  border-radius: 10px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  font-size: 0.85rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #334155;
}

.itl__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.6rem;
  margin: 0.15rem 0 0;
  font-size: 0.72rem;
  color: #6e6e73;
}
</style>
