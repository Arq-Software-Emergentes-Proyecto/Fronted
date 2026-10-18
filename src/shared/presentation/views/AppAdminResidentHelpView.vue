<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { supportApi } from '@/residentCare/infrastructure/supportApi.js'
import { useSession, getActiveDataOwnerId } from '@/iam/application/sessionStore.js'
import {
  isDocumentVisible,
  joinSupportOwner,
  onSupportChatUpdated,
} from '@/residentCare/infrastructure/supportRealtime.js'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()

const chats = ref([])
const selectedId = ref(null)
const replyText = ref('')
const sending = ref(false)
const loadingList = ref(true)
const loadError = ref('')
const messagesEl = ref(null)
const lastListSync = ref('')

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

function chatTitle(row) {
  return row?.topic || row?.residentName || row?.residentId || '—'
}

function chatMeta(row) {
  const name = row?.residentName || row?.residentId || ''
  if (row?.source === 'ai-escalation') {
    return name ? `${name} · ${t('supportAdmin.fromAssistant')}` : t('supportAdmin.fromAssistant')
  }
  return name
}

let pollTimer = 0
let stopHub = null
let signalROk = false

function upsertChat(chat) {
  if (!chat?.id) return
  const idx = chats.value.findIndex((row) => row.id === chat.id)
  if (idx >= 0) chats.value[idx] = chat
  else chats.value = [chat, ...chats.value]
  if (chat.updatedAt && (!lastListSync.value || chat.updatedAt > lastListSync.value)) {
    lastListSync.value = chat.updatedAt
  }
}

async function bindChats({ silent = false, incremental = false } = {}) {
  loadError.value = ''
  if (!ownerId.value) {
    loadingList.value = false
    loadError.value = t('supportAdmin.loadError')
    chats.value = []
    return
  }
  if (!silent) loadingList.value = true
  try {
    const since = incremental && lastListSync.value ? lastListSync.value : undefined
    const list = await supportApi.listChats('admin', { since })
    if (incremental && since) {
      for (const row of list) upsertChat(row)
    } else {
      chats.value = list
      const newest = list.map((c) => c.updatedAt).filter(Boolean).sort().at(-1)
      if (newest) lastListSync.value = newest
    }
    if (selectedId.value && !chats.value.some((row) => row.id === selectedId.value)) {
      selectedId.value = null
    }
  } catch (e) {
    console.error(e)
    loadError.value = t('supportAdmin.loadError')
    if (!incremental) chats.value = []
  } finally {
    loadingList.value = false
  }
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

async function bindRealtime() {
  stopHub?.()
  stopHub = null
  signalROk = false
  if (!ownerId.value) return
  const hub = await joinSupportOwner(ownerId.value)
  if (!hub) return
  signalROk = true
  stopHub = onSupportChatUpdated((payload) => {
    if (payload?.kind === 'admin') upsertChat({
      ...payload,
      topic: payload.topic || payload.title,
      messages: payload.messages || [],
    })
  })
}

function startFallbackPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => {
    if (!isDocumentVisible() || signalROk) return
    void bindChats({ silent: true, incremental: true })
  }, 8000)
}

watch(ownerId, async () => {
  await bindChats()
  await bindRealtime()
  startFallbackPolling()
}, { immediate: true })

function onVisibility() {
  if (isDocumentVisible()) void bindChats({ silent: true, incremental: true })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility)
}

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
  stopHub?.()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
})

