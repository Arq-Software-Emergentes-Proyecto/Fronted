/**
 * Information bounded-context domain entity.
 * Represents an official announcement (comunicado) published by an admin.
 *
 * duration  – number of days the announcement stays active (7 | 15 | 30)
 * expiresAt – ISO date-string = createdAt + duration days (calculado por el servidor, RF019;
 *             el cálculo local es solo un fallback para datos antiguos)
 */
export class Announcement {
  constructor({
    id,
    title,
    body,
    priority,
    authorId,
    authorName,
    createdAt,
    duration,
    expiresAt,
    ownerAdminId,
  }) {
    this.id = id
    this.title = title
    this.body = body
    this.priority = priority ?? 'normal'
    this.authorId = authorId
    this.authorName = authorName ?? ''
    this.ownerAdminId = ownerAdminId ?? null
    this.createdAt  = createdAt  ?? new Date().toISOString()
    this.duration   = duration   ?? 7  // days

    if (expiresAt) {
      this.expiresAt = expiresAt
    } else {
      const d = new Date(this.createdAt)
      d.setDate(d.getDate() + this.duration)
      this.expiresAt = d.toISOString()
    }
  }

  /** Returns true if the announcement has not yet expired. */
  get isActive() {
    return new Date() < new Date(this.expiresAt)
  }
}
