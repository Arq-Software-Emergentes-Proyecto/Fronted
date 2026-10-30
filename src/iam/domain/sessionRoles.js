/**
 * IAM domain: roles a session can carry inside the application.
 * Treated as a value object (frozen, no behavior).
 */
export const SessionRoles = Object.freeze({
  ADMIN: 'admin',
  RESIDENT: 'resident',
  /** Junta directiva: ve la información del condominio, no la modifica. */
  BOARD: 'board_member',
})

/** @typedef {typeof SessionRoles[keyof typeof SessionRoles]} SessionRole */
