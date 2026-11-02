/** @typedef {'en' | 'es'} SupportedLocaleCode */

/** @readonly */
export const SUPPORTED_LOCALE_CODES = /** @type {const} */ (['en', 'es'])

/**
 * BCP 47 tag for the document root (`<html lang>`).
 * @param {SupportedLocaleCode} locale
 */
export function toHtmlLang(locale) {
  return locale === 'es' ? 'es-419' : 'en'
}

/**
 * @param {string} code
 * @returns {code is SupportedLocaleCode}
 */
export function isSupportedLocale(code) {
  return SUPPORTED_LOCALE_CODES.includes(/** @type {SupportedLocaleCode} */ (code))
}
