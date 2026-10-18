import { AxiosError } from 'axios'
import { createPreviewAccessToken } from '@/iam/application/localPreviewAuth.js'
import { SessionRoles } from '@/iam/domain/sessionRoles.js'
import { maxResidentsForSubscriptionPlan, SubscriptionPlanId } from '@/billing/domain/subscriptionPlans.js'
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

function resolveActor(config) {
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

function hardcodedAiReply(userText, locale = 'es') {
  const text = String(userText ?? '').toLowerCase()
  const es = !String(locale).toLowerCase().startsWith('en')
  if (/admin|administraci|human|persona|hablar/.test(text)) {
    return es
      ? 'Puedo ayudarte con eso. Si prefieres hablar con administración, escribe “quiero hablar con un administrador” y te conectamos.'
      : 'I can help with that. If you prefer a human from management, say “I want to talk to an admin” and we will connect you.'
  }
  if (/pago|recibo|cuota|deuda|bill|payment|fee/.test(text)) {
    return es
      ? 'Tus recibos y pagos están en Finanzas. Los pendientes aparecen con estado “Por pagar”. Si un cargo no cuadra, avísame el mes y el monto.'
      : 'Your bills and payments are under Finance. Pending ones show as unpaid. If a charge looks wrong, tell me the month and amount.'
  }
  if (/reserva|espacio|piscina|guest|invitad|qr/.test(text)) {
    return es
      ? 'Para reservar un espacio común ve a Generación / Espacios, elige fecha y horario, y agrega invitados (máx. 5) para el QR.'
      : 'To book a common space go to Generation / Spaces, pick a date and time, and add guests (max 5) for the QR.'
  }
  if (/incidencia|incidente|fuga|ascensor|incident/.test(text)) {
    return es
      ? 'Puedes reportar una incidencia en la sección Incidencias. Describe el problema y, si sabes, el área del edificio.'
      : 'You can report an issue under Incidents. Describe the problem and the area of the building if you know it.'
  }
  return es
    ? 'Soy el asistente demo de BuildingFlex. Puedo orientarte sobre pagos, reservas, incidencias y contacto con administración. ¿En qué te ayudo?'
    : 'I am the BuildingFlex demo assistant. I can help with payments, reservations, incidents, and reaching management. How can I help?'
}

function shouldEscalateToAdmin(userText) {
  return /admin|administraci|humano|persona real|hablar con/.test(String(userText ?? '').toLowerCase())
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

  if (route === 'authentication/residents/complete-google' && method === 'POST') {
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
      const created = insertRow('users', {
        ...body,
        id: body.id || `resident-${Date.now()}`,
        role: body.role || 'resident',
        ownerAdminId: ownerId,
        email: body.email ?? '',
        password: body.password ?? '',
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
        const reply = {
          id: `msg-${Date.now() + 1}`,
          role: 'ai',
          authorRole: 'assistant',
          authorName: 'Asistente BuildingFlex',
          body: hardcodedAiReply(text, body.locale),
          createdAt: now(),
        }
        messages.push(reply)

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

        if (!chat.titleSummarized && messages.filter((m) => m.authorRole === 'resident' || m.role === 'user').length === 1) {
          topic = text.slice(0, 48)
          title = topic
        }
      }

      const updated = patchRow('supportChats', chatId, {
        messages,
        topic,
        title,
        titleSummarized: true,
        escalatedChatId,
        linkedChatId,
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
      const row = patchRow('importUploads', confirmMatch[1], {
        uploadStatus: 'confirmed',
        indexingStatus: 'none',
      })
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, row)
    }

    const downloadMatch = rest.match(/^([^/]+)\/download-url$/)
    if (downloadMatch && method === 'GET') {
      const row = findById('importUploads', downloadMatch[1])
      if (!row || row.uploadStatus === 'pending_upload') fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, {
        id: row.id,
        fileName: row.fileName,
        downloadUrl: `mock://download/${row.id}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
    }

    const id = rest || undefined
    if (method === 'GET' && !id) {
      return ok(
        config,
        queryCollection('importUploads', { ownerAdminId: ownerId }).filter(
          (u) => u.uploadStatus !== 'pending_upload',
        ),
      )
    }
    if (id && method === 'PATCH') {
      const row = patchRow('importUploads', id, body)
      if (!row) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, row)
    }
    if (id && method === 'DELETE') {
      if (!removeRow('importUploads', id)) fail(config, 404, 'HTTP_404', 'Not found')
      return ok(config, {})
    }
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
