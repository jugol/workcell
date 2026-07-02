import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  CheckCircle2,
  AlertOctagon,
  Loader2,
  PlayCircle,
  PencilLine,
  Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import { cn, formatCents } from "../lib/utils";
import { ApiError } from "../api/client";
import {
  agentsApi,
  type DeliberationRun,
  type DeliberationTurn,
} from "../api/agents";
import { MarkdownBody } from "./MarkdownBody";

// WC-210 (deliberation mode, slice 4 — finding B): the "내부 합의 실행
// (dual-brain)" panel. Surfaced on the agent detail page when the agent has
// `deliberation.enabled`. It lets a user kick off a LIVE dual-brain run
// (POST /agents/:id/deliberate → 202 { runId, status:"running" }), then polls
// GET /agents/:id/deliberations/:runId while the run is in flight and renders
// the streamed turns as a TIMELINE (mirroring PairRoundTimeline's visual
// language — brain badges, action chips, per-turn cost, run status).
//
// FLAG-GATED: the POST is gated by WORKCELL_PAIR_LIVE_LLM on the server; when
// off it returns 503 { code: "deliberation_live_disabled" } and we surface a
// clear "라이브 LLM 비활성" message instead of erroring out.
//
// Past runs (GET /agents/:id/deliberations) are listed so a user can click one
// to re-open its timeline without starting a new (paid) run.

// Is this error the server's "live LLM disabled" 503 (vs a real failure)?
function isLiveDisabled(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    (error.body as { code?: string } | null)?.code === "deliberation_live_disabled"
  );
}

// Brain A / B badge — A=indigo, B=violet, mirroring the pair palette so the two
// minds read as a related-but-distinct pair at a glance.
function BrainBadge({ brain }: { brain: "A" | "B" | null }) {
  const { t } = useTranslation();
  const label =
    brain === "A"
      ? t("deliberation.brain.a", { defaultValue: "Brain A" })
      : brain === "B"
        ? t("deliberation.brain.b", { defaultValue: "Brain B" })
        : t("deliberation.brain.unknown", { defaultValue: "Brain" });
  return (
    <Badge
      variant="outline"
      data-testid="deliberation-brain-badge"
      data-brain={brain ?? "?"}
      className={cn(
        "px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide",
        brain === "A"
          ? "border-indigo-500/45 bg-indigo-50/60 text-indigo-700 dark:border-indigo-300/35 dark:bg-indigo-400/10 dark:text-indigo-300"
          : "border-violet-500/45 bg-violet-50/60 text-violet-700 dark:border-violet-300/35 dark:bg-violet-400/10 dark:text-violet-300",
      )}
    >
      {label}
    </Badge>
  );
}

// Action chip. Fusion: generate = neutral (a parallel candidate), synthesize =
// green (the merged final). Legacy pre-fusion runs (propose/accept/revise) are
// still rendered for old transcripts.
const GREEN_BADGE =
  "border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300";
const NEUTRAL_BADGE = "border-border bg-muted/40 text-muted-foreground";
const AMBER_BADGE =
  "border-amber-500/45 bg-amber-50/60 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300";

function ActionBadge({ action }: { action: DeliberationTurn["action"] }) {
  const { t } = useTranslation();
  const { label, Icon, className } =
    action === "synthesize"
      ? { label: t("deliberation.action.synthesize", { defaultValue: "Synthesize" }), Icon: CheckCircle2, className: GREEN_BADGE }
      : action === "generate"
        ? { label: t("deliberation.action.generate", { defaultValue: "Generate" }), Icon: Lightbulb, className: NEUTRAL_BADGE }
        : action === "accept"
          ? { label: t("deliberation.action.accept", { defaultValue: "Review & accept" }), Icon: CheckCircle2, className: GREEN_BADGE }
          : action === "revise"
            ? { label: t("deliberation.action.revise", { defaultValue: "Revise" }), Icon: PencilLine, className: AMBER_BADGE }
            : { label: t("deliberation.action.propose", { defaultValue: "Propose" }), Icon: Lightbulb, className: NEUTRAL_BADGE };
  return (
    <Badge
      variant="outline"
      data-testid="deliberation-action-badge"
      data-action={action ?? "?"}
      className={cn("px-1.5 py-0 text-[10px] font-medium", className)}
    >
      <Icon className="mr-1 h-3 w-3" />
      {label}
    </Badge>
  );
}

