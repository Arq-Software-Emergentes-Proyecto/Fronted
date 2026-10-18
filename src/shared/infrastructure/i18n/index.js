import { createI18n } from 'vue-i18n'
import es from './locales/es.json'
import en from './locales/en.json'
import { DEFAULT_LOCALE, resolveInitialLocale } from './localePreference.js'

export default createI18n({
  legacy: false,
  locale: resolveInitialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: { es, en },
  globalInjection: true,
})
