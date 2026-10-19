<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { ChatStatus, isPendingChat, supportApi } from '@/residentCare/infrastructure/supportApi.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { foldText } from '@/residentCare/domain/faq.js'
import { autosizeTextarea, formatClock, initials, relativeTime } from '@/residentCare/domain/supportFormat.js'
import { useSession, getActiveDataOwnerId } from '@/iam/application/sessionStore.js'
import {
  isDocumentVisible,
  joinSupportOwner,
  onSupportChatUpdated,
  realtimeAvailable,
} from '@/residentCare/infrastructure/supportRealtime.js'
import { confirmSuccess, isFresh, markFresh } from '@/shared/presentation/feedback/successFeedback.js'

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
/** US032: 'pending' | 'answered' | 'all'. */
const filter = ref('all')
const statusBusy = ref(false)
const aiUsage = ref(null)

const searchQuery = ref('')
const replyEl = ref(null)
/** residentId → { floor, code } (best effort, para mostrar el departamento). */
const residentUnits = ref({})

const ownerId = computed(() => getActiveDataOwnerId() || sessionState.profile?.id || '')
const selected = computed(() => chats.value.find((row) => row.id === selectedId.value) || null)
const pendingCount = computed(() => chats.value.filter(isPendingChat).length)
const answeredCount = computed(() => chats.value.filter((row) => row.status === ChatStatus.ANSWERED).length)
const statusFilteredChats = computed(() => {
  if (filter.value === 'pending') return chats.value.filter(isPendingChat)
  if (filter.value === 'answered') return chats.value.filter((row) => row.status === ChatStatus.ANSWERED)
  return chats.value
})
const filteredChats = computed(() => {
  const terms = foldText(searchQuery.value).split(' ').filter(Boolean)
  if (!terms.length) return statusFilteredChats.value
  return statusFilteredChats.value.filter((row) => {
    const unit = residentUnits.value[row.residentId]
    const haystack = foldText(
      `${row.residentName} ${row.topic} ${row.title} ${unit?.code ?? ''} ${lastMessage(row)?.body ?? ''}`,
    )
    return terms.every((term) => haystack.includes(term))
  })
})

const filterOptions = computed(() => [
  { id: 'pending', label: t('supportAdmin.filterPending'), count: pendingCount.value },
  { id: 'answered', label: t('supportAdmin.filterAnswered'), count: answeredCount.value },
  { id: 'all', label: t('supportAdmin.filterAll'), count: chats.value.length },
])

/** AI usage: ratio del tope mensual → tono (≥80 % ámbar, tope rojo). */
const usageTone = computed(() => {
  const usage = aiUsage.value
  if (!usage) return 'ok'
  if (usage.capReached || (usage.cap > 0 && usage.used >= usage.cap)) return 'reached'
  if (usage.cap > 0 && usage.used / usage.cap >= 0.8) return 'near'
  return 'ok'
})

const usageHint = computed(() => {
  if (usageTone.value === 'reached') return t('supportAdmin.aiUsageReached')
  return usageTone.value === 'near' ? t('supportAdmin.usageNear') : t('supportAdmin.usageOk')
})
const usagePercent = computed(() => {
  const usage = aiUsage.value
  if (!usage?.cap) return 0
  return Math.min(100, Math.round((usage.used / usage.cap) * 100))
})

function isDerived(row) {
  return row?.source === 'ai-escalation' || row?.status === ChatStatus.DERIVED
}

function statusLabel(row) {
  if (row?.status === ChatStatus.CLOSED) return t('supportAdmin.statusClosed')
  if (isPendingChat(row)) return isDerived(row) ? t('supportAdmin.statusDerived') : t('supportAdmin.statusOpen')
  if (row?.status === ChatStatus.DERIVED) return t('supportAdmin.statusDerived')
  return t('supportAdmin.statusAnswered')
}

function statusClass(row) {
  if (row?.status === ChatStatus.CLOSED) return 'is-closed'
  if (row?.status === ChatStatus.DERIVED) return 'is-derived'
  if (isPendingChat(row)) return isDerived(row) ? 'is-derived' : 'is-pending'
  return 'is-answered'
}

