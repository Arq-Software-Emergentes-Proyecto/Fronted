<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSession, getActiveDataOwnerId } from '@/iam/application/sessionStore.js'
import { normalizeChat, supportApi } from '@/residentCare/infrastructure/supportApi.js'
import {
  FAQ_TOPICS,
  RESIDENT_FAQS,
  filterFaqsByTopic,
  searchFaqs,
  suggestFaqTerms,
} from '@/residentCare/domain/faq.js'
import { autosizeTextarea, formatClock, relativeTime } from '@/residentCare/domain/supportFormat.js'
import {
  isDocumentVisible,
  joinSupportChat,
  joinSupportOwner,
  onSupportChatUpdated,
  realtimeAvailable,
} from '@/residentCare/infrastructure/supportRealtime.js'

const { t, locale } = useI18n()
const { state: sessionState } = useSession()
const aiInput = ref('')
const aiSending = ref(false)
const aiChats = ref([])
const activeAiChatId = ref('')
const aiMessagesEl = ref(null)
const adminThreadMessages = ref([])
const syncError = ref('')
const creatingBlank = ref(false)
const chatsReady = ref(false)
const lastListSync = ref('')
/** 'faq' (Soporte Técnico: preguntas frecuentes) | 'chat' (asistente / administración). */
const view = ref('faq')
const faqQuery = ref('')
const openFaqId = ref('')
/** Texto en vuelo (se muestra como burbuja pendiente) y último fallo reintentable. */
const pendingText = ref('')
const sendFailure = ref(null)
const aiNotice = ref('')

/** Chip de tema activo del encabezado de ayuda ('' = todos). */
const activeTopic = ref('')
/** Móvil: lista de conversaciones desplegada. */
const showConversations = ref(false)
const composerEl = ref(null)

/** Preguntas sugeridas del asistente (tarjeta de ayuda y chat vacío). */
const ASSISTANT_SUGGESTIONS = ['aiAskFees', 'aiAskPool', 'aiAskGuests', 'aiAskLeak']
const TOPIC_BY_ID = Object.fromEntries(FAQ_TOPICS.map((topic) => [topic.id, topic]))

const filteredFaqs = computed(() =>
  searchFaqs(filterFaqsByTopic(RESIDENT_FAQS, activeTopic.value), faqQuery.value, t),
)
const faqSuggestions = computed(() =>
  filteredFaqs.value.length ? [] : suggestFaqTerms(RESIDENT_FAQS, faqQuery.value, 4, locale.value),
)
const faqFiltered = computed(() => Boolean(faqQuery.value.trim() || activeTopic.value))

function faqIcon(faq) {
  return TOPIC_BY_ID[faq.topic]?.icon || 'pi-question-circle'
}

function toggleFaq(id) {
  openFaqId.value = openFaqId.value === id ? '' : id
}

function toggleTopic(id) {
  activeTopic.value = activeTopic.value === id ? '' : id
  openFaqId.value = ''
}

function clearFaqFilters() {
  faqQuery.value = ''
  activeTopic.value = ''
  openFaqId.value = ''
}

function applyFaqSuggestion(term) {
  faqQuery.value = term
  activeTopic.value = ''
  openFaqId.value = ''
}

function openChatView() {
  view.value = 'chat'
  scrollAiToBottom()
}

/** "Iniciar chat" / "Contactar a soporte": abre una conversación en blanco (reutiliza la vacía). */
async function startChatFromHelp() {
  openChatView()
  await startAiChat()
  focusComposer()
}

/** Pregunta sugerida desde la ayuda: abre el chat en blanco y envía la pregunta. */
async function askFromHelp(key) {
  openChatView()
  await startAiChat()
  if (disposed) return
  void sendAiMessage(t(`supportResident.${key}`))
}

/** "Hablar con administración": si el chat activo ya está derivado lo abre; si no, pide la derivación. */
async function talkToAdminFromHelp() {
  openChatView()
  const current = activeAiChat.value
  if (current?.escalatedChatId) return
  if (current?.messages?.length) await startAiChat()
  if (disposed) return
  onAiSuggestion('admin')
}

const hasHistory = computed(() => aiChats.value.some((chat) => chat.messages?.length))

function chatWhen(chat) {
  return relativeTime(chat?.updatedAt || chat?.createdAt, locale.value, t('supportResident.justNow'))
}

function messageTime(m) {
  return formatClock(m?.createdAt, locale.value)
}

function selectConversation(id) {
  openAiChat(id)
  showConversations.value = false
}

async function newChatFromList() {
  showConversations.value = false
  sendFailure.value = null
  aiNotice.value = ''
  await startAiChat()
  focusComposer()
}

async function focusComposer() {
  await nextTick()
  const el = composerEl.value
  if (el && !el.disabled) el.focus()
}

function onComposerInput(event) {
  autosizeTextarea(event.target)
}

/** Enter envía; Shift+Enter hace salto de línea (y no interfiere con IME). */
function onComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void sendAiMessage()
}

const residentId = computed(() => sessionState.profile?.id ?? '')
const ownerId = computed(() => getActiveDataOwnerId() || sessionState.profile?.ownerAdminId || '')

const activeAiChat = computed(
  () => aiChats.value.find((chat) => chat.id === activeAiChatId.value) || null,
)

const displayMessages = computed(() => {
  const base = activeAiChat.value?.messages || []
  const extras = adminThreadMessages.value
    .filter((row) => row.authorRole === 'admin' || row.role === 'admin')
    .filter((row) => !base.some((item) => item.id === row.id))
    .map((row) => ({
      id: row.id,
      role: 'admin',
      body: row.body,
      createdAt: row.createdAt,
    }))
  const rows = [...base, ...extras].sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
  )
  if (pendingText.value) {
    rows.push({ id: '__pending__', role: 'user', body: pendingText.value, pending: true })
  }
  return rows
})

