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
      ? t("deliberation.brain.a", { defaultValue: "두뇌 A" })
      : brain === "B"
        ? t("deliberation.brain.b", { defaultValue: "두뇌 B" })
        : t("deliberation.brain.unknown", { defaultValue: "두뇌" });
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

// Action chip — propose / accept / revise. Accept = green (terminal good),
// revise = amber (work continues), propose = neutral.
function ActionBadge({ action }: { action: DeliberationTurn["action"] }) {
  const { t } = useTranslation();
  const { label, Icon, className } =
    action === "accept"
      ? {
          label: t("deliberation.action.accept", { defaultValue: "검토·수락" }),
          Icon: CheckCircle2,
          className: "border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
        }
      : action === "revise"
        ? {
            label: t("deliberation.action.revise", { defaultValue: "수정" }),
            Icon: PencilLine,
            className: "border-amber-500/45 bg-amber-50/60 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
          }
        : {
            label: t("deliberation.action.propose", { defaultValue: "제안" }),
            Icon: Lightbulb,
            className: "border-border bg-muted/40 text-muted-foreground",
          };
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
        {t("deliberation.status.completed", { defaultValue: "완료" })}
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
        {t("deliberation.status.failed", { defaultValue: "실패" })}
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
      {t("deliberation.status.running", { defaultValue: "진행 중" })}
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
          {t("deliberation.feedbackLabel", { defaultValue: "피드백" })}: {turn.feedback}
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
            {t("deliberation.acceptedBy", {
              defaultValue: "{{brain}} 수락",
              brain:
                run.acceptedBy === "A"
                  ? t("deliberation.brain.a", { defaultValue: "두뇌 A" })
                  : t("deliberation.brain.b", { defaultValue: "두뇌 B" }),
            })}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground" data-testid="deliberation-rounds">
          {t("deliberation.roundsSummary", { defaultValue: "{{rounds}}라운드", rounds: run.rounds ?? 0 })}
        </span>
        {totalCost > 0 ? (
          <span className="font-mono text-xs text-foreground" data-testid="deliberation-total-cost">
            {formatCents(totalCost)}
          </span>
        ) : null}
      </header>

      {run.task ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t("deliberation.taskLabel", { defaultValue: "과제" })}: </span>
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
            ? t("deliberation.awaitingTurns", { defaultValue: "두뇌들이 합의를 시작하는 중…" })
            : t("deliberation.noTurns", { defaultValue: "기록된 턴이 없습니다." })}
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
            {t("deliberation.finalOutputLabel", { defaultValue: "최종 합의 결과" })}
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
            {t("deliberation.heading", { defaultValue: "내부 합의 실행 (dual-brain)" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("deliberation.subheading", {
              defaultValue: "두 개의 두뇌가 제안→검토→수정을 반복해 하나의 결론에 합의합니다.",
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
              "라이브 LLM이 비활성화되어 있습니다 (WORKCELL_PAIR_LIVE_LLM). 합의 실행은 라이브 LLM이 켜져 있을 때만 동작합니다.",
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
            {t("deliberation.taskLabel", { defaultValue: "과제" })}
          </Label>
          <Textarea
            id="deliberation-task"
            data-testid="deliberation-task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder={t("deliberation.taskPlaceholder", {
              defaultValue: "두 두뇌가 합의해야 할 과제를 입력하세요…",
            })}
            className="text-sm"
          />
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="deliberation-max-rounds" className="text-xs text-muted-foreground">
              {t("deliberation.maxRoundsLabel", { defaultValue: "최대 라운드 (선택)" })}
            </Label>
            <Input
              id="deliberation-max-rounds"
              data-testid="deliberation-max-rounds-input"
              type="number"
              min={1}
              max={8}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              placeholder={t("deliberation.maxRoundsPlaceholder", { defaultValue: "기본값" })}
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
                {t("deliberation.starting", { defaultValue: "시작 중…" })}
              </>
            ) : (
              <>
                <PlayCircle className="mr-1 h-3.5 w-3.5" />
                {t("deliberation.run", { defaultValue: "합의 실행" })}
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
            {t("deliberation.detailError", { defaultValue: "합의 실행을 불러오지 못했습니다." })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("deliberation.loadingRun", { defaultValue: "합의 실행을 불러오는 중…" })}
          </p>
        )
      ) : null}

      {/* Past runs */}
      {runs.length > 0 ? (
        <div className="space-y-1" data-testid="deliberation-past-runs">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("deliberation.pastRuns", { defaultValue: "최근 합의 실행" })}
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
                    {run.task ?? t("deliberation.untitledRun", { defaultValue: "(과제 없음)" })}
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
