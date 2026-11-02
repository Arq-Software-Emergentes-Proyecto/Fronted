/**
 * Communications — constantes compartidas con el backend.
 * Prioridades reales del FE/BE: normal | important | urgent (RF020: urgent > important > normal).
 * Estados (diseño táctico): draft | published | archived; "expired" lo deriva el servidor de expiresAt.
 */
export const AnnouncementPriority = Object.freeze({
  NORMAL: 'normal',
  IMPORTANT: 'important',
  URGENT: 'urgent',
})

export const ANNOUNCEMENT_PRIORITY_RANK = Object.freeze({
  [AnnouncementPriority.URGENT]: 3,
  [AnnouncementPriority.IMPORTANT]: 2,
  [AnnouncementPriority.NORMAL]: 1,
})

export const AnnouncementStatus = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
  EXPIRED: 'expired',
})

/** Duraciones ofrecidas en el formulario (días). ExpiresAt = createdAt + duración (lo calcula el servidor). */
export const ANNOUNCEMENT_DURATIONS = Object.freeze([7, 15, 30])

export function announcementPriorityRank(priority) {
  return ANNOUNCEMENT_PRIORITY_RANK[priority] ?? ANNOUNCEMENT_PRIORITY_RANK[AnnouncementPriority.NORMAL]
}

/** Vigente: no vencido (RNF011). Sin expiresAt se considera no vigente. */
export function isAnnouncementActive(announcement, now = new Date()) {
  if (!announcement) return false
  if (announcement.status && announcement.status !== AnnouncementStatus.PUBLISHED) return false
  if (!announcement.expiresAt) return false
  return now < new Date(announcement.expiresAt)
}

/** Orden del carrusel (RF020): prioridad desc y luego fecha de publicación desc. */
export function compareAnnouncementsForCarousel(a, b) {
  const byPriority = announcementPriorityRank(b?.priority) - announcementPriorityRank(a?.priority)
  if (byPriority !== 0) return byPriority
  const da = String(a?.publishedAt || a?.createdAt || '')
  const db = String(b?.publishedAt || b?.createdAt || '')
  return db.localeCompare(da)
}
