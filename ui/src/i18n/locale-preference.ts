// WC-82: per-user UI language preference (browser-local). Deliberately separate
// from the per-company plan-report language (WC-81): a user may prefer a Korean
// interface while running an English-reporting company, or vice versa. Both
// default from the browser language but are independent settings.

export const UI_LOCALE_STORAGE_KEY = "workcell.ui-locale";

// Right-to-left scripts among our locales — layout direction must flip.
const RTL_BASE_LOCALES = new Set(["ar", "fa", "he", "ur"]);

function baseOf(code: string): string {
  return code.split("-")[0]?.toLowerCase() ?? "";
}

export function isRtlLocale(code: string): boolean {
  return RTL_BASE_LOCALES.has(baseOf(code));
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Access can throw in sandboxed iframes / disabled-storage contexts.
    return null;
  }
}

export function readStoredLocale(): string | null {
  return safeLocalStorage()?.getItem(UI_LOCALE_STORAGE_KEY) ?? null;
}

export function persistLocale(code: string): void {
  try {
    safeLocalStorage()?.setItem(UI_LOCALE_STORAGE_KEY, code);
  } catch {
    // Ignore quota / security errors — preference simply won't persist.
  }
}

/** First supported match for the browser's languages: exact code, then base. */
export function resolveBrowserLocale(supported: readonly string[]): string | null {
  if (typeof navigator === "undefined") return null;
  const byLower = new Map(supported.map((code) => [code.toLowerCase(), code]));
  const candidates = (
    navigator.languages?.length ? navigator.languages : [navigator.language]
  ).filter(Boolean);
  for (const raw of candidates) {
    const exact = byLower.get(raw.toLowerCase());
    if (exact) return exact;
  }
  for (const raw of candidates) {
    const base = baseOf(raw);
    const match = byLower.get(base) ?? supported.find((code) => baseOf(code) === base);
    if (match) return match;
  }
  return null;
}

/** Stored preference > browser language > fallback, constrained to `supported`. */
export function detectInitialLocale(supported: readonly string[], fallback = "en"): string {
  const stored = readStoredLocale();
  if (stored && supported.includes(stored)) return stored;
  return resolveBrowserLocale(supported) ?? fallback;
}

/** Reflect the active locale on <html lang> + dir (a11y + RTL layout). */
export function applyDocumentLocale(code: string): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.lang = code;
  el.dir = isRtlLocale(code) ? "rtl" : "ltr";
}

/** Endonym for a locale code (e.g. "ko" → "한국어") via Intl; code as fallback. */
export function localeNativeName(code: string): string {
  try {
    const display = new Intl.DisplayNames([code], { type: "language" });
    const name = display.of(code);
    if (name && name !== code) {
      return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
    }
  } catch {
    // Intl.DisplayNames unavailable or code unrecognised — fall through.
  }
  return code;
}