const AVATAR_TONES = ['tone-blue', 'tone-green', 'tone-orange', 'tone-amber', 'tone-red']

/** Tinte estable por residente para el avatar de iniciales. */
function avatarTone(row) {
  const key = String(row?.residentId || row?.residentName || '')
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]
}

function residentName(row) {
  return row?.residentName || row?.residentId || '—'
}

function residentDept(row) {
  const code = residentUnits.value[row?.residentId]?.code
  return code ? t('supportAdmin.deptLabel', { code }) : ''
}

function lastMessage(row) {
  const list = row?.messages || []
  return list.length ? list[list.length - 1] : null
}

function snippet(row) {
  const last = lastMessage(row)
  if (!last) return ''
  const body = String(last.body || '').replace(/\s+/g, ' ').trim()
  if (last.authorRole === 'admin') return `${t('supportAdmin.snippetYou')}: ${body}`
  if (last.authorRole === 'assistant' || last.authorRole === 'ai') return `${t('supportAdmin.snippetAi')}: ${body}`
  return body
}

function whenShort(row) {
  return relativeTime(row?.updatedAt || row?.createdAt, locale.value, t('supportAdmin.justNow'))
}

function messageTime(m) {
  return formatClock(m?.createdAt, locale.value)
}

function msgKind(m) {
  if (m.authorRole === 'admin') return 'admin'
  if (m.authorRole === 'assistant' || m.authorRole === 'ai') return 'ai'
  return 'resident'
}

/** Motivo de la derivación: la nota del asistente dentro del chat derivado, si la hay. */
const derivedReason = computed(() => {
  const row = selected.value
  if (!isDerived(row)) return ''
  const note = (row.messages || []).find((m) => msgKind(m) === 'ai')
  return note?.body || t('supportAdmin.derivedReasonDefault')
})

async function loadResidentUnits() {
  try {
    const list = await residentsApi.list()
    residentUnits.value = Object.fromEntries(
      list.map((r) => [String(r.id), { floor: r.floor || '', code: r.code || '' }]),
    )
  } catch {
    residentUnits.value = {}
  }
}

function backToInbox() {
  selectedId.value = null
}

function onReplyInput(event) {
  autosizeTextarea(event.target)
}

/** Enter envía; Shift+Enter hace salto de línea. */
function onReplyKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void sendReply()
}

function refreshAll() {
  void loadAiUsage()
  void bindChats()
}

async function setSelectedStatus(status, event = null) {
  const id = selected.value?.id
  if (!id || statusBusy.value) return
  statusBusy.value = true
  try {
    const updated = status === ChatStatus.CLOSED
      ? await supportApi.closeChat(id)
      : await supportApi.updateStatus(id, status)
    if (status === 'answered') {
      await confirmSuccess(event, t('feedback.markedAttended'))
      markFresh('supportChat', id)
    }
    upsertChat(updated)
    loadError.value = ''
  } catch (e) {
    console.error(e)
    loadError.value = t('supportAdmin.statusError')
  } finally {
    statusBusy.value = false
  }
}

async function loadAiUsage() {
  try {
    aiUsage.value = await supportApi.getAiUsage()
  } catch {
    aiUsage.value = null
  }
}

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
  if (role === 'assistant' || role === 'ai') return t('supportAdmin.badgeAi')
  return role
}

let pollTimer = 0
let stopHub = null
/** Set on unmount: async work resumed after an await must not (re)register anything. */
let disposed = false

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

watch(selectedId, async (id) => {
  if (!id) return
  scrollToBottom()
  await nextTick()
  autosizeTextarea(replyEl.value)
})

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
  if (disposed || !ownerId.value) return
  // The handler is kept across hub reconnections; polling covers the gaps
  // (it runs whenever `realtimeAvailable` is false).
  stopHub = onSupportChatUpdated((payload) => {
    if (payload?.kind === 'admin') upsertChat({
      ...payload,
      topic: payload.topic || payload.title,
      messages: payload.messages || [],
    })
  })
  await joinSupportOwner(ownerId.value)
}

function startFallbackPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  if (disposed) return
  pollTimer = window.setInterval(() => {
    if (!isDocumentVisible() || realtimeAvailable.value) return
    void bindChats({ silent: true, incremental: true })
  }, 8000)
}

watch(ownerId, async () => {
  void loadAiUsage()
  void loadResidentUnits()
  await bindChats()
  if (disposed) return
  await bindRealtime()
  if (disposed) return
  startFallbackPolling()
}, { immediate: true })

// Back online after a reconnect / rebuild: catch up on what was missed while offline.
watch(realtimeAvailable, (ok) => {
  if (ok && !disposed) void bindChats({ silent: true, incremental: true })
})

function onVisibility() {
  if (isDocumentVisible()) void bindChats({ silent: true, incremental: true })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility)
}

onUnmounted(() => {
  disposed = true
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = 0
  stopHub?.()
  stopHub = null
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
})

async function sendReply() {
  const id = selected.value?.id
  const text = replyText.value.trim()
  if (!id || !text || sending.value || !ownerId.value) return
  sending.value = true
  const knownIds = new Set((selected.value?.messages || []).map((m) => m.id))
  try {
    const updated = await supportApi.postMessage(id, text, locale.value)
    upsertChat(updated)
    // Icon-only send button: no green button, only the new bubble lights up.
    const sentMessages = (updated?.messages || []).filter((m) => !knownIds.has(m.id) && msgKind(m) === 'admin')
    sentMessages.forEach((m) => markFresh('supportMsg', m.id))
    replyText.value = ''
    loadError.value = ''
    await nextTick()
    autosizeTextarea(replyEl.value)
  } catch (e) {
    console.error(e)
    loadError.value = t('supportAdmin.sendError')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="app-view app-view--ai">
    <div class="support-page">
      <h1 class="bf-sr-only">{{ t('supportAdmin.title') }}</h1>

      <p v-if="loadError" class="support-hint" role="alert">
        {{ loadError }}
      </p>

      <div class="help-shell" :class="{ 'has-selection': !!selected }">
        <aside class="inbox" :aria-label="t('supportAdmin.inboxHeading')">
            <div
              v-if="aiUsage"
              class="usage-card"
              :class="`is-${usageTone}`"
              role="group"
              :aria-label="t('supportAdmin.usageAria', { used: aiUsage.used, cap: aiUsage.cap })"
              :title="usageHint"
            >
              <span class="usage-card__icon" aria-hidden="true"><i class="pi pi-sparkles" /></span>
              <div class="usage-card__body">
                <div class="usage-card__row">
                  <span class="usage-card__label">{{ t('supportAdmin.usageTitle') }}</span>
                  <span class="usage-card__value">{{ t('supportAdmin.usageValue', { used: aiUsage.used, cap: aiUsage.cap }) }}</span>
                </div>
                <div
                  v-if="aiUsage.cap"
                  class="usage-bar"
                  role="progressbar"
                  :aria-valuenow="aiUsage.used"
                  aria-valuemin="0"
                  :aria-valuemax="aiUsage.cap"
                  :aria-label="t('supportAdmin.usageTitle')"
                >
                  <span :style="{ width: `${usagePercent}%` }" />
                </div>
                <span class="bf-sr-only">{{ usageHint }}</span>
              </div>
            </div>
          <div class="inbox__tools">
            <div class="filter-pills" v-bf-seg role="group" :aria-label="t('supportAdmin.filterAria')">
              <button
                v-for="opt in filterOptions"
                :key="opt.id"
                type="button"
                class="filter-pill"
                :class="[{ 'is-active': filter === opt.id }, `filter-pill--${opt.id}`]"
                :aria-pressed="filter === opt.id"
                @click="filter = opt.id"
              >
                {{ opt.label }}
                <span class="filter-pill__count" aria-hidden="true">{{ opt.count }}</span>
                <span class="sr-only">({{ t('supportAdmin.filterCountAria', { n: opt.count }, opt.count) }})</span>
              </button>
            </div>
          </div>

          <div class="inbox__search-row">
          <div class="inbox-search" role="search">
            <i class="pi pi-search" aria-hidden="true" />
            <label class="sr-only" for="inbox-search">{{ t('supportAdmin.searchLabel') }}</label>
            <input
              id="inbox-search"
              v-model="searchQuery"
              type="search"
              autocomplete="off"
              :placeholder="t('supportAdmin.searchPlaceholder')"
            />
            <button
              v-if="searchQuery"
              type="button"
              class="inbox-search__clear"
              :aria-label="t('supportAdmin.searchClear')"
              @click="searchQuery = ''"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </div>
            <button
              type="button"
              class="icon-btn"
              :disabled="loadingList"
              :aria-label="t('supportAdmin.refresh')"
              :title="t('supportAdmin.refresh')"
              @click="refreshAll"
            >
              <i class="pi pi-refresh" :class="{ 'pi-spin': loadingList }" aria-hidden="true" />
            </button>
          </div>

          <p v-if="loadingList && !chats.length" class="inbox__empty" role="status">
            {{ t('supportAdmin.loadingList') }}
          </p>
          <p v-else-if="!chats.length" class="inbox__empty">
            {{ t('supportAdmin.emptyList') }}
          </p>
          <p v-else-if="!filteredChats.length" class="inbox__empty" role="status">
            {{ searchQuery.trim() ? t('supportAdmin.emptySearch', { q: searchQuery.trim() }) : t('supportAdmin.emptyFiltered') }}
          </p>
          <ul v-else class="inbox__list" role="list">
            <li v-for="c in filteredChats" :key="c.id">
              <button
                type="button"
                class="chat-card"
                :class="{ 'is-active': c.id === selectedId, 'bf-fresh': isFresh('supportChat', c.id) }"
                :aria-current="c.id === selectedId ? 'true' : undefined"
                @click="selectChat(c)"
              >
                <span class="avatar" :class="avatarTone(c)" aria-hidden="true">
                  {{ initials(residentName(c)) }}
                  <span v-if="isPendingChat(c)" class="avatar__dot" />
                </span>
                <span class="chat-card__body">
                  <span class="chat-card__row">
                    <span class="chat-card__name">
                      {{ residentName(c) }}
                      <span v-if="residentDept(c)" class="chat-card__dept">· {{ residentDept(c) }}</span>
                    </span>
                    <span class="chat-card__when">{{ whenShort(c) }}</span>
                  </span>
                  <span class="chat-card__topic">{{ c.topic || '—' }}</span>
                  <span class="chat-card__row">
                    <span class="chat-card__snippet">{{ snippet(c) }}</span>
                    <span class="status-pill" :class="statusClass(c)">{{ statusLabel(c) }}</span>
                  </span>
                  <span v-if="isPendingChat(c)" class="sr-only">{{ t('supportAdmin.pendingDotAria') }}</span>
                </span>
              </button>
            </li>
          </ul>
        </aside>

        <section class="pane" aria-labelledby="help-prompt-heading">
          <div v-if="!selected" class="pane-empty">
            <svg class="pane-empty__art" viewBox="0 0 200 150" aria-hidden="true" focusable="false">
              <circle cx="100" cy="78" r="66" fill="#e8eefc" />
              <rect x="44" y="40" width="88" height="56" rx="16" fill="#ffffff" />
              <path d="M64 96 L58 114 L82 96 Z" fill="#ffffff" />
              <rect x="60" y="56" width="50" height="7" rx="3.5" fill="#c7d4f5" />
              <rect x="60" y="71" width="34" height="7" rx="3.5" fill="#c7d4f5" />
              <rect x="96" y="76" width="66" height="44" rx="14" fill="#1e3a8a" />
              <path d="M146 120 L152 134 L132 120 Z" fill="#1e3a8a" />
              <circle cx="114" cy="98" r="4" fill="#ffffff" />
              <circle cx="129" cy="98" r="4" fill="#ffffff" />
              <circle cx="144" cy="98" r="4" fill="#ffffff" />
              <circle cx="150" cy="40" r="11" fill="#e3f4e8" />
              <path d="M145 40 L149 44 L156 36" stroke="#146c43" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <h2 id="help-prompt-heading" class="pane-empty__title">{{ t('supportAdmin.emptyHeading') }}</h2>
            <p class="pane-empty__sub">{{ t('supportAdmin.selectPrompt') }}</p>
          </div>

          <template v-else>
            <header class="pane-head">
              <button
                type="button"
                class="icon-btn pane-head__back"
                :aria-label="t('supportAdmin.backToInbox')"
                :title="t('supportAdmin.backToInbox')"
                @click="backToInbox"
              >
                <i class="pi pi-arrow-left" aria-hidden="true" />
              </button>
              <span class="avatar avatar--lg" :class="avatarTone(selected)" aria-hidden="true">{{ initials(residentName(selected)) }}</span>
              <div class="pane-head__text">
                <h2 id="help-prompt-heading" class="pane-head__name">
                  {{ residentName(selected) }}
                  <span class="status-pill" :class="statusClass(selected)">{{ statusLabel(selected) }}</span>
                </h2>
                <p class="pane-head__meta">
                  <span v-if="residentDept(selected)">{{ residentDept(selected) }} · </span>
                  <span>{{ t('supportAdmin.topicLabel') }}: {{ selected.topic || '—' }}</span>
                  <span v-if="selected.createdAt"> · {{ t('supportAdmin.openedOn', { date: formatWhen(selected.createdAt) }) }}</span>
                </p>
              </div>
              <div class="pane-head__actions" role="group" :aria-label="t('supportAdmin.actionsAria')">
                <button
                  v-if="selected.status !== 'answered'"
                  type="button"
                  class="btn btn--primary btn--sm"
                  :disabled="statusBusy"
                  @click="setSelectedStatus('answered', $event)"
                >
                  <i class="pi pi-check" aria-hidden="true" />
                  <span>{{ t('supportAdmin.markAnswered') }}</span>
                </button>
                <button
                  v-if="selected.status !== 'open'"
                  type="button"
                  class="btn btn--secondary btn--sm"
                  :disabled="statusBusy"
                  @click="setSelectedStatus('open')"
                >
                  <i class="pi" :class="selected.status === 'closed' ? 'pi-replay' : 'pi-inbox'" aria-hidden="true" />
                  {{ selected.status === 'closed' ? t('supportAdmin.reopenChat') : t('supportAdmin.markPending') }}
                </button>
                <button
                  v-if="selected.status !== 'closed'"
                  type="button"
                  class="btn btn--secondary btn--sm"
                  :disabled="statusBusy"
                  @click="setSelectedStatus('closed')"
                >
                  <i class="pi pi-lock" aria-hidden="true" />
                  {{ t('supportAdmin.closeChat') }}
                </button>
              </div>
            </header>

            <div v-if="isDerived(selected)" class="banner banner--amber" role="note">
              <i class="pi pi-sparkles" aria-hidden="true" />
              <div>
                <strong>{{ t('supportAdmin.derivedBannerTitle') }}</strong>
                <span>{{ t('supportAdmin.derivedReasonLabel') }}: {{ derivedReason }}</span>
              </div>
            </div>
            <div v-if="selected.status === 'closed'" class="banner banner--gray" role="note">
              <i class="pi pi-lock" aria-hidden="true" />
              <div><span>{{ t('supportAdmin.closedNotice') }}</span></div>
            </div>

            <div
              ref="messagesEl"
              class="thread"
              role="log"
              aria-live="polite"
              :aria-label="t('supportAdmin.threadAria', { name: residentName(selected) })"
            >
              <div
                v-for="m in selected.messages || []"
                :key="m.id"
                class="msg"
                :class="`msg--${msgKind(m)}`"
              >
                <span v-if="msgKind(m) === 'ai'" class="bot-avatar" aria-hidden="true"><i class="pi pi-sparkles" /></span>
                <span v-else-if="msgKind(m) === 'resident'" class="avatar avatar--sm" :class="avatarTone(selected)" aria-hidden="true">
                  {{ initials(residentName(selected)) }}
                </span>
                <div class="msg__col">
                  <span class="msg__label">
                    {{ bubbleRole(m.authorRole) }}
                    <span class="msg__time">{{ messageTime(m) }}</span>
                  </span>
                  <div class="msg__bubble" :class="{ 'bf-fresh': isFresh('supportMsg', m.id) }"><p>{{ m.body }}</p></div>
                  <span v-if="m.citedSource" class="source-pill">
                    <i class="pi pi-file" aria-hidden="true" />
                    {{ t('supportAdmin.sourceLabel') }}: {{ m.citedSource }}
                  </span>
                </div>
                <span v-if="msgKind(m) === 'admin'" class="admin-avatar" aria-hidden="true">
                  <i class="pi pi-building" />
                </span>
              </div>
            </div>

            <div class="composer-dock">
              <div class="composer">
                <label class="sr-only" for="admin-reply">{{ t('supportAdmin.messagePlaceholder') }}</label>
                <textarea
                  id="admin-reply"
                  ref="replyEl"
                  v-model="replyText"
                  rows="1"
                  :placeholder="t('supportAdmin.messagePlaceholder')"
                  :disabled="sending"
                  aria-describedby="admin-reply-hint"
                  @input="onReplyInput"
                  @keydown="onReplyKeydown"
                />
                <button
                  type="button"
                  class="composer__send"
                  :disabled="sending || !replyText.trim()"
                  :aria-label="t('supportAdmin.send')"
                  @click="sendReply()"
                >
                  <i class="pi pi-arrow-up" aria-hidden="true" />
                </button>
              </div>
              <p id="admin-reply-hint" class="composer-hint">{{ t('supportAdmin.composerHint') }}</p>
            </div>
          </template>
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
  gap: 1rem;
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

.usage-card {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  width: 100%;
  padding: 0.5rem 0.85rem 0.55rem 0.5rem;
  border-radius: 16px;
  background: var(--tint-blue);
  box-sizing: border-box;
}

.usage-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #fff;
  color: var(--navy);
  font-size: 0.85rem;
}

.usage-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.usage-card__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.usage-card__label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted);
}

