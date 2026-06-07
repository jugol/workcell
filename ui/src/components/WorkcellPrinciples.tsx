import { Compass, Workflow, Users, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// WC-80 (reality-check #4): Workcell's operating model, stated plainly in the
// UI so the board can see directly what the product does — not buried in agent
// instructions. This mirrors what the Orchestrator agent is seeded with
// server-side (onboarding-assets/orchestrator/AGENTS.md): the board owns
// direction and approvals; the Orchestrator turns direction into issues and
// runs the work like a company; agents are staffed by function; and nothing is
// Done without proof.
export const WORKCELL_PRINCIPLES: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  body: string;
}> = [
  {
    icon: Compass,
    title: "You set the direction",
    body: "The board — you — owns direction, approvals, and policy. Agents never decide what matters.",
  },
  {
    icon: Workflow,
    title: "The Orchestrator runs the work",
    body: "It turns your direction into issues and routes each one to the right agent, like running a company.",
  },
  {
    icon: Users,
    title: "Functional roles, not titles",
    body: "Agents are engineers, designers, QA, and researchers — staffed to the work, not a fixed org chart.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing is Done without proof",
    body: "Every issue moves plan → work → proof. Results are shown, not asserted.",
  },
];

export function WorkcellPrinciples({
  className,
  variant = "card",
  heading = "How Workcell works",
}: {
  className?: string;
  variant?: "card" | "bare";
  heading?: string | null;
}) {
  return (
    <section
      className={cn(
        variant === "card" && "rounded-xl border border-border bg-card/40 p-4",
        className,
      )}
      data-testid="workcell-principles"
    >
      {heading ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading}
        </p>
      ) : null}
      <ul className={cn("grid gap-3 sm:grid-cols-2", heading && "mt-3")}>
        {WORKCELL_PRINCIPLES.map((principle) => {
          const Icon = principle.icon;
          return (
            <li key={principle.title} className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0 rounded-md bg-muted/60 p-1.5 text-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">{principle.title}</p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {principle.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
