import { reactive } from 'vue'
import { supportApi } from '../infrastructure/supportApi.js'

const state = reactive({
  faqs: [],
  chatDialogVisible: false,
  activeChat: null,
  myChats: [],
  error: null,
  loadChatsError: null,
})

export function useSupportStore() {
  const loadFaqs = async () => {
    state.faqs = []
  }

  const loadMyChats = async () => {
    state.loadChatsError = null
    try {
      state.myChats = await supportApi.listChats('admin')
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
    try {
      const full = await supportApi.getChat(chat.id)
      setActiveChat(full)
      state.chatDialogVisible = true
    } catch (e) {
      state.error = 'CHAT_LOAD_FAILED'
      console.error(e)
    }
  }

  const sendResidentMessage = async (body) => {
    const chatId = state.activeChat?.id
    if (!chatId || !body.trim()) return null
    const updated = await supportApi.postMessage(chatId, body)
    setActiveChat(updated)
    await loadMyChats()
    return updated
  }

  return {
    state,
    loadFaqs,
    loadMyChats,
    openChatDialog,
    closeChatDialog,
    closeChat: closeChatDialog,
    sendResidentMessage,
    setActiveChat,
  }
}
