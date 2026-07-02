import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, CheckCircle2, AlertOctagon, Loader2 } from "lucide-react";
import type { PairGroup } from "@workcell/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { pairGroupsApi } from "../api/pair-groups";
import { ApiError } from "../api/client";
import { LiveRunTail } from "./LiveRunTail";
import { useTranslation } from "@/i18n";

// Local type guard for the in-flight run id the GET /issues/:id/pair-group
// route decorates onto the group. Optional-chained so the UI stays safe if
// the shared PairGroup type hasn't picked the field up yet.
type PairGroupWithInFlightRun = PairGroup & { runInFlightRunId?: string | null };

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
    // Poll while the group is active so server-side in-flight state
    // (runInFlight — auto-run ticker or another tab's manual run) appears and
    // clears without a manual refresh.
    refetchInterval: (query) => (query.state.data?.group?.status === "active" ? 5000 : false),
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
    onError: (err) => {
      // 409 pair_round_in_flight just means another driver (auto-run ticker
      // or another tab) beat us to the round — not a user-facing error.
      // Quietly refetch the group so runInFlight reflects reality.
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        (err.body as { code?: string } | null)?.code === "pair_round_in_flight"
      ) {
        queryClient.invalidateQueries({ queryKey: ["pair-group", issueId] });
      }
    },
  });

  // True when ANY driver is advancing a round: this tab's own mutation, the
  // server auto-run ticker, or a manual run from another tab (both surfaced
  // via group.runInFlight from the registry-decorated GET).
  const roundInFlight = runRound.isPending || group?.runInFlight === true;
  // The heartbeat run currently executing the round (server-decorated). Lets
  // us tail its real output below instead of only showing a pulsing notice.
  const runInFlightRunId =
    (group as PairGroupWithInFlightRun | null)?.runInFlightRunId ?? null;

  // Pair groups auto-run by default (server scheduler advances rounds); the
  // user must explicitly switch a group to manual mode. Only autoRunEnabled is
  // sent — the PATCH route accepts it without a status change.
  const setAutoRun = useMutation({
    mutationFn: (next: boolean) =>
      group
        ? pairGroupsApi.patch(group.id, { autoRunEnabled: next })
        : Promise.resolve({ group: null as never }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pair-group", issueId] });
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

  // Dual-brain group: ONE agent self-reviewing across two brains — the seats
  // are "work brain" / "review brain", not two agent names.
  const dualBrain = group.kind === "dual_brain";
  const laneLabel = (lane: string | null | undefined, actorAgentId: string | null) => {
    if (!dualBrain) return nameOf(actorAgentId);
    return lane === "counterpart"
      ? t("pairTimeline.dualBrain.reviewBrain", { defaultValue: "Review brain" })
      : t("pairTimeline.dualBrain.workBrain", { defaultValue: "Work brain" });
  };

  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="pair-round-timeline">
      <header className="flex flex-wrap items-center gap-3">
        <Sparkles className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            {dualBrain
              ? t("pairTimeline.dualBrain.heading", { defaultValue: "Dual-brain self-review" })
              : t("pairTimeline.heading", { defaultValue: "Pair collaboration" })}
          </h3>
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
            {dualBrain ? (
              <>
                <span className="font-medium text-foreground">{nameOf(group.ownerAgentId)}</span>
                {" · "}
                <span>{t("pairTimeline.dualBrain.workBrain", { defaultValue: "Work brain" })}</span>
                {" ⇄ "}
                <span>{t("pairTimeline.dualBrain.reviewBrain", { defaultValue: "Review brain" })}</span>
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{nameOf(group.ownerAgentId)}</span>
                {" ↔ "}
                <span className="font-medium text-foreground">{nameOf(group.counterpartAgentId)}</span>
              </>
            )}
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
              disabled={roundInFlight}
              onClick={() => runRound.mutate(1)}
            >
              {roundInFlight ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {t("pairTimeline.roundInFlight", { defaultValue: "Round in progress…" })}
                </>
              ) : (
                t("pairTimeline.runRound", { defaultValue: "Run round" })
              )}
            </Button>
            {(group.maxRounds ?? 10) - group.currentRound > 1 ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={roundInFlight}
                title={t("pairTimeline.runToConvergenceHint", { defaultValue: "Run the remaining rounds until the pair converges, aborts, or hits the round limit." })}
                onClick={() => runRound.mutate(Math.max(1, (group.maxRounds ?? 10) - group.currentRound))}
              >
                {roundInFlight ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    {t("pairTimeline.roundInFlight", { defaultValue: "Round in progress…" })}
                  </>
                ) : (
                  t("pairTimeline.runToConvergence", { defaultValue: "Run to convergence" })
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {group.status === "active" ? (
        <div
          className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-2.5 py-2"
          data-testid="pair-auto-run-toggle"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs font-medium">
              {t("pairTimeline.autoRun.label", { defaultValue: "Auto-run" })}
            </div>
            <p className="text-xs text-muted-foreground">
              {group.autoRunEnabled
                ? t("pairTimeline.autoRun.onHint", { defaultValue: "Rounds advance automatically." })
                : t("pairTimeline.autoRun.offHint", { defaultValue: "Manual mode — advance rounds with the buttons." })}
            </p>
          </div>
          <ToggleSwitch
            checked={group.autoRunEnabled}
            onCheckedChange={(next) => setAutoRun.mutate(next)}
            disabled={setAutoRun.isPending}
            aria-label={t("pairTimeline.autoRun.label", { defaultValue: "Auto-run" })}
          />
        </div>
      ) : null}

      {roundInFlight ? (
        <p
          className="flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="pair-round-in-flight-notice"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
          </span>
          {group.runInFlightSource === "auto_run"
            ? t("pairTimeline.autoRoundInFlight", { defaultValue: "Auto-run is advancing this round…" })
            : t("pairTimeline.manualRoundInFlight", { defaultValue: "A round is in progress…" })}
        </p>
      ) : null}

      {/* Live tail of the in-flight round's run output, so the user can see
          the model actually working instead of guessing whether it hung.
          Disappears with the in-flight state once the round lands. */}
      {roundInFlight && runInFlightRunId ? (
        <LiveRunTail runId={runInFlightRunId} />
      ) : null}

      {rounds.length === 0 ? (
        !roundInFlight ? (
          <p className="text-xs text-muted-foreground">{t("pairTimeline.noTurns", { defaultValue: "No turns yet. Press \"Run round\" to drive the first round." })}</p>
        ) : null
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
                      <span className="font-medium">{laneLabel(turn.lane, turn.actorAgentId)}</span>
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
