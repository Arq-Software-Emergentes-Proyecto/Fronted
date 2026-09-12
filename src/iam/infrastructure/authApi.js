import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import {
  apiError,
  normalizeEmail,
  publicUser,
} from '@/shared/infrastructure/api/utils.js'
import {
  getFirebaseAdminProfile,
  isFirebaseEmailRegistered,
  loginAdminWithFirebase,
  registerAdminWithFirebase,
} from './firebaseAuth.js'

export function parseAuthResponse(data) {
  if (!data || typeof data !== 'object') {
    throw apiError('AUTH_ERROR', 'Invalid authentication response.')
  }
  const user = data.user ?? data.User
  const token = data.token ?? data.Token
  if (!user || typeof user !== 'object' || !token) {
    throw apiError('AUTH_ERROR', 'Invalid authentication response.')
  }
  return { user: publicUser(user), token: String(token) }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

async function seedAdminDefaults(ownerId, token) {
  const headers = authHeaders(token)
  try {
    await apiClient.post(
      '/financeSettings',
      {
        ownerAdminId: ownerId,
        baseMonthlyExpense: 150,
        lateFeeRate: 0,
        lateFeePerDay: 0,
        admissionPayFromDay: 1,
        admissionPayToDay: 7,
        monthlyCharges: [],
      },
      { headers },
    )
  } catch {
    // ignore seed failure (e.g. duplicate); admin can still open Finanzas
  }
  try {
    await apiClient.post(
      '/kpi',
      {
        ownerAdminId: ownerId,
        totalResidents: 0,
        occupiedUnits: 0,
        emptyUnits: 0,
        totalDebt: 0,
      },
      { headers },
    )
  } catch {
    // ignore
  }
}

/**
 * IAM (Identity & Access Management) bounded-context API.
 *
 * Owns: authentication and admin registration.
 * Errors expose `error.code`: 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD',
 * 'EMAIL_ALREADY_EXISTS', or generic ones from the shared client.
 */
export const authApi = {
  async isEmailRegistered(email) {
    const { exists, methods } = await isFirebaseEmailRegistered(email)
    if (methods.includes('google.com') && !methods.includes('password')) {
      throw apiError('RESIDENT_USE_GOOGLE')
    }
    if (!methods.length) return true
    return exists
  },

  async loginWithGoogle({ email, googleSub, idToken }) {
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail) {
      throw apiError('EMAIL_NOT_FOUND')
    }
    try {
      const { data } = await apiClient.post('/api/v1/authentication/sign-in-google', {
        email: normalizedEmail,
        googleSub: String(googleSub ?? '').trim(),
        idToken: String(idToken ?? ''),
        provider: 'google',
      })
      return parseAuthResponse(data)
    } catch (error) {
      if (
        error?.code === 'EMAIL_NOT_FOUND' ||
        error?.code === 'INVALID_PASSWORD' ||
        error?.code === 'RESIDENT_ONLY' ||
        error?.code === 'RESIDENT_GOOGLE_REQUIRED' ||
        error?.code === 'RESIDENT_USE_GOOGLE'
      ) {
        throw apiError(error.code, error.payload?.message)
      }
      throw error
    }
  },

  async login({ email, password }) {
    return loginAdminWithFirebase({ email, password })
  },

  async registerAdmin(payload) {
    const { user, token } = await registerAdminWithFirebase(payload)
    await seedAdminDefaults(user.id, token)
    try {
      await apiClient.post('/users', {
        id: user.id,
        name: user.name,
        email: user.email,
        dni: user.dni,
        address: user.address,
        company: user.company,
        ruc: user.ruc,
        role: 'admin',
      })
    } catch {
      // mock/API user row is optional once Firebase Auth owns the account
    }
    return { user, token }
  },

  /**
   * Full user row for settings views. Uses GET /users/:id.
   */
  async getProfileById(userId) {
    if (!userId) return null
    const fromFirebase = await getFirebaseAdminProfile(userId)
    if (fromFirebase) return fromFirebase
    try {
      const { data } = await apiClient.get(`/users/${encodeURIComponent(userId)}`)
      if (!data || typeof data !== 'object') return null
      return data
    } catch {
      return null
    }
  },
}
