import {
  createMercadoPagoPreference,
  readMercadoPagoPayment,
  sendError,
  sendJson,
} from './mercadoPagoCheckout.mjs'

function pathnameOf(req) {
  return String(req.url ?? '').split('?')[0]
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

export function mercadoPagoCheckoutPlugin() {
  return {
    name: 'mercado-pago-checkout',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = pathnameOf(req)
        try {
          if (path === '/mp/checkout' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const result = await createMercadoPagoPreference(body)
            sendJson(res, 200, result)
            return
          }
          if (path === '/mp/payment' && req.method === 'GET') {
            const url = new URL(req.url, 'http://localhost')
            const result = await readMercadoPagoPayment(url.searchParams.get('id'))
            sendJson(res, 200, result)
            return
          }
        } catch (error) {
          sendError(res, error)
          return
        }
        next()
      })
    },
  }
}
