import type { FinanceByBiller } from "@workcell/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { formatCents, providerDisplayName } from "@/lib/utils";

interface FinanceBillerCardProps {
  row: FinanceByBiller;
}

export function FinanceBillerCard({ row }: FinanceBillerCardProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{providerDisplayName(row.biller)}</CardTitle>
            <CardDescription className="mt-1 text-xs">
              {t("financeBillerCard.summary", {
                defaultValue: "{{events}} across {{kinds}}",
                events: row.eventCount === 1
                  ? t("financeBillerCard.eventCount_one", { defaultValue: "{{count}} event", count: row.eventCount })
                  : t("financeBillerCard.eventCount_other", { defaultValue: "{{count}} events", count: row.eventCount }),
                kinds: row.kindCount === 1
                  ? t("financeBillerCard.kindCount_one", { defaultValue: "{{count}} kind", count: row.kindCount })
                  : t("financeBillerCard.kindCount_other", { defaultValue: "{{count}} kinds", count: row.kindCount }),
              })}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{formatCents(row.netCents)}</div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{t("financeBillerCard.net", { defaultValue: "net" })}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t("financeBillerCard.debits", { defaultValue: "debits" })}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.debitCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t("financeBillerCard.credits", { defaultValue: "credits" })}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.creditCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t("financeBillerCard.estimated", { defaultValue: "estimated" })}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.estimatedDebitCents)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
