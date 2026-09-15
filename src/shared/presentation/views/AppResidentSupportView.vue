<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSession, getActiveDataOwnerId } from '@/iam/application/sessionStore.js'
import { generateGeminiReply, summarizeChatTitle } from '@/support/infrastructure/geminiApi.js'
import { buildResidentAssistantPrompt } from '@/support/domain/residentAssistantPrompt.js'
import {
  assistantWantsEscalate,
  residentWantsAdmin,
  stripEscalateMarker,
} from '@/support/domain/supportEscalate.js'
import {
  appendAdminMessage,
  appendAiMessage,
  createAdminChat,
  createAiChat,
  patchAiChat,
  watchAdminChat,
  watchAiChats,
  watchRealtimeConnected,
} from '@/support/infrastructure/realtimeSupportDb.js'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()
const aiInput = ref('')
const aiSending = ref(false)
const aiChats = ref([])
const activeAiChatId = ref('')
const aiMessagesEl = ref(null)
const extraAdminMessages = ref([])
const syncError = ref('')
const creatingBlank = ref(false)
const chatsReady = ref(false)

const residentId = computed(() => sessionState.profile?.id ?? '')
const residentName = computed(() => sessionState.profile?.name ?? '')
const ownerId = computed(() => getActiveDataOwnerId() || sessionState.profile?.ownerAdminId || '')

const activeAiChat = computed(
  () => aiChats.value.find((chat) => chat.id === activeAiChatId.value) || null,
)

const displayMessages = computed(() => {
  const base = activeAiChat.value?.messages || []
  const extras = extraAdminMessages.value
    .filter((row) => row.authorRole === 'admin')
    .filter((row) => !base.some((item) => item.id === row.id))
    .map((row) => ({
      id: row.id,
      role: 'admin',
      body: row.body,
      createdAt: row.createdAt,
    }))
  return [...base, ...extras].sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
  )
})

const hasAiMessages = computed(() => displayMessages.value.length > 0)

function titleFromText(text) {
  const clean = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!clean) return t('supportResident.aiNewChat')
  return clean.length > 38 ? `${clean.slice(0, 38)}…` : clean
}

function messageWho(role) {
  if (role === 'user') return t('supportResident.labelYou')
  if (role === 'admin') return t('supportResident.labelAdmin')
  return t('supportResident.aiLabel')
}

function geminiSystemInstruction() {
  return buildResidentAssistantPrompt({
    locale: locale.value,
    t,
    residentName: residentName.value,
  })
}

