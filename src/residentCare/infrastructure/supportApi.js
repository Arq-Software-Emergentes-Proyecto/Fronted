import { apiClient } from '@/shared/infrastructure/api/apiClient.js'

function normalizeMessage(row) {
  const role = String(row?.role ?? row?.authorRole ?? '').trim()
  return {
    id: String(row?.id ?? ''),
    role: role === 'assistant' ? 'ai' : role,
    authorRole: String(row?.authorRole ?? (role === 'user' ? 'resident' : role === 'ai' ? 'assistant' : role)),
    body: String(row?.body ?? ''),
    authorName: row?.authorName ? String(row.authorName) : '',
    createdAt: String(row?.createdAt ?? ''),
  }
}

function normalizeChat(row) {
  const data = row && typeof row === 'object' ? row : {}
  return {
    id: String(data.id ?? ''),
    ownerAdminId: String(data.ownerAdminId ?? ''),
    residentId: String(data.residentId ?? ''),
    residentName: String(data.residentName ?? ''),
    topic: String(data.topic ?? data.title ?? ''),
    title: String(data.title ?? data.topic ?? ''),
    titleSummarized: Boolean(data.titleSummarized),
    status: String(data.status ?? 'open'),
    kind: String(data.kind ?? ''),
    source: String(data.source ?? 'resident'),
    linkedChatId: String(data.linkedChatId ?? ''),
    escalatedChatId: String(data.escalatedChatId ?? data.linkedChatId ?? ''),
    aiChatId: String(data.aiChatId ?? data.linkedChatId ?? ''),
    messages: Array.isArray(data.messages) ? data.messages.map(normalizeMessage) : [],
    createdAt: String(data.createdAt ?? ''),
    updatedAt: String(data.updatedAt ?? ''),
  }
}

/**
 * Support — unica fuente BuildingFex.Api /api/v1/support.
 * Gemini y AuthZ viven en el servidor. Sin RTDB writes ni VITE_GEMINI_API_KEY.
 */
export const supportApi = {
  async listChats(kind, { since } = {}) {
    const params = {}
    if (kind) params.kind = kind
    if (since) params.since = since
    const { data, status } = await apiClient.get('/api/v1/support/chats', {
      params,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    })
    if (status === 204) return []
    return (Array.isArray(data) ? data : []).map(normalizeChat)
  },

  async createAiChat(topic) {
    const { data } = await apiClient.post('/api/v1/support/chats', {
      kind: 'ai',
      topic: topic || undefined,
    })
    return normalizeChat(data)
  },

  async getChat(id, { afterMessageId } = {}) {
    const { data, status } = await apiClient.get(`/api/v1/support/chats/${encodeURIComponent(id)}`, {
      params: afterMessageId ? { afterMessageId } : undefined,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    })
    if (status === 204) return null
    return normalizeChat(data)
  },

  async postMessage(chatId, body, locale = 'es') {
    const { data } = await apiClient.post(
      `/api/v1/support/chats/${encodeURIComponent(chatId)}/messages`,
      { body, locale },
    )
    return normalizeChat(data)
  },
}