.usage-card__value {
  font-family: var(--bf-font-heading, inherit);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
}

.usage-bar {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  overflow: hidden;
}

.usage-bar span {
  display: block;
  height: 100%;
  min-width: 4px;
  border-radius: 999px;
  background: var(--navy);
}

.usage-card.is-near {
  background: var(--tint-amber);
}

.usage-card.is-near .usage-card__icon {
  color: #8a5a00;
}

.usage-card.is-near .usage-bar span {
  background: #d97706;
}

.usage-card.is-near .usage-card.is-reached {
  background: var(--tint-red);
}

.usage-card.is-reached .usage-card__icon {
  color: #b42318;
}

.usage-card.is-reached .usage-bar span {
  background: #d92d20;
}

.usage-card.is-reached .usage-card__value {
  color: #b42318;
}

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.125rem;
  padding: 0.3rem 1rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.btn--sm {
  padding: 0.42rem 0.85rem;
  font-size: 0.8rem;
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
  border-color: rgba(15, 23, 42, 0.12);
  color: var(--ink);
}

.btn--secondary:hover:not(:disabled) {
  background: var(--tint-blue);
  border-color: rgba(30, 58, 138, 0.2);
  color: var(--navy);
}

.btn:disabled {
  opacity: 0.55;
  cursor: wait;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
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
  opacity: 0.55;
  cursor: wait;
}

