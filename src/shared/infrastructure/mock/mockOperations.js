/**
 * Preview mock (open wireframes): v1 endpoints added after the CRUD mock — Finances operations,
 * Team tasks / shifts / staff status, IAM account status, official documents, guest passes,
 * Resident Care counters and the Excel/CSV roster import. Shapes mirror BuildingFex.Api controllers
 * (FinanceOperationsController, TasksController, ShiftsController, TeamWorkersCompatController,
 * UsersController, ImportUploadsController, GuestPassesController, SupportController, ResidentImportController).
 *
 * `handleOperations` returns a response, throws an AxiosError (via `fail`), or returns null when the
 * route is not one of these (the regular mock handlers continue).
 */
import { SessionRoles } from '@/iam/domain/sessionRoles.js'
import {
  findCharge,
  normalizeSettings,
  parseMonthKey,
  residentOwesMonth,
  todayYmd,
  toMonthKey,
} from '@/finances/domain/billingCycle.js'
import { parseDepartmentNumber } from '@/shared/domain/departmentNumber.js'
import { isExtraReceipt } from '@/finances/domain/receipt.js'
import { SUBSCRIPTION_PLAN_AI_QUERY_CAPS } from '@/billing/domain/subscriptionPlans.js'
import {
  findById,
  insertRow,
  listCollection,
  patchRow,
  queryCollection,
  removeRow,
  subscriptionSnapshot,
} from './mockDb.js'
import { MOCK_OWNER_ID } from './seed.js'
import { fail, ok, ownerFromParams, publicUser, readBody, readParams, resolveActor } from './mockAdapter.js'

const DUE_SOON_DAYS = 5
const MAX_OPEN_TASKS_PER_WORKER = 10
const GUEST_PASS_GRACE_MS = 2 * 3600_000

/** "2026-10" / "2026-10-18" → "2026-10"; anything else → null. */
function monthKeyOf(value) {
  const parsed = parseMonthKey(value)
  return parsed ? toMonthKey(parsed.year, parsed.month0) : null
}

function nowIso() {
  return new Date().toISOString()
}

function noContent(config) {
  return ok(config, '', 204)
}

function tenantOf(config) {
  const actor = resolveActor(config)
  const params = readParams(config)
  const ownerId =
    actor.role === SessionRoles.RESIDENT
      ? actor.ownerAdminId || MOCK_OWNER_ID
      : String(params.ownerAdminId ?? '').trim() || actor.ownerAdminId || ownerFromParams(params)
  return { actor, ownerId }
}

function requireAdmin(config, actor) {
  if (actor.role !== SessionRoles.ADMIN) fail(config, 403, 'ADMIN_REQUIRED', 'Solo administradores.')
}

function isPaid(status) {
  return /^(paid|pagado|approved)$/i.test(String(status ?? '').trim())
}

function isOverdueStatus(status) {
  return /^(overdue|vencido)$/i.test(String(status ?? '').trim())
}

function ymdToDate(ymd) {
  const m = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function dayDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}

