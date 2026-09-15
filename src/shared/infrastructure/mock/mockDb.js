import { SUBSCRIPTION_PLAN_PRICES_PEN, SUBSCRIPTION_PLAN_RESIDENT_LIMITS } from '@/shared/domain/subscriptionPlans.js'
import { createSeedDb, MOCK_DB_VERSION } from './seed.js'

export const MOCK_DB_STORAGE_KEY = 'buildingfex.localMockDb.v2'

const COLLECTIONS = [
  'users',
  'incidents',
  'announcements',
  'socialSpaces',
  'reservations',
  'receipts',
  'payments',
  'fees',
  'financeSettings',
  'kpi',
  'adminManagementExpenses',
  'sharedUtilityServices',
  'fixedPayoutRecipients',
  'teamWorkers',
  'serviceProviders',
  'importUploads',
  'importFolders',
  'residentExtraCharges',
  'supportChats',
  'subscriptions',
]

function ensureCollections(db) {
  if (!db || typeof db !== 'object') return
  for (const name of COLLECTIONS) {
    if (!Array.isArray(db[name])) db[name] = []
  }
}

let memory = null
let persistHook = null

export function setMockDbPersistHook(fn) {
  persistHook = typeof fn === 'function' ? fn : null
}

export function installNodeSnapshot(snapshot) {
  if (memory || !snapshot || snapshot.version !== MOCK_DB_VERSION) return false
  memory = snapshot
  ensureCollections(memory)
  return true
}

export function mergeIncomingDb(incoming) {
  const db = load()
  if (!incoming || incoming.version !== MOCK_DB_VERSION || typeof incoming !== 'object') return db
  for (const name of COLLECTIONS) {
    if (!Array.isArray(incoming[name])) continue
    if (!Array.isArray(db[name])) db[name] = []
    const byId = new Map(db[name].map((row) => [String(row?.id), row]))
    for (const row of incoming[name]) {
      const id = String(row?.id ?? '')
      if (!id || byId.has(id)) continue
      if (name === 'users' && row.role === 'resident') {
        const code = String(row.code ?? '').trim()
        const codeTaken = db.users.some(
          (user) => user.role === 'resident' && String(user.code ?? '').trim() === code,
        )
        if (codeTaken) continue
      }
      db[name].push(row)
      byId.set(id, row)
    }
  }
  persist()
  return db
}

function canUseStorage() {
  return typeof window !== 'undefined' && window.localStorage
}

function persist() {
  if (!memory) return
  if (canUseStorage()) {
    try {
      window.localStorage.setItem(MOCK_DB_STORAGE_KEY, JSON.stringify(memory))
    } catch {
      // quota / private mode
    }
  }
  persistHook?.(memory)
}

function load() {
  if (memory) return memory
  if (canUseStorage()) {
    try {
      const raw = window.localStorage.getItem(MOCK_DB_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.version === MOCK_DB_VERSION) {
          memory = parsed
          ensureCollections(memory)
          return memory
        }
      }
    } catch {
      // ignore corrupt cache
    }
  }
  memory = createSeedDb()
  persist()
  return memory
}

export function getDb() {
  return load()
}

export function saveDb() {
  persist()
}

export function resetMockDb() {
  memory = createSeedDb()
  persist()
  return memory
}

export function isKnownCollection(name) {
  return COLLECTIONS.includes(name)
}

export function listCollection(name) {
  const db = load()
  const rows = db[name]
  return Array.isArray(rows) ? rows : []
}

export function findById(name, id) {
  const needle = String(id)
  return listCollection(name).find((row) => String(row?.id) === needle) ?? null
}

export function insertRow(name, row) {
  const db = load()
  if (!Array.isArray(db[name])) db[name] = []
  const next = { ...row }
  if (next.id == null || String(next.id).length === 0) {
    next.id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  }
  db[name].push(next)
  persist()
  return next
}

export function replaceRow(name, id, row) {
  const db = load()
  const rows = db[name]
  if (!Array.isArray(rows)) return null
  const index = rows.findIndex((item) => String(item?.id) === String(id))
  if (index < 0) return null
  const next = { ...row, id: rows[index].id }
  rows[index] = next
  persist()
  return next
}

