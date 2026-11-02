import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import { reservationsApi } from '@/socialSpaces/infrastructure/reservationsApi.js'
import { withOwnerParams } from '@/shared/infrastructure/api/ownerQuery.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import { parseAuthResponse } from '@/iam/infrastructure/authApi.js'
import {
  apiError,
  findResidentByCode,
  normalizeCode,
  normalizeEmail,
  publicResident,
} from '@/shared/infrastructure/api/utils.js'
import { getResidentLimitForActiveOwner, refreshSubscriptionFromApi } from '@/billing/infrastructure/subscriptionPlanStorage.js'
import { parseDepartmentNumber } from '@/shared/domain/departmentNumber.js'
import { todayYmd } from '@/finances/domain/billingCycle.js'

const USERS_BASE = '/api/v1/users'
const RESIDENTS_IMPORT_BASE = '/api/v1/residents/import'

/** Invite link the admin shares with the resident (no email provider is integrated). */
export function residentInviteLink(resident) {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const params = new URLSearchParams({ invite: '1' })
  if (resident?.inviteToken) params.set('token', resident.inviteToken)
  else params.set('code', resident?.code || '')
  return `${baseUrl}/login?${params.toString()}`
}

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
    const { data } = await apiClient.get(USERS_BASE, {
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

    const { data: created } = await apiClient.post(USERS_BASE, newResident)
    await refreshSubscriptionFromApi().catch(() => {})
    return publicResident(created)
  },

  /**
   * US016: upload an .xlsx/.csv roster. The API validates every row first and rejects the whole file
   * with a per-row report (error.payload.errors) when any required cell is invalid.
   * @param {File} file
   * @returns {Promise<{ created: number, totalRows: number, residents: ReturnType<typeof publicResident>[] }>}
   */
  async importFile(file) {
    if (!file) throw apiError('FILE_REQUIRED')
    const form = new FormData()
    form.append('file', file, file.name)
    const { data } = await apiClient.post(`${RESIDENTS_IMPORT_BASE}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    })
    await refreshSubscriptionFromApi().catch(() => {})
    const residents = Array.isArray(data?.residents) ? data.residents.map(publicResident) : []
    return {
      created: Number(data?.created ?? residents.length),
      totalRows: Number(data?.totalRows ?? residents.length),
      residents,
    }
  },

  /** Template download (authenticated) → Blob. @param {'xlsx' | 'csv'} format */
  async downloadImportTemplate(format = 'xlsx') {
    const response = await apiClient.get(`${RESIDENTS_IMPORT_BASE}/template`, {
      params: { format },
      responseType: 'blob',
    })
    return response.data
  },

  /** US028: el admin corrige nombre y unidad (el número de departamento define piso y código). */
  async update(id, { name, department }) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')
    const parsed = parseDepartmentNumber(department)
    if (!parsed) throw apiError('INVALID_DEPARTMENT_NUMBER')
    const cleanName = String(name ?? '').trim()
    if (!cleanName) throw apiError('RESIDENT_FIELDS_REQUIRED')
    const { data } = await apiClient.patch(`${USERS_BASE}/${encodeURIComponent(cleanId)}`, {
      name: cleanName,
      floor: parsed.floor,
      code: parsed.department,
    })
    return publicResident(data)
  },

  async setBillFromNextMonth(id, billFromNextMonth) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')
    const { data } = await apiClient.patch(`${USERS_BASE}/${encodeURIComponent(cleanId)}`, {
      billFromNextMonth: Boolean(billFromNextMonth),
    })
    return publicResident(data)
  },

  /**
   * IAM AccountStatus: DEACTIVATED residents cannot sign in and every request gets
   * 403 ACCOUNT_DEACTIVATED (data is kept, unlike delete). Reversible with reactivate.
   */
  async setAccountActive(id, active) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) throw apiError('RESIDENT_NOT_FOUND')
    const action = active ? 'reactivate' : 'deactivate'
    const { data } = await apiClient.patch(`${USERS_BASE}/${encodeURIComponent(cleanId)}/${action}`)
    return publicResident(data)
  },

  /** Lookup público por invite token (128-bit). */
  async findByInviteToken(token) {
    const inviteToken = String(token ?? '').trim()
    if (!inviteToken) {
      throw apiError('RESIDENT_NOT_FOUND')
    }
    try {
      const { data } = await apiClient.get('/api/v1/authentication/residents/invite', {
        params: { token: inviteToken },
      })
      return publicResident(data)
    } catch (error) {
      if (error?.status === 404 || error?.code === 'RESIDENT_NOT_FOUND') {
        throw apiError('RESIDENT_NOT_FOUND')
      }
      if (error?.code === 'INVITE_EXPIRED' || error?.code === 'INVITE_ALREADY_USED') {
        throw apiError(error.code, error.payload?.message)
      }
      throw error
    }
  },

  /** @deprecated Prefer findByInviteToken. */
  async findByCode(code) {
    return residentsApi.findByInviteToken(code)
  },

  async remove(id) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) {
      throw apiError('RESIDENT_NOT_FOUND')
    }
    await apiClient.delete(`${USERS_BASE}/${encodeURIComponent(cleanId)}`)
    return { id: cleanId }
  },

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
      await apiClient.delete(`${USERS_BASE}/${encodeURIComponent(cleanId)}`)
    } catch (error) {
      errors.push({ entity: 'user', error })
      throw apiError('RESIDENT_DELETE_FAILED')
    }

    return { id: cleanId, summary, errors }
  },

  /**
   * Accept the invite with email + password (Firebase email/password account) instead of Google.
   * The API binds the Firebase uid to the resident exactly like complete-google.
   */
  async completeInviteWithPassword({ token, email, name, idToken }) {
    const inviteToken = String(token ?? '').trim()
    const cleanEmail = normalizeEmail(email)
    if (!inviteToken || !cleanEmail || !idToken) {
      throw apiError('RESIDENT_FIELDS_REQUIRED')
    }
    try {
      const { data } = await apiClient.post('/api/v1/authentication/residents/complete-invite', {
        token: inviteToken,
        email: cleanEmail,
        name: String(name ?? '').trim(),
        idToken: String(idToken),
        provider: 'password',
      })
      return parseAuthResponse(data)
    } catch (error) {
      if (error?.code === 'RESIDENT_NOT_FOUND') throw apiError('RESIDENT_NOT_FOUND')
      if (error?.code === 'EMAIL_ALREADY_EXISTS') throw apiError('EMAIL_ALREADY_EXISTS')
      if (
        error?.code === 'INVALID_ID_TOKEN' ||
        error?.code === 'INVITE_EXPIRED' ||
        error?.code === 'INVITE_ALREADY_USED' ||
        error?.code === 'INVITE_EMAIL_MISMATCH'
      ) {
        throw apiError(error.code, error.payload?.message)
      }
      throw error
    }
  },

  async completeInviteWithGoogle({ token, code, email, name, googleSub, idToken }) {
    const inviteToken = String(token ?? code ?? '').trim()
    const cleanEmail = normalizeEmail(email)
    const cleanName = String(name ?? '').trim()
    const cleanSub = String(googleSub ?? '').trim()

    if (!inviteToken || !cleanEmail) {
      throw apiError('RESIDENT_FIELDS_REQUIRED')
    }

    const payload = {
      token: inviteToken,
      code: inviteToken,
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
      if (error?.code === 'RESIDENT_NOT_FOUND') {
        throw apiError('RESIDENT_NOT_FOUND')
      }
      if (error?.code === 'EMAIL_ALREADY_EXISTS') {
        throw apiError('EMAIL_ALREADY_EXISTS')
      }
      if (error?.code === 'INVALID_ID_TOKEN') {
        throw apiError('INVALID_ID_TOKEN', error.payload?.message)
      }
      if (
        error?.code === 'INVITE_EXPIRED' ||
        error?.code === 'INVITE_ALREADY_USED' ||
        error?.code === 'INVITE_EMAIL_MISMATCH'
      ) {
        throw apiError(error.code, error.payload?.message)
      }
      throw error
    }
  },
}
