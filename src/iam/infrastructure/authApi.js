import { apiClient } from '@/shared/infrastructure/api/apiClient.js'
import {
  apiError,
  normalizeEmail,
  publicUser,
} from '@/shared/infrastructure/api/utils.js'
import {
  LOCAL_PREVIEW_ENABLED,
  previewAdminAuthResult,
} from '@/iam/application/localPreviewAuth.js'
import {
  isFirebaseEmailRegistered,
  loginAdminWithFirebase,
  registerAdminWithFirebase,
} from './firebaseAuth.js'

function isCredentialLoginError(error) {
  const code = String(error?.code ?? '')
  const details = `${code} ${error?.message ?? ''}`.toLowerCase()
  return (
    code === 'INVALID_PASSWORD' ||
    code === 'EMAIL_NOT_FOUND' ||
    code === 'AUTH_ERROR' ||
    details.includes('invalid-credential') ||
    details.includes('invalid_login_credentials')
  )
}

export function parseAuthResponse(data) {
  if (!data || typeof data !== 'object') {
    throw apiError('AUTH_ERROR', 'Invalid authentication response.')
  }
  const user = data.user ?? data.User
  if (!user || typeof user !== 'object') {
    throw apiError('AUTH_ERROR', 'Invalid authentication response.')
  }
  const useFirebase =
    data.useFirebaseIdToken === true ||
    data.UseFirebaseIdToken === true ||
    data.token == null ||
    data.Token == null ||
    data.token === '' ||
    data.Token === ''
  const rawToken = data.token ?? data.Token
  return {
    user: publicUser(user),
    token: rawToken != null && String(rawToken).length ? String(rawToken) : null,
    useFirebaseIdToken: useFirebase,
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

function profileFromApi(data, fallback = {}) {
  if (!data || typeof data !== 'object') return null
  const id = String(data.id ?? data.Id ?? fallback.id ?? '').trim()
  if (!id) return null
  return {
    id,
    name: String(data.name ?? data.Name ?? fallback.name ?? '').trim(),
    email: normalizeEmail(data.email ?? data.Email ?? fallback.email ?? ''),
    role: 'admin',
    dni: String(data.dni ?? data.Dni ?? '').trim(),
    address: String(data.address ?? data.Address ?? '').trim(),
    company: String(data.company ?? data.Company ?? '').trim(),
    ruc: String(data.ruc ?? data.Ruc ?? '').trim(),
  }
}

async function upsertProfile(token, draft) {
  const { data } = await apiClient.post(
    '/api/v1/profiles',
    {
      name: draft.name,
      email: draft.email,
      dni: draft.dni,
      address: draft.address,
      company: draft.company,
      ruc: draft.ruc,
    },
    { headers: authHeaders(token) },
  )
  return profileFromApi(data, draft)
}

async function fetchMyProfile(token) {
  const { data } = await apiClient.get('/api/v1/profiles/me', {
    headers: authHeaders(token),
  })
  return profileFromApi(data)
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
    // ignore
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
 * Auth = Firebase. Perfil = unica fuente BuildingFex.Api /api/v1/profiles.
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
      const parsed = parseAuthResponse(data)
      return parsed
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
    try {
      const { identity, token } = await loginAdminWithFirebase({ email, password })
      try {
        const profile = await fetchMyProfile(token)
        if (!profile) {
          throw apiError('PROFILE_NOT_FOUND')
        }
        return { user: profile, token, profileIncomplete: false }
      } catch (error) {
        // Auth ok pero sin fila en profiles → recuperable
        if (
          error?.code === 'PROFILE_NOT_FOUND' ||
          error?.status === 404 ||
          error?.code === 'HTTP_404'
        ) {
          return {
            user: {
              ...identity,
              dni: '',
              address: '',
              company: '',
              ruc: '',
            },
            token,
            profileIncomplete: true,
          }
        }
        throw error
      }
    } catch (error) {
      if (LOCAL_PREVIEW_ENABLED && isCredentialLoginError(error)) {
        return previewAdminAuthResult({ email })
      }
      throw error
    }
  },

  /** Completa perfil tras Auth sin perfil (o tras fallo de POST en el registro). */
  async completeProfile(token, draft) {
    const profile = await upsertProfile(token, draft)
    if (!profile?.id) {
      throw apiError('PROFILE_SAVE_FAILED', 'No se pudo guardar el perfil en el servidor.')
    }
    await seedAdminDefaults(profile.id, token)
    return { user: profile, token }
  },

  async registerAdmin(payload) {
    const { identity, token, profileDraft } = await registerAdminWithFirebase(payload)
    try {
      const profile = await upsertProfile(token, profileDraft)
      if (!profile?.id) {
        throw apiError('PROFILE_SAVE_FAILED')
      }
      await seedAdminDefaults(profile.id, token)
      return { user: profile, token, profileIncomplete: false }
    } catch (error) {
      // 409: ya hay admin — no es recuperable con completar-perfil
      if (
        error?.code === 'ADMIN_BOOTSTRAP_CLOSED' ||
        error?.status === 409 ||
        error?.code === 'HTTP_409'
      ) {
        throw apiError(
          'ADMIN_BOOTSTRAP_CLOSED',
          error?.payload?.message
            || 'Ya existe un administrador. El auto-registro está cerrado.',
        )
      }
      // Cuenta Firebase ya existe: el usuario puede login y completar perfil
      if (
        error?.code === 'PROFILE_SAVE_FAILED' ||
        error?.code === 'NETWORK_ERROR' ||
        error?.code === 'TIMEOUT' ||
        error?.code === 'HTTP_500' ||
        error?.status >= 500
      ) {
        const incomplete = apiError(
          'PROFILE_INCOMPLETE_AFTER_AUTH',
          'Cuenta creada en Auth pero el perfil no se guardo. Completa tu perfil.',
        )
        incomplete.token = token
        incomplete.identity = identity
        incomplete.profileDraft = profileDraft
        throw incomplete
      }
      throw error
    }
  },

  async getProfileById(userId) {
    if (!userId) return null
    try {
      const { data } = await apiClient.get(`/api/v1/profiles/${encodeURIComponent(userId)}`)
      return profileFromApi(data, { id: userId })
    } catch {
      return null
    }
  },
}