const hasAiMessages = computed(() => displayMessages.value.length > 0 || Boolean(sendFailure.value))
const activeStatusNote = computed(() => {
  const status = activeAiChat.value?.status
  if (status === 'derived') return t('supportResident.statusDerived')
  if (status === 'closed') return t('supportResident.statusClosed')
  return ''
})

function messageWho(role) {
  if (role === 'user') return t('supportResident.labelYou')
  if (role === 'admin') return t('supportResident.labelAdmin')
  return t('supportResident.aiLabel')
}

async function scrollAiToBottom() {
  await nextTick()
  const el = aiMessagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

let pollTimer = 0
let creatingBlankLock = false
let stopHub = null
/** Set on unmount: async work resumed after an await must not (re)register anything. */
let disposed = false

function upsertLocalChat(chat) {
  if (!chat?.id) return
  const idx = aiChats.value.findIndex((row) => row.id === chat.id)
  if (idx >= 0) aiChats.value[idx] = chat
  else aiChats.value = [chat, ...aiChats.value]
  if (chat.updatedAt && (!lastListSync.value || chat.updatedAt > lastListSync.value)) {
    lastListSync.value = chat.updatedAt
  }
}

async function refreshAiChats({ silent = false, incremental = false } = {}) {
  if (!residentId.value) {
    aiChats.value = []
    chatsReady.value = true
    return
  }
  try {
    const since = incremental && lastListSync.value ? lastListSync.value : undefined
    const list = await supportApi.listChats('ai', { since })
    if (incremental && since) {
      for (const chat of list) upsertLocalChat(chat)
    } else {
      aiChats.value = list
      const newest = list.map((c) => c.updatedAt).filter(Boolean).sort().at(-1)
      if (newest) lastListSync.value = newest
    }
    chatsReady.value = true
    syncError.value = ''
    if (!aiChats.value.some((chat) => chat.id === activeAiChatId.value)) {
      activeAiChatId.value = aiChats.value[0]?.id || ''
    }
    if (!aiChats.value.length) await startAiChat()
  } catch (error) {
    console.error(error)
    chatsReady.value = true
    if (!silent) syncError.value = t('supportResident.syncError')
  }
}

async function refreshAdminThread() {
  const linkedId = activeAiChat.value?.escalatedChatId
  if (!linkedId) {
    adminThreadMessages.value = []
    return
  }
  try {
    const lastId = adminThreadMessages.value.at(-1)?.id
    const chat = await supportApi.getChat(linkedId, { afterMessageId: lastId })
    if (!chat) return
    if (lastId && chat.messages?.length) {
      const known = new Set(adminThreadMessages.value.map((m) => m.id))
      adminThreadMessages.value = [
        ...adminThreadMessages.value,
        ...chat.messages.filter((m) => !known.has(m.id)),
      ]
    } else {
      adminThreadMessages.value = chat.messages || []
    }
  } catch {
    // ignore
  }
}

function startFallbackPolling() {
  stopFallbackPolling()
  pollTimer = window.setInterval(() => {
    if (!isDocumentVisible()) return
    if (realtimeAvailable.value) return
    void refreshAiChats({ silent: true, incremental: true })
    void refreshAdminThread()
  }, 8000)
}

function stopFallbackPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = 0
}

async function bindRealtime() {
  stopHub?.()
  stopHub = null
  if (disposed || !ownerId.value) return
  // The handler is kept across hub reconnections; polling covers the gaps
  // (it runs whenever `realtimeAvailable` is false).
  stopHub = onSupportChatUpdated((payload) => {
    if (!payload?.id) return
    if (payload.kind === 'ai' && payload.residentId === residentId.value) {
      upsertLocalChat({
        ...payload,
        title: payload.title || payload.topic,
        messages: payload.messages || [],
      })
    }
    if (payload.id === activeAiChat.value?.escalatedChatId) {
      adminThreadMessages.value = payload.messages || []
    }
  })
  await joinSupportOwner(ownerId.value)
  if (disposed) return
  if (activeAiChatId.value) await joinSupportChat(activeAiChatId.value)
}

watch([ownerId, residentId], async () => {
  await refreshAiChats()
  if (disposed) return
  await bindRealtime()
  if (disposed) return
  startFallbackPolling()
}, { immediate: true })

// Back online after a reconnect / rebuild: catch up on what was missed while offline.
watch(realtimeAvailable, (ok) => {
  if (!ok || disposed) return
  void refreshAiChats({ silent: true, incremental: true })
  void refreshAdminThread()
})

watch(activeAiChatId, async (id) => {
  if (id) await joinSupportChat(id)
  if (disposed) return
  void refreshAdminThread()
})

watch(
  () => activeAiChat.value?.escalatedChatId,
  () => {
    void refreshAdminThread()
  },
)

watch(
  () => displayMessages.value.length,
  () => scrollAiToBottom(),
)

function onVisibility() {
  if (isDocumentVisible()) void refreshAiChats({ silent: true, incremental: true })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility)
}

onUnmounted(() => {
  disposed = true
  stopFallbackPolling()
  stopHub?.()
  stopHub = null
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
})