// Run-level status pill (running spinner / completed / failed).
function RunStatusBadge({ status }: { status: DeliberationRun["status"] }) {
  const { t } = useTranslation();
  if (status === "completed") {
    return (
      <Badge
        variant="outline"
        data-testid="deliberation-run-status"
        data-status="completed"
        className="px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        {t("deliberation.status.completed", { defaultValue: "Completed" })}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge
        variant="outline"
        data-testid="deliberation-run-status"
        data-status="failed"
        className="px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide border-destructive/45 bg-destructive/10 text-destructive"
      >
        <AlertOctagon className="mr-1 h-3 w-3" />
        {t("deliberation.status.failed", { defaultValue: "Failed" })}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      data-testid="deliberation-run-status"
      data-status="running"
      className="px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide border-cyan-500/45 bg-cyan-50/60 text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300"
    >
      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      {t("deliberation.status.running", { defaultValue: "Running" })}
    </Badge>
  );
}

// One turn row in the timeline: brain + action + content + (optional) feedback +
// per-turn cost. Mirrors the PairRoundTimeline turn layout.
function TurnRow({ turn }: { turn: DeliberationTurn }) {
  const { t } = useTranslation();
  return (
    <li className="text-xs" data-testid="deliberation-turn">
      <div className="flex flex-wrap items-center gap-2">
        <BrainBadge brain={turn.brain} />
        <ActionBadge action={turn.action} />
        {turn.costCents && turn.costCents > 0 ? (
          <span className="font-mono text-[10px] text-muted-foreground" data-testid="deliberation-turn-cost">
            {formatCents(turn.costCents)}
          </span>
        ) : null}
      </div>
      {turn.content ? (
        <div className="mt-1" data-testid="deliberation-turn-content">
          <MarkdownBody className="text-xs text-muted-foreground" linkIssueReferences={false}>
            {turn.content}
          </MarkdownBody>
        </div>
      ) : null}
      {turn.feedback ? (
        <p
          className="mt-1 border-l-2 border-amber-400/50 pl-2 text-[11px] italic text-muted-foreground"
          data-testid="deliberation-turn-feedback"
        >
          {t("deliberation.feedbackLabel", { defaultValue: "Feedback" })}: {turn.feedback}
        </p>
      ) : null}
    </li>
  );
}

// The run summary header + the turn timeline for ONE run.
function RunTimeline({ detail }: { detail: { run: DeliberationRun; turns: DeliberationTurn[] } }) {
  const { t } = useTranslation();
  const { run, turns } = detail;
  const totalCost = run.totalCostCents ?? turns.reduce((sum, turn) => sum + (turn.costCents ?? 0), 0);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="deliberation-run-timeline">
      <header className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        {run.acceptedBy ? (
          <span className="text-xs text-muted-foreground" data-testid="deliberation-accepted-by">
            {t("deliberation.synthesizedBy", {
              defaultValue: "Synthesized by {{brain}}",
              brain:
                run.acceptedBy === "A"
                  ? t("deliberation.brain.a", { defaultValue: "Brain A" })
                  : t("deliberation.brain.b", { defaultValue: "Brain B" }),
            })}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground" data-testid="deliberation-rounds">
          {t("deliberation.roundsSummary", { defaultValue: "{{rounds}} rounds", rounds: run.rounds ?? 0 })}
        </span>
        {totalCost > 0 ? (
          <span className="font-mono text-xs text-foreground" data-testid="deliberation-total-cost">
            {formatCents(totalCost)}
          </span>
        ) : null}
      </header>

      {run.task ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t("deliberation.taskLabel", { defaultValue: "Task" })}: </span>
          {run.task}
        </p>
      ) : null}

      {run.status === "failed" && run.error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="deliberation-run-error"
        >
          {run.error}
        </p>
      ) : null}

      {turns.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="deliberation-no-turns">
          {run.status === "running"
            ? t("deliberation.awaitingTurns", { defaultValue: "The brains are starting to deliberate…" })
            : t("deliberation.noTurns", { defaultValue: "No turns recorded." })}
        </p>
      ) : (
        <ol className="space-y-2" data-testid="deliberation-timeline">
          {turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
        </ol>
      )}

      {run.status === "completed" && run.finalOutput ? (
        <div
          className="rounded-md border border-emerald-500/30 bg-emerald-50/40 p-2 dark:bg-emerald-950/20"
          data-testid="deliberation-final-output"
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            {t("deliberation.synthesizedResult", { defaultValue: "Synthesized result" })}
          </div>
          <MarkdownBody className="text-xs" linkIssueReferences={false}>
            {run.finalOutput}
          </MarkdownBody>
        </div>
      ) : null}
    </section>
  );
}