.btn:focus-visible,
.icon-btn:focus-visible,
.filter-pill:focus-visible,
.chat-card:focus-visible,
.inbox-search__clear:focus-visible,
.composer__send:focus-visible {
  outline: 2px solid var(--navy);
  outline-offset: 2px;
}

/* ---------- Shell ---------- */
.help-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 22rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  overflow: hidden;
}

/* ---------- Inbox ---------- */
.inbox {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
  padding: 0.9rem 0.75rem 0.75rem;
  border-right: 1px solid var(--line);
  background: #fafbfd;
}

.inbox__tools {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.filter-pills {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  background: rgba(15, 23, 42, 0.06);
  padding: 4px;
  gap: 2px;
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.38rem 0.7rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.28s ease;
}

.filter-pill:hover {
  color: #0f172a;
}

.filter-pill__count {
  min-width: 1.2rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: #eef0f4;
  color: #475467;
  font-size: 0.7rem;
  line-height: 1.2rem;
  text-align: center;
}

.filter-pill--pending .filter-pill__count {
  background: var(--tint-red);
  color: #b42318;
}

.filter-pill--answered .filter-pill__count {
  background: var(--tint-green);
  color: #146c43;
}

.filter-pill.is-active {
  background: transparent;
  border-color: transparent;
  color: #0f172a;
}

.filter-pill.is-active .filter-pill__count {
  background: #f1f5f9;
  color: #0f172a;
}

.inbox__search-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inbox-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem 0.5rem 0.9rem;
  border: 1px solid rgba(15, 23, 42, 0.1);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  font-size: 0.85rem;
}

