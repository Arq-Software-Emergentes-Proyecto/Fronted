import { createApp, watch } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import App from '@/shared/presentation/App.vue'
import i18n from '@/shared/infrastructure/i18n'
import router from '@/shared/presentation/router'
import '@/shared/presentation/assets/main.css'
import 'primeicons/primeicons.css'
import '@/shared/presentation/assets/bf-feedback.css'
import '@/shared/presentation/assets/bf-segmented.css'
import { vBfSeg } from '@/shared/presentation/directives/segmented.js'
import { syncDocumentLocale } from '@/shared/application/syncDocumentLocale.js'
import { storeLocale } from '@/shared/infrastructure/i18n/localePreference.js'
import { startFirebaseAnalytics } from '@/iam/infrastructure/firebaseApp.js'
import { hydratePreviewMockFromBrowser } from '@/shared/infrastructure/mock/hydratePreviewMock.js'

const app = createApp(App)

app.use(i18n)
app.use(router)
app.use(PrimeVue, {
  theme: {
    preset: Aura,
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
