import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mercadoPagoCheckoutPlugin } from './server/viteMercadoPagoPlugin.js'
import { previewMockApiPlugin } from './server/vitePreviewMockPlugin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Compat + versioned routes exposed by BuildingFex.Api */
const API_ROUTE_PREFIXES = [
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

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:5001'
  // Same default as src/iam/application/localPreviewAuth.js (on in `vite` dev unless set to false).
  const openWireframes =
    String(env.VITE_OPEN_WIREFRAMES ?? (command === 'serve' ? 'true' : 'false')) === 'true'
  if (env.MP_ACCESS_TOKEN) process.env.MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN
  if (env.MERCADOPAGO_ACCESS_TOKEN) {
    process.env.MERCADOPAGO_ACCESS_TOKEN = env.MERCADOPAGO_ACCESS_TOKEN
  }

  return {
    // The dev-server mock API only serves wireframe/demo mode. With VITE_OPEN_WIREFRAMES=false
    // it must stay out of the way so `server.proxy` reaches the real BuildingFex.Api.
    plugins: [
      vue(),
      ...(openWireframes ? [previewMockApiPlugin()] : []),
      mercadoPagoCheckoutPlugin(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      proxy: Object.fromEntries(
        API_ROUTE_PREFIXES.map((prefix) => [
          prefix,
          // /hubs = SignalR (/hubs/support): WebSocket upgrades must be proxied too.
          { target: apiTarget, changeOrigin: true, ...(prefix === '/hubs' ? { ws: true } : {}) },
        ]),
      ),
    },
  }
})