async function startAiChat() {
  const blank = aiChats.value.find((chat) => !chat.messages?.length)
  if (blank) {
    activeAiChatId.value = blank.id
    return
  }
  if (!residentId.value || creatingBlankLock) return
  creatingBlankLock = true
  creatingBlank.value = true
  try {
    const chat = await supportApi.createAiChat(t('supportResident.aiNewChat'))
    upsertLocalChat(chat)
    activeAiChatId.value = chat.id
    syncError.value = ''
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
  sendFailure.value = null
  aiNotice.value = ''
}

/** Traduce el error del POST a un mensaje claro y si se puede reintentar (US033 / TS009 / RNF012). */
function describeSendError(error) {
  const code = error?.code
  if (code === 'GEMINI_API_KEY_MISSING') {
    return { message: t('supportResident.aiMissingKey'), retryable: false, offerAdmin: true }
  }
  if (code === 'AI_UNAVAILABLE' || error?.status === 503) {
    return { message: t('supportResident.aiUnavailable'), retryable: true, offerAdmin: true }
  }
  if (code === 'GEMINI_RATE_LIMITED') {
    return { message: t('supportResident.aiBusy'), retryable: true, offerAdmin: false }
  }
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') {
    return { message: t('supportResident.aiNetworkError'), retryable: true, offerAdmin: false }
  }
  return { message: t('supportResident.sendError'), retryable: true, offerAdmin: false }
}

async function sendAiMessage(preset) {
  const text = String(preset ?? aiInput.value).trim()
  if (!text || aiSending.value) return
  if (!residentId.value) return
  if (!activeAiChat.value) await startAiChat()
  const chatId = activeAiChatId.value
  if (!chatId) return

  // El input no se limpia hasta que el servidor confirma: si falla, el texto no se pierde.
  aiSending.value = true
  pendingText.value = text
  sendFailure.value = null
  aiNotice.value = ''
  scrollAiToBottom()
  try {
    const updated = await supportApi.postMessage(chatId, text, locale.value)
    upsertLocalChat(updated)
    if (aiInput.value.trim() === text) aiInput.value = ''
    if (updated.escalatedChatId) await refreshAdminThread()
    syncError.value = ''
  } catch (error) {
    console.error(error)
    if (error?.code === 'AI_MONTHLY_CAP_REACHED') {
      // Tope del plan: el servidor ya guardó y derivó la consulta a administración.
      if (error?.payload?.chat) upsertLocalChat(normalizeChat(error.payload.chat))
      if (aiInput.value.trim() === text) aiInput.value = ''
      aiNotice.value = t('supportResident.aiCapReached')
      await refreshAdminThread()
    } else {
      if (!aiInput.value.trim()) aiInput.value = text
      sendFailure.value = { text, chatId, ...describeSendError(error) }
    }
  } finally {
    pendingText.value = ''
    aiSending.value = false
    scrollAiToBottom()
    await nextTick()
    autosizeTextarea(composerEl.value)
    if (view.value === 'chat') focusComposer()
  }
}

function retryFailedMessage() {
  const failed = sendFailure.value
  if (!failed) return
  if (failed.chatId) activeAiChatId.value = failed.chatId
  void sendAiMessage(failed.text)
}