.inbox-search:focus-within {
  border-color: var(--navy);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.inbox-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 0.85rem;
  color: var(--ink);
}

.inbox-search__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border: none;
  border-radius: 50%;
  background: var(--soft);
  color: var(--muted);
  font-size: 0.7rem;
  cursor: pointer;
}

.inbox__empty {
  margin: 0.5rem 0.4rem;
  font-size: 0.84rem;
  line-height: 1.45;
  color: var(--muted);
}

.inbox__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.chat-card {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  width: 100%;
  padding: 0.7rem 0.7rem;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  text-align: left;
  font: inherit;
  color: var(--ink);
  cursor: pointer;
}

.chat-card:hover {
  background: #fff;
  border-color: var(--line);
}

.chat-card.is-active {
  background: var(--tint-blue);
  border-color: transparent;
}

.avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  background: var(--tint-amber);
  color: #8a5a00;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.avatar.tone-blue { background: var(--tint-blue); color: var(--navy); }
.avatar.tone-green { background: var(--tint-green); color: #146c43; }
.avatar.tone-orange { background: var(--tint-orange); color: #b54708; }
.avatar.tone-amber { background: var(--tint-amber); color: #8a5a00; }
.avatar.tone-red { background: var(--tint-red); color: #b42318; }

.chat-card.is-active .avatar {
  background: #fff;
}

.avatar--lg {
  width: 2.75rem;
  height: 2.75rem;
  font-size: 0.85rem;
}

.avatar--sm {
  width: 1.85rem;
  height: 1.85rem;
  font-size: 0.66rem;
}

.avatar__dot {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid #fafbfd;
  border-radius: 50%;
  background: #d92d20;
}

.chat-card.is-active .avatar__dot {
  border-color: var(--tint-blue);
}

.chat-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.chat-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}

.chat-card__name {
  min-width: 0;
  font-size: 0.85rem;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-card__dept {
  font-weight: 500;
  color: var(--muted);
}

.chat-card__when {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--muted);
}

.chat-card__topic {
  font-size: 0.8rem;
  font-weight: 600;
  color: #344054;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-card.is-active .chat-card__topic {
  color: var(--navy);
}

.chat-card__snippet {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.4;
  background: #eef0f4;
  color: #475467;
  white-space: nowrap;
}

.status-pill.is-pending {
  background: var(--tint-red);
  color: #b42318;
}

.status-pill.is-answered {
  background: var(--tint-green);
  color: #146c43;
}

.status-pill.is-derived {
  background: var(--tint-amber);
  color: #8a5a00;
}

/* ---------- Conversation pane ---------- */
.pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.pane-empty {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem 1.5rem;
  text-align: center;
}

.pane-empty__art {
  width: 11rem;
  height: auto;
  margin-bottom: 0.5rem;
}

.pane-empty__title {
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  color: var(--ink);
}

.pane-empty__sub {
  margin: 0;
  max-width: 24rem;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--muted);
}

.pane-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem 0.8rem;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--line);
}

