import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { authApi, parseAuthResponse } from '@/iam/infrastructure/authApi.js'
import {
  apiError,
  findResidentByCode,
  normalizeCode,
  normalizeEmail,
  publicResident,
} from '@/shared/infrastructure/api/utils.js'
import { getResidentLimitForActiveOwner, refreshSubscriptionFromApi } from '@/shared/infrastructure/subscriptionPlanStorage.js'
import { parseDepartmentNumber } from '@/shared/domain/departmentNumber.js'
import { todayYmd } from '@/finances/domain/billingCycle.js'

/**
 * Residents bounded-context API.
 *
 * Owns: lifecycle of resident accounts (creation by admin, invitation lookup,
 * credentials provisioning).
 * Errors expose `error.code`: 'RESIDENT_FIELDS_REQUIRED',
 * 'RESIDENT_CODE_ALREADY_EXISTS', 'RESIDENT_PLAN_LIMIT_REACHED', 'RESIDENT_NOT_FOUND', 'EMAIL_ALREADY_EXISTS'.
 */
export const residentsApi = {
  async list() {
    const { data } = await apiClient.get('/users', {
      params: withOwnerParams({ role: 'resident' }),
    })
    return Array.isArray(data) ? data.map(publicResident) : []
  },

  async add({ name, floor, code, department, billFromNextMonth = false }) {
    const cleanName = String(name ?? '').trim()

    let cleanFloor
    let cleanCode

    if (department != null && String(department).trim().length) {
      const parsed = parseDepartmentNumber(department)
      if (!parsed) {
        throw apiError('INVALID_DEPARTMENT_NUMBER')
      }
      cleanFloor = parsed.floor
      cleanCode = parsed.department
    } else {
      cleanFloor = String(floor ?? '').trim()
      cleanCode = normalizeCode(code)
    }

    if (!cleanName || !cleanFloor || !cleanCode) {
      throw apiError('RESIDENT_FIELDS_REQUIRED')
    }

    const codeExists = await findResidentByCode(cleanCode)
    if (codeExists) {
      throw apiError('RESIDENT_CODE_ALREADY_EXISTS')
    }

    const ownerAdminId = getActiveDataOwnerId()
    if (!ownerAdminId) {
      throw apiError('RESIDENT_OWNER_REQUIRED')
    }

    const existingResidents = await residentsApi.list()
    const limit = getResidentLimitForActiveOwner()
    if (existingResidents.length >= limit) {
      throw apiError('RESIDENT_PLAN_LIMIT_REACHED')
    }

    const newResident = {
      id: `resident-${Date.now()}`,
      name: cleanName,
      floor: cleanFloor,
      code: cleanCode,
      email: '',
      password: '',
      role: 'resident',
      admissionDate: todayYmd(),
      billFromNextMonth: Boolean(billFromNextMonth),
      ownerAdminId,
    }

    const { data: created } = await apiClient.post('/users', newResident)
    await refreshSubscriptionFromApi().catch(() => {})
    return publicResident(created)
  },

  async setBillFromNextMonth(id, billFromNextMonth) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')
    const { data } = await apiClient.patch(`/users/${encodeURIComponent(cleanId)}`, {
      billFromNextMonth: Boolean(billFromNextMonth),
    })
    return publicResident(data)
  },

  async findByCode(code) {
    const normalized = normalizeCode(code)
    if (!normalized) {
      throw apiError('RESIDENT_NOT_FOUND')
    }
    try {
      const { data } = await apiClient.get('/api/v1/authentication/residents/invite', {
        params: { code: normalized },
      })
      return publicResident(data)
    } catch (error) {
      if (error?.status === 404 || error?.code === 'RESIDENT_NOT_FOUND') {
        throw apiError('RESIDENT_NOT_FOUND')
      }
      throw error
    }
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('RESIDENT_NOT_FOUND')
    }
    await apiClient.delete(`/users/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },

  /**
   * Returns counters of linked data that would be deleted in cascade.
   * Useful to show a preview to the admin before confirming the delete.
   * Errors per entity are silenced (count is 0) but reported via `errors`.
   */
  async previewLinkedData(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')

    const summary = { reservations: 0 }
    const errors = []

    try {
      const reservations = await reservationsApi.listByResident(cleanId)
      summary.reservations = Array.isArray(reservations) ? reservations.length : 0
    } catch (error) {
      errors.push({ entity: 'reservations', error })
    }

    return { summary, errors }
  },

  /**
   * Cascade-delete a resident and every piece of data linked to them.
   *
   * The function tries to remove every related entity even if a previous
   * step fails (so a transient error on one collection does not orphan the
   * rest), and finally removes the user record itself. The returned
   * `summary` reports how many items were deleted per entity, and the
   * optional `errors` array surfaces any partial failures so the UI can
   * decide what to do next.
   */
  async removeCascade(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')

    const summary = { reservations: 0 }
    const errors = []

    try {
      const result = await reservationsApi.removeByResident(cleanId)
      summary.reservations = result?.removed ?? 0
    } catch (error) {
      errors.push({ entity: 'reservations', error })
    }

    try {
      await apiClient.delete(`/users/${encodeURIComponent(cleanId)}`)
    } catch (error) {
      errors.push({ entity: 'user', error })
      throw apiError('RESIDENT_DELETE_FAILED')
    }

    return { id: cleanId, summary, errors }
  },

  async setCredentials({ code, email, password }) {
    const cleanCode = normalizeCode(code)
    const cleanEmail = normalizeEmail(email)
    const cleanPassword = String(password ?? '')

    if (!cleanCode || !cleanEmail || !cleanPassword) {
      throw apiError('RESIDENT_FIELDS_REQUIRED')
    }

    try {
      const { data } = await apiClient.post('/api/v1/authentication/residents/set-credentials', {
        code: cleanCode,
        email: cleanEmail,
        password: cleanPassword,
      })
      return parseAuthResponse(data)
    } catch (error) {
      if (error?.code === 'RESIDENT_NOT_FOUND') {
        throw apiError('RESIDENT_NOT_FOUND')
      }
      if (error?.code === 'EMAIL_ALREADY_EXISTS') {
        throw apiError('EMAIL_ALREADY_EXISTS')
      }
      if (error?.code === 'INVALID_PASSWORD' || error?.code === 'EMAIL_NOT_FOUND') {
        throw apiError(error.code, error.payload?.message)
      }
      throw error
    }
  },

  async completeInviteWithGoogle({ code, email, name, googleSub, idToken }) {
    const cleanCode = normalizeCode(code)
    const cleanEmail = normalizeEmail(email)
    const cleanName = String(name ?? '').trim()
    const cleanSub = String(googleSub ?? '').trim()

    if (!cleanCode || !cleanEmail) {
      throw apiError('RESIDENT_FIELDS_REQUIRED')
    }

    const payload = {
      code: cleanCode,
      email: cleanEmail,
      name: cleanName,
      googleSub: cleanSub,
      idToken: String(idToken ?? ''),
      provider: 'google',
    }

    try {
      const { data } = await apiClient.post(
        '/api/v1/authentication/residents/complete-google',
        payload,
      )
      return parseAuthResponse(data)
    } catch (error) {
      if (error?.status === 404 || error?.code === 'HTTP_404') {
        return residentsApi.setCredentials({
          code: cleanCode,
          email: cleanEmail,
          password: cleanSub ? `google:${cleanSub}` : `google:${Date.now()}`,
        })
      }
      if (error?.code === 'RESIDENT_NOT_FOUND') {
        throw apiError('RESIDENT_NOT_FOUND')
      }
      if (error?.code === 'EMAIL_ALREADY_EXISTS') {
        throw apiError('EMAIL_ALREADY_EXISTS')
      }
      throw error
    }
  },
}