function askForAdmin() {
  sendFailure.value = null
  void sendAiMessage(t('supportResident.aiSuggestionAdmin'))
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
  <div class="app-view app-view--ai" :class="{ 'is-chat': view === 'chat' }">
    <div class="support-page">
      <p v-if="!residentId" class="support-hint" role="status">
        {{ t('supportResident.sessionMissing') }}
      </p>
      <p v-else-if="!ownerId" class="support-hint" role="status">
        {{ t('supportResident.ownerMissing') }}
      </p>
      <p v-if="syncError" class="support-hint" role="alert">
        {{ syncError }}
      </p>

      <!-- Ayuda: preguntas frecuentes + asistente -->
      <div v-if="view === 'faq'" class="help">
        <section class="help-hero" aria-labelledby="help-heading">
          <div class="help-hero__body">
            <h1 id="help-heading" class="help-hero__title">{{ t('supportResident.title') }}</h1>
            <p class="help-hero__sub">{{ t('supportResident.headerSubtitle') }}</p>

            <div class="help-search" role="search">
              <i class="pi pi-search" aria-hidden="true" />
              <label class="sr-only" for="faq-search">{{ t('supportResident.faqSearchLabel') }}</label>
              <input
                id="faq-search"
                v-model="faqQuery"
                type="search"
                autocomplete="off"
                :placeholder="t('supportResident.searchPlaceholder')"
              />
              <button
                v-if="faqQuery"
                type="button"
                class="help-search__clear"
                :aria-label="t('supportResident.faqClear')"
                @click="faqQuery = ''"
              >
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </div>

            <div class="topic-chips" v-bf-seg role="group" :aria-label="t('supportResident.topicsAria')">
              <button
                v-for="topic in FAQ_TOPICS"
                :key="topic.id"
                type="button"
                class="topic-chip"
                :class="{ 'is-active': activeTopic === topic.id }"
                :aria-pressed="activeTopic === topic.id"
                @click="toggleTopic(topic.id)"
              >
                <i class="pi" :class="topic.icon" aria-hidden="true" />
                {{ t(topic.labelKey) }}
              </button>
            </div>
          </div>
          <svg class="help-hero__art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
            <rect x="8" y="14" width="96" height="60" rx="18" fill="#ffffff" />
            <path d="M30 74 L26 92 L48 74 Z" fill="#ffffff" />
            <rect x="26" y="32" width="54" height="8" rx="4" fill="#c7d4f5" />
            <rect x="26" y="48" width="36" height="8" rx="4" fill="#c7d4f5" />
            <rect x="70" y="50" width="82" height="52" rx="16" fill="#1e3a8a" />
            <path d="M132 102 L138 116 L118 102 Z" fill="#1e3a8a" />
            <circle cx="94" cy="76" r="4.5" fill="#ffffff" />
            <circle cx="111" cy="76" r="4.5" fill="#ffffff" />
            <circle cx="128" cy="76" r="4.5" fill="#ffffff" />
          </svg>
        </section>

        <div class="help-grid">
          <aside class="assistant-card" aria-labelledby="assistant-heading">
            <div class="assistant-card__head">
              <span class="bot-avatar bot-avatar--lg" aria-hidden="true">
                <i class="pi pi-sparkles" />
              </span>
              <div>
                <h2 id="assistant-heading" class="assistant-card__name">{{ t('supportResident.assistantName') }}</h2>
                <p class="assistant-card__status">
                  <span class="online-dot" aria-hidden="true" />
                  {{ t('supportResident.assistantStatus') }}
                </p>
              </div>
            </div>
            <p class="assistant-card__intro">{{ t('supportResident.assistantIntro') }}</p>
            <p class="assistant-card__label">{{ t('supportResident.assistantTryLabel') }}</p>
            <ul class="ask-list" role="list">
              <li v-for="key in ASSISTANT_SUGGESTIONS" :key="key">
                <button
                  type="button"
                  class="ask-chip"
                  :disabled="aiSending || !residentId"
                  @click="askFromHelp(key)"
                >
                  <span>{{ t(`supportResident.${key}`) }}</span>
                  <i class="pi pi-arrow-up-right" aria-hidden="true" />
                </button>
              </li>
            </ul>
            <div class="assistant-card__actions">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="creatingBlank || !residentId"
                @click="startChatFromHelp"
              >
                <i class="pi pi-comments" aria-hidden="true" />
                {{ t('supportResident.startChat') }}
              </button>
              <button
                type="button"
                class="btn btn--secondary"
                :disabled="aiSending || !residentId"
                @click="talkToAdminFromHelp"
              >
                <i class="pi pi-user" aria-hidden="true" />
                {{ t('supportResident.talkToAdmin') }}
              </button>
            </div>
          </aside>

          <section class="faq" aria-labelledby="faq-heading">
            <div class="faq__head">
              <h2 id="faq-heading" class="faq__title">{{ t('supportResident.faqTitle') }}</h2>
              <span v-if="faqFiltered" class="faq__count" role="status">
                {{ t('supportResident.faqResultsCount', { n: filteredFaqs.length }, filteredFaqs.length) }}
              </span>
            </div>

            <ul v-if="filteredFaqs.length" class="faq-list" role="list">
              <li
                v-for="faq in filteredFaqs"
                :key="faq.id"
                class="faq-card"
                :class="[{ 'is-open': openFaqId === faq.id }, faq.topic ? `topic-${faq.topic}` : 'topic-general']"
              >
                <button
                  :id="`faq-q-${faq.id}`"
                  type="button"
                  class="faq-card__q"
                  :aria-expanded="openFaqId === faq.id"
                  :aria-controls="`faq-a-${faq.id}`"
                  @click="toggleFaq(faq.id)"
                >
                  <span class="faq-card__icon" aria-hidden="true">
                    <i class="pi" :class="faqIcon(faq)" />
                  </span>
                  <span class="faq-card__text">{{ t(faq.questionKey) }}</span>
                  <i class="pi pi-chevron-down faq-card__chev" aria-hidden="true" />
                </button>
                <div
                  v-show="openFaqId === faq.id"
                  :id="`faq-a-${faq.id}`"
                  class="faq-card__a"
                  role="region"
                  :aria-labelledby="`faq-q-${faq.id}`"
                >
                  <p>{{ t(faq.answerKey) }}</p>
                </div>
              </li>
            </ul>

            <div v-else class="faq-empty" role="status">
              <span class="faq-empty__icon" aria-hidden="true"><i class="pi pi-search" /></span>
              <p class="faq-empty__title">{{ t('supportResident.faqNoResults') }}</p>
              <div class="faq-empty__suggest">
                <span>{{ t('supportResident.faqSuggestions') }}</span>
                <button
                  v-for="term in faqSuggestions"
                  :key="term"
                  type="button"
                  class="suggest-chip"
                  @click="applyFaqSuggestion(term)"
                >
                  {{ term }}
                </button>
              </div>
              <div class="faq-empty__actions">
                <button type="button" class="btn btn--primary btn--sm" @click="startChatFromHelp">
                  <i class="pi pi-comments" aria-hidden="true" />
                  {{ t('supportResident.faqContactSupport') }}
                </button>
                <button type="button" class="btn btn--ghost btn--sm" @click="clearFaqFilters">
                  {{ t('supportResident.faqClearFilters') }}
                </button>
              </div>
            </div>

            <div v-if="filteredFaqs.length" class="faq-contact">
              <span>{{ t('supportResident.faqNotFound') }}</span>
              <button type="button" class="link-btn" @click="startChatFromHelp">
                {{ t('supportResident.faqContactSupport') }}
              </button>
            </div>
          </section>
        </div>
      </div>

      <!-- Chat con el asistente / administración -->
      <div v-else class="chat-shell" :class="{ 'has-list': hasHistory }">
        <aside
          v-if="hasHistory"
          id="chat-conversations"
          class="chat-list"
          :class="{ 'is-open': showConversations }"
          :aria-label="t('common.chatHistoryAria')"
        >
          <div class="chat-list__head">
            <h2 class="chat-list__title">{{ t('supportResident.conversationsTitle') }}</h2>
            <button
              type="button"
              class="icon-btn"
              :disabled="creatingBlank"
              :aria-label="t('supportResident.aiNewChat')"
              :title="t('supportResident.aiNewChat')"
              @click="newChatFromList"
            >
              <i class="pi pi-plus" aria-hidden="true" />
            </button>
          </div>
          <ul class="chat-list__items" role="list">
            <li v-for="chat in aiChats" :key="chat.id">
              <button
                type="button"
                class="conv"
                :class="{ 'is-active': chat.id === activeAiChatId }"
                :aria-current="chat.id === activeAiChatId ? 'true' : undefined"
                @click="selectConversation(chat.id)"
              >
                <span class="conv__title">{{ chat.title || t('supportResident.aiNewChat') }}</span>
                <span class="conv__meta">
                  <span v-if="chat.status === 'derived'" class="mini-pill mini-pill--amber">
                    {{ t('supportResident.labelAdmin') }}
                  </span>
                  <span v-else-if="chat.status === 'closed'" class="mini-pill">
                    {{ t('supportAdmin.statusClosed') }}
                  </span>
                  <span class="conv__when">{{ chatWhen(chat) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </aside>

        <section class="chat-main" aria-labelledby="chat-heading">
          <header class="chat-head">
            <button
              type="button"
              class="icon-btn chat-head__back"
              :aria-label="t('supportResident.backToFaqAria')"
              :title="t('supportResident.backToFaqAria')"
              @click="view = 'faq'"
            >
              <i class="pi pi-arrow-left" aria-hidden="true" />
            </button>
            <span class="bot-avatar" aria-hidden="true"><i class="pi pi-sparkles" /></span>
            <div class="chat-head__text">
              <h1 id="chat-heading" class="chat-head__name">{{ t('supportResident.assistantName') }}</h1>
              <p class="chat-head__status">
                <span class="online-dot" aria-hidden="true" />
                {{ t('supportResident.assistantStatus') }}
              </p>
            </div>
            <button
              v-if="hasHistory"
              type="button"
              class="pill-btn chat-head__convs"
              :aria-expanded="showConversations"
              aria-controls="chat-conversations"
              :aria-label="t('supportResident.conversationsToggleAria')"
              @click="showConversations = !showConversations"
            >
              <i class="pi pi-history" aria-hidden="true" />
              <span class="chat-head__convs-text">
                {{ t('supportResident.conversationsCount', { n: aiChats.length }, aiChats.length) }}
              </span>
              <span class="chat-head__convs-n" aria-hidden="true">{{ aiChats.length }}</span>
            </button>
            <button type="button" class="pill-btn chat-head__faq" @click="view = 'faq'">
              <i class="pi pi-question-circle" aria-hidden="true" />
              {{ t('supportResident.aiBackToFaqs') }}
            </button>
          </header>

          <div v-if="activeAiChat?.status === 'derived'" class="banner banner--amber" role="status">
            <i class="pi pi-users" aria-hidden="true" />
            <div>
              <strong>{{ t('supportResident.derivedBanner') }}</strong>
              <span>{{ t('supportResident.derivedBannerHint') }}</span>
            </div>
          </div>
          <div v-else-if="activeAiChat?.status === 'closed'" class="banner banner--gray" role="status">
            <i class="pi pi-lock" aria-hidden="true" />
            <div>
              <strong>{{ t('supportResident.statusClosed') }}</strong>
              <span>{{ t('supportResident.closedBannerHint') }}</span>
            </div>
          </div>

          <div v-if="!hasAiMessages" class="chat-empty">
            <span class="bot-avatar bot-avatar--xl" aria-hidden="true"><i class="pi pi-sparkles" /></span>
            <h2 class="chat-empty__title">{{ t('supportResident.aiGreeting') }}</h2>
            <p class="chat-empty__sub">{{ t('supportResident.assistantIntro') }}</p>
            <div class="chat-empty__chips">
              <button
                v-for="key in ASSISTANT_SUGGESTIONS"
                :key="key"
                type="button"
                class="ask-chip ask-chip--inline"
                :disabled="aiSending"
                @click="sendAiMessage(t(`supportResident.${key}`))"
              >
                {{ t(`supportResident.${key}`) }}
              </button>
              <button
                type="button"
                class="ask-chip ask-chip--inline ask-chip--admin"
                :disabled="aiSending"
                @click="onAiSuggestion('admin')"
              >
                <i class="pi pi-user" aria-hidden="true" />
                {{ t('supportResident.aiSuggestionAdmin') }}
              </button>
            </div>
          </div>

          <div
            v-else
            ref="aiMessagesEl"
            class="thread"
            role="log"
            aria-live="polite"
            :aria-label="t('supportResident.threadAria')"
          >
            <div
              v-for="m in displayMessages"
              :key="m.id"
              class="msg"
              :class="{
                'msg--user': m.role === 'user',
                'msg--ai': m.role === 'ai',
                'msg--admin': m.role === 'admin',
                'is-pending': m.pending,
              }"
            >
              <span v-if="m.role === 'ai'" class="bot-avatar bot-avatar--sm" aria-hidden="true">
                <i class="pi pi-sparkles" />
              </span>
              <span v-else-if="m.role === 'admin'" class="admin-avatar" aria-hidden="true">
                <i class="pi pi-user" />
              </span>
              <div class="msg__col">
                <span v-if="m.role === 'admin'" class="msg__label">{{ t('supportResident.labelAdmin') }}</span>
                <span v-else class="sr-only">{{ messageWho(m.role) }}:</span>
                <div class="msg__bubble">
                  <p>{{ m.body }}</p>
                </div>
                <span v-if="m.citedSource" class="source-pill">
                  <i class="pi pi-file" aria-hidden="true" />
                  {{ t('supportResident.sourceLabel') }}: {{ m.citedSource }}
                </span>
                <span class="msg__meta">
                  {{ m.pending ? t('supportResident.aiPending') : messageTime(m) }}
                </span>
              </div>
            </div>

            <div v-if="aiSending" class="msg msg--ai msg--typing">
              <span class="bot-avatar bot-avatar--sm" aria-hidden="true"><i class="pi pi-sparkles" /></span>
              <div class="msg__col">
                <div class="msg__bubble">
                  <span class="typing" aria-hidden="true"><span /><span /><span /></span>
                  <span class="sr-only">{{ t('supportResident.aiTyping') }}</span>
                </div>
              </div>
            </div>

            <div v-if="sendFailure" class="notice notice--red" role="alert">
              <i class="pi pi-exclamation-circle" aria-hidden="true" />
              <div class="notice__body">
                <p>{{ sendFailure.message }}</p>
                <div class="notice__actions">
                  <button
                    v-if="sendFailure.retryable"
                    type="button"
                    class="btn btn--danger btn--sm"
                    :disabled="aiSending"
                    @click="retryFailedMessage"
                  >
                    <i class="pi pi-refresh" aria-hidden="true" />
                    {{ t('supportResident.retry') }}
                  </button>
                  <button
                    v-if="sendFailure.offerAdmin"
                    type="button"
                    class="btn btn--ghost-danger btn--sm"
                    :disabled="aiSending"
                    @click="askForAdmin"
                  >
                    {{ t('supportResident.talkToAdmin') }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="aiNotice" class="notice notice--amber" role="status">
              <i class="pi pi-info-circle" aria-hidden="true" />
              <div class="notice__body"><p>{{ aiNotice }}</p></div>
            </div>
          </div>

          <div class="composer-dock">
            <div class="composer">
              <label class="sr-only" for="resident-composer">{{ t('supportResident.composerLabel') }}</label>
              <textarea
                id="resident-composer"
                ref="composerEl"
                v-model="aiInput"
                rows="1"
                :placeholder="t('supportResident.aiAskPlaceholder')"
                :disabled="aiSending"
                aria-describedby="resident-composer-hint"
                @input="onComposerInput"
                @keydown="onComposerKeydown"
              />
              <button
                type="button"
                class="composer__send"
                :disabled="aiSending || !aiInput.trim()"
                :aria-label="t('supportResident.send')"
                @click="sendAiMessage()"
              >
                <i class="pi pi-arrow-up" aria-hidden="true" />
              </button>
            </div>
            <p id="resident-composer-hint" class="composer-hint">{{ t('supportResident.composerHint') }}</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Visual language: AppDashboardView / AppFinanceView — solid soft tints, white cards, pills, no gradients. */
.app-view {
  --navy: #1e3a8a;
  --navy-hover: #172554;
  --ink: #0f172a;
  --muted: #6e6e73;
  --line: rgba(15, 23, 42, 0.07);
  --tint-blue: #e8eefc;
  --tint-green: #e3f4e8;
  --tint-orange: #fdeee2;
  --tint-amber: #fdf3dc;
  --tint-red: #fde4e4;
  --soft: #f4f6fa;
  padding: 1.25rem 1.5rem 1.5rem;
  width: 100%;
  max-width: 88rem;
  box-sizing: border-box;
}

.app-view--ai {
  flex: 1;
  min-height: 0;
  height: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.support-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.support-hint {
  margin: 0;
  padding: 0.6rem 0.9rem;
  border-radius: 12px;
  background: var(--tint-red);
  color: #b42318;
  font-size: 0.85rem;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0.68rem 1.1rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.btn--sm {
  padding: 0.45rem 0.9rem;
  font-size: 0.8125rem;
}

.btn--primary {
  background: var(--navy);
  color: #fff;
}

.btn--primary:hover:not(:disabled) {
  background: var(--navy-hover);
}

.btn--secondary {
  background: #fff;
  border-color: rgba(30, 58, 138, 0.22);
  color: var(--navy);
}

.btn--secondary:hover:not(:disabled) {
  background: var(--tint-blue);
}

.btn--ghost {
  background: transparent;
  color: var(--navy);
}

.btn--ghost:hover:not(:disabled) {
  background: var(--tint-blue);
}

.btn--danger {
  background: #b42318;
  color: #fff;
}

.btn--danger:hover:not(:disabled) {
  background: #912018;
}

.btn--ghost-danger {
  background: #fff;
  border-color: #f4b8b3;
  color: #b42318;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn:focus-visible,
.icon-btn:focus-visible,
.pill-btn:focus-visible,
.topic-chip:focus-visible,
.ask-chip:focus-visible,
.suggest-chip:focus-visible,
.faq-card__q:focus-visible,
.conv:focus-visible,
.link-btn:focus-visible,
.help-search__clear:focus-visible,
.composer__send:focus-visible {
  outline: 2px solid var(--navy);
  outline-offset: 2px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: #fff;
  color: var(--ink);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--tint-blue);
  color: var(--navy);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.pill-btn:hover {
  background: var(--tint-blue);
  color: var(--navy);
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  color: var(--navy);
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

/* ---------- Avatars ---------- */
.bot-avatar,
.admin-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: var(--navy);
  color: #fff;
  font-size: 1rem;
}

.bot-avatar--lg {
  width: 3rem;
  height: 3rem;
  font-size: 1.2rem;
}

.bot-avatar--xl {
  width: 3.5rem;
  height: 3.5rem;
  font-size: 1.35rem;
}

.bot-avatar--sm,
.admin-avatar {
  width: 1.85rem;
  height: 1.85rem;
  font-size: 0.78rem;
}

.admin-avatar {
  background: var(--tint-green);
  color: #146c43;
}

.online-dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #22a559;
  flex-shrink: 0;
}

/* ---------- Help (FAQ) ---------- */
.help {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-bottom: 0.5rem;
}

.help-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.75rem 2rem;
  border-radius: 18px;
  background: var(--tint-blue);
}

.help-hero__body {
  flex: 1;
  min-width: 0;
  max-width: 44rem;
}

.help-hero__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ink);
}

.help-hero__sub {
  margin: 0.3rem 0 0;
  font-size: 0.9rem;
  color: #4b5563;
}

.help-hero__art {
  flex-shrink: 0;
  width: 10rem;
  height: auto;
}

.help-search {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1.1rem;
  padding: 0.7rem 0.9rem 0.7rem 1.1rem;
  border: 1px solid rgba(30, 58, 138, 0.12);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
}

.help-search:focus-within {
  border-color: var(--navy);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.16);
}

.help-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.95rem;
  color: var(--ink);
}

