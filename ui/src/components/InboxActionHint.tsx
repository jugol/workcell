import { ArrowRight } from "lucide-react";
import type { IssueBlockedInboxAttention } from "@workcell/shared";
import { cn } from "../lib/utils";

interface InboxActionHintProps {
  attention: IssueBlockedInboxAttention;
  className?: string;
}

// The glanceable "what should I do here" directive for an inbox row. The server
// already computes a short imperative action label (e.g. "Choose disposition",
// "Decide approval", "Answer question") plus an explanatory detail — this surfaces
// the label as an accent pill (distinct from the amber/violet *reason* chip, which
// says *why* it stopped) with the detail as a hover tooltip. Reason = why; this = what.
export function InboxActionHint({ attention, className }: InboxActionHintProps) {
  const label = attention.action?.label;
  if (!label) return null;
  return (
    <span
      data-testid="inbox-action-hint"
      aria-label={`Action: ${label}`}
      title={attention.action.detail ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold leading-tight text-primary sm:text-[11px]",
        className,
      )}
    >
      <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
