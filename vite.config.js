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
  '/importUploads',
  '/importFolders',
  '/residentExtraCharges',
  '/supportChats',
]

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:5001'
  if (env.MP_ACCESS_TOKEN) process.env.MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN
  if (env.MERCADOPAGO_ACCESS_TOKEN) {
    process.env.MERCADOPAGO_ACCESS_TOKEN = env.MERCADOPAGO_ACCESS_TOKEN
  }

  return {
    plugins: [vue(), previewMockApiPlugin(), mercadoPagoCheckoutPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      proxy: Object.fromEntries(
        API_ROUTE_PREFIXES.map((prefix) => [
          prefix,
          { target: apiTarget, changeOrigin: true },
        ]),
      ),
    },
  }
})