async function sendReply() {
  const id = selected.value?.id
  const text = replyText.value.trim()
  if (!id || !text || sending.value || !ownerId.value) return
  sending.value = true
  try {
    const updated = await supportApi.postMessage(id, text, locale.value)
    upsertChat(updated)
    replyText.value = ''
    loadError.value = ''
  } catch (e) {
    console.error(e)
    loadError.value = t('supportAdmin.loadError')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="app-view app-view--ai">
    <div class="finance-page">
      <p v-if="loadError" class="app-view__subtitle support-session-hint" role="alert">
        {{ loadError }}
      </p>

      <div class="ai-shell">
        <aside class="ai-sidebar" :aria-label="t('supportAdmin.inboxHeading')">
          <button type="button" class="ai-new" :disabled="loadingList" @click="bindChats">
            <i class="pi pi-refresh" aria-hidden="true" />
            {{ t('supportAdmin.refresh') }}
          </button>
          <p class="ai-recents-label">{{ t('supportAdmin.inboxHeading') }}</p>
          <p v-if="!loadingList && !chats.length" class="ai-empty">
            {{ t('supportAdmin.emptyList') }}
          </p>
          <ul v-else class="ai-recent-list" role="list">
            <li v-for="c in chats" :key="c.id">
              <button
                type="button"
                class="ai-recent"
                :class="{ 'is-active': c.id === selectedId }"
                @click="selectChat(c)"
              >
                <span class="ai-recent__title">{{ chatTitle(c) }}</span>
                <span class="ai-recent__meta">{{ chatMeta(c) }}</span>
              </button>
            </li>
          </ul>
        </aside>

        <section class="ai-main" aria-labelledby="help-prompt-heading">
          <div v-if="!selected" class="ai-stage">
            <h2 id="help-prompt-heading" class="ai-heading">{{ t('supportAdmin.emptyHeading') }}</h2>
            <p class="ai-stage__sub">{{ t('supportAdmin.selectPrompt') }}</p>
          </div>

          <template v-else>
            <header class="ai-thread-head">
              <h2 id="help-prompt-heading" class="ai-thread-head__name">
                {{ selected.residentName || selected.residentId }}
              </h2>
              <p class="ai-thread-head__meta">
                {{ t('supportAdmin.topicLabel') }}: {{ selected.topic || '—' }}
                <span v-if="selected.createdAt"> · {{ formatWhen(selected.createdAt) }}</span>
              </p>
            </header>
            <div ref="messagesEl" class="ai-thread" role="log" aria-live="polite">
              <div
                v-for="m in selected.messages || []"
                :key="m.id"
                class="ai-msg"
                :class="{
                  'ai-msg--user': m.authorRole === 'admin',
                  'ai-msg--resident': m.authorRole === 'resident',
                  'ai-msg--ai': m.authorRole === 'assistant' || m.authorRole === 'ai',
                }"
              >
                <span class="ai-msg__who">{{ bubbleRole(m.authorRole) }}</span>
                <p>{{ m.body }}</p>
              </div>
            </div>
            <div class="ai-dock">
              <div class="ai-composer">
                <span class="ai-composer__plus" aria-hidden="true">
                  <i class="pi pi-plus" />
                </span>
                <input
                  v-model="replyText"
                  type="text"
                  :placeholder="t('supportAdmin.messagePlaceholder')"
                  :aria-label="t('supportAdmin.messagePlaceholder')"
                  :disabled="sending"
                  @keydown.enter.prevent="sendReply()"
                />
                <button
                  type="button"
                  class="ai-composer__send"
                  :disabled="sending || !replyText.trim()"
                  :aria-label="t('supportAdmin.send')"
                  @click="sendReply()"
                >
                  <i class="pi pi-arrow-up" aria-hidden="true" />
                </button>
              </div>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.75rem 1.5rem 2.5rem;
  max-width: 72rem;
}