.pane-head__back {
  display: none;
}

.pane-head__text {
  flex: 1 1 14rem;
  min-width: 0;
}

.pane-head__name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.55rem;
  margin: 0;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.pane-head__meta {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.pane-head__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-left: auto;
}

.banner {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  margin: 0.75rem 1.25rem 0;
  padding: 0.7rem 0.95rem;
  border-radius: 14px;
  font-size: 0.83rem;
  line-height: 1.45;
}

.banner .pi {
  margin-top: 0.18rem;
}

.banner div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.banner--amber {
  background: var(--tint-amber);
  color: #7a4f00;
}

.banner--gray {
  background: #eef0f4;
  color: #475467;
}

.thread {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  padding: 1.25rem max(1.25rem, calc(50% - 26rem)) 0.75rem;
}

.msg {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  max-width: 80%;
  align-self: flex-start;
}

.msg__col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
  min-width: 0;
}

.msg__label {
  padding: 0 0.3rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: #475467;
}

.msg__time {
  margin-left: 0.3rem;
  font-weight: 500;
  color: #8e8e93;
}

.msg__bubble {
  padding: 0.7rem 0.95rem;
  border-radius: 18px 18px 18px 6px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.09);
  color: var(--ink);
}

.msg__bubble p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.msg--ai .msg__bubble {
  background: var(--soft);
  border-color: transparent;
}

