export class Faq {
  constructor({ id, questionKey, answerKey, keywords = [], topic = '' }) {
    this.id = id;
    this.questionKey = questionKey;
    this.answerKey = answerKey;
    /** Tema para los chips de filtro (ver FAQ_TOPICS); vacío = general. */
    this.topic = topic;
    /** Términos de búsqueda (es/en, sin tildes) además del texto traducido. */
    this.keywords = keywords;
  }
}

export class ChatTicket {
  constructor({ id, residentId, topic, status = 'Open', createdAt = new Date().toISOString() }) {
    this.id = id;
    this.residentId = residentId;
    this.topic = topic;
    this.status = status;
    this.createdAt = createdAt;
  }
}

/** RF008: preguntas frecuentes de uso, alcance y contratación (textos en i18n supportResident.faqN*). */
export const RESIDENT_FAQS = [
  new Faq({ id: 'faq5', topic: 'payments', questionKey: 'supportResident.faq5Question', answerKey: 'supportResident.faq5Answer',
    keywords: ['pago', 'pagos', 'pagar', 'cuota', 'cuotas', 'conciliacion', 'recibo', 'deuda', 'mercado pago', 'tarjeta', 'finanzas', 'payment', 'pay', 'fee', 'receipt'] }),
  new Faq({ id: 'faq6', topic: 'bookings', questionKey: 'supportResident.faq6Question', answerKey: 'supportResident.faq6Answer',
    keywords: ['reserva', 'reservas', 'reservar', 'area comun', 'piscina', 'parrilla', 'gimnasio', 'aforo', 'servicios', 'booking', 'reservation', 'common area', 'pool'] }),
  new Faq({ id: 'faq7', topic: 'incidents', questionKey: 'supportResident.faq7Question', answerKey: 'supportResident.faq7Answer',
    keywords: ['incidencia', 'incidencias', 'reporte', 'reportar', 'falla', 'fuga', 'averia', 'mantenimiento', 'issue', 'incident', 'report', 'repair', 'leak'] }),
  new Faq({ id: 'faq8', topic: 'guests', questionKey: 'supportResident.faq8Question', answerKey: 'supportResident.faq8Answer',
    keywords: ['invitado', 'invitados', 'visita', 'qr', 'codigo', 'generacion', 'acceso', 'guest', 'visitor', 'qr code'] }),
  new Faq({ id: 'faq9', questionKey: 'supportResident.faq9Question', answerKey: 'supportResident.faq9Answer',
    keywords: ['asistente', 'ia', 'chat', 'reglamento', 'actas', 'fuente', 'tope', 'consultas', 'administracion', 'junta', 'assistant', 'ai', 'rules', 'minutes', 'limit'] }),
  new Faq({ id: 'faq10', topic: 'account', questionKey: 'supportResident.faq10Question', answerKey: 'supportResident.faq10Answer',
    keywords: ['idioma', 'ingles', 'espanol', 'cuenta', 'perfil', 'contrasena', 'sesion', 'invitacion', 'enlace', 'language', 'account', 'password', 'login'] }),
  new Faq({ id: 'faq1', questionKey: 'supportResident.faq1Question', answerKey: 'supportResident.faq1Answer',
    keywords: ['buildingfex', 'plataforma', 'que es', 'condominio', 'platform', 'what is'] }),
  new Faq({ id: 'faq2', questionKey: 'supportResident.faq2Question', answerKey: 'supportResident.faq2Answer',
    keywords: ['plan', 'planes', 'suscripcion', 'precio', 'contratar', 'contratacion', 'departamentos', 'subscription', 'pricing', 'price'] }),
  new Faq({ id: 'faq3', questionKey: 'supportResident.faq3Question', answerKey: 'supportResident.faq3Answer',
    keywords: ['contacto', 'contactar', 'soporte', 'ayuda', 'equipo', 'correo', 'contact', 'support', 'help', 'team'] }),
  new Faq({ id: 'faq4', topic: 'account', questionKey: 'supportResident.faq4Question', answerKey: 'supportResident.faq4Answer',
    keywords: ['datos', 'seguridad', 'privacidad', 'proteccion', 'data', 'security', 'privacy'] }),
]

/** Chips de tema del encabezado de ayuda (residente). */
export const FAQ_TOPICS = [
  { id: 'payments', labelKey: 'supportResident.topicPayments', icon: 'pi-credit-card' },
  { id: 'bookings', labelKey: 'supportResident.topicBookings', icon: 'pi-calendar' },
  { id: 'incidents', labelKey: 'supportResident.topicIncidents', icon: 'pi-wrench' },
  { id: 'guests', labelKey: 'supportResident.topicGuests', icon: 'pi-users' },
  { id: 'account', labelKey: 'supportResident.topicAccount', icon: 'pi-user' },
]

export function filterFaqsByTopic(faqs, topic) {
  return topic ? faqs.filter((faq) => faq.topic === topic) : faqs
}

/** Términos sugeridos por defecto cuando no hay coincidencias (US009 escenario 2). */
export const DEFAULT_FAQ_SUGGESTIONS = {
  es: ['pagos', 'reservas', 'incidencias', 'invitados'],
  en: ['payment', 'booking', 'incident', 'guest'],
}

export function foldText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * RF009 / US009: filtra por palabra clave sobre pregunta, respuesta (ya traducidas) y keywords.
 * Todas las palabras de la consulta deben aparecer (AND), ignorando tildes y mayúsculas.
 */
export function searchFaqs(faqs, query, translate) {
  const terms = foldText(query).split(' ').filter((term) => term.length > 1)
  if (!terms.length) return faqs
  return faqs.filter((faq) => {
    const haystack = foldText(
      `${translate(faq.questionKey)} ${translate(faq.answerKey)} ${faq.keywords.join(' ')}`,
    )
    return terms.every((term) => haystack.includes(term))
  })
}

function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) rows[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length][b.length]
}

/** Términos parecidos a la búsqueda (distancia de edición) o, si no hay, los sugeridos por defecto. */
export function suggestFaqTerms(faqs, query, max = 4, locale = 'es') {
  const terms = foldText(query).split(' ').filter((term) => term.length > 2)
  const vocabulary = [...new Set(faqs.flatMap((faq) => faq.keywords).filter((k) => !k.includes(' ')))]
  const scored = []
  for (const word of vocabulary) {
    let best = Infinity
    for (const term of terms) {
      const d = word.startsWith(term) || term.startsWith(word) ? 0 : distance(term, word)
      best = Math.min(best, d)
    }
    if (best <= Math.max(1, Math.floor(word.length / 3))) scored.push({ word, best })
  }
  const similar = scored
    .sort((a, b) => a.best - b.best || a.word.localeCompare(b.word))
    .slice(0, max)
    .map((row) => row.word)
  const defaults = DEFAULT_FAQ_SUGGESTIONS[String(locale).startsWith('en') ? 'en' : 'es']
  return similar.length ? similar : defaults.slice(0, max)
}
