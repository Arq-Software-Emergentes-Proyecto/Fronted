/**
 * One-time migration: tag existing json-server rows with ownerAdminId so each
 * admin account only sees their own data. Legacy demo data is assigned to admin-seed-1.
 *
 * Run: node server/migrate-owner-admin.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, 'db.json')
const SEED = 'admin-seed-1'

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'))

function tagArray(arr, value = SEED) {
  if (!Array.isArray(arr)) return
  for (const row of arr) {
    if (row && typeof row === 'object' && row.ownerAdminId == null) {
      row.ownerAdminId = value
    }
  }
}

for (const u of db.users ?? []) {
  if (u.role === 'resident' && u.ownerAdminId == null) {
    u.ownerAdminId = SEED
  }
}

tagArray(db.fees)
tagArray(db.payments)
tagArray(db.receipts)
tagArray(db.incidents)
tagArray(db.socialSpaces)
tagArray(db.reservations)
tagArray(db.teamWorkers)
tagArray(db.fixedPayoutRecipients)
tagArray(db.adminManagementExpenses)

const oldSettings = db.financeSettings
if (oldSettings && !Array.isArray(oldSettings)) {
  db.financeSettings = [
    {
      id: `finance-settings-${SEED}`,
      ownerAdminId: SEED,
      baseMonthlyExpense: oldSettings.baseMonthlyExpense ?? 150,
      lateFeeRate: oldSettings.lateFeeRate ?? 0.05,
    },
  ]
} else if (!Array.isArray(db.financeSettings)) {
  db.financeSettings = []
}

const oldKpi = db.kpi
if (oldKpi && !Array.isArray(oldKpi)) {
  db.kpi = [
    {
      id: `kpi-${SEED}`,
      ownerAdminId: SEED,
      totalResidents: oldKpi.totalResidents ?? 0,
      occupiedUnits: oldKpi.occupiedUnits ?? 0,
      emptyUnits: oldKpi.emptyUnits ?? 0,
      totalDebt: oldKpi.totalDebt ?? 0,
    },
  ]
} else if (!Array.isArray(db.kpi)) {
  db.kpi = []
}

const adminIds = (db.users ?? []).filter((u) => u.role === 'admin').map((u) => u.id)
for (const aid of adminIds) {
  const hasFs = (db.financeSettings ?? []).some((r) => r.ownerAdminId === aid)
  if (!hasFs) {
    db.financeSettings.push({
      id: `finance-settings-${aid}`,
      ownerAdminId: aid,
      baseMonthlyExpense: 150,
      lateFeeRate: 0.05,
    })
  }
  const hasKpi = (db.kpi ?? []).some((r) => r.ownerAdminId === aid)
  if (!hasKpi) {
    db.kpi.push({
      id: `kpi-${aid}`,
      ownerAdminId: aid,
      totalResidents: 0,
      occupiedUnits: 0,
      emptyUnits: 0,
      totalDebt: 0,
    })
  }
}

fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`)
console.log('OK: ownerAdminId migration applied (legacy owner:', SEED + ')')
