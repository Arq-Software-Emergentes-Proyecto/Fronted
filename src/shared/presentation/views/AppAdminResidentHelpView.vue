<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'

import { appendAdminMessage, watchAdminChats } from '@/support/infrastructure/realtimeSupportDb.js'
import { useSession, getActiveDataOwnerId } from '@/iam/application/sessionStore.js'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()

const chats = ref([])
const selectedId = ref(null)
const replyText = ref('')
const sending = ref(false)
const loadingList = ref(true)
const loadError = ref('')
const messagesEl = ref(null)

const adminName = computed(() => sessionState.profile?.name ?? '')
const ownerId = computed(() => getActiveDataOwnerId() || sessionState.profile?.id || '')
const selected = computed(() => chats.value.find((row) => row.id === selectedId.value) || null)

function formatWhen(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(locale.value === 'es' ? 'es-PE' : 'en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

function bubbleRole(role) {
  if (role === 'admin') return t('supportAdmin.badgeAdmin')
  if (role === 'resident') return t('supportAdmin.badgeResident')
  if (role === 'assistant' || role === 'ai') return t('supportAdmin.badgeAssistant')
  return role
}

function previewLast(row) {
  const msgs = row.messages
  if (!Array.isArray(msgs) || !msgs.length) return '—'
  const last = msgs[msgs.length - 1]
  return typeof last?.body === 'string' ? last.body : '—'
}

let stopChats = null

function bindChats() {
  stopChats?.()
  stopChats = null
  chats.value = []
  loadError.value = ''
  if (!ownerId.value) {
    loadingList.value = false
    loadError.value = t('supportAdmin.loadError')
    return
  }
  loadingList.value = true
  stopChats = watchAdminChats(ownerId.value, (list, error) => {
    loadingList.value = false
    if (error) {
      loadError.value = t('supportAdmin.loadError')
      chats.value = []
      return
    }
    loadError.value = ''
    chats.value = list
    if (selectedId.value && !list.some((row) => row.id === selectedId.value)) {
      selectedId.value = null
    }
  })
}

function selectChat(row) {
  selectedId.value = row.id
}

async function scrollToBottom() {
  await nextTick()
  const el = messagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => selected.value?.messages?.length,
  () => scrollToBottom(),
)

watch(ownerId, () => bindChats(), { immediate: true })

onUnmounted(() => {
  stopChats?.()
})

async function sendReply() {
  const id = selected.value?.id
  const text = replyText.value.trim()
  if (!id || !text || sending.value || !ownerId.value) return
  sending.value = true
  try {
    await appendAdminMessage(ownerId.value, id, {
      authorRole: 'admin',
      body: text,
      authorName: adminName.value,
    })
    replyText.value = ''
  } catch (e) {
    console.error(e)
    loadError.value = t('supportAdmin.loadError')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="app-view">
    <h1 class="app-view__title">{{ t('supportAdmin.title') }}</h1>
    <p class="app-view__subtitle">{{ t('supportAdmin.subtitle') }}</p>

    <div class="finance-page">
      <div class="finance-toolbar-row">
        <Button
          type="button"
          rounded
          outlined
          severity="secondary"
          :label="t('supportAdmin.refresh')"
          icon="pi pi-refresh"
          class="finance-toolbar-row__btn"
          :loading="loadingList"
          @click="bindChats"
        />
      </div>

      <p v-if="loadError" class="support-load-error" role="alert">{{ loadError }}</p>

      <div class="finance-main-row">
        <aside
          class="finance-panel finance-panel--calendar calendar-widget help-inbox"
          aria-labelledby="help-inbox-heading"
        >
          <h2 id="help-inbox-heading" class="finance-panel__section-title">
            {{ t('supportAdmin.inboxHeading') }}
          </h2>
          <p v-if="!loadingList && !chats.length" class="empty-list help-inbox__empty">
            {{ t('supportAdmin.emptyList') }}
          </p>
          <ul v-else class="help-chat-rows">
            <li v-for="c in chats" :key="c.id">
              <button
                type="button"
                class="help-chat-row"
                :class="{ 'help-chat-row--active': c.id === selectedId }"
                @click="selectChat(c)"
              >
                <span class="help-chat-row__name">{{ c.residentName || c.residentId }}</span>
                <span class="help-chat-row__topic">{{
                  c.source === 'ai-escalation'
                    ? `${c.topic} · ${t('supportAdmin.fromAssistant')}`
                    : c.topic
                }}</span>
                <span class="help-chat-row__time">{{ formatWhen(c.updatedAt || c.createdAt) }}</span>
                <span class="help-chat-row__preview">{{ previewLast(c) }}</span>
              </button>
            </li>
          </ul>
        </aside>

        <section
          v-if="selected"
          class="finance-panel finance-panel--table table-panel help-thread"
          aria-labelledby="thread-heading"
        >
          <h2 id="thread-heading" class="finance-panel__section-title help-thread__resident">
            {{ selected.residentName || selected.residentId }}
          </h2>
          <p class="app-view__subtitle help-thread__meta">
            {{ t('supportAdmin.topicLabel') }}: {{ selected.topic }} · {{ formatWhen(selected.createdAt) }}
          </p>

          <div ref="messagesEl" class="help-thread__messages" role="log">
            <div
              v-for="m in selected.messages || []"
              :key="m.id"
              class="help-bubble"
              :class="
                m.authorRole === 'admin'
                  ? 'help-bubble--admin'
                  : m.authorRole === 'resident'
                    ? 'help-bubble--resident'
                    : 'help-bubble--other'
              "
            >
              <span class="help-bubble__label">{{ bubbleRole(m.authorRole) }}</span>
              <span v-if="m.authorName" class="help-bubble__name">{{ m.authorName }}</span>
              <p class="help-bubble__body">{{ m.body }}</p>
              <span class="help-bubble__time">{{ formatWhen(m.createdAt) }}</span>
            </div>
          </div>

          <div class="help-thread__compose">
            <Textarea
              v-model="replyText"
              rows="3"
              class="support-textarea"
              :placeholder="t('supportAdmin.messagePlaceholder')"
              autoResize
              @keydown.enter.exact.prevent="sendReply"
            />
            <div class="help-thread__actions">
              <Button
                type="button"
                rounded
                :label="t('supportAdmin.send')"
                icon="pi pi-send"
                class="finance-toolbar-row__btn"
                :disabled="!replyText.trim()"
                :loading="sending"
                @click="sendReply"
              />
            </div>
          </div>
        </section>

        <div v-else class="finance-panel table-panel help-placeholder">
          <p class="app-view__subtitle help-placeholder__text">{{ t('supportAdmin.selectPrompt') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.app-view__title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--apple-text, #1d1d1f);
}

.app-view__subtitle {
  margin: 0.5rem 0 0;
  max-width: 42rem;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: -0.015em;
  color: var(--apple-text-secondary, #6e6e73);
}

.finance-page {
  margin-top: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.finance-toolbar-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.finance-toolbar-row__btn :deep(.p-button) {
  font-weight: 500;
  font-size: 0.8125rem;
  padding-block: 0.5rem;
  padding-inline: 1rem;
}

.finance-main-row {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 1.25rem;
}

.table-panel {
  flex: 1 1 58%;
  min-width: 0;
}

.calendar-widget {
  flex: 0 1 22rem;
  min-width: 17rem;
}

@media (max-width: 1024px) {
  .finance-main-row {
    flex-direction: column;
  }

  .calendar-widget {
    flex: 1 1 auto;
    min-width: 0;
    max-width: none;
  }
}

.finance-panel {
  padding: 1.2rem 1.25rem 1.35rem;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.finance-panel--calendar {
  background: #fafafa;
}

.finance-panel--table {
  padding: 1.2rem 1.25rem 1.35rem;
  overflow: hidden;
}

.finance-panel__section-title {
  margin: 0 0 0.85rem;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--apple-text, #1d1d1f);
}

.support-load-error {
  color: #d70015;
  font-size: 0.8125rem;
  margin: 0;
}

.help-inbox {
  max-height: 70vh;
  overflow-y: auto;
}

.help-inbox__empty {
  margin: 0;
  padding: 0.35rem 0 0.5rem;
  text-align: left;
}

.empty-list {
  color: var(--apple-text-secondary, #6e6e73);
  font-size: 0.8125rem;
}

.help-chat-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.help-chat-row {
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding: 0.75rem 0.35rem;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-family: inherit;
  transition: background 0.12s ease;
  border-radius: 10px;
}

.help-chat-row:hover {
  background: rgba(0, 0, 0, 0.03);
}

.help-chat-row--active {
  background: rgba(10, 132, 255, 0.1);
}

.help-chat-row__name {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--apple-text, #1d1d1f);
}

.help-chat-row__topic {
  font-size: 0.78rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.help-chat-row__time {
  font-size: 0.72rem;
  color: #86868b;
}

.help-chat-row__preview {
  font-size: 0.8rem;
  color: #6e6e73;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.help-thread__resident {
  margin-bottom: 0.35rem;
}

.help-thread__meta {
  margin: 0 0 1rem;
  max-width: none;
}

.help-thread__messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.25rem 0 1rem;
  max-height: 42vh;
  min-height: 10rem;
}

.help-bubble {
  max-width: 95%;
  padding: 0.65rem 0.85rem;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.help-bubble--resident {
  align-self: flex-start;
  background: #fafafa;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.help-bubble--admin {
  align-self: flex-end;
  background: rgba(10, 132, 255, 0.1);
  border: 1px solid rgba(10, 132, 255, 0.22);
}

.help-bubble--other {
  align-self: flex-start;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.help-bubble__label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.055em;
  color: #86868b;
}

.help-bubble__name {
  display: block;
  font-size: 0.72rem;
  color: #6e6e73;
  margin-bottom: 0.2rem;
}

.help-bubble__body {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--apple-text, #1d1d1f);
}

.help-bubble__time {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.68rem;
  color: #86868b;
}

.help-thread {
  display: flex;
  flex-direction: column;
  min-height: 28rem;
}

.help-thread__compose {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding-top: 0.75rem;
  margin-top: auto;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.help-thread__actions {
  display: flex;
  justify-content: flex-end;
}

.support-textarea {
  width: 100%;
  border-radius: 10px;
  border: 1px solid #d2d2d7;
  font-size: 0.875rem;
}

.support-textarea:focus {
  outline: none;
  border-color: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.18);
}

.help-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 28rem;
  background: #fafafa;
}

.help-placeholder__text {
  margin: 0;
  text-align: center;
  max-width: 22rem;
}
</style>