function shiftMonth(monthKey, delta) {
  const [y, m] = String(monthKey).split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function receiptTotal(row) {
  return Number(row.amount ?? 0) + Number(row.lateFee ?? 0) + Number(row.extraCharges ?? 0)
}

/** Mes contable de un recibo: billingMonth o, para legacy, el mes anterior al vencimiento (Receipt.EffectiveBillingMonth). */
function receiptMonth(row) {
  const billing = monthKeyOf(row.billingMonth)
  if (billing) return billing
  const due = monthKeyOf(row.dueDate)
  return due ? shiftMonth(due, -1) : null
}

const SPANISH_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

function feeMonth(row) {
  const direct = monthKeyOf(row.month)
  if (direct) return direct
  const text = String(row.month ?? '').toLowerCase()
  const idx = SPANISH_MONTHS.findIndex((name) => text.includes(name))
  const year = text.replace(/\D/g, '')
  if (idx >= 0 && year.length === 4) return `${year}-${String(idx + 1).padStart(2, '0')}`
  return monthKeyOf(row.dueDate)
}

/** DelinquencyPolicy.Classify → paid | overdue | dueSoon | pending. */
function classify(status, dueDate, today) {
  if (isPaid(status)) return 'paid'
  if (isOverdueStatus(status)) return 'overdue'
  const due = ymdToDate(dueDate)
  if (due && today > due) return 'overdue'
  if (due && dayDiff(due, today) <= DUE_SOON_DAYS) return 'dueSoon'
  return 'pending'
}

function daysOverdue(status, dueDate, today) {
  if (isPaid(status)) return 0
  const due = ymdToDate(dueDate)
  if (!due) return 0
  return Math.max(0, dayDiff(today, due))
}

const SEVERITY = { overdue: 4, dueSoon: 3, pending: 2, paid: 1, none: 0 }

function settingsFor(ownerId) {
  const row = queryCollection('financeSettings', { ownerAdminId: ownerId })[0]
  return row ? { raw: row, normalized: normalizeSettings(row) } : null
}

function billableCharge(ownerId, monthKey) {
  const settings = settingsFor(ownerId)
  const charge = settings ? findCharge(settings.normalized.monthlyCharges, monthKey) : null
  return { settings, charge: charge && Number(charge.amount) > 0 ? charge : null }
}

function receiptCoversMonth(row, monthKey) {
  // Like the API's Receipt.CoversMonth: an extra-charge receipt never covers the month's fee.
  if (isExtraReceipt(row)) return false
  const billing = monthKeyOf(row.billingMonth)
  if (billing) return billing === monthKey
  return String(row.dueDate ?? '').startsWith(shiftMonth(monthKey, 1))
}

function residentsOf(ownerId) {
  return queryCollection('users', { role: 'resident', ownerAdminId: ownerId })
}

function monthlyBalance(ownerId, monthKey) {
  const income = queryCollection('payments', { ownerAdminId: ownerId })
    .filter((row) => String(row.paidAt ?? '').slice(0, 7) === monthKey)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const expenses = queryCollection('adminManagementExpenses', { ownerAdminId: ownerId })
    .filter((row) => String(row.purchaseDate ?? '').slice(0, 7) === monthKey)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  return { month: monthKey, income, expenses, net: income - expenses }
}

/* ------------------------------------------------------------------ PDF */

function pdfEscape(text) {
  return String(text ?? '')
    .replace(/[^\x20-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

/** Minimal one-page PDF (Helvetica, WinAnsi) so "Descargar recibo" yields a real file in the demo. */
function buildReceiptPdf(lines) {
  const content = [
    'BT',
    '/F1 18 Tf',
    '56 780 Td',
    `(${pdfEscape(lines[0])}) Tj`,
    '/F1 11 Tf',
    ...lines.slice(1).flatMap((line) => ['0 -22 Td', `(${pdfEscape(line)}) Tj`]),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff
  return bytes
}

/** Demo download for an uploaded document (the preview never stores the binary): PDF or text placeholder. */
export function demoFileDataUrl(fileName, mimeType) {
  const name = String(fileName || 'archivo')
  const lines = [
    'BuildingFex - Vista previa',
    `Archivo: ${name}`,
    'En el modo demo los archivos no se guardan en el servidor;',
    'con la API real se descarga el archivo original.',
  ]
  if (/pdf/i.test(String(mimeType)) || /\.pdf$/i.test(name)) {
    const bytes = buildReceiptPdf(lines)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return `data:application/pdf;base64,${btoa(binary)}`
  }
  return `data:text/plain;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`
}

function pdfResponse(config, fileName, lines) {
  const bytes = buildReceiptPdf(lines)
  const data = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'application/pdf' }) : bytes
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${fileName}"`,
    },
    config,
    request: { mock: true },
  }
}

function money(value) {
  return `S/ ${Number(value || 0).toFixed(2)}`
}

/* ------------------------------------------------------------- Finances */

function handleFinances(config, method, rest) {
  const { actor, ownerId } = tenantOf(config)
  const params = readParams(config)
  const body = readBody(config)
  const today = ymdToDate(todayYmd())

  if (rest === 'receipts/generate' && method === 'POST') {
    requireAdmin(config, actor)
    const rawMonth = String(params.month ?? body.month ?? '').trim()
    const month = rawMonth ? monthKeyOf(rawMonth) : todayYmd().slice(0, 7)
    if (!month) fail(config, 400, 'INVALID_MONTH', 'El mes debe tener formato yyyy-MM.', { field: 'month' })
    const { settings, charge } = billableCharge(ownerId, month)
    if (!charge) {
      fail(config, 422, 'MISSING_MONTHLY_CHARGE', `Configura la cuota de mantenimiento de ${month} antes de facturar.`, {
        result: { month, created: 0, alreadyBilled: 0, notDue: 0, skipped: true, reason: 'MISSING_MONTHLY_CHARGE' },
      })
    }
    const receipts = queryCollection('receipts', { ownerAdminId: ownerId })
    let created = 0
    let alreadyBilled = 0
    let notDue = 0
    const stamp = Date.now()
    residentsOf(ownerId).forEach((resident, seq) => {
      if (!residentOwesMonth(resident, month, settings.raw)) {
        notDue += 1
        return
      }
      if (receipts.some((r) => String(r.residentId) === String(resident.id) && receiptCoversMonth(r, month))) {
        alreadyBilled += 1
        return
      }
      insertRow('receipts', {
        id: `${stamp}${String(seq).padStart(3, '0')}`,
        residentId: resident.id,
        ownerAdminId: ownerId,
        issueDate: todayYmd(),
        dueDate: charge.paymentDue,
        paymentOpen: charge.paymentOpen,
        amount: Number(charge.amount),
        status: 'Pending',
        lateFee: 0,
        extraCharges: 0,
        concept: 'Mantenimiento',
        billingMonth: charge.month,
        kind: 'monthly',
      })
      created += 1
    })
    return ok(config, { month, created, alreadyBilled, notDue, skipped: false, reason: null })
  }

  if (rest === 'billing-alerts' && method === 'GET') {
    requireAdmin(config, actor)
    const month = todayYmd().slice(0, 7)
    const { charge } = billableCharge(ownerId, month)
    return ok(
      config,
      charge
        ? []
        : [
            {
              code: 'MISSING_MONTHLY_CHARGE',
              month,
              message: `No se configuró la cuota de mantenimiento de ${month}. La facturación automática está detenida hasta que registres el monto.`,
            },
          ],
    )
  }

  if (rest === 'payment-calendar' && method === 'GET') {
    const months = Math.min(24, Math.max(1, Number(params.months) || 6))
    let residentId = String(params.residentId ?? '').trim() || null
    if (actor.role === SessionRoles.RESIDENT) {
      if (residentId && residentId !== String(actor.id)) {
        fail(config, 403, 'FORBIDDEN_TENANT', 'Solo puedes ver tu propio calendario.')
      }
      residentId = String(actor.id)
    }
    const current = todayYmd().slice(0, 7)
    const monthKeys = Array.from({ length: months }, (_, i) => shiftMonth(current, i - (months - 1)))
    const monthSet = new Set(monthKeys)
    let residents = residentsOf(ownerId)
    if (residentId) residents = residents.filter((r) => String(r.id) === residentId)

    const items = []
    for (const r of queryCollection('receipts', { ownerAdminId: ownerId })) {
      const month = receiptMonth(r)
      if (month && monthSet.has(month)) {
        items.push({ residentId: String(r.residentId), month, id: String(r.id), status: r.status, dueDate: r.dueDate, amount: receiptTotal(r) })
      }
    }
    for (const f of queryCollection('fees', { ownerAdminId: ownerId })) {
      const month = feeMonth(f)
      if (month && monthSet.has(month)) {
        items.push({ residentId: String(f.residentId), month, id: String(f.id), status: f.status, dueDate: f.dueDate, amount: Number(f.amount ?? 0) })
      }
    }

    const rows = [...residents]
      .sort(
        (a, b) =>
          String(a.floor ?? '').localeCompare(String(b.floor ?? ''), undefined, { numeric: true }) ||
          String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }) ||
          String(a.name ?? '').localeCompare(String(b.name ?? '')),
      )
      .map((resident) => {
        const own = items.filter((i) => i.residentId === String(resident.id))
        const cells = monthKeys.map((month) => {
          const list = own.filter((i) => i.month === month)
          if (!list.length) return { month, status: 'none', amount: 0, dueDate: null, daysOverdue: 0, receiptIds: [] }
          const worst = list
            .map((i) => classify(i.status, i.dueDate, today))
            .sort((a, b) => SEVERITY[b] - SEVERITY[a])[0]
          const unpaid = list.filter((i) => !isPaid(i.status))
          const relevant = unpaid.length ? unpaid : list
          const dueDate =
            relevant
              .map((i) => i.dueDate)
              .filter(Boolean)
              .sort()[0] ?? null
          return {
            month,
            status: worst,
            amount: relevant.reduce((sum, i) => sum + i.amount, 0),
            dueDate,
            daysOverdue: Math.max(0, ...unpaid.map((i) => daysOverdue(i.status, i.dueDate, today))),
            receiptIds: list.map((i) => i.id),
          }
        })
        const overdueAmount = cells.filter((c) => c.status === 'overdue').reduce((sum, c) => sum + c.amount, 0)
        return {
          residentId: String(resident.id),
          name: resident.name ?? '',
          floor: resident.floor ?? null,
          code: resident.code ?? null,
          overdueAmount,
          hasOverdue: overdueAmount > 0,
          cells,
        }
      })

    return ok(config, { today: todayYmd(), dueSoonDays: DUE_SOON_DAYS, months: monthKeys, residents: rows })
  }

  if (rest === 'balance' && method === 'GET') {
    requireAdmin(config, actor)
    const raw = String(params.month ?? '').trim()
    const month = raw ? monthKeyOf(raw) : todayYmd().slice(0, 7)
    if (!month) fail(config, 400, 'INVALID_MONTH', 'El mes debe tener formato yyyy-MM.', { field: 'month' })
    return ok(config, monthlyBalance(ownerId, month))
  }

  const paymentPdf = rest.match(/^payments\/([^/]+)\/receipt-pdf$/)
  if (paymentPdf && method === 'GET') {
    const payment = findById('payments', paymentPdf[1])
    if (!payment) fail(config, 404, 'PAYMENT_NOT_FOUND', 'Pago no encontrado.')
    if (actor.role === SessionRoles.RESIDENT && String(payment.residentId) !== String(actor.id)) {
      fail(config, 403, 'FORBIDDEN_TENANT', 'No tienes acceso a este pago.')
    }
    const resident = findById('users', payment.residentId)
    return pdfResponse(config, `comprobante-${payment.id}.pdf`, [
      'BuildingFex - Comprobante de pago',
      `Comprobante: ${payment.reference || payment.id}`,
      `Residente: ${resident?.name ?? payment.residentId}${resident?.code ? ` (Dpto. ${resident.code})` : ''}`,
      `Concepto: ${payment.concept || 'Mantenimiento'}`,
      `Monto pagado: ${money(payment.amount)}`,
      `Fecha de pago: ${String(payment.paidAt ?? '').slice(0, 10)}`,
      `Medio de pago: ${payment.method || '-'}`,
      'Documento generado en modo demo.',
    ])
  }

  const receiptPdf = rest.match(/^receipts\/([^/]+)\/pdf$/)
  if (receiptPdf && method === 'GET') {
    const receipt = findById('receipts', receiptPdf[1])
    if (!receipt) fail(config, 404, 'RECEIPT_NOT_FOUND', 'Recibo no encontrado.')
    if (actor.role === SessionRoles.RESIDENT && String(receipt.residentId) !== String(actor.id)) {
      fail(config, 403, 'FORBIDDEN_TENANT', 'No tienes acceso a este recibo.')
    }
    if (!isPaid(receipt.status)) fail(config, 409, 'RECEIPT_NOT_PAID', 'El recibo aún no está pagado.')
    const resident = findById('users', receipt.residentId)
    return pdfResponse(config, `recibo-${receipt.id}.pdf`, [
      'BuildingFex - Recibo pagado',
      `Recibo: ${receipt.id}`,
      `Residente: ${resident?.name ?? receipt.residentId}${resident?.code ? ` (Dpto. ${resident.code})` : ''}`,
      `Concepto: ${receipt.concept || 'Mantenimiento'}`,
      `Mes: ${receiptMonth(receipt) ?? '-'}`,
      `Cuota: ${money(receipt.amount)}   Mora: ${money(receipt.lateFee)}   Extras: ${money(receipt.extraCharges)}`,
      `Total: ${money(receiptTotal(receipt))}`,
      `Vencimiento: ${receipt.dueDate || '-'}`,
      'Estado: PAGADO',
      'Documento generado en modo demo.',
    ])
  }

  return null
}

