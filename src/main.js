import { createApp, watch } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { definePreset } from '@primevue/themes'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import App from '@/shared/presentation/App.vue'
import i18n from '@/shared/infrastructure/i18n'
import router from '@/shared/presentation/router'
import '@/shared/presentation/assets/main.css'
import 'primeicons/primeicons.css'
import '@/shared/presentation/assets/bf-feedback.css'
import '@/shared/presentation/assets/bf-segmented.css'
import '@/shared/presentation/assets/bf-success.css'
import { vBfSeg } from '@/shared/presentation/directives/segmented.js'
import { syncDocumentLocale } from '@/shared/application/syncDocumentLocale.js'
import { storeLocale } from '@/shared/infrastructure/i18n/localePreference.js'
import { startFirebaseAnalytics } from '@/iam/infrastructure/firebaseApp.js'
import { hydratePreviewMockFromBrowser } from '@/shared/infrastructure/mock/hydratePreviewMock.js'

// Aura trae esmeralda como color principal (bordes de foco verdes en inputs, selects y fechas de los
// modales). Se reemplaza por el azul marino de la marca (#1e3a8a).
const BuildingFexPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#eef2fb',
      100: '#dbe4f7',
      200: '#b8c8ee',
      300: '#8ea6e0',
      400: '#5b7bc9',
      500: '#1e3a8a',
      600: '#1b347c',
      700: '#172554',
      800: '#142049',
      900: '#101a3b',
      950: '#0b122a',
    },
  },
})

const app = createApp(App)

app.use(i18n)
app.use(router)
app.use(PrimeVue, {
  theme: {
    preset: BuildingFexPreset,
  },
  // Toasts must never steal focus from what the user is doing (PrimeVue autofocuses the close button).
  pt: {
    toast: { closeButton: { autofocus: false } },
  },
})
app.use(ToastService)
app.use(ConfirmationService)
app.directive('bf-seg', vBfSeg)

hydratePreviewMockFromBrowser().finally(() => {
  app.mount('#app')
  startFirebaseAnalytics()
})

watch(
  () => i18n.global.locale.value,
  (loc, previous) => {
    syncDocumentLocale(loc)
    // Persist only explicit changes, so a browser-derived default can still follow the browser.
    if (previous !== undefined) storeLocale(loc)
  },
  { immediate: true },
)
