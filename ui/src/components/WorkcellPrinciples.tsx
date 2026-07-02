import { Compass, Workflow, Users, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

// WC-80 (reality-check #4): Workcell's operating model, stated plainly in the
// UI so the board can see directly what the product does — not buried in agent
// instructions. This mirrors what the Orchestrator agent is seeded with
// server-side (onboarding-assets/orchestrator/AGENTS.md): the board owns
// direction and approvals; the team manages each project in detail; the design
// system is the source of truth that work is built and verified against; and
// nothing is Done without proof — finished work compounds into team learning.
export const WORKCELL_PRINCIPLES: ReadonlyArray<{
  icon: LucideIcon;
  titleKey: string;
  title: string;
  bodyKey: string;
  body: string;
}> = [
  {
    icon: Compass,
    titleKey: "workcellPrinciples.direction.title",
    title: "You set the direction",
    bodyKey: "workcellPrinciples.direction.body",
    body: "The board — you — owns direction, approvals, and policy. Your team of agents never decides what matters.",
  },
  {
    icon: Workflow,
    titleKey: "workcellPrinciples.projects.title",
    title: "Projects, managed in detail",
    bodyKey: "workcellPrinciples.projects.body",
    body: "The team runs on projects, not departments. Each one is planned, tracked, and managed in detail from start to finish.",
  },
  {
    icon: Users,
    titleKey: "workcellPrinciples.designTruth.title",
    title: "Design is the source of truth",
    bodyKey: "workcellPrinciples.designTruth.body",
    body: "Each project's design system anchors the plan. Designers propose, you approve, coders build to the approved design, and QA verifies against it.",
  },
  {
    icon: ShieldCheck,
    titleKey: "workcellPrinciples.proof.title",
    title: "Nothing is Done without proof",
    bodyKey: "workcellPrinciples.proof.body",
    body: "Every issue moves plan → work → proof. Results are shown, not asserted — and finished work compounds into team learning.",
  },
];

const DEFAULT_HEADING = "How Workcell works";

export function WorkcellPrinciples({
  className,
  variant = "card",
  heading,
}: {
  className?: string;
  variant?: "card" | "bare";
  heading?: string | null;
}) {
  const { t } = useTranslation();
  const resolvedHeading =
    heading === undefined
      ? t("workcellPrinciples.heading", { defaultValue: DEFAULT_HEADING })
      : heading;
  return (
    <section
      className={cn(
        variant === "card" && "rounded-xl border border-border bg-card/40 p-4",
        className,
      )}
      data-testid="workcell-principles"
    >
      {resolvedHeading ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {resolvedHeading}
        </p>
      ) : null}
      <ul className={cn("grid gap-3 sm:grid-cols-2", resolvedHeading && "mt-3")}>
        {WORKCELL_PRINCIPLES.map((principle) => {
          const Icon = principle.icon;
          return (
            <li key={principle.titleKey} className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0 rounded-md bg-muted/60 p-1.5 text-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">
                  {t(principle.titleKey, { defaultValue: principle.title })}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {t(principle.bodyKey, { defaultValue: principle.body })}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