/* ----------------------------------------------------------------- Team */

function workerStatus(row) {
  return String(row?.status ?? '').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
}

function openTasksOf(staffId) {
  return listCollection('maintenanceTasks').filter(
    (t) => String(t.staffId) === String(staffId) && t.status !== 'COMPLETED',
  )
}

function workerResource(row) {
  const status = workerStatus(row)
  return {
    id: row.id,
    ownerAdminId: row.ownerAdminId ?? null,
    name: row.name ?? '',
    phone: row.phone ?? '',
    dni: row.dni ?? '',
    salary: Number(row.salary ?? 0),
    photoUrl: row.photoUrl ?? '',
    position: String(row.position ?? 'MAINTENANCE').toUpperCase(),
    status,
    isActive: status === 'ACTIVE',
    deactivatedAt: row.deactivatedAt ?? null,
    openTasks: openTasksOf(row.id).length,
  }
}

const STAFF_POSITIONS = ['CONCIERGE', 'MAINTENANCE', 'CLEANING', 'SECURITY']

function guardWorker(config, id, ownerId) {
  const row = findById('teamWorkers', id)
  if (!row) fail(config, 404, 'TEAM_WORKER_NOT_FOUND', 'Trabajador no encontrado.')
  if (row.ownerAdminId && String(row.ownerAdminId) !== String(ownerId)) {
    fail(config, 403, 'FORBIDDEN_TENANT', 'No tienes acceso a este trabajador.')
  }
  return row
}

function checkWorkload(config, worker, additional = 1) {
  if (workerStatus(worker) === 'INACTIVE') fail(config, 409, 'WORKER_INACTIVE', 'El trabajador está inactivo.')
  if (openTasksOf(worker.id).length + additional > MAX_OPEN_TASKS_PER_WORKER) {
    fail(config, 409, 'WORKLOAD_EXCEEDED', `El trabajador ya tiene ${MAX_OPEN_TASKS_PER_WORKER} tareas abiertas.`)
  }
}