async function scrollAiToBottom() {
  await nextTick()
  const el = aiMessagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

let stopAiChats = null
let stopAdminThread = null
let stopConnected = null
let creatingBlankLock = false
let connectWaitTimer = 0

function bindAiChats() {
  stopAiChats?.()
  stopAiChats = null
  stopConnected?.()
  stopConnected = null
  if (connectWaitTimer) window.clearTimeout(connectWaitTimer)
  chatsReady.value = false
  if (!ownerId.value || !residentId.value) {
    aiChats.value = []
    return
  }
  stopConnected = watchRealtimeConnected((ok) => {
    if (ok && syncError.value === t('supportResident.syncError')) {
      syncError.value = ''
    }
  })
  connectWaitTimer = window.setTimeout(() => {
    if (!chatsReady.value) syncError.value = t('supportResident.syncError')
  }, 6000)
  stopAiChats = watchAiChats(ownerId.value, residentId.value, (list, error) => {
    if (connectWaitTimer) window.clearTimeout(connectWaitTimer)
    syncError.value = error ? t('supportResident.syncError') : ''
    aiChats.value = list
    chatsReady.value = true
    if (!list.some((chat) => chat.id === activeAiChatId.value)) {
      activeAiChatId.value = list[0]?.id || ''
    }
    if (!error && !list.length) void startAiChat()
  })
}

function bindAdminThread(chatId) {
  stopAdminThread?.()
  stopAdminThread = null
  extraAdminMessages.value = []
  if (!ownerId.value || !chatId) return
  stopAdminThread = watchAdminChat(ownerId.value, chatId, (chat) => {
    extraAdminMessages.value = chat?.messages || []
  })
}

watch([ownerId, residentId], () => {
  bindAiChats()
}, { immediate: true })

watch(
  () => activeAiChat.value?.escalatedChatId,
  (chatId) => bindAdminThread(chatId),
  { immediate: true },
)

watch(
  () => displayMessages.value.length,
  () => scrollAiToBottom(),
)

watch([chatsReady, aiChats], async () => {
  if (!chatsReady.value || !ownerId.value || !residentId.value) return
  if (creatingBlank.value || aiChats.value.length) return
  await startAiChat()
})

onUnmounted(() => {
  stopAiChats?.()
  stopAdminThread?.()
  stopConnected?.()
  if (connectWaitTimer) window.clearTimeout(connectWaitTimer)
})

async function startAiChat() {
  const blank = aiChats.value.find((chat) => !chat.messages?.length)
  if (blank) {
    activeAiChatId.value = blank.id
    return
  }
  if (!ownerId.value || !residentId.value || creatingBlankLock) return
  creatingBlankLock = true
  creatingBlank.value = true
  try {
    const chat = await createAiChat({
      ownerId: ownerId.value,
      residentId: residentId.value,
      title: t('supportResident.aiNewChat'),
    })
    activeAiChatId.value = chat.id
  } catch (error) {
    console.error(error)
    syncError.value = t('supportResident.syncError')
  } finally {
    creatingBlankLock = false
    creatingBlank.value = false
  }
}

function openAiChat(id) {
  activeAiChatId.value = id
}

function toAdminTranscript(messages) {
  return (messages || []).map((row) => ({
    id: row.id,
    authorRole: row.role === 'user' ? 'resident' : row.role === 'admin' ? 'admin' : 'assistant',
    body: row.body,
    createdAt: row.createdAt,
    authorName: row.role === 'user' ? residentName.value : undefined,
  }))
}

async function maybeSummarizeTitle(chatId, messages) {
  const chat = aiChats.value.find((row) => row.id === chatId)
  if (!chat || chat.titleSummarized || (messages?.length ?? 0) < 2) return
  try {
    const title = await summarizeChatTitle({
      messages,
      locale: locale.value,
    })
    if (!title) return
    await patchAiChat(ownerId.value, residentId.value, chatId, {
      title,
      titleSummarized: true,
    })
  } catch (error) {
    console.error(error)
  }
}

async function escalateChat(chatId, extraMessages = []) {
  const chat = aiChats.value.find((row) => row.id === chatId)
  if (!chat || chat.escalatedChatId) return chat?.escalatedChatId || ''
  const merged = [...(chat.messages || [])]
  for (const row of extraMessages) {
    if (!row?.body) continue
    if (!merged.some((item) => item.id === row.id || item.body === row.body)) {
      merged.push(row)
    }
  }
  const topic =
    chat.title && chat.title !== t('supportResident.aiNewChat')
      ? chat.title
      : t('supportResident.defaultChatTopic')
  const adminChat = await createAdminChat({
    ownerId: ownerId.value,
    residentId: residentId.value,
    residentName: residentName.value,
    topic,
    source: 'ai-escalation',
    aiChatId: chat.id,
    messages: toAdminTranscript(merged),
  })
  await patchAiChat(ownerId.value, residentId.value, chat.id, {
    escalatedChatId: adminChat.id,
  })
  await appendAiMessage(ownerId.value, residentId.value, chat.id, {
    role: 'ai',
    body: t('supportResident.escalatedToAdmin'),
  })
  return adminChat.id
}

async function sendAiMessage(preset) {
  const text = String(preset ?? aiInput.value).trim()
  if (!text || aiSending.value) return
  if (!ownerId.value || !residentId.value) return
  if (!activeAiChat.value) await startAiChat()
  const chatId = activeAiChatId.value
  if (!chatId) return

  aiInput.value = ''
  aiSending.value = true
  try {
    const current = aiChats.value.find((row) => row.id === chatId)
    const userMsg = await appendAiMessage(ownerId.value, residentId.value, chatId, {
      role: 'user',
      body: text,
    })
    if (current && !current.titleSummarized) {
      await patchAiChat(ownerId.value, residentId.value, chatId, {
        title: titleFromText(text),
      })
    }

    if (current?.escalatedChatId) {
      await appendAdminMessage(ownerId.value, current.escalatedChatId, {
        authorRole: 'resident',
        body: text,
        authorName: residentName.value,
      })
      return
    }

    const history = [...(current?.messages || []), userMsg].filter(
      (row) => row.role === 'user' || row.role === 'ai',
    )

    if (residentWantsAdmin(text)) {
      await escalateChat(chatId, [userMsg])
      await maybeSummarizeTitle(chatId, [
        ...history,
        { role: 'ai', body: t('supportResident.escalatedToAdmin') },
      ])
      return
    }

    try {
      const reply = await generateGeminiReply({
        messages: history,
        systemInstruction: geminiSystemInstruction(),
      })
      const shouldEscalate = assistantWantsEscalate(reply)
      const body = stripEscalateMarker(reply) || t('supportResident.escalatedToAdmin')
      const aiMsg = await appendAiMessage(ownerId.value, residentId.value, chatId, {
        role: 'ai',
        body,
      })
      await maybeSummarizeTitle(chatId, [...history, aiMsg])
      if (shouldEscalate) await escalateChat(chatId, [userMsg, aiMsg])
    } catch (error) {
      console.error(error)
      await appendAiMessage(ownerId.value, residentId.value, chatId, {
        role: 'ai',
        body:
          error?.code === 'GEMINI_API_KEY_MISSING'
            ? t('supportResident.aiMissingKey')
            : error?.code === 'GEMINI_BUSY'
              ? t('supportResident.aiBusy')
              : t('supportResident.aiError'),
      })
    }
  } catch (error) {
    console.error(error)
    syncError.value = t('supportResident.syncError')
  } finally {
    aiSending.value = false
    scrollAiToBottom()
  }
}

function onAiSuggestion(kind) {
  if (kind === 'admin') {
    sendAiMessage(t('supportResident.aiSuggestionAdmin'))
    return
  }
  sendAiMessage(t(`supportResident.${kind}`))
}
</script>

<template>
  <div class="app-view app-view--ai">
    <div class="finance-page">
      <p v-if="!residentId" class="app-view__subtitle support-session-hint" role="status">
        {{ t('supportResident.sessionMissing') }}
      </p>
      <p v-else-if="!ownerId" class="app-view__subtitle support-session-hint" role="status">
        {{ t('supportResident.ownerMissing') }}
      </p>
      <p v-if="syncError" class="app-view__subtitle support-session-hint" role="alert">
        {{ syncError }}
      </p>

      <div class="ai-shell">
        <aside class="ai-sidebar" aria-label="Chat history">
          <button type="button" class="ai-new" @click="startAiChat">
            <i class="pi pi-plus" aria-hidden="true" />
            {{ t('supportResident.aiNewChat') }}
          </button>
          <p class="ai-recents-label">{{ t('supportResident.aiRecents') }}</p>
          <ul class="ai-recent-list" role="list">
            <li v-for="chat in aiChats" :key="chat.id">
              <button
                type="button"
                class="ai-recent"
                :class="{ 'is-active': chat.id === activeAiChatId }"
                @click="openAiChat(chat.id)"
              >
                {{ chat.title }}
              </button>
            </li>
          </ul>
        </aside>

        <section class="ai-main" aria-labelledby="ai-prompt-heading">
          <div v-if="!hasAiMessages" class="ai-stage">
            <h2 id="ai-prompt-heading" class="ai-heading">{{ t('supportResident.aiPrompt') }}</h2>
            <div class="ai-composer">
              <span class="ai-composer__plus" aria-hidden="true">
                <i class="pi pi-plus" />
              </span>
              <input
                v-model="aiInput"
                type="text"
                :placeholder="t('supportResident.aiAskPlaceholder')"
                :aria-label="t('supportResident.aiAskPlaceholder')"
                :disabled="aiSending"
                @keydown.enter.prevent="sendAiMessage()"
              />
              <button
                type="button"
                class="ai-composer__send"
                :disabled="aiSending || !aiInput.trim()"
                :aria-label="t('supportResident.send')"
                @click="sendAiMessage()"
              >
                <i class="pi pi-arrow-up" aria-hidden="true" />
              </button>
            </div>
            <div class="ai-suggestions">
              <button type="button" class="ai-suggestion" @click="onAiSuggestion('aiSuggestionFees')">
                <i class="pi pi-credit-card" aria-hidden="true" />
                {{ t('supportResident.aiSuggestionFees') }}
              </button>
              <button type="button" class="ai-suggestion" @click="onAiSuggestion('aiSuggestionSpaces')">
                <i class="pi pi-building" aria-hidden="true" />
                {{ t('supportResident.aiSuggestionSpaces') }}
              </button>
              <button type="button" class="ai-suggestion" @click="onAiSuggestion('admin')">
                <i class="pi pi-user" aria-hidden="true" />
                {{ t('supportResident.aiSuggestionAdmin') }}
              </button>
            </div>
          </div>

          <template v-else>
            <div ref="aiMessagesEl" class="ai-thread" role="log" aria-live="polite">
              <div
                v-for="m in displayMessages"
                :key="m.id"
                class="ai-msg"
                :class="{
                  'ai-msg--user': m.role === 'user',
                  'ai-msg--ai': m.role === 'ai',
                  'ai-msg--admin': m.role === 'admin',
                }"
              >
                <span class="ai-msg__who">{{ messageWho(m.role) }}</span>
                <p>{{ m.body }}</p>
              </div>
              <div v-if="aiSending" class="ai-msg ai-msg--ai ai-msg--typing">
                <span class="ai-msg__who">{{ t('supportResident.aiLabel') }}</span>
                <p>{{ t('supportResident.aiTyping') }}</p>
              </div>
            </div>
            <div class="ai-dock">
              <div class="ai-composer">
                <span class="ai-composer__plus" aria-hidden="true">
                  <i class="pi pi-plus" />
                </span>
                <input
                  v-model="aiInput"
                  type="text"
                  :placeholder="t('supportResident.aiAskPlaceholder')"
                  :aria-label="t('supportResident.aiAskPlaceholder')"
                  :disabled="aiSending"
                  @keydown.enter.prevent="sendAiMessage()"
                />
                <button
                  type="button"
                  class="ai-composer__send"
                  :disabled="aiSending || !aiInput.trim()"
                  :aria-label="t('supportResident.send')"
                  @click="sendAiMessage()"
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
/* Page shell — aligned with AppFinanceView */
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

