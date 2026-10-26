/**
 * Filtro de relevancia del asistente (espejo de backend ResidentCare/Domain/Services/QuestionRelevancePolicy.cs).
 * Saludos, temas ajenos y mensajes sin contenido se responden sin IA y no consumen el tope del plan.
 * Lo usa la demo del navegador para comportarse igual que la API.
 */

export const QuestionScope = /** @type {const} */ ({
  BUILDING: 'building',
  SMALL_TALK: 'smallTalk',
  OFF_TOPIC: 'offTopic',
  UNCLEAR: 'unclear',
})

/** Consultas con IA por residente al día (backend AnswerPolicy.ResidentDailyAiQueries). */
export const RESIDENT_DAILY_AI_QUERIES = 15

const BUILDING_TERMS = [
  'edificio', 'condominio', 'departamento', 'depa', 'dpto', 'piso', 'torre', 'bloque', 'vecino', 'vecinos',
  'reglamento', 'regla', 'reglas', 'norma', 'normas', 'acta', 'actas', 'junta', 'asamblea', 'administracion',
  'administrador', 'administradora', 'conserje', 'porteria', 'portero', 'vigilancia', 'vigilante', 'seguridad',
  'mascota', 'mascotas', 'perro', 'perros', 'gato', 'gatos', 'ruido', 'ruidos', 'fiesta', 'musica', 'horario',
  'horarios', 'estacionamiento', 'cochera', 'cocheras', 'basura', 'reciclaje', 'mudanza', 'obra', 'obras',
  'remodelacion', 'multa', 'multas', 'sancion', 'lavanderia', 'azotea', 'jardin', 'ascensor', 'ascensores',
  'escalera', 'pasillo', 'puerta', 'llaves', 'intercomunicador', 'propietario', 'inquilino', 'alquiler',
  'pagar', 'pago', 'pagos', 'cuota', 'cuotas', 'mantenimiento', 'recibo', 'recibos', 'deuda', 'saldo',
  'mora', 'morosidad', 'comprobante', 'mercado pago', 'tarjeta', 'vence', 'vencimiento',
  'reservar', 'reserva', 'reservas', 'area comun', 'areas comunes', 'piscina', 'parrilla', 'gimnasio', 'salon',
  'sum', 'cancha', 'aforo', 'invitado', 'invitados', 'visita', 'visitas', 'qr', 'incidencia', 'incidencias',
  'falla', 'fuga', 'gotera', 'averia', 'malogrado', 'malograda', 'no funciona', 'luz', 'agua', 'desague',
  'humedad', 'filtracion', 'reparacion', 'arreglar',
  'buildingfex', 'comunicado', 'comunicados', 'aviso', 'avisos', 'documento', 'documentos', 'cuenta',
  'contrasena', 'invitacion', 'enlace', 'app', 'aplicacion',
  'building', 'condo', 'condominium', 'apartment', 'unit', 'neighbor', 'neighbour', 'rules', 'minutes',
  'board', 'management', 'manager', 'concierge', 'doorman', 'pet', 'pets', 'dog', 'cat', 'noise', 'parking',
  'trash', 'garbage', 'moving', 'fee', 'fees', 'payment', 'pay', 'receipt', 'debt', 'dues', 'booking',
  'reservation', 'pool', 'gym', 'grill', 'guest', 'guests', 'visitor', 'incident', 'leak', 'broken',
  'elevator', 'repair', 'announcement', 'password', 'account',
]

const OFF_TOPIC_REQUESTS = [
  'chiste', 'chistes', 'poema', 'poesia', 'cancion', 'cuento', 'historia de amor', 'receta', 'recetas',
  'adivinanza', 'trabalenguas', 'horoscopo', 'tarea', 'ensayo', 'monografia', 'codigo', 'programa en',
  'programar', 'python', 'javascript', 'java', 'sql', 'excel formula', 'traduce', 'traducir', 'traduccion',
  'resume este libro', 'escribe una carta', 'ignora tus instrucciones', 'ignora las instrucciones',
  'olvida tus instrucciones', 'tu prompt', 'system prompt', 'que modelo eres', 'eres chatgpt', 'eres gemini',
  'joke', 'poem', 'song', 'story about', 'recipe', 'riddle', 'horoscope', 'homework', 'essay', 'write code',
  'translate', 'ignore your instructions', 'ignore previous instructions', 'your prompt', 'what model are you',
]

