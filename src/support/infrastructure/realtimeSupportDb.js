import { get, onValue, push, ref, set, update } from 'firebase/database'
import { getFirebaseRtdb } from '@/iam/infrastructure/firebaseApp.js'

export function rtdbKey(value) {
  return String(value ?? '').trim().replace(/[.#$\[\]]/g, '_')
}

function rtdb() {
  return getFirebaseRtdb()
}

function requireOwner(ownerId) {
  const id = rtdbKey(ownerId)
  if (!id) {
    const error = new Error('OWNER_REQUIRED')
    error.code = 'OWNER_REQUIRED'
    throw error
  }
  return id
}

function aiChatsPath(ownerId, residentId) {
  return `owners/${requireOwner(ownerId)}/aiChats/${rtdbKey(residentId)}`
}

function aiChatPath(ownerId, residentId, chatId) {
  return `${aiChatsPath(ownerId, residentId)}/${rtdbKey(chatId)}`
}

function adminChatsPath(ownerId) {
  return `owners/${requireOwner(ownerId)}/adminChats`
}

function adminChatPath(ownerId, chatId) {
  return `${adminChatsPath(ownerId)}/${rtdbKey(chatId)}`
}

function messagesFromMap(map) {
  if (!map) return []
  if (Array.isArray(map)) return map.filter(Boolean)
  return Object.entries(map)
    .map(([id, row]) => ({
      ...(row && typeof row === 'object' ? row : { body: String(row ?? '') }),
      id: row?.id || id,
    }))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}

function compact(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null))
}

export function normalizeAiChat(raw, fallbackId = '') {
  const row = raw && typeof raw === 'object' ? raw : {}
  return {
    id: String(row.id || fallbackId),
    residentId: String(row.residentId ?? ''),
    title: String(row.title ?? ''),
    titleSummarized: Boolean(row.titleSummarized),
    escalatedChatId: String(row.escalatedChatId ?? ''),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? row.createdAt ?? ''),
    messages: messagesFromMap(row.messages),
  }
}

export function normalizeAdminChat(raw, fallbackId = '') {
  const row = raw && typeof raw === 'object' ? raw : {}
  return {
    id: String(row.id || fallbackId),
    ownerAdminId: String(row.ownerAdminId ?? ''),
    residentId: String(row.residentId ?? ''),
    residentName: String(row.residentName ?? ''),
    topic: String(row.topic ?? ''),
    status: String(row.status ?? 'open'),
    source: String(row.source ?? 'resident'),
    aiChatId: String(row.aiChatId ?? ''),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? row.createdAt ?? ''),
    messages: messagesFromMap(row.messages),
  }
}

function listFromSnapshot(val, normalize) {
  if (!val || typeof val !== 'object') return []
  return Object.entries(val)
    .map(([id, row]) => normalize(row, id))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
}

function wrapListen(path, onData) {
  const node = ref(rtdb(), path)
  return onValue(
    node,
    (snap) => onData(snap.val()),
    (error) => {
      console.error(error)
      onData(null, error)
    },
  )
}

export function watchRealtimeConnected(onState) {
  return onValue(ref(rtdb(), '.info/connected'), (snap) => {
    onState(snap.val() === true)
  })
}

export function watchAiChats(ownerId, residentId, onList) {
  return wrapListen(aiChatsPath(ownerId, residentId), (val, error) => {
    if (error) {
      onList([], error)
      return
    }
    onList(listFromSnapshot(val, normalizeAiChat))
  })
}

export function watchAdminChats(ownerId, onList) {
  return wrapListen(adminChatsPath(ownerId), (val, error) => {
    if (error) {
      onList([], error)
      return
    }
    onList(listFromSnapshot(val, normalizeAdminChat))
  })
}

export function watchAdminChat(ownerId, chatId, onChat) {
  return wrapListen(adminChatPath(ownerId, chatId), (val, error) => {
    if (error) {
      onChat(null, error)
      return
    }
    onChat(val ? normalizeAdminChat(val, chatId) : null)
  })
}

export async function createAiChat({ ownerId, residentId, title }) {
  const id = `ai-${Date.now()}`
  const now = new Date().toISOString()
  const chat = {
    id,
    residentId: String(residentId ?? ''),
    title: String(title ?? ''),
    titleSummarized: false,
    escalatedChatId: '',
    createdAt: now,
    updatedAt: now,
  }
  await set(ref(rtdb(), aiChatPath(ownerId, residentId, id)), chat)
  return normalizeAiChat(chat)
}

export async function patchAiChat(ownerId, residentId, chatId, patch) {
  await update(ref(rtdb(), aiChatPath(ownerId, residentId, chatId)), compact({
    ...patch,
    updatedAt: new Date().toISOString(),
  }))
}

export async function appendAiMessage(ownerId, residentId, chatId, message) {
  const now = new Date().toISOString()
  const messagesRef = ref(rtdb(), `${aiChatPath(ownerId, residentId, chatId)}/messages`)
  const rowRef = push(messagesRef)
  const row = compact({
    id: rowRef.key,
    role: message.role,
    body: String(message.body ?? '').trim(),
    createdAt: now,
  })
  await set(rowRef, row)
  await update(ref(rtdb(), aiChatPath(ownerId, residentId, chatId)), { updatedAt: now })
  return row
}

export async function createAdminChat({
  ownerId,
  residentId,
  residentName,
  topic,
  source = 'resident',
  aiChatId = '',
  messages = [],
}) {
  const id = `help-${Date.now()}`
  const now = new Date().toISOString()
  const msgMap = {}
  for (const message of messages) {
    const mid = rtdbKey(message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    msgMap[mid] = compact({
      id: mid,
      authorRole: message.authorRole,
      body: String(message.body ?? '').trim(),
      createdAt: message.createdAt || now,
      authorName: message.authorName,
    })
  }
  const chat = {
    id,
    ownerAdminId: String(ownerId),
    residentId: String(residentId ?? ''),
    residentName: String(residentName ?? ''),
    topic: String(topic || 'Soporte').trim() || 'Soporte',
    status: 'open',
    source,
    aiChatId: String(aiChatId ?? ''),
    createdAt: now,
    updatedAt: now,
    ...(Object.keys(msgMap).length ? { messages: msgMap } : {}),
  }
  await set(ref(rtdb(), adminChatPath(ownerId, id)), chat)
  return normalizeAdminChat(chat)
}

export async function appendAdminMessage(ownerId, chatId, message) {
  const now = new Date().toISOString()
  const rowRef = push(ref(rtdb(), `${adminChatPath(ownerId, chatId)}/messages`))
  const row = compact({
    id: rowRef.key,
    authorRole: message.authorRole,
    body: String(message.body ?? '').trim(),
    createdAt: now,
    authorName: message.authorName,
  })
  await set(rowRef, row)
  await update(ref(rtdb(), adminChatPath(ownerId, chatId)), { updatedAt: now })
  return row
}

export async function getAdminChat(ownerId, chatId) {
  const snap = await get(ref(rtdb(), adminChatPath(ownerId, chatId)))
  return snap.exists() ? normalizeAdminChat(snap.val(), chatId) : null
}

export async function listAdminChatsForResident(ownerId, residentId) {
  const snap = await get(ref(rtdb(), adminChatsPath(ownerId)))
  return listFromSnapshot(snap.val(), normalizeAdminChat).filter(
    (chat) => String(chat.residentId) === String(residentId),
  )
}