.help-search__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 50%;
  background: var(--soft);
  color: var(--muted);
  cursor: pointer;
}

.topic-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 0.85rem;
  padding: 4px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.06);
}

.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.9rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: #64748b;
  transition: color 0.28s ease;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.topic-chip .pi {
  font-size: 0.8rem;
  color: var(--navy);
}

.topic-chip:hover {
  color: #0f172a;
}

.topic-chip.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.topic-chip.is-active .pi {
  color: var(--navy);
}

.help-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  grid-template-areas: 'faq assistant';
  gap: 1rem;
  align-items: start;
}

/* FAQ list */
.faq {
  grid-area: faq;
  min-width: 0;
}

.faq__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0.25rem 0.15rem 0.65rem;
}

.faq__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.faq__count {
  font-size: 0.8rem;
  color: var(--muted);
}

.faq-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.faq-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  overflow: hidden;
}

.faq-card.is-open {
  border-color: rgba(30, 58, 138, 0.18);
}

.faq-card__q {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  width: 100%;
  padding: 0.8rem 1rem;
  border: none;
  background: none;
  text-align: left;
  font: inherit;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}

.faq-card__q:hover .faq-card__text {
  color: var(--navy);
}

.faq-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  font-size: 0.85rem;
  background: var(--soft);
  color: #475467;
}

