import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";
import type { PairBindingForAgent } from "../lib/pair-bindings";

// WC-189 (checkpoint #5): the agent-side pair marker. Rendered on any agent
// that is currently bound in an active PairGroup, in BOTH the agent list and
// the org chart, so a pair binding is visibly confirmable from the agent side
// (not just on the issue). Violet palette matches the existing pair UI (WC-34
// kanban pair chip + PairRoundTimeline) so the relationship reads as "pair"
// at a glance.
//
// Each binding links to the counterpart agent; the title names the counterpart
// + the issue the pair is collaborating on ("⇄ 페어: <other> · <REF>"). When
// the counterpart agent id is known the badge is a link to that agent;
// otherwise it degrades to a static pill (the binding still proves the agent
// is paired).
//
// Additive: agents with no active binding render nothing here.

const VIOLET_PILL =
  "border-violet-500/45 bg-violet-50/60 text-violet-700 dark:border-violet-300/35 dark:bg-violet-400/10 dark:text-violet-300";

function PairBadgeItem({ binding, compact }: { binding: PairBindingForAgent; compact?: boolean }) {
  const { t } = useTranslation();
  const issueRef = binding.issueIdentifier ?? binding.issueTitle;
  const counterpartName =
    binding.counterpartAgentName ??
    t("pairBadge.unknownCounterpart", { defaultValue: "unassigned" });
  // Compact (org chart node) shows just "⇄ 페어"; full (list / detail) names
  // the counterpart. Both expose the full context via the title attribute.
  const label = compact
    ? t("pairBadge.labelShort", { defaultValue: "⇄ pair" })
    : t("pairBadge.label", { defaultValue: "⇄ pair: {{name}}", name: counterpartName });
  const title = t("pairBadge.title", {
    defaultValue: "Paired with {{name}} on {{ref}}",
    name: counterpartName,
    ref: issueRef,
  });

  const className = cn(
    "px-1.5 py-0 text-[10px] font-medium leading-tight no-underline",
    VIOLET_PILL,
  );

  if (binding.counterpartAgentId) {
    return (
      <Badge
        asChild
        variant="outline"
        className={cn(className, "transition-colors hover:brightness-110")}
        title={title}
      >
        <Link
          to={`/agents/${binding.counterpartAgentId}`}
          onClick={(e) => e.stopPropagation()}
          aria-label={title}
          data-testid="pair-badge"
        >
          {label}
        </Link>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={className}
      title={title}
      aria-label={title}
      data-testid="pair-badge"
    >
      {label}
    </Badge>
  );
}

/**
 * Render the pair marker(s) for one agent. An agent paired on multiple issues
 * shows one badge per binding. Returns null when there are no bindings, so the
 * caller can drop it inline without conditionals.
 */
export function PairBadge({
  bindings,
  compact,
  className,
}: {
  bindings: PairBindingForAgent[] | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!bindings || bindings.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)} data-testid="pair-badge-group">
      {bindings.map((binding) => (
        <PairBadgeItem key={binding.pairGroupId} binding={binding} compact={compact} />
      ))}
    </span>
  );
}