function handleTeamWorkers(config, method, id, action) {
  const { actor, ownerId } = tenantOf(config)
  requireAdmin(config, actor)
  const body = readBody(config)
  const params = readParams(config)

  if (!id && method === 'GET') {
    let rows = queryCollection('teamWorkers', { ownerAdminId: ownerId }).map(workerResource)
    if (params.status) rows = rows.filter((w) => w.status === String(params.status).toUpperCase())
    return ok(config, rows)
  }
  if (!id && method === 'POST') {
    const name = String(body.name ?? '').trim()
    const phone = String(body.phone ?? '').trim()
    const dni = String(body.dni ?? '').trim()
    if (!name || !phone || !dni || !Number.isFinite(Number(body.salary))) {
      fail(config, 400, 'TEAM_WORKER_FIELDS_REQUIRED', 'Nombre, teléfono, DNI y sueldo son obligatorios.')
    }
    const position = String(body.position ?? 'MAINTENANCE').trim().toUpperCase() || 'MAINTENANCE'
    if (!STAFF_POSITIONS.includes(position)) fail(config, 400, 'INVALID_POSITION', 'Puesto inválido.')
    const created = insertRow('teamWorkers', {
      id: body.id || `worker-${Date.now()}`,
      ownerAdminId: ownerId,
      name,
      phone,
      dni,
      salary: Number(body.salary),
      photoUrl: String(body.photoUrl ?? ''),
      position,
      status: 'ACTIVE',
      deactivatedAt: null,
    })
    return ok(config, workerResource(created), 201)
  }

  const worker = guardWorker(config, id, ownerId)

  if (!action && method === 'PATCH') {
    const patch = {}
    for (const key of ['name', 'phone', 'dni', 'photoUrl']) {
      if (body[key] != null) patch[key] = String(body[key]).trim()
    }
    if (body.salary != null) patch.salary = Number(body.salary)
    if (body.position != null) {
      const position = String(body.position).trim().toUpperCase()
      if (!STAFF_POSITIONS.includes(position)) fail(config, 400, 'INVALID_POSITION', 'Puesto inválido.')
      patch.position = position
    }
    return ok(config, workerResource(patchRow('teamWorkers', worker.id, patch)))
  }

  if (action === 'deactivate' && method === 'PATCH') {
    const reassignToId = String(body.reassignToId ?? params.reassignToId ?? '').trim()
    const open = openTasksOf(worker.id)
    let reassignedTasks = 0
    if (reassignToId && open.length) {
      if (reassignToId === String(worker.id)) fail(config, 400, 'TEAM_ERROR', 'Elige otro trabajador.')
      const target = guardWorker(config, reassignToId, ownerId)
      checkWorkload(config, target, open.length)
      for (const task of open) {
        patchRow('maintenanceTasks', task.id, { staffId: target.id, updatedAt: nowIso() })
        reassignedTasks += 1
      }
    }
    const updated = patchRow('teamWorkers', worker.id, { status: 'INACTIVE', deactivatedAt: nowIso() })
    // Turnos futuros del trabajador desactivado ya no aplican.
    for (const shift of listCollection('shifts').filter((s) => String(s.staffId) === String(worker.id))) {
      if (new Date(shift.start) > new Date()) removeRow('shifts', shift.id)
    }
    const left = openTasksOf(worker.id).length
    return ok(config, { worker: workerResource(updated), reassignedTasks, openTasksLeft: left })
  }

  if (action === 'reactivate' && method === 'PATCH') {
    return ok(config, workerResource(patchRow('teamWorkers', worker.id, { status: 'ACTIVE', deactivatedAt: null })))
  }

  if (!action && method === 'DELETE') {
    removeRow('teamWorkers', worker.id)
    return noContent(config)
  }

  return null
}

function taskResource(row) {
  return {
    id: row.id,
    ownerAdminId: row.ownerAdminId ?? null,
    staffId: row.staffId,
    incidentId: row.incidentId ?? null,
    description: row.description ?? '',
    scheduledFor: row.scheduledFor ?? null,
    status: row.status ?? 'PENDING',
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt ?? nowIso(),
    updatedAt: row.updatedAt ?? null,
  }
}

function handleTasks(config, method, rest) {
  const { actor, ownerId } = tenantOf(config)
  requireAdmin(config, actor)
  const body = readBody(config)
  const params = readParams(config)
  const [id, action] = rest ? rest.split('/') : []

  if (!id && method === 'GET') {
    let rows = queryCollection('maintenanceTasks', { ownerAdminId: ownerId })
    if (params.staffId) rows = rows.filter((t) => String(t.staffId) === String(params.staffId))
    if (params.status) rows = rows.filter((t) => t.status === String(params.status).toUpperCase())
    if (params.incidentId) rows = rows.filter((t) => String(t.incidentId ?? '') === String(params.incidentId))
    if (String(params.open) === 'true') rows = rows.filter((t) => t.status !== 'COMPLETED')
    rows = [...rows].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return ok(config, rows.map(taskResource))
  }

  if (!id && method === 'POST') {
    const staffId = String(body.staffId ?? '').trim()
    const description = String(body.description ?? '').trim()
    if (!staffId || !description) {
      fail(config, 400, 'TASK_FIELDS_REQUIRED', 'staffId y description son obligatorios.')
    }
    const worker = findById('teamWorkers', staffId)
    if (!worker) fail(config, 404, 'TEAM_WORKER_NOT_FOUND', 'Trabajador no encontrado.')
    const incidentId = String(body.incidentId ?? '').trim() || null
    if (incidentId && !findById('incidents', incidentId)) {
      fail(config, 404, 'INCIDENT_NOT_FOUND', 'Incidencia no encontrada.')
    }
    checkWorkload(config, worker)
    const created = insertRow('maintenanceTasks', {
      id: body.id || `task-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`,
      ownerAdminId: ownerId,
      staffId: worker.id,
      incidentId,
      description: description.slice(0, 2000),
      scheduledFor: body.scheduledFor ? new Date(body.scheduledFor).toISOString() : null,
      status: 'PENDING',
      startedAt: null,
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: null,
    })
    return ok(config, taskResource(created), 201)
  }

  const task = findById('maintenanceTasks', id)
  if (!task) fail(config, 404, 'TASK_NOT_FOUND', 'Tarea no encontrada.')

  if (!action && method === 'GET') return ok(config, taskResource(task))

  if (action === 'start' && method === 'PATCH') {
    if (task.status !== 'PENDING') {
      fail(config, 409, 'INVALID_TASK_TRANSITION', 'Solo una tarea pendiente puede iniciarse.')
    }
    const at = nowIso()
    return ok(config, taskResource(patchRow('maintenanceTasks', task.id, { status: 'IN_PROGRESS', startedAt: at, updatedAt: at })))
  }

  if (action === 'complete' && method === 'PATCH') {
    if (task.status === 'COMPLETED') fail(config, 409, 'INVALID_TASK_TRANSITION', 'La tarea ya está completada.')
    const at = nowIso()
    return ok(
      config,
      taskResource(
        patchRow('maintenanceTasks', task.id, {
          status: 'COMPLETED',
          startedAt: task.startedAt || at,
          completedAt: at,
          updatedAt: at,
        }),
      ),
    )
  }

  if (action === 'reassign' && method === 'PATCH') {
    const staffId = String(body.staffId ?? '').trim()
    if (!staffId) fail(config, 400, 'TASK_FIELDS_REQUIRED', 'staffId es obligatorio.')
    if (task.status === 'COMPLETED') {
      fail(config, 409, 'INVALID_TASK_TRANSITION', 'Una tarea completada no puede reasignarse.')
    }
    const worker = findById('teamWorkers', staffId)
    if (!worker) fail(config, 404, 'TEAM_WORKER_NOT_FOUND', 'Trabajador no encontrado.')
    if (String(worker.id) === String(task.staffId)) return ok(config, taskResource(task))
    checkWorkload(config, worker)
    return ok(config, taskResource(patchRow('maintenanceTasks', task.id, { staffId: worker.id, updatedAt: nowIso() })))
  }

  return null
}

