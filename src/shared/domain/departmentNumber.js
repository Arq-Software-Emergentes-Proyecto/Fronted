/**
 * Department number encodes floor + unit: last 2 digits = unit, leading digits = floor.
 * Examples: 304 → floor 3, 1204 → floor 12, 101 → floor 1.
 */

const DEPARTMENT_PATTERN = /^\d{3,4}$/

/**
 * @param {string | number | null | undefined} value
 * @returns {string | null}
 */
export function normalizeDepartmentNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits.length) return null
  return digits
}

/**
 * @param {string | number | null | undefined} department
 * @returns {string | null} floor label (e.g. "3", "12")
 */
export function deriveFloorFromDepartment(department) {
  const normalized = normalizeDepartmentNumber(department)
  if (!normalized || !DEPARTMENT_PATTERN.test(normalized)) return null

  const floorPart = normalized.slice(0, -2)
  const floor = Number.parseInt(floorPart, 10)
  if (!Number.isFinite(floor) || floor <= 0) return null

  return String(floor)
}

/**
 * @param {string | number | null | undefined} department
 * @returns {{ department: string, floor: string } | null}
 */
export function parseDepartmentNumber(department) {
  const normalized = normalizeDepartmentNumber(department)
  if (!normalized || !DEPARTMENT_PATTERN.test(normalized)) return null

  const floor = deriveFloorFromDepartment(normalized)
  if (!floor) return null

  return { department: normalized, floor }
}

/**
 * @param {string | number | null | undefined} department
 * @returns {boolean}
 */
export function isValidDepartmentNumber(department) {
  return parseDepartmentNumber(department) != null
}