.msg--admin {
  align-self: flex-end;
}

.msg--admin .msg__col {
  align-items: flex-end;
}

.msg--admin .msg__bubble {
  border-radius: 18px 18px 6px 18px;
  background: var(--navy);
  border-color: var(--navy);
  color: #fff;
}

/* Respuesta recién enviada: la burbuja azul conserva su fondo (texto blanco) y solo la rodea un halo verde. */
.msg--admin .msg__bubble.bf-fresh {
  animation:
    bf-fresh-in 0.8s var(--bf-ease),
    msg-fresh-ring 3.4s var(--bf-ease-soft);
}

@keyframes msg-fresh-ring {
  0%,
  45% {
    box-shadow: 0 0 0 3px var(--bf-success-line);
  }
}

.bot-avatar,
.admin-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.85rem;
  height: 1.85rem;
  border-radius: 50%;
  font-size: 0.75rem;
}

.bot-avatar {
  background: var(--navy);
  color: #fff;
}

.admin-avatar {
  background: var(--tint-blue);
  color: var(--navy);
}

.msg > .avatar,
.msg > .bot-avatar,
.msg > .admin-avatar {
  margin-top: 1.4rem;
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

.composer-dock {
  flex-shrink: 0;
  padding: 0.6rem max(1.25rem, calc(50% - 26rem)) 0.9rem;
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
@media (max-width: 1200px) {
  .help-shell {
    grid-template-columns: 19.5rem minmax(0, 1fr);
  }
}

/* Narrow content: master / detail (inbox first, conversation full width with a back button). */
@media (max-width: 900px) {
  .help-shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .inbox {
    border-right: none;
  }

  .help-shell.has-selection .inbox,
  .help-shell:not(.has-selection) .pane {
    display: none;
  }

  .pane-head__back {
    display: inline-flex;
  }
}

/* Phone (stacked app nav, see AppShellView): the page scrolls; the conversation keeps a usable height. */
@media (max-width: 720px) {
  .app-view {
    padding: 1rem 1rem 1.5rem;
  }

  .app-view--ai {
    height: auto;
    max-height: none;
    overflow: visible;
  }

  .support-page {
    flex: none;
  }


  .help-shell {
    flex: none;
  }

  .help-shell:not(.has-selection) {
    min-height: 24rem;
  }

  .inbox__list {
    overflow: visible;
  }

  .help-shell.has-selection {
    height: calc(100dvh - 2rem - var(--mobilebar-height, 0px));
    min-height: 32rem;
  }

  .pane-head {
    padding: 0.7rem 0.8rem;
  }

  .pane-head__actions {
    width: 100%;
    margin-left: 0;
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
