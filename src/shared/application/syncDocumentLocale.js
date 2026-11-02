import { toHtmlLang } from '../domain/locale.js'

/**
 * Application use case: keep `<html lang>` aligned with the active UI locale.
 * @param {import('../domain/locale.js').SupportedLocaleCode} localeCode
 */
export function syncDocumentLocale(localeCode) {
  document.documentElement.setAttribute('lang', toHtmlLang(localeCode))
}
