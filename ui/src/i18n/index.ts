import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { applyDocumentLocale, detectInitialLocale, persistLocale } from "./locale-preference";

// WC-82: resolve the initial UI locale from the user's stored preference, then
// the browser language, then English — instead of hard-locking to English.
const initialLocale = detectInitialLocale(supportedLocales, DEFAULT_LOCALE);

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});
// init is synchronous (initAsync: false), so the document reflects the locale
// immediately on first import.
applyDocumentLocale(initialLocale);

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/**
 * Change the UI language at runtime: switch i18next (re-renders all
 * useTranslation consumers), persist the choice, and reflect it on <html
 * lang>/dir. No-op for unsupported codes.
 */
export async function setLocale(code: string): Promise<void> {
  if (!supportedLocales.includes(code)) return;
  await i18n.changeLanguage(code);
  persistLocale(code);
  applyDocumentLocale(code);
}

export function getCurrentLocale(): string {
  return i18n.language || DEFAULT_LOCALE;
}

export const useTranslation = useReactI18nextTranslation;
export { i18n, DEFAULT_LOCALE, supportedLocales };
