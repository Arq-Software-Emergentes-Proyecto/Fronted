import { AxiosError } from 'axios'
import { createPreviewAccessToken } from '@/iam/application/localPreviewAuth.js'
import { SessionRoles } from '@/iam/domain/sessionRoles.js'
import { maxResidentsForSubscriptionPlan, SubscriptionPlanId } from '@/billing/domain/subscriptionPlans.js'
import { buildLocalPlanCatalog, suggestPlanForDepartments } from '@/billing/domain/planCatalog.js'
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
import { isExtraReceipt, ReceiptKinds, resolveReceiptKind } from '@/finances/domain/receipt.js'
import { demoFileDataUrl, handleOperations, uploadResource } from './mockOperations.js'

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const want = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) {
      return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
    }
  }
  return ''
}

/** Decode preview JWT (or any JWT payload) from Authorization for Node mock context. */
function authClaimsFromConfig(config) {
  const raw = headerValue(config.headers, 'authorization')
  const match = raw.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  try {
    const segment = String(match[1]).split('.')[1]
    if (!segment) return null
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json =
      typeof Buffer !== 'undefined'
        ? Buffer.from(padded, 'base64').toString('utf8')
        : atob(padded)
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

export function resolveActor(config) {
  const claims = authClaimsFromConfig(config)
  const sub = claims?.sub != null ? String(claims.sub) : ''
  const role =
    claims?.role === SessionRoles.RESIDENT ? SessionRoles.RESIDENT : SessionRoles.ADMIN
  if (sub) {
    return {
      id: sub,
      role,
      email: claims?.email != null ? String(claims.email) : '',
      ownerAdminId:
        role === SessionRoles.RESIDENT
          ? MOCK_OWNER_ID
          : sub,
    }
  }
  const ownerId = getActiveDataOwnerId() || MOCK_OWNER_ID
  return { id: ownerId, role: SessionRoles.ADMIN, email: '', ownerAdminId: ownerId }
}

/** Demo assistant: canned reply + the building document it "cites" (like the real RAG reply). */
function hardcodedAiReply(userText, locale = 'es') {
  const text = String(userText ?? '').toLowerCase()
  const es = !String(locale).toLowerCase().startsWith('en')
  const rules = es ? 'Reglamento interno.pdf' : 'Internal rules.pdf'
  if (shouldEscalateToAdmin(userText)) {
    return {
      body: es
        ? 'Listo, derivé tu consulta a administración. Te responderán por este mismo chat.'
        : 'Done, I forwarded your request to management. They will reply in this same chat.',
    }
  }
  if (/admin|administraci|human|persona|hablar/.test(text)) {
    return {
      body: es
        ? 'Puedo ayudarte con eso. Si prefieres hablar con administración, escribe “quiero hablar con un administrador” y te conectamos.'
        : 'I can help with that. If you prefer a human from management, say “I want to talk to an admin” and we will connect you.',
    }
  }
  if (/pago|recibo|cuota|deuda|bill|payment|fee/.test(text)) {
    return {
      body: es
        ? 'La cuota de mantenimiento vence el día 5 de cada mes. Tus recibos están en Finanzas: los pendientes aparecen como “Por pagar” y puedes pagarlos con tarjeta o Mercado Pago. Si un cargo no cuadra, avísame el mes y el monto.'
        : 'The maintenance fee is due on the 5th of each month. Your bills are under Finance: pending ones show as unpaid and you can pay them by card or Mercado Pago. If a charge looks wrong, tell me the month and amount.',
      citedSource: rules,
    }
  }
  if (/reserva|espacio|piscina|guest|invitad|qr|book|pool/.test(text)) {
    return {
      body: es
        ? 'La piscina abre de 7:00 a 21:00 y cada reserva admite hasta 5 invitados. Reserva en Servicios eligiendo espacio, fecha y horario; luego, en Generación, agrega a tus invitados y comparte el enlace o el QR.'
        : 'The pool is open 7:00–21:00 and each booking allows up to 5 guests. Book under Services by picking the space, date and time; then, under Generation, add your guests and share the link or QR code.',
      citedSource: rules,
    }
  }
  if (/incidencia|incidente|fuga|ascensor|incident|leak/.test(text)) {
    return {
      body: es
        ? 'Repórtala en la sección Incidencias con una foto y el área del edificio. Según el acuerdo de junta, las fugas de agua se atienden con prioridad dentro de 24 horas.'
        : 'Report it under Incidents with a photo and the area of the building. Per the board agreement, water leaks are handled as a priority within 24 hours.',
      citedSource: es ? 'Acta de junta – agosto 2026.pdf' : 'Board minutes – August 2026.pdf',
    }
  }
  return {
    body: es
      ? 'Soy el asistente demo de BuildingFex. Puedo orientarte sobre pagos, reservas, incidencias y contacto con administración. ¿En qué te ayudo?'
      : 'I am the BuildingFex demo assistant. I can help with payments, reservations, incidents, and reaching management. How can I help?',
  }
}

function shouldEscalateToAdmin(userText) {
  return /hablar con|quiero (un |una )?(administrador|administraci|humano|persona)|persona real|talk to (an? )?(admin|human)|speak (to|with)/.test(
    String(userText ?? '').toLowerCase(),
  )
}

function publicSupportChat(row) {
  return {
    id: row.id,
    ownerAdminId: row.ownerAdminId ?? MOCK_OWNER_ID,
    residentId: row.residentId ?? '',
    residentName: row.residentName ?? '',
    topic: row.topic ?? row.title ?? '',
    title: row.title ?? row.topic ?? '',
    titleSummarized: Boolean(row.titleSummarized),
    status: row.status ?? 'open',
    pending: !row.status || row.status === 'open',
    closedAt: row.closedAt ?? '',
    kind: row.kind ?? '',
    source: row.source ?? 'resident',
    linkedChatId: row.linkedChatId ?? row.escalatedChatId ?? '',
    escalatedChatId: row.escalatedChatId ?? row.linkedChatId ?? '',
    aiChatId: row.aiChatId ?? row.linkedChatId ?? '',
    messages: Array.isArray(row.messages) ? row.messages : [],
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

export function pathParts(config) {
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

export function readBody(config) {
  const raw = config.data
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return {}
  }
}

export function readParams(config) {
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

export function ok(config, data, status = 200) {
  return {
    data,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    headers: { 'content-type': 'application/json' },
    config,
    request: { mock: true },
  }
}

export function fail(config, status, code, message, extra = {}) {
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

export function publicUser(user) {
  const isResident = user.role === 'resident'
  const inviteAlive = isResident && !user.inviteUsedAt
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    floor: user.floor ?? null,
    code: user.code ?? null,
    ownerAdminId: user.ownerAdminId ?? null,
    // Mirror BuildingFex.Api UserResourceAssembler (admission, billing flag, invite, account status).
    admissionDate: user.admissionDate ? String(user.admissionDate).slice(0, 10) : null,
    billFromNextMonth: isResident ? Boolean(user.billFromNextMonth) : null,
    hasCredentials: isResident
      ? user.hasCredentials === true ||
        user.authProvider === 'google' ||
        Boolean(user.googleSub) ||
        Boolean(user.email && user.password)
      : null,
    authProvider: user.authProvider || null,
    inviteToken: inviteAlive ? (user.inviteToken ?? null) : null,
    inviteExpiresAt: inviteAlive ? (user.inviteExpiresAt ?? null) : null,
    accountStatus: String(user.accountStatus ?? '').toUpperCase() === 'DEACTIVATED' ? 'DEACTIVATED' : 'ACTIVE',
    deactivatedAt: user.deactivatedAt ?? null,
  }
}

function authPayload(user) {
  const role = user.role === SessionRoles.RESIDENT ? SessionRoles.RESIDENT : SessionRoles.ADMIN
  // Preview local: token mock. En API real useFirebaseIdToken=true y token=null.
  return {
    user: publicUser(user),
    token: createPreviewAccessToken({
      role,
      email: user.email,
      sub: user.id,
    }),
    useFirebaseIdToken: false,
  }
}

export function ownerFromParams(params) {
  const raw = params.ownerAdminId
  if (raw != null && String(raw).length) return String(raw)
  return getActiveDataOwnerId() ?? MOCK_OWNER_ID
}

function handleCollection(config, method, collection, id) {
  const params = readParams(config)
  const body = readBody(config)

  // Query flags of the real API that are not row fields (Social Spaces history / purge).
  if (collection === 'reservations') {
    delete params.includeCancelled
    delete params.purge
  }

  if (collection === 'kpi' && method === 'GET' && !id) {
    return ok(config, [computeKpi(ownerFromParams(params))])
  }

  if (collection === 'financeSettings' && method === 'PATCH' && !id) {
    const ownerId = ownerFromParams(params)
    const match = queryCollection('financeSettings', ownerId ? { ownerAdminId: ownerId } : {})[0]
    if (!match) fail(config, 404, 'SETTINGS_NOT_FOUND', 'Settings not found')
    return ok(config, patchRow('financeSettings', match.id, body))
  }

  if (collection === 'receipts' && method === 'POST' && !id) {
    // Mirrors the API (ReceiptsCompatController): resolve kind; one MONTHLY fee per resident and
    // month (RNF011) — a duplicate returns the existing row; extra-charge receipts always insert.
    const kind = resolveReceiptKind(body.kind, body.amount, body.extraCharges)
    const row = { ...body, kind }
    const month = String(row.billingMonth ?? '').trim().slice(0, 7)
    if (kind === ReceiptKinds.MONTHLY && month) {
      const ownerAdminId = String(row.ownerAdminId ?? ownerFromParams(params) ?? '')
      const duplicate = queryCollection('receipts', {}).find(
        (r) =>
          String(r.ownerAdminId ?? ownerAdminId) === ownerAdminId &&
          String(r.residentId) === String(row.residentId) &&
          !isExtraReceipt(r) &&
          String(r.billingMonth ?? '').slice(0, 7) === month,
      )
      if (duplicate) return ok(config, duplicate)
    }
    return ok(config, insertRow('receipts', row), 201)
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
    const inviteToken = String(params.token ?? params.code ?? '').trim()
    const user = listCollection('users').find(
      (row) =>
        row.role === 'resident' &&
        (String(row.inviteToken ?? '').trim() === inviteToken ||
          String(row.code ?? '').trim() === inviteToken),
    )
    if (!user) fail(config, 404, 'RESIDENT_NOT_FOUND', 'Resident not found')
    if (user.inviteUsedAt) fail(config, 400, 'INVITE_ALREADY_USED', 'Invite already used')
    return ok(config, {
      name: user.name,
      floor: user.floor,
      code: user.code,
      inviteExpiresAt: user.inviteExpiresAt ?? null,
    })
  }

  if (
    (route === 'authentication/residents/complete-google' ||
      route === 'authentication/residents/complete-invite') &&
    method === 'POST'
  ) {
    const inviteToken = String(body.token ?? body.code ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const googleSub = String(body.googleSub ?? '').trim()
    const name = String(body.name ?? '').trim()
    const user = listCollection('users').find(
      (row) =>
        row.role === 'resident' &&
        (String(row.inviteToken ?? '').trim() === inviteToken ||
          String(row.code ?? '').trim() === inviteToken),
    )
    if (!user) fail(config, 404, 'RESIDENT_NOT_FOUND', 'Resident not found')
    if (!email) fail(config, 400, 'RESIDENT_FIELDS_REQUIRED', 'Google email is required')
    if (user.inviteEmail && String(user.inviteEmail).toLowerCase() !== email) {
      fail(config, 400, 'INVITE_EMAIL_MISMATCH', 'Google email does not match invitation')
    }
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
      inviteUsedAt: new Date().toISOString(),
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

  // Billing — public plan catalog + plan caps (mirror BuildingFex.Api PlansController / SubscriptionController)
  if (route === 'plans' && method === 'GET') {
    return ok(config, buildLocalPlanCatalog())
  }

  if (route === 'plans/suggest' && method === 'GET') {
    const departments = Number(params.departments ?? 0)
    return ok(config, { departments, planId: suggestPlanForDepartments(departments) })
  }

  if (route === 'subscription/limits' && method === 'GET') {
    const snapshot = subscriptionSnapshot(ownerFromParams(params))
    return ok(config, {
      planId: snapshot.planId,
      status: snapshot.status,
      maxDepartments: snapshot.residentLimit,
      departmentsUsed: snapshot.residentsCount,
      departmentsAvailable: Math.max(0, snapshot.residentLimit - snapshot.residentsCount),
      monthlyAiQueries: snapshot.monthlyAiQueries,
      aiQueriesUsed: null,
      canAddResidents: snapshot.canAddResidents,
    })
  }

  // Profiles — buildings (RF015 / TS001 / TS002)
  if (route === 'buildings' || route.startsWith('buildings/')) {
    const ownerId = ownerFromParams(params)
    const rest = route === 'buildings' ? '' : route.slice('buildings/'.length)
    const toResource = (row) => ({
      ...row,
      suggestedPlanId: suggestPlanForDepartments(row.departmentCount),
    })
    const validate = () => {
      const errors = {}
      if (!String(body.name ?? '').trim()) errors.name = ['El nombre del edificio es obligatorio.']
      if (!String(body.address ?? '').trim()) errors.address = ['La dirección es obligatoria.']
      const count = Number(body.departmentCount)
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        errors.departmentCount = ['La cantidad de departamentos debe estar entre 1 y 5000.']
      }
      if (Object.keys(errors).length) fail(config, 400, 'BUILDING_VALIDATION_FAILED', 'Datos del edificio inválidos.', { errors })
    }
    const mine = () => queryCollection('buildings', { ownerAdminId: ownerId })
    if (!rest && method === 'POST') {
      validate()
      if (mine().length) fail(config, 409, 'BUILDING_ALREADY_REGISTERED', 'Building already registered', { id: mine()[0].id })
      const created = insertRow('buildings', {
        id: Date.now(),
        name: String(body.name).trim(),
        address: String(body.address).trim(),
        departmentCount: Number(body.departmentCount),
        ownerAdminId: ownerId,
        createdAt: new Date().toISOString(),
      })
      return ok(config, toResource(created), 201)
    }
    if (rest === 'mine' && method === 'GET') return ok(config, mine().map(toResource))
    const [id, sub] = rest.split('/')
    const row = mine().find((item) => String(item.id) === String(id))
    if (!row) fail(config, 404, 'BUILDING_NOT_FOUND', 'Building not found')
    if (!sub && method === 'GET') return ok(config, toResource(row))
    if (!sub && method === 'PUT') {
      validate()
      return ok(
        config,
        toResource(
          patchRow('buildings', row.id, {
            name: String(body.name).trim(),
            address: String(body.address).trim(),
            departmentCount: Number(body.departmentCount),
          }),
        ),
      )
    }
    if (sub === 'residents' && method === 'GET') {
      return ok(config, queryCollection('users', { role: 'resident', ownerAdminId: ownerId }))
    }
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

  // Users (residents + lookup) — mirror BuildingFex.Api /api/v1/users
  if (route === 'users' || route.startsWith('users/')) {
    const id = route === 'users' ? undefined : route.slice('users/'.length)
    if (!id && method === 'GET') {
      let rows = listCollection('users')
      if (params.role) {
        rows = rows.filter((row) => String(row.role ?? '') === String(params.role))
      }
      if (params.ownerAdminId) {
        rows = rows.filter(
          (row) =>
            String(row.ownerAdminId ?? '') === String(params.ownerAdminId) ||
            String(row.id) === String(params.ownerAdminId),
        )
      }
      if (params.email) {
        const email = String(params.email).trim().toLowerCase()
        rows = rows.filter(
          (row) => String(row.email ?? '').trim().toLowerCase() === email,
        )
      }
      if (params.code) {
        const code = String(params.code).trim()
        rows = rows.filter((row) => String(row.code ?? '').trim() === code)
      }
      return ok(config, rows.map(publicUser))
    }
    if (!id && method === 'POST') {
      const ownerId =
        String(body.ownerAdminId ?? '').trim() ||
        ownerFromParams(params) ||
        MOCK_OWNER_ID
      const role = body.role || 'resident'
      const code = String(body.code ?? '').trim()
      if (
        role === 'resident' &&
        code &&
        queryCollection('users', { role: 'resident', ownerAdminId: ownerId }).some(
          (row) => String(row.code ?? '').trim() === code,
        )
      ) {
        fail(config, 400, 'RESIDENT_CODE_ALREADY_EXISTS', 'Department already registered')
      }
      const created = insertRow('users', {
        ...body,
        id: body.id || `resident-${Date.now()}`,
        role,
        ownerAdminId: ownerId,
        email: body.email ?? '',
        password: body.password ?? '',
        ...(role === 'resident'
          ? {
              inviteToken: body.inviteToken || `inv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
              inviteExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
              accountStatus: 'ACTIVE',
            }
          : {}),
      })
      return ok(config, publicUser(created), 201)
    }
    if (id && method === 'GET') {
      const row = findById('users', id)
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, publicUser(row))
    }
    if (id && method === 'PATCH') {
      const row = patchRow('users', id, body)
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, publicUser(row))
    }
    if (id && method === 'DELETE') {
      if (!removeRow('users', id)) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, {})
    }
  }

  // Support chats — hardcoded AI replies for wireframe / local demo
  if (route === 'support/chats' || route.startsWith('support/chats/')) {
    const actor = resolveActor(config)
    const rest = route === 'support/chats' ? '' : route.slice('support/chats/'.length)
    const now = () => new Date().toISOString()

    if (!rest && method === 'GET') {
      const kind = String(params.kind ?? '').trim()
      const since = String(params.since ?? '').trim()
      let rows = listCollection('supportChats')

      if (kind === 'ai') {
        rows = rows.filter(
          (row) =>
            String(row.kind ?? '') === 'ai' &&
            String(row.residentId ?? '') === String(actor.id),
        )
      } else if (kind === 'admin') {
        const ownerId = actor.ownerAdminId || MOCK_OWNER_ID
        rows = rows.filter(
          (row) =>
            (String(row.kind ?? '') === 'admin' ||
              String(row.source ?? '') === 'ai-escalation' ||
              (!row.kind && String(row.residentId ?? ''))) &&
            String(row.kind ?? '') !== 'ai' &&
            String(row.ownerAdminId ?? ownerId) === String(ownerId),
        )
      }

      if (since) {
        rows = rows.filter((row) => String(row.updatedAt ?? '') > since)
      }

      rows = [...rows].sort((a, b) =>
        String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
      )
      return ok(config, rows.map(publicSupportChat))
    }

    if (!rest && method === 'POST') {
      const kind = String(body.kind ?? 'ai').trim() || 'ai'
      const residentId =
        kind === 'ai'
          ? actor.id
          : String(body.residentId ?? actor.id)
      const resident =
        listCollection('users').find((row) => String(row.id) === String(residentId)) || null
      const created = insertRow('supportChats', {
        id: `chat-${Date.now()}`,
        ownerAdminId: resident?.ownerAdminId || actor.ownerAdminId || MOCK_OWNER_ID,
        residentId,
        residentName: resident?.name || actor.email || 'Residente demo',
        topic: String(body.topic ?? body.title ?? 'Nueva consulta').trim() || 'Nueva consulta',
        title: String(body.title ?? body.topic ?? 'Nueva consulta').trim() || 'Nueva consulta',
        titleSummarized: false,
        status: 'open',
        kind,
        source: kind === 'ai' ? 'resident' : 'resident',
        linkedChatId: '',
        escalatedChatId: '',
        messages: [],
        createdAt: now(),
        updatedAt: now(),
      })
      return ok(config, publicSupportChat(created), 201)
    }

    const messageMatch = rest.match(/^([^/]+)\/messages$/)
    if (messageMatch && method === 'POST') {
      const chatId = messageMatch[1]
      const chat = findById('supportChats', chatId)
      if (!chat) fail(config, 404, 'HTTP_404', 'Chat not found')

      const text = String(body.body ?? '').trim()
      if (!text) fail(config, 400, 'MESSAGE_REQUIRED', 'Message is required')

      const messages = Array.isArray(chat.messages) ? [...chat.messages] : []
      const isAdminActor = actor.role === SessionRoles.ADMIN && chat.kind !== 'ai'
      const userMsg = {
        id: `msg-${Date.now()}`,
        role: isAdminActor ? 'admin' : 'user',
        authorRole: isAdminActor ? 'admin' : 'resident',
        authorName: isAdminActor ? 'Admin demo' : chat.residentName || 'Residente',
        body: text,
        createdAt: now(),
      }
      messages.push(userMsg)

      let escalatedChatId = chat.escalatedChatId || ''
      let linkedChatId = chat.linkedChatId || ''
      let topic = chat.topic
      let title = chat.title || chat.topic

      if (chat.kind === 'ai') {
        const answer = hardcodedAiReply(text, body.locale)
        const reply = {
          id: `msg-${Date.now() + 1}`,
          role: 'ai',
          authorRole: 'assistant',
          authorName: 'Asistente BuildingFlex',
          body: answer.body,
          ...(answer.citedSource ? { citedSource: answer.citedSource } : {}),
          createdAt: now(),
        }
        messages.push(reply)

        if (!chat.titleSummarized && messages.filter((m) => m.authorRole === 'resident' || m.role === 'user').length === 1) {
          topic = text.slice(0, 48)
          title = topic
        }

        if (!escalatedChatId && shouldEscalateToAdmin(text)) {
          const adminChat = insertRow('supportChats', {
            id: `chat-esc-${Date.now()}`,
            ownerAdminId: chat.ownerAdminId || MOCK_OWNER_ID,
            residentId: chat.residentId,
            residentName: chat.residentName,
            topic: topic || 'Consulta escalada',
            title: title || 'Consulta escalada',
            titleSummarized: true,
            status: 'open',
            kind: 'admin',
            source: 'ai-escalation',
            linkedChatId: chat.id,
            aiChatId: chat.id,
            escalatedChatId: '',
            messages: [
              {
                id: `msg-esc-${Date.now()}`,
                role: 'resident',
                authorRole: 'resident',
                authorName: chat.residentName || 'Residente',
                body: text,
                createdAt: now(),
              },
              {
                id: `msg-esc-${Date.now() + 1}`,
                role: 'ai',
                authorRole: 'assistant',
                authorName: 'Asistente BuildingFlex',
                body: 'El residente pidió hablar con administración.',
                createdAt: now(),
              },
            ],
            createdAt: now(),
            updatedAt: now(),
          })
          escalatedChatId = adminChat.id
          linkedChatId = adminChat.id
        }

      }

      // Estados (Resident Care): admin responde → answered; residente escribe → open; IA derivada → derived.
      let status = chat.status || 'open'
      if (chat.kind === 'ai') status = escalatedChatId ? 'derived' : 'answered'
      else status = isAdminActor ? 'answered' : 'open'

      const updated = patchRow('supportChats', chatId, {
        messages,
        topic,
        title,
        titleSummarized: true,
        escalatedChatId,
        linkedChatId,
        status,
        updatedAt: now(),
      })
      return ok(config, publicSupportChat(updated))
    }

    const statusMatch = rest.match(/^([^/]+)\/(status|close)$/)
    if (statusMatch && method === 'PATCH') {
      const chat = findById('supportChats', statusMatch[1])
      if (!chat) fail(config, 404, 'CHAT_NOT_FOUND', 'Chat not found')
      const raw = statusMatch[2] === 'close' ? 'closed' : String(body.status ?? '').trim().toLowerCase()
      const status = { pending: 'open', attended: 'answered' }[raw] || raw
      if (!['open', 'answered', 'closed'].includes(status)) fail(config, 400, 'INVALID_STATUS', 'Invalid status')
      const updated = patchRow('supportChats', chat.id, {
        status,
        closedAt: status === 'closed' ? now() : '',
        updatedAt: now(),
      })
      return ok(config, publicSupportChat(updated))
    }

    if (rest && method === 'GET') {
      const chatId = rest.split('/')[0]
      const afterMessageId = String(params.afterMessageId ?? '').trim()
      const chat = findById('supportChats', chatId)
      if (!chat) {
        return ok(config, null, 204)
      }
      let messages = Array.isArray(chat.messages) ? chat.messages : []
      if (afterMessageId) {
        const idx = messages.findIndex((m) => String(m.id) === afterMessageId)
        messages = idx >= 0 ? messages.slice(idx + 1) : messages
      }
      return ok(config, publicSupportChat({ ...chat, messages }))
    }
  }

  if (route === 'profiles' && method === 'POST') {
    const ownerId =
      String(body.id ?? '').trim() ||
      getActiveDataOwnerId() ||
      MOCK_OWNER_ID
    const profile = {
      id: ownerId,
      name: String(body.name ?? '').trim() || 'Admin',
      email: String(body.email ?? '').trim().toLowerCase(),
      role: 'admin',
      dni: String(body.dni ?? '').trim(),
      address: String(body.address ?? '').trim(),
      company: String(body.company ?? '').trim(),
      ruc: String(body.ruc ?? '').trim(),
    }
    const existing = listCollection('profiles').find((row) => String(row.id) === ownerId)
    if (existing) {
      return ok(config, patchRow('profiles', ownerId, profile))
    }
    return ok(config, insertRow('profiles', { ...profile, id: ownerId }), 201)
  }

  if (route === 'profiles/me' && method === 'GET') {
    const ownerId = getActiveDataOwnerId() || MOCK_OWNER_ID
    const profile =
      listCollection('profiles').find((row) => String(row.id) === ownerId) ||
      listCollection('users').find(
        (row) => row.role === 'admin' && String(row.id) === ownerId,
      )
    if (!profile) fail(config, 404, 'PROFILE_NOT_FOUND', 'Profile not found')
    return ok(config, {
      id: profile.id,
      name: profile.name ?? '',
      email: profile.email ?? '',
      role: 'admin',
      dni: profile.dni ?? '',
      address: profile.address ?? '',
      company: profile.company ?? '',
      ruc: profile.ruc ?? '',
    })
  }

  if (route.startsWith('profiles/') && method === 'GET') {
    const userId = route.slice('profiles/'.length)
    const profile =
      listCollection('profiles').find((row) => String(row.id) === userId) ||
      listCollection('users').find(
        (row) => row.role === 'admin' && String(row.id) === userId,
      )
    if (!profile) fail(config, 404, 'PROFILE_NOT_FOUND', 'Profile not found')
    return ok(config, {
      id: profile.id,
      name: profile.name ?? '',
      email: profile.email ?? '',
      role: 'admin',
      dni: profile.dni ?? '',
      address: profile.address ?? '',
      company: profile.company ?? '',
      ruc: profile.ruc ?? '',
    })
  }

  // Import v1 — mirror /api/v1/import/folders|uploads
  if (route === 'import/folders' || route.startsWith('import/folders/')) {
    const id = route === 'import/folders' ? undefined : route.slice('import/folders/'.length)
    const ownerId = getActiveDataOwnerId() || MOCK_OWNER_ID
    if (method === 'GET' && !id) {
      return ok(
        config,
        queryCollection('importFolders', { ownerAdminId: ownerId }),
      )
    }
    if (method === 'POST' && !id) {
      return ok(
        config,
        insertRow('importFolders', {
          ...body,
          ownerAdminId: ownerId,
          createdAt: body.createdAt || new Date().toISOString(),
        }),
        201,
      )
    }
    if (id && method === 'PATCH') {
      const row = patchRow('importFolders', id, body)
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, row)
    }
    if (id && method === 'DELETE') {
      const current = findById('importFolders', id)
      if (!current) fail(config, 404, 'HTTP_404', 'Not found')
      if (current.isHome || current.isContext) {
        fail(config, 400, 'SYSTEM_FOLDER_PROTECTED', 'Protected folder')
      }
      removeRow('importFolders', id)
      return ok(config, {})
    }
  }

  if (route === 'import/uploads' || route.startsWith('import/uploads/')) {
    const rest = route === 'import/uploads' ? '' : route.slice('import/uploads/'.length)
    const ownerId = getActiveDataOwnerId() || MOCK_OWNER_ID

    if (rest === 'signed-url' && method === 'POST') {
      const id = `import-${Date.now()}`
      const safe = String(body.fileName || 'archivo').replace(/[^\w.\-()+ ]+/g, '_').slice(0, 180)
      const storagePath = `owners/${ownerId}/import/${id}/${safe}`
      insertRow('importUploads', {
        id,
        ownerAdminId: ownerId,
        fileName: body.fileName || 'archivo',
        mimeType: body.mimeType || 'application/octet-stream',
        size: Number(body.size) || 0,
        storagePath,
        folderId: body.folderId || null,
        uploadStatus: 'pending_upload',
        indexingStatus: 'none',
        uploadedAt: new Date().toISOString(),
        documentType: body.documentType ? String(body.documentType).toUpperCase() : null,
        documentStatus: 'PENDING_UPLOAD',
        version: 1,
      })
      return ok(config, {
        id,
        storagePath,
        uploadUrl: 'mock://local-put',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        contentType: body.mimeType || 'application/octet-stream',
        method: 'PUT',
      })
    }

    const confirmMatch = rest.match(/^([^/]+)\/confirm$/)
    if (confirmMatch && method === 'POST') {
      const current = findById('importUploads', confirmMatch[1])
      if (!current) fail(config, 404, 'HTTP_404', 'Not found')
      const row = patchRow('importUploads', current.id, {
        uploadStatus: 'confirmed',
        indexingStatus: 'none',
        ...(current.documentStatus && current.documentStatus !== 'PENDING_UPLOAD'
          ? {}
          : { documentStatus: 'PUBLISHED', publishedAt: new Date().toISOString() }),
      })
      return ok(config, uploadResource(row))
    }

    const downloadMatch = rest.match(/^([^/]+)\/download-url$/)
    if (downloadMatch && method === 'GET') {
      const row = findById('importUploads', downloadMatch[1])
      if (!row || row.uploadStatus === 'pending_upload') fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, {
        id: row.id,
        fileName: row.fileName,
        downloadUrl: demoFileDataUrl(row.fileName, row.mimeType),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
    }

    const id = rest || undefined
    if (method === 'GET' && !id) {
      return ok(
        config,
        queryCollection('importUploads', { ownerAdminId: ownerId })
          .filter((u) => u.uploadStatus !== 'pending_upload')
          .map(uploadResource),
      )
    }
    if (id && method === 'PATCH') {
      const patch = { ...body }
      if (patch.documentType != null) {
        patch.documentType = String(patch.documentType).toUpperCase()
        if (!['REGULATION', 'MINUTES', 'OTHER'].includes(patch.documentType)) {
          fail(config, 400, 'INVALID_DOCUMENT_TYPE', 'Invalid document type')
        }
      }
      const row = patchRow('importUploads', id, patch)
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, uploadResource(row))
    }
    if (id && method === 'DELETE') {
      if (!removeRow('importUploads', id)) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, {})
    }
  }

  fail(config, 404, 'HTTP_404', `No mock for /api/v1/${route}`)
}

const ANNOUNCEMENT_RANK = { urgent: 3, important: 2, normal: 1 }

function mockIncidentEvent(type, status, comment, actor) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    type,
    status,
    comment: comment || null,
    authorId: actor?.id ?? null,
    authorName: actor?.id ? (findById('users', actor.id)?.name ?? null) : null,
    authorRole: actor?.role ?? null,
    createdAt: new Date().toISOString(),
  }
}

const ESCALATION_MS = 48 * 3600 * 1000
const ASSISTANT_ACTOR = { id: null, role: 'assistant' }

/** Triaje de la demo (sin IA real): palabras clave → categoría y prioridad, como GeminiIncidentTriageAdvisor. */
const TRIAGE_RULES = [
  { re: /gas|incendio|fuego|humo|cortocircuito|atrapad|inundaci/, category: 'Seguridad', priority: 'critical', reason: 'Riesgo para las personas o el edificio: requiere atención inmediata.' },
  { re: /ascensor|elevador/, category: 'Ascensores', priority: 'high', reason: 'El ascensor afecta la movilidad de varios departamentos.' },
  { re: /agua|fuga|filtraci|tuber|desag|caño|inodoro|ducha|gasfiter/, category: 'Gasfitería', priority: 'high', reason: 'Una fuga de agua puede dañar otros departamentos si no se atiende pronto.' },
  { re: /luz|luminaria|foco|eléctric|electric|enchufe|tablero/, category: 'Electricidad', priority: 'medium', reason: 'Falla eléctrica sin riesgo inmediato reportado.' },
  { re: /puerta|cerradura|cámara|camara|robo|portón|porton|seguridad/, category: 'Seguridad', priority: 'high', reason: 'Afecta el control de acceso del edificio.' },
  { re: /basura|limpieza|sucio|olor/, category: 'Limpieza', priority: 'low', reason: 'Tema de limpieza sin riesgo para las personas.' },
  { re: /ruido|vecino|mascota|música|musica/, category: 'Convivencia', priority: 'low', reason: 'Tema de convivencia entre vecinos.' },
  { re: /grieta|pared|techo|piso|estructura/, category: 'Estructura', priority: 'medium', reason: 'Daño en la estructura que conviene revisar.' },
  { re: /piscina|gimnasio|jardín|jardin|parque|sum|terraza/, category: 'Áreas comunes', priority: 'medium', reason: 'Afecta un área común del edificio.' },
]

function mockTriage(row) {
  const text = `${row.title ?? ''} ${row.description ?? ''}`.toLowerCase()
  const rule = TRIAGE_RULES.find((r) => r.re.test(text))
  return rule
    ? { category: rule.category, priority: rule.priority, reason: rule.reason }
    : { category: 'Otros', priority: 'medium', reason: 'No hay datos suficientes para una prioridad mayor.' }
}

function triageSummary(category, priority) {
  return [category && `Categoría: ${category}`, priority && `Prioridad: ${priority}`].filter(Boolean).join(' · ')
}

function withTriageSuggestion(row, events) {
  const s = mockTriage(row)
  events.push(mockIncidentEvent('ai_triage_suggested', row.status, triageSummary(s.category, s.priority), ASSISTANT_ACTOR))
  return { ...s, suggestedAt: new Date().toISOString() }
}

/** Campos derivados que calcula el backend (escalated, aiSuggestion.pending). */
function derivedIncidentFields(row) {
  const unassigned = !row.providerId && !row.provider
  const s = row.aiSuggestion
  return {
    escalated: !!row.escalatedAt && row.status === 'open' && unassigned,
    ...(s
      ? {
          aiSuggestion: {
            ...s,
            pending:
              String(s.category ?? '').toLowerCase() !== String(row.category ?? '').toLowerCase() ||
              (s.priority ?? null) !== (row.priority ?? null),
          },
        }
      : {}),
  }
}

/** EscalationPolicy de la demo: abierta y sin proveedor por más de 48 h → se escala una sola vez. */
function sweepIncidents() {
  const now = Date.now()
  for (const row of queryCollection('incidents', {})) {
    const patch = {}
    const unassigned = !row.providerId && !row.provider
    const reported = new Date(row.createdAt || 0).getTime()
    if (!row.escalatedAt && row.status === 'open' && unassigned && reported && now - reported >= ESCALATION_MS) {
      patch.escalatedAt = new Date().toISOString()
      patch.events = [
        ...(Array.isArray(row.events) ? row.events : []),
        mockIncidentEvent('escalated', row.status, 'Sin asignar por más de 48 horas: se avisó a la administración.', { id: null, role: 'system' }),
      ]
    }
    const derived = derivedIncidentFields({ ...row, ...patch })
    if (patch.escalatedAt || derived.escalated !== row.escalated || derived.aiSuggestion?.pending !== row.aiSuggestion?.pending) {
      patchRow('incidents', row.id, { ...patch, ...derived })
    }
  }
}

/**
 * Preview mock de Incidents / Communications: replica las reglas del backend
 * (asunto obligatorio, comentario de resolución, historial, vigencia y orden de comunicados).
 * Devuelve null si la ruta no aplica (sigue el CRUD genérico).
 */
function handleIncidentsAndAnnouncements(config, method, parts) {
  const [collection, id, action] = parts
  const actor = resolveActor(config)
  const body = readBody(config)

  if (collection === 'announcements' && !id) {
    if (method === 'GET') {
      const params = readParams(config)
      const now = new Date()
      const onlyActive =
        actor.role === SessionRoles.RESIDENT || String(params.activeOnly) === 'true'
      const rows = queryCollection('announcements', { ownerAdminId: ownerFromParams(params) })
        .filter((a) => !onlyActive || (a.expiresAt && now < new Date(a.expiresAt)))
        .map((a) => ({
          ...a,
          status: a.expiresAt && now >= new Date(a.expiresAt) ? 'expired' : 'published',
          isActive: !!a.expiresAt && now < new Date(a.expiresAt),
        }))
        .sort((a, b) => {
          const diff = (ANNOUNCEMENT_RANK[b.priority] ?? 1) - (ANNOUNCEMENT_RANK[a.priority] ?? 1)
          return diff || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        })
      return ok(config, rows)
    }
    if (method === 'POST') {
      const createdAt = new Date()
      const duration = Number(body.duration) > 0 ? Number(body.duration) : 7
      const expires = new Date(createdAt)
      expires.setDate(expires.getDate() + duration)
      return ok(
        config,
        insertRow('announcements', {
          ...body,
          duration,
          createdAt: createdAt.toISOString(),
          publishedAt: createdAt.toISOString(),
          expiresAt: expires.toISOString(),
          status: 'published',
        }),
        201,
      )
    }
  }

  // Como Announcement.Update(): conserva autor/fechas y recalcula expiresAt = publishedAt + duration (0 = mantener).
  if (collection === 'announcements' && id && !action && method === 'PUT') {
    const current = findById('announcements', id)
    if (!current) fail(config, 404, 'ANNOUNCEMENT_NOT_FOUND', 'Comunicado no encontrado.')
    if (!String(body.title ?? '').trim()) fail(config, 400, 'TITLE_REQUIRED', 'El título es obligatorio.')
    const requested = Number(body.duration)
    const duration = requested > 0 ? Math.min(requested, 365) : Number(current.duration) || 7
    const expires = new Date(current.publishedAt || current.createdAt || Date.now())
    expires.setDate(expires.getDate() + duration)
    return ok(
      config,
      replaceRow('announcements', id, {
        ...current,
        title: String(body.title).trim(),
        body: String(body.body ?? '').trim(),
        priority: ANNOUNCEMENT_RANK[body.priority] ? body.priority : current.priority || 'normal',
        duration,
        expiresAt: expires.toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    )
  }

  if (collection !== 'incidents') return null
  sweepIncidents()

  if (!id && method === 'POST') {
    if (!String(body.title ?? body.subject ?? '').trim()) {
      fail(config, 400, 'TITLE_REQUIRED', 'El asunto es obligatorio.')
    }
    if (!String(body.description ?? '').trim()) {
      fail(config, 400, 'DESCRIPTION_REQUIRED', 'La descripción es obligatoria.')
    }
    const isResident = actor.role === SessionRoles.RESIDENT
    // Como IncidentCommandService: providerId → nombre/teléfono del proveedor; el residente no asigna.
    const providerId = isResident ? '' : String(body.providerId ?? '').trim()
    const provider = providerId ? findById('serviceProviders', providerId) : null
    if (providerId && !provider) fail(config, 400, 'PROVIDER_NOT_FOUND', 'Proveedor no encontrado.')
    const events = [mockIncidentEvent('reported', 'open', null, actor)]
    if (provider) events.push(mockIncidentEvent('assigned', 'open', provider.name, actor))
    const row = {
      ...body,
      title: String(body.title ?? body.subject).trim(),
      status: 'open',
      ...(isResident ? { residentId: actor.id } : {}),
      providerId: provider?.id ?? null,
      provider: provider?.name ?? (isResident ? '' : String(body.provider ?? '')),
      providerPhone: provider?.phone ?? null,
      providerSpecialty: provider?.specialty ?? null,
      events,
    }
    // Triaje automático al reportar sin categoría o prioridad (la demo no consume cupo de IA).
    if (!String(row.category ?? '').trim() || !row.priority) row.aiSuggestion = withTriageSuggestion(row, events)
    return ok(config, insertRow('incidents', { ...row, ...derivedIncidentFields(row) }), 201)
  }

  if (!id) return null
  const current = findById('incidents', id)
  if (!current) return null
  const events = Array.isArray(current.events) ? [...current.events] : []

  if (!action && method === 'PUT') {
    const next = { ...current, ...body, events }
    if (body.status === 'resolved' && current.status !== 'resolved') {
      if (!String(body.resolutionComment ?? '').trim()) {
        fail(config, 400, 'RESOLUTION_COMMENT_REQUIRED', 'Documenta la solución antes de resolver.')
      }
      next.resolvedAt = new Date().toISOString()
      events.push(mockIncidentEvent('resolved', 'resolved', body.resolutionComment, actor))
    } else if (body.status && body.status !== current.status) {
      if (current.status === 'resolved') {
        next.resolvedAt = null
        next.resolutionComment = null
      }
      events.push(mockIncidentEvent('status_changed', body.status, null, actor))
    }
    return ok(config, replaceRow('incidents', id, { ...next, ...derivedIncidentFields(next) }))
  }

  if (action === 'assign' && method === 'PATCH') {
    const providerId = String(body.providerId ?? '').trim()
    const provider = providerId ? findById('serviceProviders', providerId) : null
    if (providerId && !provider) fail(config, 400, 'PROVIDER_NOT_FOUND', 'Proveedor no encontrado.')
    const status = provider && current.status === 'open' ? 'in-progress' : current.status
    events.push(
      mockIncidentEvent(provider ? 'assigned' : 'unassigned', status, provider?.name ?? null, actor),
    )
    return ok(
      config,
      patchRow('incidents', id, {
        providerId: provider?.id ?? null,
        provider: provider?.name ?? '',
        providerPhone: provider?.phone ?? null,
        providerSpecialty: provider?.specialty ?? null,
        status,
        events,
        ...derivedIncidentFields({ ...current, providerId: provider?.id ?? null, provider: provider?.name ?? '', status }),
      }),
    )
  }

  if (action === 'resolve' && method === 'PATCH') {
    const comment = String(body.resolutionComment ?? body.comment ?? '').trim()
    if (!comment) {
      fail(config, 400, 'RESOLUTION_COMMENT_REQUIRED', 'Documenta la solución antes de resolver.')
    }
    events.push(mockIncidentEvent('resolved', 'resolved', comment, actor))
    return ok(
      config,
      patchRow('incidents', id, {
        status: 'resolved',
        resolutionComment: comment,
        resolvedAt: new Date().toISOString(),
        events,
        escalated: false,
      }),
    )
  }

  if (action === 'triage-suggestion' && method === 'POST') {
    if (actor.role !== SessionRoles.ADMIN) fail(config, 403, 'FORBIDDEN', 'Solo el administrador.')
    const aiSuggestion = withTriageSuggestion(current, events)
    const next = { ...current, aiSuggestion, events }
    return ok(config, patchRow('incidents', id, { aiSuggestion, events, ...derivedIncidentFields(next) }))
  }

  if (action === 'triage' && method === 'PATCH') {
    if (actor.role !== SessionRoles.ADMIN) fail(config, 403, 'FORBIDDEN', 'Solo el administrador.')
    const s = current.aiSuggestion
    const category = String(body.category ?? '').trim() || s?.category || null
    const priority = String(body.priority ?? '').trim() || s?.priority || null
    if (!category && !priority) {
      fail(config, 400, 'TRIAGE_SUGGESTION_REQUIRED', 'No hay una sugerencia de triaje para confirmar.')
    }
    const next = { ...current, category: category ?? current.category, priority: priority ?? current.priority }
    events.push(mockIncidentEvent('triage_confirmed', current.status, triageSummary(next.category, next.priority), actor))
    return ok(
      config,
      patchRow('incidents', id, { category: next.category, priority: next.priority, events, ...derivedIncidentFields(next) }),
    )
  }

  if (action === 'comments' && method === 'POST') {
    const comment = String(body.comment ?? '').trim()
    if (!comment) fail(config, 400, 'COMMENT_REQUIRED', 'El comentario es obligatorio.')
    events.push(mockIncidentEvent('comment', current.status, comment, actor))
    return ok(config, patchRow('incidents', id, { events }))
  }

  return null
}

export async function localMockAdapter(config) {
  const method = String(config.method ?? 'get').toUpperCase()
  const parts = pathParts(config)

  try {
    // Demo realism: the assistant takes a moment to answer (shows the typing indicator).
    if (method === 'POST' && /\/support\/chats\/[^/]+\/messages$/.test(String(config.url ?? ''))) {
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
    const operation = await handleOperations(config, method, parts)
    if (operation) return operation

    if (parts[0] === 'api' && parts[1] === 'v1') {
      return handleV1(config, method, parts)
    }

    const [collection, id] = parts
    const domainResponse = handleIncidentsAndAnnouncements(config, method, parts)
    if (domainResponse) return domainResponse
    if (isKnownCollection(collection)) {
      return handleCollection(config, method, collection, id)
    }

    fail(config, 404, 'HTTP_404', `No mock for /${parts.join('/')}`)
  } catch (error) {
    // Diagnostics for QA / devtools: every mock failure is kept in window.__mockErrors.
    if (typeof window !== 'undefined') {
      const list = (window.__mockErrors = window.__mockErrors || [])
      list.push({
        method,
        url: String(config.url ?? ''),
        status: error?.response?.status ?? null,
        code: error?.response?.data?.code ?? String(error?.message ?? error),
      })
      if (list.length > 200) list.shift()
    }
    throw error
  }
}
