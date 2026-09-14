const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

const PREFERRED_MODELS = [
  'gemini-2.0-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
]

let resolvedModelId = ''

export function getGeminiApiKey() {
  return String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()
}

export function isGeminiConfigured() {
  return Boolean(getGeminiApiKey())
}

function geminiError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function uniqueIds(ids) {
  const seen = new Set()
  const next = []
  for (const id of ids) {
    const clean = String(id ?? '').trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    next.push(clean)
  }
  return next
}

function toGeminiContents(messages) {
  const contents = (Array.isArray(messages) ? messages : [])
    .filter((row) => String(row?.body ?? '').trim())
    .map((row) => ({
      role: row.role === 'user' ? 'user' : 'model',
      parts: [{ text: String(row.body).trim() }],
    }))
  if (contents[0]?.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hola' }] })
  }
  return contents
}

function isUnavailableModel(status, message) {
  const text = String(message ?? '').toLowerCase()
  return (
    status === 404 ||
    text.includes('not found') ||
    text.includes('no longer available') ||
    text.includes('not supported for generatecontent')
  )
}

function isBusy(status, message) {
  const text = String(message ?? '').toLowerCase()
  return (
    status === 429 ||
    status === 503 ||
    text.includes('high demand') ||
    text.includes('unavailable') ||
    text.includes('resource exhausted') ||
    text.includes('try again later')
  )
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function listGenerateContentModels(apiKey) {
  const response = await fetch(`${GEMINI_ENDPOINT}?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) return []
  return (Array.isArray(payload.models) ? payload.models : [])
    .filter((model) =>
      Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods.includes('generateContent')
        : true,
    )
    .map((model) => String(model.name ?? '').replace(/^models\//, ''))
    .filter((id) => id && /flash/i.test(id) && !/tts|image|live|audio/i.test(id))
}

async function requestGemini(apiKey, modelId, contents, systemInstruction, generationConfig = {}) {
  const response = await fetch(
    `${GEMINI_ENDPOINT}/${encodeURIComponent(modelId)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: String(systemInstruction ?? '').trim() }],
        },
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          ...generationConfig,
        },
      }),
    },
  )
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

function readReply(payload) {
  return (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => String(part?.text ?? ''))
    .join('')
    .trim()
}

/**
 * @param {{
 *   messages: Array<{ role: string, body: string }>,
 *   systemInstruction: string,
 *   generationConfig?: Record<string, unknown>,
 * }} params
 */
export async function generateGeminiReply({ messages, systemInstruction, generationConfig }) {
  const apiKey = getGeminiApiKey()
  if (!apiKey) throw geminiError('GEMINI_API_KEY_MISSING', 'Gemini API key is missing')

  const contents = toGeminiContents(messages)
  if (!contents.length) throw geminiError('GEMINI_EMPTY_PROMPT', 'Message is required')

  const configured = String(import.meta.env.VITE_GEMINI_MODEL ?? '').trim()
  const listed = await listGenerateContentModels(apiKey).catch(() => [])
  const candidates = uniqueIds([
    resolvedModelId,
    configured && configured !== 'gemini-flash-latest' ? configured : '',
    ...PREFERRED_MODELS,
    ...listed,
  ])

  let lastBusy = false
  let lastMessage = ''

  for (const modelId of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { response, payload } = await requestGemini(
        apiKey,
        modelId,
        contents,
        systemInstruction,
        generationConfig,
      )
      if (response.ok) {
        const text = readReply(payload)
        if (!text) throw geminiError('GEMINI_EMPTY_REPLY', 'Gemini returned an empty reply')
        resolvedModelId = modelId
        return text
      }

      lastMessage = payload?.error?.message || `HTTP ${response.status}`
      if (isUnavailableModel(response.status, lastMessage)) break
      if (isBusy(response.status, lastMessage)) {
        lastBusy = true
        resolvedModelId = ''
        await sleep(700 * (attempt + 1))
        continue
      }
      throw geminiError('GEMINI_REQUEST_FAILED', lastMessage)
    }
  }

  throw geminiError(
    lastBusy ? 'GEMINI_BUSY' : 'GEMINI_REQUEST_FAILED',
    lastMessage || 'Gemini request failed',
  )
}

function cleanTitle(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean)
  if (!line) return ''
  return line
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
}

/**
 * Short sidebar title from the conversation, in the resident's language.
 * @param {{ messages: Array<{ role: string, body: string }>, locale?: string }} params
 */
export async function summarizeChatTitle({ messages, locale = 'es' }) {
  const snippet = (Array.isArray(messages) ? messages : [])
    .filter((row) => String(row?.body ?? '').trim())
    .slice(0, 8)
    .map((row) => `${row.role === 'user' ? 'Resident' : 'Assistant'}: ${String(row.body).trim()}`)
    .join('\n')
  if (!snippet) return ''

  const language = locale === 'en' ? 'English' : 'Spanish'
  const text = await generateGeminiReply({
    messages: [
      {
        role: 'user',
        body: `Write a 3-6 word title summarizing this resident support chat. Language: ${language}. Title only, no quotes.\n\n${snippet}`,
      },
    ],
    systemInstruction: 'You only output a short chat title. No extra text.',
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 40,
    },
  })
  return cleanTitle(text)
}