.topic-payments .faq-card__icon { background: var(--tint-blue); color: var(--navy); }
.topic-bookings .faq-card__icon { background: var(--tint-green); color: #146c43; }
.topic-incidents .faq-card__icon { background: var(--tint-orange); color: #b54708; }
.topic-guests .faq-card__icon { background: var(--tint-amber); color: #8a5a00; }
.topic-account .faq-card__icon { background: var(--tint-red); color: #b42318; }

.faq-card__text {
  flex: 1;
  min-width: 0;
}

.faq-card__chev {
  flex-shrink: 0;
  font-size: 0.8rem;
  color: var(--muted);
  transition: transform 0.2s ease;
}

.faq-card.is-open .faq-card__chev {
  transform: rotate(180deg);
  color: var(--navy);
}

.faq-card__a {
  padding: 0 1.1rem 1rem 3.9rem;
}

.faq-card__a p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.55;
  color: #424245;
  white-space: pre-line;
}

.faq-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
  padding: 2rem 1.25rem;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  text-align: center;
}

.faq-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: var(--tint-blue);
  color: var(--navy);
}

.faq-empty__title {
  margin: 0;
  font-weight: 600;
  color: var(--ink);
}

.faq-empty__suggest {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.faq-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.suggest-chip {
  padding: 0.3rem 0.8rem;
  border: none;
  border-radius: 999px;
  background: var(--tint-blue);
  color: var(--navy);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.suggest-chip:hover {
  background: #d9e3fa;
}

.faq-contact {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 0.15rem 0;
  font-size: 0.875rem;
  color: var(--muted);
}

/* Assistant card */
.assistant-card {
  grid-area: assistant;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1.35rem;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
}

.assistant-card__head {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}

.assistant-card__name {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.assistant-card__status {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: var(--muted);
}

.assistant-card__status .online-dot {
  margin-top: 0.3rem;
}

.assistant-card__intro {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #424245;
}

.assistant-card__label {
  margin: 0.15rem 0 -0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted);
}

.ask-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.ask-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.9rem;
  border: none;
  border-radius: 14px;
  background: var(--soft);
  color: var(--ink);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.ask-chip .pi {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--navy);
}

.ask-chip:hover:not(:disabled) {
  background: var(--tint-blue);
  color: var(--navy);
}

.ask-chip:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ask-chip--inline {
  width: auto;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #fff;
}

.ask-chip--admin {
  background: var(--tint-green);
  border-color: transparent;
  color: #146c43;
}

.ask-chip--admin .pi {
  color: #146c43;
}

.assistant-card__actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

/* ---------- Chat ---------- */
.chat-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  overflow: hidden;
}

.chat-shell.has-list {
  grid-template-columns: 16rem minmax(0, 1fr);
}

.chat-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: #fafbfd;
}

