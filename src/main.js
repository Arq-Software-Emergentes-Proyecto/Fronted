import { createApp, watch } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import App from '@/shared/presentation/App.vue'
import i18n from '@/shared/infrastructure/i18n'
import router from '@/shared/presentation/router'
import '@/shared/presentation/assets/main.css'
import 'primeicons/primeicons.css'
import { syncDocumentLocale } from '@/shared/application/syncDocumentLocale.js'
import { startFirebaseAnalytics } from '@/iam/infrastructure/firebaseApp.js'

const app = createApp(App)

app.use(i18n)
app.use(router)
app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
})
app.use(ToastService)

app.mount('#app')
startFirebaseAnalytics()

watch(
  () => i18n.global.locale.value,
  (loc) => {
    syncDocumentLocale(loc)
  },
  { immediate: true },
)