function shiftResource(row) {
  return {
    id: row.id,
    ownerAdminId: row.ownerAdminId ?? null,
    staffId: row.staffId,
    start: row.start,
    end: row.end,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? nowIso(),
  }
}

function handleShifts(config, method, rest) {
  const { actor, ownerId } = tenantOf(config)
  requireAdmin(config, actor)
  const body = readBody(config)
  const params = readParams(config)
  const id = rest || null

  const overlaps = (staffId, start, end, ignoreId) =>
    queryCollection('shifts', { ownerAdminId: ownerId }).some(
      (s) =>
        String(s.staffId) === String(staffId) &&
        String(s.id) !== String(ignoreId ?? '') &&
        new Date(s.start) < end &&
        start < new Date(s.end),
    )

  if (!id && method === 'GET') {
    let rows = queryCollection('shifts', { ownerAdminId: ownerId })
    if (params.staffId) rows = rows.filter((s) => String(s.staffId) === String(params.staffId))
    if (params.from) rows = rows.filter((s) => new Date(s.end) > new Date(params.from))
    if (params.to) rows = rows.filter((s) => new Date(s.start) < new Date(params.to))
    rows = [...rows].sort((a, b) => String(a.start).localeCompare(String(b.start)))
    return ok(config, rows.map(shiftResource))
  }

  if (!id && method === 'POST') {
    const staffId = String(body.staffId ?? '').trim()
    if (!staffId || !body.start || !body.end) {
      fail(config, 400, 'SHIFT_FIELDS_REQUIRED', 'staffId, start y end son obligatorios.')
    }
    const start = new Date(body.start)
    const end = new Date(body.end)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      fail(config, 400, 'SHIFT_INVALID_RANGE', 'El fin del turno debe ser posterior al inicio.')
    }
    const worker = findById('teamWorkers', staffId)
    if (!worker) fail(config, 404, 'TEAM_WORKER_NOT_FOUND', 'Trabajador no encontrado.')
    if (workerStatus(worker) === 'INACTIVE') fail(config, 409, 'WORKER_INACTIVE', 'El trabajador está inactivo.')
    if (overlaps(worker.id, start, end)) {
      fail(config, 409, 'SHIFT_OVERLAP', 'El turno se cruza con otro turno del mismo trabajador.')
    }
    const created = insertRow('shifts', {
      id: body.id || `shift-${Date.now()}`,
      ownerAdminId: ownerId,
      staffId: worker.id,
      start: start.toISOString(),
      end: end.toISOString(),
      notes: body.notes ? String(body.notes).trim() : null,
      createdAt: nowIso(),
    })
    return ok(config, shiftResource(created), 201)
  }

  const shift = findById('shifts', id)
  if (!shift) fail(config, 404, 'SHIFT_NOT_FOUND', 'Turno no encontrado.')
  if (method === 'GET') return ok(config, shiftResource(shift))
  if (method === 'DELETE') {
    removeRow('shifts', shift.id)
    return noContent(config)
  }
  if (method === 'PUT' || method === 'PATCH') {
    const start = body.start ? new Date(body.start) : new Date(shift.start)
    const end = body.end ? new Date(body.end) : new Date(shift.end)
    if (end <= start) fail(config, 400, 'SHIFT_INVALID_RANGE', 'El fin del turno debe ser posterior al inicio.')
    if (overlaps(shift.staffId, start, end, shift.id)) {
      fail(config, 409, 'SHIFT_OVERLAP', 'El turno se cruza con otro turno del mismo trabajador.')
    }
    return ok(
      config,
      shiftResource(
        patchRow('shifts', shift.id, {
          start: start.toISOString(),
          end: end.toISOString(),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        }),
      ),
    )
  }
  return null
}

/* ------------------------------------------------------- IAM / Documents */

function handleUserStatus(config, method, id, action) {
  if (method !== 'PATCH' || (action !== 'deactivate' && action !== 'reactivate')) return null
  const { actor, ownerId } = tenantOf(config)
  requireAdmin(config, actor)
  const user = findById('users', id)
  if (!user || user.role !== 'resident') fail(config, 404, 'RESIDENT_NOT_FOUND', 'Residente no encontrado.')
  if (String(user.ownerAdminId ?? '') !== String(ownerId)) fail(config, 403, 'FORBIDDEN_TENANT', 'Residente de otro condominio.')
  const updated = patchRow(
    'users',
    user.id,
    action === 'deactivate'
      ? { accountStatus: 'DEACTIVATED', deactivatedAt: nowIso() }
      : { accountStatus: 'ACTIVE', deactivatedAt: null },
  )
  return ok(config, publicUser(updated))
}

const DOCUMENT_TYPES = ['REGULATION', 'MINUTES', 'OTHER']

export function uploadResource(row) {
  const uploadStatus = row.uploadStatus ?? 'confirmed'
  const documentStatus =
    row.documentStatus ?? (uploadStatus === 'pending_upload' ? 'PENDING_UPLOAD' : 'PUBLISHED')
  return {
    ...row,
    uploadStatus,
    documentType: row.documentType ?? null,
    version: Number(row.version ?? 1),
    publishedAt: row.publishedAt ?? (documentStatus === 'PUBLISHED' ? row.uploadedAt ?? null : null),
    documentStatus,
    supersedesId: row.supersedesId ?? null,
    isCurrent: uploadStatus === 'confirmed' && documentStatus === 'PUBLISHED',
  }
}

