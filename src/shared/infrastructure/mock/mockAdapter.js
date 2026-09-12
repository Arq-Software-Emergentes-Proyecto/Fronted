import { AxiosError } from 'axios'
import { createPreviewAccessToken } from '@/iam/application/localPreviewAuth.js'
import { SessionRoles } from '@/iam/domain/sessionRoles.js'
import { maxResidentsForSubscriptionPlan, SubscriptionPlanId } from '@/shared/domain/subscriptionPlans.js'
import { getActiveDataOwnerId } from '@/shared/infrastructure/api/ownerTenant.js'
import {
  computeKpi,
  findById,
  insertRow,
  isKnownCollection,
  listCollection,
  patchRow,
  queryCollection,
  removeRow,
  replaceRow,
  subscriptionSnapshot,
  upsertSubscription,
} from './mockDb.js'
import { MOCK_OWNER_ID } from './seed.js'

function pathParts(config) {
  const raw = String(config.url ?? '')
  const withoutQuery = raw.split('?')[0]
  return withoutQuery
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
}

function readBody(config) {
  const raw = config.data
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return {}
  }
}

function readParams(config) {
  const params = config.params && typeof config.params === 'object' ? { ...config.params } : {}
  const raw = String(config.url ?? '')
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : ''
  if (query) {
    for (const [key, value] of new URLSearchParams(query).entries()) {
      params[key] = value
    }
  }
  return params
}

function ok(config, data, status = 200) {
  return {
    data,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    headers: { 'content-type': 'application/json' },
    config,
    request: { mock: true },
  }
}

function fail(config, status, code, message, extra = {}) {
  const data = { code, message, ...extra }
  const error = new AxiosError(message ?? code, AxiosError.ERR_BAD_REQUEST, config, {}, {
    status,
    statusText: 'Error',
    data,
    headers: {},
    config,
  })
  throw error
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    floor: user.floor ?? null,
    code: user.code ?? null,
    ownerAdminId: user.ownerAdminId ?? null,
  }
}

function authPayload(user) {
  const role = user.role === SessionRoles.RESIDENT ? SessionRoles.RESIDENT : SessionRoles.ADMIN
  return {
    user: publicUser(user),
    token: createPreviewAccessToken({
      role,
      email: user.email,
      sub: user.id,
    }),
  }
}

function ownerFromParams(params) {
  const raw = params.ownerAdminId
  if (raw != null && String(raw).length) return String(raw)
  return getActiveDataOwnerId() ?? MOCK_OWNER_ID
}

function handleCollection(config, method, collection, id) {
  const params = readParams(config)
  const body = readBody(config)

  if (collection === 'kpi' && method === 'GET' && !id) {
    return ok(config, [computeKpi(ownerFromParams(params))])
  }

  if (collection === 'financeSettings' && method === 'PATCH' && !id) {
    const ownerId = ownerFromParams(params)
    const match = queryCollection('financeSettings', ownerId ? { ownerAdminId: ownerId } : {})[0]
    if (!match) fail(config, 404, 'SETTINGS_NOT_FOUND', 'Settings not found')
    return ok(config, patchRow('financeSettings', match.id, body))
  }

  if (!id) {
    if (method === 'GET') return ok(config, queryCollection(collection, params))
    if (method === 'POST') return ok(config, insertRow(collection, body), 201)
    fail(config, 405, 'HTTP_405', 'Method not allowed')
  }

  if (method === 'GET') {
    const row = findById(collection, id)
    if (!row) fail(config, 404, 'HTTP_404', 'Not found')
    return ok(config, row)
  }
  if (method === 'PUT') {
    const row = replaceRow(collection, id, body)
    if (!row) fail(config, 404, 'HTTP_404', 'Not found')
    return ok(config, row)
  }
  if (method === 'PATCH') {
    const row = patchRow(collection, id, body)
    if (!row) fail(config, 404, 'HTTP_404', 'Not found')
    return ok(config, row)
  }
  if (method === 'DELETE') {
    if (!removeRow(collection, id)) fail(config, 404, 'HTTP_404', 'Not found')
    return ok(config, {})
  }

  fail(config, 405, 'HTTP_405', 'Method not allowed')
}