const GENERAL_TOPICS = [
  'clima', 'pronostico', 'futbol', 'partido', 'mundial', 'pelicula', 'peliculas', 'serie', 'series', 'netflix',
  'noticias', 'presidente', 'politica', 'elecciones', 'bitcoin', 'cripto', 'criptomoneda', 'dolar', 'bolsa',
  'capital de', 'quien gano', 'quien es', 'que es la', 'historia del', 'inteligencia artificial', 'videojuego',
  'weather', 'forecast', 'football', 'soccer', 'movie', 'news', 'president', 'politics', 'election',
  'crypto', 'stock market', 'capital of', 'who won', 'who is', 'video game',
]

const GREETINGS = [
  'hola', 'holi', 'buenas', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches', 'que tal', 'hey',
  'hello', 'hi', 'good morning', 'good afternoon', 'good evening',
]

const THANKS = [
  'gracias', 'muchas gracias', 'mil gracias', 'ok', 'okey', 'oki', 'vale', 'listo', 'perfecto', 'genial',
  'entendido', 'de acuerdo', 'chau', 'chao', 'adios', 'hasta luego', 'nos vemos', 'bye', 'thanks',
  'thank you', 'thx', 'great', 'perfect', 'got it', 'goodbye', 'see you',
]

const FILLERS = ['a', 'y', 'muy', 'tu', 'ti', 'todo', 'todos', 'senor', 'senora', 'you', 'so', 'much', 'very', 'all']

const ARITHMETIC = /^(cuanto es |what is |calcula )?[\d\s.,]+[+\-*/x^][\d\s.,+\-*/x^()]+$/

/** Minúsculas, sin tildes y sin signos de puntuación (igual que SupportEscalate.Fold). */
function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsAny(padded, terms) {
  return terms.some((t) => padded.includes(` ${t} `))
}

function isOnly(folded, phrases) {
  const words = folded.split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 5) return false
  let rest = ` ${folded} `
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) rest = rest.split(` ${phrase} `).join(' ')
  for (const filler of FILLERS) rest = rest.split(` ${filler} `).join(' ')
  return rest.trim().length === 0
}

export function classifyQuestion(text) {
  const folded = fold(text)
  const letters = (folded.match(/\p{L}/gu) || []).length
  if (letters < 2) return QuestionScope.UNCLEAR

  const padded = ` ${folded} `
  if (ARITHMETIC.test(folded)) return QuestionScope.OFF_TOPIC
  if (isOnly(folded, GREETINGS) || isOnly(folded, THANKS)) return QuestionScope.SMALL_TALK
  if (containsAny(padded, OFF_TOPIC_REQUESTS)) return QuestionScope.OFF_TOPIC
  if (!containsAny(padded, BUILDING_TERMS) && containsAny(padded, GENERAL_TOPICS)) return QuestionScope.OFF_TOPIC
  return QuestionScope.BUILDING
}

/** Respuesta fija para un mensaje filtrado (mismos textos que el backend). */
export function filteredReply(scope, text, locale = 'es') {
  const en = String(locale).toLowerCase().startsWith('en')
  if (scope === QuestionScope.SMALL_TALK) {
    if (isOnly(fold(text), THANKS)) {
      return en
        ? "You're welcome! If you have another question about your building, just write it here."
        : '¡Con gusto! Si tienes otra duda sobre tu edificio, escríbela aquí.'
    }
    return en
      ? "Hi! I'm your building's assistant. I can help with the rules, payments, bookings, guests and incidents. What do you need?"
      : '¡Hola! Soy el asistente de tu edificio. Puedo ayudarte con el reglamento, los pagos, las reservas, tus invitados y las incidencias. ¿Qué necesitas?'
  }
  if (scope === QuestionScope.OFF_TOPIC) {
    return en
      ? "I can only help with questions about your building and BuildingFex: rules, meeting minutes, payments, bookings, guests or incidents. This message did not use any of your building's assistant queries."
      : 'Solo puedo ayudarte con dudas de tu edificio y de BuildingFex: reglamento, actas, pagos, reservas, invitados o incidencias. Este mensaje no usó ninguna de las consultas del asistente de tu edificio.'
  }
  return en
    ? "I didn't understand your message. Could you write your question about the building with a bit more detail?"
    : 'No entendí tu mensaje. ¿Puedes escribir tu duda sobre el edificio con un poco más de detalle?'
}

export function residentDailyLimitReply(locale = 'es', limit = RESIDENT_DAILY_AI_QUERIES) {
  return String(locale).toLowerCase().startsWith('en')
    ? `You've reached today's limit of ${limit} assistant questions. You can ask again tomorrow; if it's urgent, ask to talk to the building administration.`
    : `Llegaste al límite de ${limit} consultas al asistente por hoy. Podrás volver a preguntar mañana; si es urgente, pide hablar con la administración.`
}
