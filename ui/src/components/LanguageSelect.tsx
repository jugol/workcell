import { Languages } from "lucide-react";
import { useTranslation, setLocale, supportedLocales } from "@/i18n";
import { localeNativeName } from "@/i18n/locale-preference";
import { cn } from "@/lib/utils";

// WC-82: runtime UI language picker. Lists every supported locale by its
// endonym (Intl.DisplayNames) and switches i18next on change, which re-renders
// every useTranslation consumer and persists the choice. Mounted in the account
// menu next to the theme toggle. Options are computed once at module load.
const LOCALE_OPTIONS = [...supportedLocales]
  .map((code) => ({ code, name: localeNativeName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const current = supportedLocales.includes(i18n.language) ? i18n.language : "en";
  const label = t("accountMenu.language.label", { defaultValue: "Language" });

  return (
    <div className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left", className)}>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Languages className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {t("accountMenu.language.description", {
            defaultValue: "Choose your interface language.",
          })}
        </span>
        <select
          aria-label={label}
          value={current}
          onChange={(event) => {
            void setLocale(event.target.value);
          }}
          className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
        >
          {LOCALE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
