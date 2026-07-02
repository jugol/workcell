// WC-81 (reality-check #6): the language the Orchestrator/planner writes plan
// reports and issue drafts in. Stored per-company (companies.plan_report_language)
// and asked during onboarding. We deliberately offer a curated, common subset
// rather than the full 40+ UI locales — these are languages an LLM drafts
// fluently. Codes line up with the UI i18n locale codes so the two can converge
// later. Unknown-but-non-empty codes still flow through (label falls back to the
// raw code) so this never hard-blocks an unusual choice.

export interface PlanReportLanguageOption {
  /** Locale code, aligned with the UI i18n locales (e.g. "ko", "pt-BR"). */
  code: string;
  /** English name, used when instructing the model ("Write ... in Korean."). */
  label: string;
  /** Endonym shown in the picker so a native speaker recognises it. */
  nativeLabel: string;
}

export const DEFAULT_PLAN_REPORT_LANGUAGE = "en";

export const PLAN_REPORT_LANGUAGES: readonly PlanReportLanguageOption[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "zh-CN", label: "Chinese (Simplified)", nativeLabel: "简体中文" },
  { code: "zh-TW", label: "Chinese (Traditional)", nativeLabel: "繁體中文" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "pt-BR", label: "Portuguese (Brazil)", nativeLabel: "Português (Brasil)" },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
];

export const PLAN_REPORT_LANGUAGE_CODES: readonly string[] = PLAN_REPORT_LANGUAGES.map(
  (entry) => entry.code,
);

/** True when the code is unset or English (i.e. no translation instruction needed). */
export function isDefaultPlanReportLanguage(code?: string | null): boolean {
  return !code || code === DEFAULT_PLAN_REPORT_LANGUAGE;
}

/**
 * English label for a code, used to instruct the model. Returns null for the
 * default (English / unset) so callers can skip injecting any directive. An
 * unknown but non-empty code is returned as-is rather than dropped.
 */
export function resolvePlanReportLanguageLabel(code?: string | null): string | null {
  if (isDefaultPlanReportLanguage(code)) return null;
  const found = PLAN_REPORT_LANGUAGES.find((entry) => entry.code === code);
  return found ? found.label : (code as string);
}

/** Normalise an incoming code to a stored value, falling back to the default. */
export function normalizePlanReportLanguage(code?: string | null): string {
  const trimmed = typeof code === "string" ? code.trim() : "";
  return trimmed || DEFAULT_PLAN_REPORT_LANGUAGE;
}
