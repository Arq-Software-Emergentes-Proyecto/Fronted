import fs from 'node:fs'
import path from 'node:path'

const DB_PATH = path.join(process.cwd(), 'server', '.local-mock-db.json')

const API_PREFIXES = [
  '/api',
  '/hubs',
  '/users',
  '/incidents',
  '/announcements',
  '/socialSpaces',
  '/reservations',
  '/receipts',
  '/payments',
  '/fees',
  '/financeSettings',
  '/kpi',
  '/adminManagementExpenses',
  '/sharedUtilityServices',
  '/fixedPayoutRecipients',
  '/teamWorkers',
  '/serviceProviders',
  '/residentExtraCharges',
]

function pathnameOf(req) {
  return String(req.url ?? '').split('?')[0]
}

function isMockApiPath(pathname) {
  if (pathname === '/__preview/hydrate') return true
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload ?? {}))
}

function readSnapshotFile() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeSnapshotFile(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db))
  } catch {
    // ignore disk errors in preview
  }
}

/**
 * Serves the local mock API from the Vite process so every browser
 * (including incognito) shares the same residents and invite codes.
 */
export function previewMockApiPlugin() {
  return {
    name: 'preview-mock-api',
    apply: 'serve',
    configureServer(server) {
      let mockAdapter = null
      let mockDb = null

      async function loadMockModules() {
        mockAdapter = await server.ssrLoadModule('/src/shared/infrastructure/mock/mockAdapter.js')
        mockDb = await server.ssrLoadModule('/src/shared/infrastructure/mock/mockDb.js')
        mockDb.setMockDbPersistHook(writeSnapshotFile)
        mockDb.installNodeSnapshot(readSnapshotFile())
      }

      // Hot-reload mock modules when source changes (wireframe hardcode iteration).
      server.watcher?.add([
        path.join(process.cwd(), 'src/shared/infrastructure/mock'),
      ])
      server.watcher?.on('change', (file) => {
        if (String(file).includes(`${path.sep}mock${path.sep}`)) {
          mockAdapter = null
          mockDb = null
        }
      })

      server.middlewares.use(async (req, res, next) => {
        const pathname = pathnameOf(req)
        if (!isMockApiPath(pathname)) {
          next()
          return
        }

        try {
          if (!mockAdapter || !mockDb) await loadMockModules()

          if (pathname === '/__preview/hydrate' && req.method === 'POST') {
            const body = await readJsonBody(req)
            mockDb.mergeIncomingDb(body)
            sendJson(res, 200, { ok: true })
            return
          }

          const url = new URL(req.url ?? '/', 'http://localhost')
          const method = String(req.method ?? 'GET').toUpperCase()
          let data = {}
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            data = await readJsonBody(req)
          }

          const result = await mockAdapter.localMockAdapter({
            url: `${url.pathname}${url.search}`,
            method,
            data,
            params: Object.fromEntries(url.searchParams.entries()),
            headers: req.headers,
          })
          sendJson(res, result.status ?? 200, result.data)
        } catch (error) {
          if (error?.isAxiosError && error.response) {
            sendJson(res, error.response.status ?? 500, error.response.data)
            return
          }
          sendJson(res, 500, {
            code: 'PREVIEW_MOCK_ERROR',
            message: error?.message || 'Preview mock failed',
          })
        }
      })
    },
  }
}