.support-session-hint {
  margin-top: 0.35rem;
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

.ai-new:hover {
  color: var(--apple-blue, #1e3a8a);
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
  text-align: left;
  padding: 0.52rem 0.7rem;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--apple-text, #1d1d1f);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-recent:hover {
  background: rgba(255, 255, 255, 0.8);
}

.ai-recent.is-active {
  background: #fff;
  color: var(--apple-blue, #1e3a8a);
  font-weight: 600;
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
  margin: 0 0 1.5rem;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.04em;
  color: var(--apple-text, #1d1d1f);
  text-align: center;
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

.ai-suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.35rem 1.35rem;
  margin-top: 1.35rem;
}

.ai-suggestion {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: none;
  background: none;
  color: var(--apple-text-tertiary, #6e6e73);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  padding: 0.3rem 0;
}

.ai-suggestion:hover {
  color: var(--apple-blue, #1e3a8a);
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

.ai-msg--ai {
  align-self: flex-start;
  background: var(--apple-bg-secondary, #f5f5f7);
  color: var(--apple-text, #1d1d1f);
}

.ai-msg--user {
  align-self: flex-end;
  background: rgba(30, 58, 138, 0.1);
  color: var(--apple-blue, #1e3a8a);
}

.ai-msg--admin {
  align-self: flex-start;
  background: rgba(10, 132, 255, 0.12);
  color: var(--apple-text, #1d1d1f);
  border: 1px solid rgba(10, 132, 255, 0.2);
}

.ai-msg--typing p {
  color: var(--apple-text-secondary, #86868b);
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
