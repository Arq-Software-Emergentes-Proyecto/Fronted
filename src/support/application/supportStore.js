import { reactive } from 'vue'
import { supportApi } from '../infrastructure/supportApi.js'
import {
  appendAdminMessage,
  createAdminChat,
  getAdminChat,
  listAdminChatsForResident,
} from '../infrastructure/realtimeSupportDb.js'
import { getActiveDataOwnerId } from '@/iam/application/sessionStore.js'

const state = reactive({
  faqs: [],
  isSubmittingTicket: false,
  chatDialogVisible: false,
  activeChat: null,
  myChats: [],
  error: null,
  loadChatsError: null,
})

export function useSupportStore() {
  const loadFaqs = async () => {
    try {
      state.faqs = await supportApi.getFaqs()
    } catch (e) {
      state.error = 'Failed to load frequent questions'
      console.error(e)
    }
  }

  const loadMyChats = async (residentId) => {
    state.loadChatsError = null
    const cleanId = residentId != null ? String(residentId) : ''
    const ownerId = getActiveDataOwnerId()
    if (!cleanId || !ownerId) {
      state.myChats = []
      return
    }
    try {
      state.myChats = await listAdminChatsForResident(ownerId, cleanId)
    } catch (e) {
      state.loadChatsError = 'CHATS_LOAD_FAILED'
      console.error(e)
      state.myChats = []
    }
  }

  const setActiveChat = (chat) => {
    state.activeChat = chat ? { ...chat, messages: [...(chat.messages || [])] } : null
  }

  const closeChatDialog = () => {
    state.chatDialogVisible = false
    state.activeChat = null
  }

  const openChatDialog = async (chat) => {
    state.error = null
    const ownerId = getActiveDataOwnerId()
    try {
      const full = ownerId ? await getAdminChat(ownerId, chat.id) : chat
      setActiveChat(full)
      state.chatDialogVisible = true
    } catch (e) {
      state.error = 'CHAT_LOAD_FAILED'
      console.error(e)
    }
  }

  /**
   * @param {string} residentId
   * @param {string} [residentName]
   * @param {string} [topic]
   */
  const initiateAsyncChat = async (residentId, residentName, topic) => {
    state.isSubmittingTicket = true
    state.error = null
    try {
      const newChat = await createAdminChat({
        ownerId: getActiveDataOwnerId(),
        residentId,
        residentName,
        topic: topic || 'Soporte',
        source: 'resident',
      })
      await loadMyChats(residentId)
      setActiveChat(newChat)
      state.chatDialogVisible = true
      return newChat
    } catch (e) {
      state.error = 'CHAT_CREATE_FAILED'
      console.error(e)
      throw e
    } finally {
      state.isSubmittingTicket = false
    }
  }

  /**
   * @param {string} body
   * @param {{ name?: string }} [residentProfile]
   */
  const sendResidentMessage = async (body, residentProfile = {}) => {
    const chatId = state.activeChat?.id
    const ownerId = getActiveDataOwnerId()
    if (!chatId || !ownerId || !body.trim()) return null
    await appendAdminMessage(ownerId, chatId, {
      authorRole: 'resident',
      body,
      authorName: residentProfile.name,
    })
    const updated = await getAdminChat(ownerId, chatId)
    setActiveChat(updated)
    const rid = updated?.residentId
    if (rid) await loadMyChats(rid)
    return updated
  }

  /** @deprecated use closeChatDialog */
  const closeChat = () => {
    closeChatDialog()
  }

  return {
    state,
    loadFaqs,
    loadMyChats,
    initiateAsyncChat,
    openChatDialog,
    closeChatDialog,
    closeChat,
    sendResidentMessage,
    setActiveChat,
  }
}