function handleV1(config, method, parts) {
  const route = parts.slice(2).join('/')
  const params = readParams(config)
  const body = readBody(config)

  if (route === 'authentication/check-email' && method === 'GET') {
    const email = String(params.email ?? '').trim().toLowerCase()
    const exists = listCollection('users').some(
      (user) => String(user.email ?? '').trim().toLowerCase() === email,
    )
    return ok(config, { exists })
  }

  if (route === 'authentication/sign-in' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const user = listCollection('users').find(
      (row) => String(row.email ?? '').trim().toLowerCase() === email,
    )
    if (!user) fail(config, 401, 'EMAIL_NOT_FOUND', 'Email not found')
    if (user.role === 'resident') {
      fail(config, 401, 'RESIDENT_USE_GOOGLE', 'Residents must sign in with Google')
    }
    if (String(user.password ?? '') !== password) {
      fail(config, 401, 'INVALID_PASSWORD', 'Invalid password')
    }
    return ok(config, authPayload(user))
  }

  if (route === 'authentication/sign-in-google' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase()
    const googleSub = String(body.googleSub ?? '').trim()
    const user = listCollection('users').find((row) => {
      const sameEmail = email && String(row.email ?? '').trim().toLowerCase() === email
      const sameGoogle = googleSub && String(row.googleSub ?? '').trim() === googleSub
      return sameEmail || sameGoogle
    })
    if (!user) fail(config, 401, 'EMAIL_NOT_FOUND', 'Email not found')
    if (user.role !== 'resident') {
      fail(config, 401, 'RESIDENT_ONLY', 'Only invited residents can use this login')
    }
    const activatedWithGoogle =
      user.authProvider === 'google' ||
      Boolean(user.googleSub) ||
      user.hasCredentials === true
    if (!activatedWithGoogle) {
      fail(config, 401, 'RESIDENT_GOOGLE_REQUIRED', 'Resident must finish Google invite first')
    }
    return ok(config, authPayload(user))
  }

  if (route === 'authentication/register-admin' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase()
    const exists = listCollection('users').some(
      (row) => String(row.email ?? '').trim().toLowerCase() === email,
    )
    if (exists) fail(config, 409, 'EMAIL_ALREADY_EXISTS', 'Email already exists')
    const user = insertRow('users', {
      name: String(body.name ?? '').trim() || 'Admin',
      email,
      password: String(body.password ?? ''),
      dni: String(body.dni ?? '').trim(),
      address: String(body.address ?? '').trim(),
      company: String(body.company ?? '').trim(),
      ruc: String(body.ruc ?? '').trim(),
      role: 'admin',
    })
    insertRow('financeSettings', {
      ownerAdminId: user.id,
      baseMonthlyExpense: 150,
      lateFeeRate: 0,
      lateFeePerDay: 0,
      admissionPayFromDay: 1,
      admissionPayToDay: 7,
      monthlyCharges: [],
    })
    upsertSubscription(user.id, { planId: 'standard', isPaid: true, paidUntil: null })
    return ok(config, authPayload(user), 201)
  }

  if (route === 'authentication/residents/invite' && method === 'GET') {
    const code = String(params.code ?? '').trim()
    const user = listCollection('users').find(
      (row) => row.role === 'resident' && String(row.code ?? '').trim() === code,
    )
    if (!user) fail(config, 404, 'RESIDENT_NOT_FOUND', 'Resident not found')
    return ok(config, user)
  }

  if (route === 'authentication/residents/complete-google' && method === 'POST') {
    const code = String(body.code ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const googleSub = String(body.googleSub ?? '').trim()
    const name = String(body.name ?? '').trim()
    const user = listCollection('users').find(
      (row) => row.role === 'resident' && String(row.code ?? '').trim() === code,
    )
    if (!user) fail(config, 404, 'RESIDENT_NOT_FOUND', 'Resident not found')
    if (!email) fail(config, 400, 'RESIDENT_FIELDS_REQUIRED', 'Google email is required')
    const taken = listCollection('users').some(
      (row) => row.id !== user.id && String(row.email ?? '').trim().toLowerCase() === email,
    )
    if (taken) fail(config, 409, 'EMAIL_ALREADY_EXISTS', 'Email already exists')
    const updated = patchRow('users', user.id, {
      email,
      password: '',
      authProvider: 'google',
      googleSub,
      hasCredentials: true,
    })
    return ok(config, authPayload(updated))
  }

  if (route === 'authentication/residents/set-credentials' && method === 'POST') {
    const code = String(body.code ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const provider = String(body.provider ?? '').trim()
    const user = listCollection('users').find(
      (row) => row.role === 'resident' && String(row.code ?? '').trim() === code,
    )
    if (!user) fail(config, 404, 'RESIDENT_NOT_FOUND', 'Resident not found')
    if (provider !== 'google' && !password) {
      fail(config, 400, 'RESIDENT_FIELDS_REQUIRED', 'Password is required')
    }
    const taken = listCollection('users').some(
      (row) => row.id !== user.id && String(row.email ?? '').trim().toLowerCase() === email,
    )
    if (taken) fail(config, 409, 'EMAIL_ALREADY_EXISTS', 'Email already exists')
    const updated = patchRow('users', user.id, {
      email,
      password: provider === 'google' ? '' : password,
      ...(provider === 'google'
        ? { authProvider: 'google', googleSub: String(body.googleSub ?? '').trim(), hasCredentials: true }
        : {}),
    })
    return ok(config, authPayload(updated))
  }

  if (route === 'subscription' && method === 'GET') {
    return ok(config, subscriptionSnapshot(ownerFromParams(params)))
  }

  if (route === 'subscription' && method === 'PATCH') {
    const ownerId = ownerFromParams(params)
    const planId = String(body.planId ?? 'free')
    const snapshot = subscriptionSnapshot(ownerId)
    if (planId === SubscriptionPlanId.FREE && snapshot.residentsCount > maxResidentsForSubscriptionPlan(planId)) {
      fail(config, 409, 'PLAN_DOWNGRADE_RESIDENTS_EXCEEDED', 'Too many residents for the free plan')
    }
    return ok(config, upsertSubscription(ownerId, { planId, isPaid: planId !== SubscriptionPlanId.FREE }))
  }

  if (route === 'subscription/checkout' && method === 'POST') {
    return ok(config, {
      preferenceId: `pref-sub-${Date.now()}`,
      initPoint: null,
      demo: true,
      amount: 0,
      planId: String(body.planId ?? 'essential'),
    })
  }

  if (route === 'subscription/confirm' && method === 'POST') {
    const ownerId = ownerFromParams(params)
    const planId = String(body.planId ?? 'essential')
    const paidUntil = new Date()
    paidUntil.setDate(paidUntil.getDate() + 30)
    const y = paidUntil.getFullYear()
    const m = String(paidUntil.getMonth() + 1).padStart(2, '0')
    const d = String(paidUntil.getDate()).padStart(2, '0')
    const subscription = upsertSubscription(ownerId, {
      planId,
      isPaid: true,
      paidUntil: `${y}-${m}-${d}`,
    })
    return ok(config, {
      activated: true,
      planId,
      paidUntil: subscription.paidUntil,
      subscription,
    })
  }

  if ((route === 'payments/checkout' || route === 'payments/preference') && method === 'POST') {
    return ok(config, {
      preferenceId: `pref-pay-${Date.now()}`,
      initPoint: null,
      demo: true,
    })
  }

  if (route === 'payments/confirm' && method === 'POST') {
    const residentId = String(body.residentId ?? '')
    const ownerId = ownerFromParams(params)
    const pendingReceipts = queryCollection('receipts', {
      residentId,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }).filter((row) => row.status !== 'Paid')
    const pendingFees = queryCollection('fees', {
      residentId,
      ...(ownerId ? { ownerAdminId: ownerId } : {}),
    }).filter((row) => row.status !== 'Pagado')

    const paidAt = new Date().toISOString()
    let itemsPaid = 0

    for (const receipt of pendingReceipts) {
      patchRow('receipts', receipt.id, { status: 'Paid' })
      insertRow('payments', {
        residentId,
        feeId: receipt.id,
        feeMonth: receipt.dueDate,
        concept: receipt.concept || 'Mantenimiento',
        amount:
          Number(receipt.amount ?? 0) +
          Number(receipt.lateFee ?? 0) +
          Number(receipt.extraCharges ?? 0),
        paidAt,
        method: 'Mercado Pago (demo)',
        reference: `DEMO-${receipt.id}`,
        ownerAdminId: receipt.ownerAdminId ?? ownerId,
      })
      itemsPaid += 1
    }
    for (const fee of pendingFees) {
      patchRow('fees', fee.id, { status: 'Pagado' })
      itemsPaid += 1
    }

    return ok(config, { reconciled: itemsPaid > 0, itemsPaid, paidAt })
  }

  fail(config, 404, 'HTTP_404', `No mock for /api/v1/${route}`)
}

export async function localMockAdapter(config) {
  const method = String(config.method ?? 'get').toUpperCase()
  const parts = pathParts(config)

  try {
    if (parts[0] === 'api' && parts[1] === 'v1') {
      return handleV1(config, method, parts)
    }

    const [collection, id] = parts
    if (isKnownCollection(collection)) {
      return handleCollection(config, method, collection, id)
    }

    fail(config, 404, 'HTTP_404', `No mock for /${parts.join('/')}`)
  } catch (error) {
    if (error instanceof AxiosError) throw error
    throw error
  }
}