export function patchRow(name, id, patch) {
  const current = findById(name, id)
  if (!current) return null
  return replaceRow(name, id, { ...current, ...patch, id: current.id })
}

export function removeRow(name, id) {
  const db = load()
  const rows = db[name]
  if (!Array.isArray(rows)) return false
  const index = rows.findIndex((item) => String(item?.id) === String(id))
  if (index < 0) return false
  rows.splice(index, 1)
  persist()
  return true
}

export function queryCollection(name, params = {}) {
  const sortKey = params._sort
  const order = String(params._order ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
  const filters = Object.entries(params).filter(([key]) => !key.startsWith('_'))

  let rows = listCollection(name).filter((row) =>
    filters.every(([key, value]) => {
      if (value == null || value === '') return true
      return String(row?.[key] ?? '') === String(value)
    }),
  )

  if (sortKey) {
    rows = [...rows].sort((a, b) => {
      const left = String(a?.[sortKey] ?? '')
      const right = String(b?.[sortKey] ?? '')
      if (left < right) return -1 * order
      if (left > right) return 1 * order
      return 0
    })
  }

  return rows
}

function monthKeyFromIso(value) {
  const raw = String(value ?? '').trim()
  return raw.length >= 7 ? raw.slice(0, 7) : ''
}

export function computeKpi(ownerId) {
  const residents = queryCollection('users', { role: 'resident', ...(ownerId ? { ownerAdminId: ownerId } : {}) })
  const receipts = queryCollection('receipts', ownerId ? { ownerAdminId: ownerId } : {})
  const payments = queryCollection('payments', ownerId ? { ownerAdminId: ownerId } : {})
  const expenses = queryCollection('adminManagementExpenses', ownerId ? { ownerAdminId: ownerId } : {})

  const pending = receipts.filter((row) => row.status !== 'Paid')
  const totalDebt = pending.reduce(
    (sum, row) =>
      sum + Number(row.amount ?? 0) + Number(row.lateFee ?? 0) + Number(row.extraCharges ?? 0),
    0,
  )

  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i -= 1) {
    months.push(new Date(now.getFullYear(), now.getMonth() - i, 1))
  }

  const monthlyChart = months.map((date) => {
    const monthKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
    const income = payments
      .filter((row) => monthKeyFromIso(row.paidAt) === monthKey)
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
    const monthExpenses = expenses
      .filter((row) => monthKeyFromIso(row.purchaseDate) === monthKey)
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
    return { monthKey, income, expenses: monthExpenses }
  })

  return {
    id: 'kpi-live',
    ownerAdminId: ownerId ?? null,
    totalResidents: residents.length,
    occupiedUnits: residents.length,
    emptyUnits: Math.max(0, 12 - residents.length),
    totalDebt,
    totalPendingDebt: totalDebt,
    monthlyChart,
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

export function getOrCreateSubscription(ownerId) {
  const db = load()
  if (!Array.isArray(db.subscriptions)) db.subscriptions = []
  let row = db.subscriptions.find((item) => String(item.ownerAdminId) === String(ownerId))
  if (!row) {
    row = {
      ownerAdminId: ownerId,
      planId: 'standard',
      paidUntil: null,
      isPaid: false,
    }
    db.subscriptions.push(row)
    persist()
  }
  return row
}

export function subscriptionSnapshot(ownerId) {
  const row = getOrCreateSubscription(ownerId)
  const residentsCount = queryCollection('users', { role: 'resident', ownerAdminId: ownerId }).length
  const planId = String(row.planId ?? 'free')
  return {
    planId,
    residentLimit: SUBSCRIPTION_PLAN_RESIDENT_LIMITS[planId] ?? 9,
    residentsCount,
    monthlyPricePen: SUBSCRIPTION_PLAN_PRICES_PEN[planId] ?? 0,
    paidUntil: row.paidUntil ?? null,
    isPaid: Boolean(row.isPaid),
  }
}

export function upsertSubscription(ownerId, patch) {
  const row = getOrCreateSubscription(ownerId)
  Object.assign(row, patch)
  persist()
  return subscriptionSnapshot(ownerId)
}

