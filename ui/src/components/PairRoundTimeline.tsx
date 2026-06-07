import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, CheckCircle2, AlertOctagon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { pairGroupsApi } from "../api/pair-groups";
import { useTranslation } from "@/i18n";

// WC-126 (commercial-grade transparency): derive the pair's total spend and
// whether turns ran against a real model ("live") or the deterministic stub
// ("simulated"). A user must be able to tell whether a pair is doing real work
// or a dry run. Pure + exported so it can be unit-tested without the query
// harness. `live` wins over `simulated` if any turn was live.
export function derivePairTimelineMeta(
  turns: Array<{ costCents?: number; metadata?: Record<string, unknown> | null }>,
): { totalCostCents: number; liveMode: "live" | "simulated" | null } {
  const totalCostCents = turns.reduce((sum, turn) => sum + (turn.costCents ?? 0), 0);
  const liveMode = turns.some((turn) => (turn.metadata as { live?: boolean } | null)?.live === true)
    ? "live"
    : turns.some((turn) => (turn.metadata as { stub?: boolean } | null)?.stub === true)
      ? "simulated"
      : null;
  return { totalCostCents, liveMode };
}

// WC-46 (§9 #3 UI): Pair-round timeline. Mounted on IssueDetail when
// issue.workOwnerKind === "pair". Shows the current PairGroup state,
// the list of rounds + each round's turns, and a "Run round" button
// to drive the orchestrator. WC-146: the executor runs the real
// two-model exchange by default in normal runtime (deterministic stub
// under test / WORKCELL_PAIR_LIVE_LLM=0); the Live/Simulated badge
// reflects which actually ran.
export function PairRoundTimeline({
  issueId,
  agents = [],
}: {
  issueId: string;
  agents?: Array<{ id: string; name: string }>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const nameOf = (id?: string | null) =>
    (id && agents.find((a) => a.id === id)?.name) ||
    (id ? `${id.slice(0, 8)}…` : t("pairTimeline.unassigned", { defaultValue: "unassigned" }));

  const groupQuery = useQuery({
    queryKey: ["pair-group", issueId],
    queryFn: () => pairGroupsApi.getActiveForIssue(issueId),
  });
  const group = groupQuery.data?.group ?? null;

  const turnsQuery = useQuery({
    queryKey: ["pair-group", group?.id, "turns"],
    queryFn: () => (group ? pairGroupsApi.listTurns(group.id) : Promise.resolve({ turns: [] })),
    enabled: Boolean(group?.id),
    refetchInterval: group?.status === "active" ? 5000 : false,
  });
  const turns = turnsQuery.data?.turns ?? [];

  // Group turns by round number for display.
  const rounds = useMemo(() => {
    const byRound = new Map<number, typeof turns>();
    for (const turn of turns) {
      const arr = byRound.get(turn.round) ?? [];
      arr.push(turn);
      byRound.set(turn.round, arr);
    }
    return Array.from(byRound.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, items]) => ({ round, turns: items }));
  }, [turns]);

  // WC-126 (commercial-grade transparency): total spend + live/simulated mode.
  const { totalCostCents, liveMode } = derivePairTimelineMeta(turns);

  // WC-127: drive N rounds in one call. The server (runUntilStop) stops early on
  // convergence/abort and clamps to 10, so "run to convergence" passes the
  // group's remaining round budget and lets the stop policy end it.
  const runRound = useMutation({
    mutationFn: (rounds: number) =>
      group ? pairGroupsApi.runRound(group.id, rounds) : Promise.resolve({ results: [] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pair-group", issueId] });
      queryClient.invalidateQueries({ queryKey: ["pair-group", group?.id, "turns"] });
    },
  });

  if (groupQuery.isLoading) {
    return (
      <section className="rounded-md border border-border p-3 text-sm text-muted-foreground">
        {t("pairTimeline.loadingState", { defaultValue: "Loading pair group state…" })}
      </section>
    );
  }

  if (!group) {
    return (
      <section className="rounded-md border border-dashed border-border/60 p-3 text-sm text-muted-foreground">
        {t("pairTimeline.noActiveGroup", { defaultValue: "Pair mode is set on this issue but no active pair group exists yet." })}
      </section>
    );
  }

  const statusBadgeClass =
    group.status === "completed"
      ? "border-emerald-500/45 bg-emerald-50/60 text-emerald-700"
      : group.status === "aborted"
      ? "border-destructive/45 bg-destructive/10 text-destructive"
      : "border-violet-500/45 bg-violet-50/60 text-violet-700";

  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="pair-round-timeline">
      <header className="flex flex-wrap items-center gap-3">
        <Sparkles className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("pairTimeline.heading", { defaultValue: "Pair collaboration" })}</h3>
          <p className="text-xs text-muted-foreground">
            {t("pairTimeline.roundSummary", { defaultValue: "Round {{current}} of {{max}} · {{count}} turns recorded", current: group.currentRound + 1, max: group.maxRounds, count: turns.length })}
            {totalCostCents > 0 ? (
              <span className="ml-1 font-mono text-foreground">· ${(totalCostCents / 100).toFixed(2)}</span>
            ) : null}
            {group.stopReason ? (
              <span>
                {" · "}
                {t("pairTimeline.stoppedBecause", {
                  defaultValue: "stopped: {{reason}}",
                  reason: t(`pairTimeline.stopReason.${group.stopReason}`, {
                    defaultValue: group.stopReason.replace(/_/g, " "),
                  }),
                })}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{nameOf(group.ownerAgentId)}</span>
            {" ↔ "}
            <span className="font-medium text-foreground">{nameOf(group.counterpartAgentId)}</span>
          </p>
        </div>
        {liveMode ? (
          <Badge
            variant="outline"
            className={`ml-auto px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide ${
              liveMode === "live"
                ? "border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-border bg-muted/40 text-muted-foreground"
            }`}
            title={
              liveMode === "live"
                ? t("pairTimeline.mode.liveHint", { defaultValue: "Turns ran against a real model." })
                : t("pairTimeline.mode.simulatedHint", { defaultValue: "Turns ran against the deterministic stub — no model was called." })
            }
          >
            {liveMode === "live"
              ? t("pairTimeline.mode.live", { defaultValue: "Live" })
              : t("pairTimeline.mode.simulated", { defaultValue: "Simulated" })}
          </Badge>
        ) : null}
        <Badge variant="outline" className={`${liveMode ? "" : "ml-auto"} px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide ${statusBadgeClass}`}>
          {group.status === "active" ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" /> {t("pairTimeline.status.active", { defaultValue: "Active" })}
            </>
          ) : group.status === "completed" ? (
            <>
              <CheckCircle2 className="mr-1 h-3 w-3" /> {t("pairTimeline.status.completed", { defaultValue: "Completed" })}
            </>
          ) : (
            <>
              <AlertOctagon className="mr-1 h-3 w-3" /> {t("pairTimeline.status.aborted", { defaultValue: "Aborted" })}
            </>
          )}
        </Badge>
        {group.status === "active" ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={runRound.isPending}
              onClick={() => runRound.mutate(1)}
            >
              {runRound.isPending ? t("pairTimeline.running", { defaultValue: "Running…" }) : t("pairTimeline.runRound", { defaultValue: "Run round" })}
            </Button>
            {(group.maxRounds ?? 10) - group.currentRound > 1 ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={runRound.isPending}
                title={t("pairTimeline.runToConvergenceHint", { defaultValue: "Run the remaining rounds until the pair converges, aborts, or hits the round limit." })}
                onClick={() => runRound.mutate(Math.max(1, (group.maxRounds ?? 10) - group.currentRound))}
              >
                {t("pairTimeline.runToConvergence", { defaultValue: "Run to convergence" })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {rounds.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("pairTimeline.noTurns", { defaultValue: "No turns yet. Press \"Run round\" to drive the first round." })}</p>
      ) : (
        <ol className="space-y-2">
          {rounds.map(({ round, turns }) => (
            <li key={round} className="rounded-md border border-border/60 p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t("pairTimeline.round", { defaultValue: "Round {{number}}", number: round + 1 })}
              </div>
              <ul className="mt-1 space-y-1">
                {turns.map((turn) => (
                  <li key={turn.id} className="text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{nameOf(turn.actorAgentId)}</span>
                      <Badge
                        variant="outline"
                        className={`px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide ${
                          turn.outcome === "delivered"
                            ? "border-emerald-500/45 bg-emerald-50/60 text-emerald-700"
                            : turn.outcome === "no_change"
                            ? "border-border bg-muted/40 text-muted-foreground"
                            : "border-destructive/45 bg-destructive/10 text-destructive"
                        }`}
                      >
                        {turn.outcome}
                      </Badge>
                      {turn.costCents > 0 ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          ${(turn.costCents / 100).toFixed(2)}
                        </span>
                      ) : null}
                    </div>
                    {turn.summary ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {turn.summary}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
