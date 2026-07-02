import type { BillingType } from "@workcell/shared";

// WC-57 (P2 §3 real-LLM groundwork): shared cost mapping.
//
// Extracted verbatim from heartbeat.ts so the pair-turn invoker (WC-58) and
// the heartbeat run ledger compute billed cost IDENTICALLY. The Phase-2
// design map flagged "divergent pricing" as a real risk if the pair invoker
// re-derived cents on its own; centralizing the formula here removes it.
//
// Pure functions only — no DB, no side effects — so both call sites (and
// any future adapter-backed invocation) stay consistent and unit-testable.

// Normalize an arbitrary adapter/ledger billing-type string to the canonical
// ledger BillingType union. Unknown / empty values fall back to "unknown".
//
// PARITY (WC-68): this matches the original heartbeat normalizer EXACTLY — it
// switched on the *untrimmed* string (via readNonEmptyString, which returned
// the raw value when non-blank). So a whitespace-padded token like "  api  "
// is NOT a recognized billing type and falls through to "unknown" (rather
// than being trimmed and matched). Preserving this is important: only
// "subscription_included" is zeroed by normalizeBilledCostCents, so silently
// matching "  subscription  " would flip a billed turn to free.
export function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = typeof value === "string" && value.trim().length > 0 ? value : "";
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

// Convert a USD cost to integer cents for the ledger. Subscription-included
// turns are free at the margin (already paid via the plan), so they bill 0.
// Non-finite / negative costs clamp to 0.
export function normalizeBilledCostCents(
  costUsd: number | null | undefined,
  billingType: BillingType,
): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

// Convenience for callers holding a raw adapter result: derive billed cents
// directly from a costUsd + a raw (un-normalized) billingType string. Used by
// the pair-turn invoker (WC-58), which gets { costUsd, billingType } straight
// off AdapterExecutionResult.
export function billedCostCentsFromAdapterResult(input: {
  costUsd?: number | null;
  billingType?: unknown;
}): number {
  return normalizeBilledCostCents(
    input.costUsd,
    normalizeLedgerBillingType(input.billingType),
  );
}