function handleDocuments(config, method, id, action) {
  if (method !== 'POST' || (action !== 'publish' && action !== 'archive')) return null
  const { actor } = tenantOf(config)
  requireAdmin(config, actor)
  const body = readBody(config)
  const upload = findById('importUploads', id)
  if (!upload) fail(config, 404, 'HTTP_404', 'Not found')
  if (upload.uploadStatus !== 'confirmed') fail(config, 400, 'NOT_CONFIRMED', 'Confirma la subida primero.')

  if (action === 'archive') {
    return ok(config, uploadResource(patchRow('importUploads', upload.id, { documentStatus: 'ARCHIVED', indexingStatus: 'none' })))
  }

  const requestedType = body.documentType != null ? String(body.documentType).toUpperCase() : null
  if (requestedType && !DOCUMENT_TYPES.includes(requestedType)) {
    fail(config, 400, 'INVALID_DOCUMENT_TYPE', 'Tipo de documento inválido.', { allowed: DOCUMENT_TYPES })
  }
  let previous = null
  if (body.supersedesId) {
    previous = findById('importUploads', body.supersedesId)
    if (!previous) fail(config, 404, 'SUPERSEDED_DOCUMENT_NOT_FOUND', 'Documento a reemplazar no encontrado.')
    if (String(previous.id) === String(upload.id)) {
      fail(config, 400, 'SUPERSEDES_SELF', 'Un documento no puede reemplazarse a sí mismo.')
    }
  }
  const current = uploadResource(upload)
  const patch = {
    documentStatus: 'PUBLISHED',
    publishedAt: current.documentStatus === 'PUBLISHED' && current.publishedAt ? current.publishedAt : nowIso(),
    documentType: requestedType ?? (previous ? previous.documentType ?? null : current.documentType),
  }
  if (previous) {
    patch.version = Math.max(current.version, Number(previous.version ?? 1) + 1)
    patch.supersedesId = previous.id
  }
  const document = uploadResource(patchRow('importUploads', upload.id, patch))
  const superseded = previous
    ? uploadResource(patchRow('importUploads', previous.id, { documentStatus: 'SUPERSEDED', indexingStatus: 'none' }))
    : null
  return ok(config, { document, superseded })
}

/* ---------------------------------------------------------- Guest passes */

function reservationEndMs(r) {
  const date = ymdToDate(r.date)
  const [h, m] = String(r.endTime ?? '23:59').split(':').map(Number)
  if (!date) return null
  date.setHours(h || 0, m || 0, 0, 0)
  return date.getTime()
}

function passStatus(r) {
  const status = String(r.status ?? '').toUpperCase()
  if (status === 'CANCELLED' || r.cancelledAt) return 'CANCELLED'
  const end = reservationEndMs(r)
  if (end != null && Date.now() > end + GUEST_PASS_GRACE_MS) return 'EXPIRED'
  return 'VALID'
}

function shortName(full) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

function passJson(r) {
  const status = passStatus(r)
  const end = reservationEndMs(r)
  const space = findById('socialSpaces', r.spaceId)
  return {
    valid: status === 'VALID',
    status,
    expiresAt: end != null ? new Date(end + GUEST_PASS_GRACE_MS).toISOString() : null,
    reservation: {
      id: r.id,
      spaceName: space?.name ?? '',
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      status: r.status ?? 'CONFIRMED',
      hostName: shortName(r.residentName),
    },
    guests: (Array.isArray(r.guests) ? r.guests : []).map((g) => ({
      id: String(g.id ?? ''),
      name: String(g.name ?? ''),
      checkedIn: Boolean(g.checkedIn),
      checkedInAt: g.checkedInAt ?? null,
    })),
  }
}

function handleGuestPasses(config, method, rest) {
  const [token, action] = rest.split('/')
  const reservation = listCollection('reservations').find(
    (r) => token && String(r.guestInviteToken ?? '') === token,
  )
  if (!action && method === 'GET') {
    if (!reservation) {
      fail(config, 404, 'GUEST_PASS_NOT_FOUND', 'Invitación no encontrada.', { valid: false, status: 'NOT_FOUND' })
    }
    return ok(config, passJson(reservation))
  }
  if (action === 'check-in' && method === 'POST') {
    const { actor, ownerId } = tenantOf(config)
    requireAdmin(config, actor)
    if (!reservation) fail(config, 404, 'GUEST_PASS_NOT_FOUND', 'Invitación no encontrada.')
    if (reservation.ownerAdminId && String(reservation.ownerAdminId) !== String(ownerId)) {
      fail(config, 403, 'FORBIDDEN_TENANT', 'Pase de otro condominio.')
    }
    const status = passStatus(reservation)
    if (status !== 'VALID') {
      const code = status === 'CANCELLED' ? 'GUEST_PASS_CANCELLED' : 'GUEST_PASS_EXPIRED'
      fail(config, 410, code, status === 'CANCELLED' ? 'La reserva fue cancelada.' : 'El pase expiró.', {
        valid: false,
        status,
      })
    }
    const body = readBody(config)
    const guestId = String(body.guestId ?? '').trim()
    const on = body.checkedIn !== false
    const guests = Array.isArray(reservation.guests) ? reservation.guests : []
    if (guestId && !guests.some((g) => String(g.id) === guestId)) {
      fail(config, 404, 'GUEST_NOT_FOUND', 'Invitado no encontrado.')
    }
    const next = guests.map((g) =>
      !guestId || String(g.id) === guestId
        ? { ...g, checkedIn: on, checkedInAt: on ? g.checkedInAt || nowIso() : null }
        : g,
    )
    return ok(config, passJson(patchRow('reservations', reservation.id, { guests: next })))
  }
  return null
}

/* -------------------------------------------------------- Resident Care */

function handleSupportCounters(config, method, rest) {
  if (method !== 'GET') return null
  const { actor, ownerId } = tenantOf(config)
  if (rest === 'chats/summary') {
    requireAdmin(config, actor)
    const rows = listCollection('supportChats').filter(
      (c) => String(c.kind ?? '') !== 'ai' && String(c.ownerAdminId ?? ownerId) === String(ownerId),
    )
    const count = (fn) => rows.filter((c) => fn(String(c.status ?? 'open'))).length
    return ok(config, {
      pending: count((s) => s === 'open' || s === 'pending'),
      answered: count((s) => s === 'answered'),
      closed: count((s) => s === 'closed'),
      total: rows.length,
    })
  }
  if (rest === 'ai-usage') {
    requireAdmin(config, actor)
    const { planId } = subscriptionSnapshot(ownerId)
    const cap = Number(SUBSCRIPTION_PLAN_AI_QUERY_CAPS[planId] ?? 150)
    const period = todayYmd().slice(0, 7)
    const ownerResidents = new Set(residentsOf(ownerId).map((r) => String(r.id)))
    const used = listCollection('supportChats')
      .filter((c) => String(c.kind ?? '') === 'ai' && ownerResidents.has(String(c.residentId ?? '')))
      .flatMap((c) => (Array.isArray(c.messages) ? c.messages : []))
      .filter((m) => (m.role === 'ai' || m.authorRole === 'assistant') && String(m.createdAt ?? '').startsWith(period))
      .length
    return ok(config, {
      period,
      used,
      cap,
      remaining: Math.max(0, cap - used),
      capReached: used >= cap,
      planId,
    })
  }
  return null
}

