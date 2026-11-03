import { apiClient } from '@/shared/infrastructure/api/apiClient.js'

function normalizeMessage(row) {
  const role = String(row?.role ?? row?.authorRole ?? '').trim()
  return {
    id: String(row?.id ?? ''),
    role: role === 'assistant' ? 'ai' : role,
    authorRole: String(row?.authorRole ?? (role === 'user' ? 'resident' : role === 'ai' ? 'assistant' : role)),
    body: String(row?.body ?? ''),
    authorName: row?.authorName ? String(row.authorName) : '',
    citedSource: row?.citedSource ? String(row.citedSource) : '',
    citedDocumentId: row?.citedDocumentId ? String(row.citedDocumentId) : '',
    createdAt: String(row?.createdAt ?? ''),
  }
}

/** Estados de conversación (Resident Care): open = pendiente, answered = atendido. */
export const ChatStatus = Object.freeze({
  OPEN: 'open',
  ANSWERED: 'answered',
  DERIVED: 'derived',
  CLOSED: 'closed',
})

export function isPendingChat(chat) {
  const status = String(chat?.status ?? '').trim().toLowerCase()
  return !status || status === ChatStatus.OPEN
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
    status: String(data.status || ChatStatus.OPEN),
    pending: typeof data.pending === 'boolean' ? data.pending : isPendingChat(data),
    closedAt: data.closedAt ? String(data.closedAt) : '',
    kind: String(data.kind ?? ''),
    source: String(data.source ?? 'resident'),
    linkedChatId: String(data.linkedChatId ?? ''),
    incidentId: String(data.incidentId ?? ''),
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

  /**
   * Errores: 503 AI_UNAVAILABLE / GEMINI_API_KEY_MISSING (no se guardó el mensaje, se puede reintentar),
   * 429 GEMINI_RATE_LIMITED o AI_MONTHLY_CAP_REACHED (este último trae `payload.chat` ya derivado).
   */
  async postMessage(chatId, body, locale = 'es') {
    const { data } = await apiClient.post(
      `/api/v1/support/chats/${encodeURIComponent(chatId)}/messages`,
      { body, locale },
      { timeout: 25000 },
    )
    return normalizeChat(data)
  },

  /** Admin: open (pendiente) | answered (atendido) | closed. */
  async updateStatus(chatId, status) {
    const { data } = await apiClient.patch(
      `/api/v1/support/chats/${encodeURIComponent(chatId)}/status`,
      { status },
    )
    return normalizeChat(data)
  },

  /** Residente: registra la consulta como incidencia (Resident Care → Incidents). */
  async reportIncident(chatId, { title = '', description = '' } = {}) {
    const { data } = await apiClient.post(
      `/api/v1/support/chats/${encodeURIComponent(chatId)}/incident`,
      { title: title || null, description: description || null },
    )
    return normalizeChat(data)
  },

  async closeChat(chatId) {
    const { data } = await apiClient.patch(`/api/v1/support/chats/${encodeURIComponent(chatId)}/close`)
    return normalizeChat(data)
  },

  /** Admin: contadores de la bandeja { pending, answered, closed, total }. */
  async getSummary() {
    const { data } = await apiClient.get('/api/v1/support/chats/summary')
    return {
      pending: Number(data?.pending ?? 0),
      answered: Number(data?.answered ?? 0),
      closed: Number(data?.closed ?? 0),
      total: Number(data?.total ?? 0),
    }
  },

  /** Admin: consumo del tope mensual de consultas IA del plan { period, used, cap, remaining, filtered, residentDailyLimit }. */
  async getAiUsage() {
    const { data } = await apiClient.get('/api/v1/support/ai-usage')
    return {
      period: String(data?.period ?? ''),
      used: Number(data?.used ?? 0),
      cap: Number(data?.cap ?? 0),
      remaining: Number(data?.remaining ?? 0),
      capReached: Boolean(data?.capReached),
      /** Mensajes respondidos sin IA por el filtro de relevancia (no consumen el tope). */
      filtered: Number(data?.filtered ?? 0),
      residentDailyLimit: Number(data?.residentDailyLimit ?? 0),
    }
  },
}

export { normalizeChat }