.chat-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 1rem 0.85rem 0.6rem 1.1rem;
}

.chat-list__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--ink);
}

.chat-list__items {
  list-style: none;
  margin: 0;
  padding: 0 0.6rem 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.conv {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: none;
  border-radius: 12px;
  background: transparent;
  text-align: left;
  font: inherit;
  color: var(--ink);
  cursor: pointer;
}

.conv:hover {
  background: #f0f3f9;
}

.conv.is-active {
  background: var(--tint-blue);
}

.conv__title {
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv.is-active .conv__title {
  color: var(--navy);
}

.conv__meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  color: var(--muted);
}

.mini-pill {
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: #eef0f4;
  color: #475467;
  font-size: 0.68rem;
  font-weight: 600;
}

.mini-pill--amber {
  background: var(--tint-amber);
  color: #8a5a00;
}

.chat-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.chat-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--line);
}

.chat-head__back,
.chat-head__convs,
.chat-head__convs-n {
  display: none;
}

.chat-head__text {
  flex: 1;
  min-width: 0;
}

.chat-head__name {
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.chat-head__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.1rem 0 0;
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.banner {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  margin: 0.75rem 1.25rem 0;
  padding: 0.7rem 0.95rem;
  border-radius: 14px;
  font-size: 0.84rem;
  line-height: 1.4;
}

.banner .pi {
  margin-top: 0.15rem;
}

.banner div {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.4rem;
}

.banner--amber {
  background: var(--tint-amber);
  color: #7a4f00;
}

.banner--gray {
  background: #eef0f4;
  color: #475467;
}

.chat-empty {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 2rem 1.5rem;
  text-align: center;
}

.chat-empty__title {
  margin: 0.4rem 0 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.3rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  color: var(--ink);
}

.chat-empty__sub {
  margin: 0;
  max-width: 30rem;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--muted);
}