/* ------------------------------------------------------- Roster import */

const HEADER_ALIASES = {
  nombre: 'name', nombres: 'name', nombrecompleto: 'name', nombreyapellido: 'name', nombresyapellidos: 'name',
  residente: 'name', vecino: 'name', name: 'name', fullname: 'name',
  departamento: 'department', depto: 'department', dpto: 'department', dep: 'department', unidad: 'department',
  numerodepartamento: 'department', nrodepartamento: 'department', codigo: 'department', department: 'department',
  apartment: 'department', unit: 'department', code: 'department',
  piso: 'floor', floor: 'floor',
  email: 'email', correo: 'email', correoelectronico: 'email', mail: 'email',
  fechaingreso: 'admissionDate', fechadeingreso: 'admissionDate', ingreso: 'admissionDate', admissiondate: 'admissionDate',
  facturardesdemessiguiente: 'billFromNextMonth', facturarmessiguiente: 'billFromNextMonth', billfromnextmonth: 'billFromNextMonth',
}

function headerKey(raw) {
  let key = String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  for (const suffix of ['aaaammdd', 'ddmmaaaa', 'yyyymmdd', 'opcional', 'obligatorio', 'sino']) {
    if (key.endsWith(suffix) && key.length > suffix.length) key = key.slice(0, -suffix.length)
  }
  return HEADER_ALIASES[key] ?? null
}

function splitCsvLine(line, sep) {
  const out = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      out.push(cell)
      cell = ''
    } else cell += ch
  }
  out.push(cell)
  return out.map((c) => c.trim())
}

function importFailure(config, code, message, extra = {}) {
  fail(config, 400, code, message, {
    totalRows: 0,
    invalidRows: 0,
    errors: [{ row: 0, column: null, code, message }],
    ...extra,
  })
}

async function handleRosterImport(config, method, rest) {
  const { actor, ownerId } = tenantOf(config)
  requireAdmin(config, actor)

  if (rest === 'template' && method === 'GET') {
    const format = String(readParams(config).format ?? 'xlsx').toLowerCase()
    // El .xlsx lo arma el servidor (ClosedXML); en la vista previa el panel cae a la plantilla CSV local.
    if (format !== 'csv') fail(config, 501, 'TEMPLATE_UNAVAILABLE', 'La plantilla Excel requiere la API.')
    const csv =
      '﻿nombre;departamento;piso;email;fecha_ingreso;facturar_desde_mes_siguiente\n' +
      'Ana Torres;304;3;ana.torres@correo.com;2026-01-15;no\nLuis Ramos;1201;;;;\n'
    return {
      data: new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/csv; charset=utf-8' },
      config,
      request: { mock: true },
    }
  }

  if (rest !== '' || method !== 'POST') return null

  const file = typeof FormData !== 'undefined' && config.data instanceof FormData ? config.data.get('file') : null
  if (!file || !file.size) importFailure(config, 'FILE_REQUIRED', 'Selecciona un archivo .xlsx o .csv.')
  const name = String(file.name ?? '').toLowerCase()
  if (name.endsWith('.xlsx')) {
    importFailure(
      config,
      'UNSUPPORTED_FILE_TYPE',
      'En el modo demo (sin servidor) solo se procesan archivos .csv. Descarga la plantilla CSV o conecta la API para importar .xlsx.',
    )
  }
  if (!name.endsWith('.csv')) importFailure(config, 'UNSUPPORTED_FILE_TYPE', 'Sube un archivo .xlsx o .csv (usa la plantilla).')

  const text = String(await file.text()).replace(/^﻿/, '')
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
  if (!lines.length) importFailure(config, 'EMPTY_FILE', 'El archivo no tiene datos.')
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','
  const columns = splitCsvLine(lines[0], sep).map(headerKey)
  if (!columns.includes('name') || !columns.includes('department')) {
    importFailure(config, 'MISSING_COLUMNS', 'No se encontraron las columnas "nombre" y "departamento". Usa la plantilla.')
  }
  const rows = lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line, sep)
    const row = { rowNumber: i + 2 }
    columns.forEach((key, idx) => {
      if (key) row[key] = cells[idx] ?? ''
    })
    return row
  })
  if (!rows.length) importFailure(config, 'EMPTY_FILE', 'El archivo no tiene filas de residentes.')
  if (rows.length > 1000) importFailure(config, 'TOO_MANY_ROWS', 'El archivo supera el máximo de 1000 filas.')

  const existing = residentsOf(ownerId)
  const taken = new Set(existing.map((r) => String(r.code ?? '').trim()))
  const emails = new Set(listCollection('users').map((u) => String(u.email ?? '').trim().toLowerCase()).filter(Boolean))
  const errors = []
  const parsed = []
  const seenCodes = new Set()
  for (const row of rows) {
    const err = (column, code, message) => errors.push({ row: row.rowNumber, column, code, message })
    const fullName = String(row.name ?? '').trim()
    if (!fullName) err('nombre', 'NAME_REQUIRED', 'El nombre es obligatorio.')
    const rawDept = String(row.department ?? '').trim()
    const dept = rawDept ? parseDepartmentNumber(rawDept) : null
    if (!rawDept) err('departamento', 'DEPARTMENT_REQUIRED', 'El departamento es obligatorio.')
    else if (!dept) err('departamento', 'INVALID_DEPARTMENT', `"${rawDept}" no es un número de departamento válido (ej. 302 o 1201).`)
    const code = dept?.department ?? rawDept
    if (dept && taken.has(code)) err('departamento', 'DEPARTMENT_ALREADY_REGISTERED', `El departamento ${code} ya está registrado.`)
    if (dept && seenCodes.has(code)) err('departamento', 'DUPLICATE_DEPARTMENT', `El departamento ${code} está repetido en el archivo.`)
    seenCodes.add(code)
    const email = String(row.email ?? '').trim().toLowerCase()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err('email', 'INVALID_EMAIL', 'El correo no es válido.')
    else if (email && emails.has(email)) err('email', 'EMAIL_ALREADY_EXISTS', 'El correo ya está registrado.')
    const admission = String(row.admissionDate ?? '').trim()
    if (admission && !/^\d{4}-\d{2}-\d{2}$/.test(admission)) {
      err('fecha_ingreso', 'INVALID_ADMISSION_DATE', 'La fecha de ingreso debe tener formato AAAA-MM-DD.')
    }
    const bill = /^(si|sí|yes|true|1|x)$/i.test(String(row.billFromNextMonth ?? '').trim())
    parsed.push({
      name: fullName,
      floor: String(row.floor ?? '').trim() || dept?.floor || '',
      code,
      email,
      admissionDate: admission || todayYmd(),
      billFromNextMonth: bill,
    })
  }

  const snapshot = subscriptionSnapshot(ownerId)
  if (!errors.length && existing.length + parsed.length > snapshot.residentLimit) {
    fail(config, 400, 'RESIDENT_PLAN_LIMIT_REACHED', `Tu plan admite ${snapshot.residentLimit} departamentos.`, {
      totalRows: rows.length,
      invalidRows: 0,
      residentLimit: snapshot.residentLimit,
      residentsCount: existing.length,
      errors: [{ row: 0, column: null, code: 'RESIDENT_PLAN_LIMIT_REACHED', message: `Tu plan admite ${snapshot.residentLimit} departamentos.` }],
    })
  }
  if (errors.length) {
    fail(config, 400, 'IMPORT_VALIDATION_FAILED', 'El archivo tiene filas con errores; no se importó ningún residente.', {
      totalRows: rows.length,
      invalidRows: new Set(errors.map((e) => e.row)).size,
      errors,
    })
  }

  const stamp = Date.now()
  const created = parsed.map((p, i) =>
    insertRow('users', {
      id: `resident-${stamp}-${i}`,
      role: 'resident',
      ownerAdminId: ownerId,
      name: p.name,
      floor: p.floor,
      code: p.code,
      email: '',
      inviteEmail: p.email || null,
      password: '',
      admissionDate: p.admissionDate,
      billFromNextMonth: p.billFromNextMonth,
      inviteToken: `inv-${stamp.toString(36)}${i}${Math.random().toString(36).slice(2, 8)}`,
      inviteExpiresAt: new Date(stamp + 7 * 86400000).toISOString(),
      accountStatus: 'ACTIVE',
    }),
  )
  return ok(config, { created: created.length, totalRows: rows.length, residents: created.map(publicUser) }, 201)
}