.app-view--ai {
  max-width: 88rem;
  flex: 1;
  min-height: 0;
  height: 100%;
  max-height: 100%;
  padding: 1rem 1.5rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
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

.support-session-hint {
  margin: 0 0 0.75rem;
  color: #b42318;
}

.finance-page {
  margin-top: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.ai-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 16.75rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.ai-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
  overflow: hidden;
  padding: 0.9rem 0.75rem 1rem;
  background: var(--apple-bg-secondary, #f5f5f7);
  border-right: 1px solid rgba(0, 0, 0, 0.06);
}

.ai-new {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.58rem 0.8rem;
  border: none;
  border-radius: 12px;
  background: #fff;
  color: var(--apple-text, #1d1d1f);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.ai-new:hover:not(:disabled) {
  color: var(--apple-blue, #1e3a8a);
}

.ai-new:disabled {
  opacity: 0.55;
  cursor: wait;
}

.ai-recents-label {
  flex-shrink: 0;
  margin: 0.35rem 0.35rem 0;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--apple-text-secondary, #86868b);
}

.ai-empty {
  margin: 0.35rem 0.35rem 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.ai-recent {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.12rem;
  text-align: left;
  padding: 0.52rem 0.7rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--apple-text, #1d1d1f);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.ai-recent:hover {
  background: rgba(255, 255, 255, 0.8);
}

.ai-recent.is-active {
  background: #fff;
  color: var(--apple-blue, #1e3a8a);
  font-weight: 600;
}

.ai-recent__title,
.ai-recent__meta {
  display: block;
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-recent__meta {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--apple-text-secondary, #86868b);
}

.ai-recent.is-active .ai-recent__meta {
  color: rgba(30, 58, 138, 0.72);
}

.ai-main {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.ai-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.5rem 2.25rem;
}

.ai-heading {
  margin: 0 0 0.65rem;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.04em;
  color: var(--apple-text, #1d1d1f);
  text-align: center;
}

.ai-stage__sub {
  margin: 0;
  max-width: 26rem;
  text-align: center;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-thread-head {
  flex-shrink: 0;
  padding: 0.95rem 1.5rem 0.8rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.ai-thread-head__name {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--apple-text, #1d1d1f);
}

.ai-thread-head__meta {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--apple-text-secondary, #6e6e73);
}

.ai-composer {
  width: min(40rem, 100%);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.4rem 0.4rem 0.85rem;
  border: 1px solid var(--apple-border-hairline, #d2d2d7);
  border-radius: 980px;
  background: #fff;
  box-shadow: var(--apple-shadow-md, 0 4px 24px rgba(0, 0, 0, 0.06));
}

.ai-composer:focus-within {
  border-color: var(--apple-blue, #1e3a8a);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.16);
}

.ai-composer__plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  color: var(--apple-text-secondary, #86868b);
  font-size: 0.85rem;
}

.ai-composer input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.95rem;
  color: var(--apple-text, #1d1d1f);
}

.ai-composer__send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.35rem;
  height: 2.35rem;
  border: none;
  border-radius: 50%;
  background: var(--apple-blue, #1e3a8a);
  color: #fff;
  cursor: pointer;
}

.ai-composer__send:hover:not(:disabled) {
  background: var(--apple-blue-hover, #172554);
}

.ai-composer__send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.ai-thread {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  width: 100%;
  margin: 0;
  padding: 1.5rem max(1.5rem, calc(50% - 22rem)) 0.75rem;
}

.ai-msg {
  max-width: 86%;
  padding: 0.8rem 1rem;
  border-radius: 16px;
}

.ai-msg p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-msg__who {
  display: block;
  margin-bottom: 0.3rem;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--apple-text-secondary, #86868b);
}

.ai-msg--ai,
.ai-msg--resident {
  align-self: flex-start;
  background: var(--apple-bg-secondary, #f5f5f7);
  color: var(--apple-text, #1d1d1f);
}

.ai-msg--user {
  align-self: flex-end;
  background: rgba(30, 58, 138, 0.1);
  color: var(--apple-blue, #1e3a8a);
}

.ai-dock {
  flex-shrink: 0;
  padding: 0.75rem 1.25rem 1.35rem;
  display: flex;
  justify-content: center;
}

@media (max-width: 860px) {
  .ai-shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .ai-sidebar {
    border-right: none;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  }

  .ai-recent-list {
    max-height: 8rem;
  }
}
</style>
