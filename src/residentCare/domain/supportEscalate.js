function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ESCALATE_TOKEN = '[[ESCALATE_ADMIN]]'

const PHRASES = [
  'pasame con el administrador',
  'pasame con administracion',
  'pasame al administrador',
  'pasame a administracion',
  'pasa me con el administrador',
  'conectame con el administrador',
  'comunicame con el administrador',
  'hablar con administracion',
  'hablar con el administrador',
  'quiero hablar con el administrador',
  'quiero un administrador',
  'transferir a administracion',
  'pass me to the admin',
  'pass me to admin',
  'talk to admin',
  'talk to building admin',
  'speak to an administrator',
  'speak with admin',
  'connect me with admin',
  'transfer me to admin',
]

const REQUEST_PATTERNS = [
  /pasa(me|nos).{0,24}admin/,
  /conecta(me|nos).{0,24}admin/,
  /comunica(me|nos).{0,24}admin/,
  /hablar.{0,24}admin/,
  /pass me.{0,24}admin/,
  /talk to.{0,20}admin/,
  /speak (to|with).{0,20}admin/,
  /transfer me.{0,24}admin/,
]

export function residentWantsAdmin(text) {
  const q = fold(text)
  if (!q) return false
  if (PHRASES.some((phrase) => q.includes(phrase))) return true
  return REQUEST_PATTERNS.some((pattern) => pattern.test(q))
}

export function assistantWantsEscalate(text) {
  return String(text ?? '').includes(ESCALATE_TOKEN)
}

export function stripEscalateMarker(text) {
  return String(text ?? '')
    .replace(/\s*\[\[ESCALATE_ADMIN\]\]\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export { ESCALATE_TOKEN }