/* --------------------------------------------------------- Reservations */

const MAX_GUESTS = 5

function hhmm(value) {
  const [h, m] = String(value ?? '').split(':').map(Number)
  return Number.isFinite(h) ? h * 60 + (m || 0) : NaN
}

function isActiveReservation(r) {
  return String(r.status ?? 'CONFIRMED').toUpperCase() !== 'CANCELLED' && !r.cancelledAt
}

/** ReservationPolicy.CanHostGuests: max 5 invitados y aforo (titular + invitados). */
function checkGuests(config, space, guestCount) {
  if (guestCount > MAX_GUESTS) {
    fail(config, 400, 'RESERVATION_TOO_MANY_GUESTS', `Máximo ${MAX_GUESTS} invitados por reserva.`)
  }
  const capacity = Number(space?.capacity)
  if (capacity > 0 && guestCount + 1 > capacity) {
    fail(config, 409, 'RESERVATION_CAPACITY_EXCEEDED', 'La cantidad de personas supera el aforo del espacio.')
  }
}

/** ReservationPolicy.CanReserve on create; guest list changes re-check the capacity. */
function handleReservations(config, method, id) {
  const body = readBody(config)
  if (!id && method === 'POST') {
    const space = findById('socialSpaces', body.spaceId)
    if (!space) fail(config, 404, 'SPACE_NOT_FOUND', 'Espacio no encontrado.')
    if (String(space.status ?? '').toUpperCase() === 'MAINTENANCE') {
      fail(config, 409, 'SPACE_UNDER_MAINTENANCE', 'El espacio está en mantenimiento.')
    }
    const start = hhmm(body.startTime)
    const end = hhmm(body.endTime)
    if (!body.date || Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      fail(config, 400, 'RESERVATION_TIME_INVALID', 'Horario inválido.')
    }
    const sameDay = listCollection('reservations').filter(
      (r) => String(r.spaceId) === String(space.id) && r.date === body.date && isActiveReservation(r),
    )
    if (sameDay.some((r) => hhmm(r.startTime) < end && start < hhmm(r.endTime))) {
      fail(config, 409, 'RESERVATION_OVERLAP', 'Traslape de horario: la reserva se cruza con otra existente.')
    }
    const maxPerDay = Number(space.maxReservationsPerDay)
    if (maxPerDay > 0 && sameDay.length >= maxPerDay) {
      fail(config, 409, 'RESERVATION_DAY_FULL', 'El espacio alcanzó su límite de reservas para esa fecha.')
    }
    checkGuests(config, space, Array.isArray(body.guests) ? body.guests.length : 0)
    return null // valid → generic CRUD insert
  }
  if (id && method === 'PATCH' && Array.isArray(body.guests)) {
    const current = findById('reservations', id)
    if (!current) return null
    checkGuests(config, findById('socialSpaces', current.spaceId), body.guests.length)
  }
  return null
}

/* --------------------------------------------------------------- Router */

export async function handleOperations(config, method, parts) {
  if (parts[0] === 'teamWorkers') {
    return handleTeamWorkers(config, method, parts[1], parts[2])
  }
  if (parts[0] === 'reservations') {
    return handleReservations(config, method, parts[1])
  }
  if (parts[0] !== 'api' || parts[1] !== 'v1') return null
  const route = parts.slice(2).join('/')
  const sub = (prefix) => (route === prefix ? '' : route.startsWith(`${prefix}/`) ? route.slice(prefix.length + 1) : null)

  let rest
  if ((rest = sub('finances')) !== null) return handleFinances(config, method, rest)
  if ((rest = sub('tasks')) !== null) return handleTasks(config, method, rest)
  if ((rest = sub('shifts')) !== null) return handleShifts(config, method, rest)
  if ((rest = sub('staff')) !== null) {
    const [id, action] = rest ? rest.split('/') : []
    return handleTeamWorkers(config, method, id, action)
  }
  if ((rest = sub('guest-passes')) !== null && rest) return handleGuestPasses(config, method, rest)
  if ((rest = sub('support')) !== null) return handleSupportCounters(config, method, rest)
  if ((rest = sub('residents/import')) !== null) return handleRosterImport(config, method, rest)
  if ((rest = sub('users')) !== null && rest.includes('/')) {
    const [id, action] = rest.split('/')
    return handleUserStatus(config, method, id, action)
  }
  if ((rest = sub('import/uploads')) !== null && rest.includes('/')) {
    const [id, action] = rest.split('/')
    return handleDocuments(config, method, id, action)
  }
  return null
}