.chat-empty__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.45rem;
  max-width: 40rem;
  margin-top: 0.6rem;
}

.thread {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.25rem max(1.25rem, calc(50% - 25rem)) 0.75rem;
}

.msg {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  max-width: 82%;
}

.msg__col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
  min-width: 0;
}

.msg__bubble {
  padding: 0.7rem 0.95rem;
  border-radius: 18px 18px 18px 6px;
  background: var(--soft);
  color: var(--ink);
}

.msg__bubble p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.msg__label {
  font-size: 0.72rem;
  font-weight: 700;
  color: #146c43;
}

.msg__meta {
  padding: 0 0.3rem;
  font-size: 0.7rem;
  color: #8e8e93;
}

.msg--user {
  align-self: flex-end;
}

.msg--user .msg__col {
  align-items: flex-end;
}

.msg--user .msg__bubble {
  border-radius: 18px 18px 6px 18px;
  background: var(--navy);
  color: #fff;
}

.msg--ai {
  align-self: flex-start;
}

.msg--admin .admin-avatar {
  margin-top: 1.3rem;
}

.msg--admin {
  align-self: flex-start;
}

.msg--admin .msg__bubble {
  background: var(--tint-green);
}

.msg.is-pending .msg__bubble {
  opacity: 0.6;
}

.source-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.22rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: #475467;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-pill .pi {
  font-size: 0.7rem;
  color: var(--navy);
}

.typing {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  height: 1.35rem;
  padding: 0 0.1rem;
}

.typing span {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: #98a2b3;
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.55; }
  30% { transform: translateY(-4px); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .typing span {
    animation: none;
  }
}

.notice {
  align-self: stretch;
  display: flex;
  gap: 0.65rem;
  padding: 0.75rem 0.95rem;
  border-radius: 14px;
  font-size: 0.85rem;
  line-height: 1.45;
}

.notice > .pi {
  margin-top: 0.2rem;
}

.notice__body p {
  margin: 0;
}

.notice__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.55rem;
}

.notice--red {
  background: var(--tint-red);
  color: #b42318;
}

.notice--amber {
  background: var(--tint-amber);
  color: #7a4f00;
}

.composer-dock {
  flex-shrink: 0;
  padding: 0.6rem max(1.25rem, calc(50% - 25rem)) 0.9rem;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.35rem 0.35rem 0.35rem 1.1rem;
  border: 1px solid #dde2ea;
  border-radius: 26px;
  background: #fff;
}

.composer:focus-within {
  border-color: var(--navy);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.composer textarea {
  flex: 1;
  min-width: 0;
  min-height: 2.5rem;
  max-height: 140px;
  padding: 0.6rem 0;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  font: inherit;
  font-size: 0.92rem;
  line-height: 1.35;
  color: var(--ink);
  box-sizing: border-box;
}

.composer textarea:disabled {
  color: var(--muted);
}

.composer__send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border: none;
  border-radius: 50%;
  background: var(--navy);
  color: #fff;
  cursor: pointer;
}

.composer__send:hover:not(:disabled) {
  background: var(--navy-hover);
}

.composer__send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.composer-hint {
  margin: 0.35rem 0 0;
  text-align: center;
  font-size: 0.7rem;
  color: #8e8e93;
}

/* ---------- Responsive ---------- */
@media (max-width: 1100px) {
  .help-grid {
    grid-template-columns: minmax(0, 1fr) 19rem;
  }
}

@media (max-width: 900px) {
  .help-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'assistant' 'faq';
  }

  .assistant-card {
    position: static;
  }

  .help-hero__art {
    display: none;
  }

  .chat-shell,
  .chat-shell.has-list {
    display: flex;
    flex-direction: column;
  }

  .chat-main {
    flex: 1;
  }

  .chat-list {
    display: none;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .chat-list.is-open {
    display: flex;
  }

  .chat-list__items {
    max-height: 13rem;
  }

  .chat-head__convs {
    display: inline-flex;
  }
}

/* Phone (stacked app nav, see AppShellView): the page scrolls; the chat keeps a usable height. */
@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 1.5rem;
  }

  .app-view--ai {
    height: auto;
    max-height: none;
    overflow: visible;
  }

  .support-page,
  .help {
    flex: none;
    overflow: visible;
  }

  .help-hero {
    padding: 1.25rem 1.1rem;
  }

  .help-hero__title {
    font-size: 1.35rem;
  }

  .assistant-card {
    padding: 1.1rem;
  }

  .faq-card__a {
    padding-left: 1rem;
  }

  .chat-shell {
    flex: none;
    height: calc(100dvh - 2rem);
    min-height: 32rem;
  }

  .chat-head {
    gap: 0.55rem;
    padding: 0.7rem 0.8rem;
  }

  .chat-head__back {
    display: inline-flex;
  }

  .chat-head__faq {
    display: none;
  }

  .chat-head .bot-avatar {
    width: 2.1rem;
    height: 2.1rem;
    font-size: 0.85rem;
  }

  .chat-head__convs {
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
  }

  .chat-head__convs-text {
    display: none;
  }

  .chat-head__convs-n {
    display: inline;
  }

  .chat-head__status {
    white-space: normal;
  }

  .banner {
    margin: 0.6rem 0.8rem 0;
  }

  .thread {
    padding: 1rem 0.8rem 0.5rem;
  }

  .msg {
    max-width: 92%;
  }

  .composer-dock {
    padding: 0.5rem 0.8rem 0.8rem;
  }

  .composer-hint {
    display: none;
  }
}
</style>