export function DeliberationPanel({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [task, setTask] = useState("");
  const [maxRounds, setMaxRounds] = useState("");
  // The run currently being viewed (the just-started one, or one clicked from
  // the past-runs list). null until the user starts/selects a run.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Sticky "live disabled" notice — set when the POST returns the 503 so the
  // message persists even though the mutation error clears on the next attempt.
  const [liveDisabled, setLiveDisabled] = useState(false);

  const runsQuery = useQuery({
    queryKey: ["agent-deliberations", agentId, companyId ?? null],
    queryFn: () => agentsApi.listDeliberations(agentId, companyId),
  });
  const runs = runsQuery.data?.runs ?? [];

  const detailQuery = useQuery({
    queryKey: ["agent-deliberation", agentId, activeRunId, companyId ?? null],
    queryFn: () => agentsApi.getDeliberation(agentId, activeRunId!, companyId),
    enabled: Boolean(activeRunId),
    // Poll while the run is in flight; stop once it reaches a terminal state.
    refetchInterval: (query) =>
      query.state.data?.run.status === "running" ? 2000 : false,
  });

  const start = useMutation({
    mutationFn: () => {
      const trimmed = task.trim();
      const parsedRounds = maxRounds.trim() === "" ? undefined : Number.parseInt(maxRounds, 10);
      return agentsApi.startDeliberation(
        agentId,
        {
          task: trimmed,
          ...(parsedRounds && Number.isFinite(parsedRounds) ? { maxRoundsOverride: parsedRounds } : {}),
        },
        companyId,
      );
    },
    onMutate: () => {
      setLiveDisabled(false);
    },
    onSuccess: (res) => {
      setActiveRunId(res.runId);
      setTask("");
      setMaxRounds("");
      // Refresh the past-runs list so the new run appears at the top.
      void queryClient.invalidateQueries({ queryKey: ["agent-deliberations", agentId] });
    },
    onError: (error) => {
      if (isLiveDisabled(error)) setLiveDisabled(true);
    },
  });

  // A real (non-503) start error to surface inline.
  const startError =
    start.isError && !isLiveDisabled(start.error) ? start.error : null;

  const canSubmit = task.trim().length > 0 && !start.isPending;

  return (
    <section className="max-w-3xl space-y-4" data-testid="deliberation-panel">
      <header className="flex items-center gap-2">
        <Brain className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div>
          <h3 className="text-sm font-semibold">
            {t("deliberation.heading", { defaultValue: "Internal deliberation run (dual-brain)" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("deliberation.subheading", {
              defaultValue: "Two brains repeat propose → review → revise until they agree on a single conclusion.",
            })}
          </p>
        </div>
      </header>

      {liveDisabled ? (
        <div
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="deliberation-live-disabled"
        >
          {t("deliberation.liveDisabled", {
            defaultValue:
              "Live LLM is disabled (WORKCELL_PAIR_LIVE_LLM). Deliberation runs only work when live LLM is turned on.",
          })}
        </div>
      ) : null}

      {/* Run form */}
      <form
        className="space-y-2 rounded-md border border-border p-3"
        data-testid="deliberation-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) start.mutate();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="deliberation-task" className="text-xs text-muted-foreground">
            {t("deliberation.taskLabel", { defaultValue: "Task" })}
          </Label>
          <Textarea
            id="deliberation-task"
            data-testid="deliberation-task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder={t("deliberation.taskPlaceholder", {
              defaultValue: "Enter the task the two brains should agree on…",
            })}
            className="text-sm"
          />
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="deliberation-max-rounds" className="text-xs text-muted-foreground">
              {t("deliberation.maxRoundsLabel", { defaultValue: "Max rounds (optional)" })}
            </Label>
            <Input
              id="deliberation-max-rounds"
              data-testid="deliberation-max-rounds-input"
              type="number"
              min={1}
              max={8}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              placeholder={t("deliberation.maxRoundsPlaceholder", { defaultValue: "Default" })}
              className="h-8 w-28 text-sm"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            data-testid="deliberation-submit"
            disabled={!canSubmit}
            className="h-8"
          >
            {start.isPending ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                {t("deliberation.starting", { defaultValue: "Starting…" })}
              </>
            ) : (
              <>
                <PlayCircle className="mr-1 h-3.5 w-3.5" />
                {t("deliberation.run", { defaultValue: "Run deliberation" })}
              </>
            )}
          </Button>
        </div>
        {startError ? (
          <p className="text-xs text-destructive" data-testid="deliberation-start-error">
            {startError instanceof Error ? startError.message : String(startError)}
          </p>
        ) : null}
      </form>

      {/* Active run timeline */}
      {activeRunId ? (
        detailQuery.data ? (
          <RunTimeline detail={detailQuery.data} />
        ) : detailQuery.isError ? (
          <p className="text-xs text-destructive" data-testid="deliberation-detail-error">
            {t("deliberation.detailError", { defaultValue: "Failed to load the deliberation run." })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("deliberation.loadingRun", { defaultValue: "Loading the deliberation run…" })}
          </p>
        )
      ) : null}

      {/* Past runs */}
      {runs.length > 0 ? (
        <div className="space-y-1" data-testid="deliberation-past-runs">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("deliberation.pastRuns", { defaultValue: "Recent deliberation runs" })}
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  data-testid="deliberation-past-run"
                  data-run-id={run.id}
                  onClick={() => setActiveRunId(run.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/50",
                    run.id === activeRunId && "bg-accent/40",
                  )}
                >
                  <RunStatusBadge status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {run.task ?? t("deliberation.untitledRun", { defaultValue: "(no task)" })}
                  </span>
                  {run.totalCostCents && run.totalCostCents > 0 ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatCents(run.totalCostCents)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
