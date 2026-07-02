import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Sparkles } from "lucide-react";
import { useTranslation } from "@/i18n";
import { issuesApi, type GrillQuestion } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const GRILL_MODE_STORAGE_KEY = "workcell:planner-grill-mode";

function loadGrillModePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(GRILL_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistGrillModePreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GRILL_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Non-fatal: a private-mode storage rejection just means the toggle won't persist.
  }
}

// WC-184 (CP0 "Grill mode"): a resolved clarifying question carries the answer
// the user settled on (pre-filled from the planner's recommendation, editable).
type ResolvedGrillQuestion = GrillQuestion & { answer: string };

// WC-184: compose the answered grill Q&A into a block appended to the original
// prompt so the NORMAL draft route drafts with the clarified intent. Only
// answered questions are included; an empty answer is skipped.
export function buildGrilledPrompt(prompt: string, resolved: ResolvedGrillQuestion[]): string {
  const answered = resolved.filter((item) => item.answer.trim().length > 0);
  if (answered.length === 0) return prompt;
  const lines = ["", "Clarifying answers:"];
  for (const item of answered) {
    lines.push(`- Q: ${item.question.trim()}`);
    lines.push(`  A: ${item.answer.trim()}`);
  }
  return `${prompt}${lines.join("\n")}`;
}

// WC-184 (CP0 "Grill mode"): the planner-draft bar at the top of the Issues
// page. With Grill OFF this is byte-identical to the original inline bar: type a
// prompt, the planner drafts a structured issue. With Grill ON, submitting the
// prompt first asks the planner for the highest-leverage clarifying questions;
// each is shown with the planner's recommended answer pre-filled into an
// editable input + the rationale as helper text. "Draft with these answers"
// appends the resolved Q&A to the prompt and runs the normal draft; "Skip and
// draft" is the escape hatch that drafts without answers.
export function PlannerDraftBar({
  companyId,
  hasPlannerCapableAgent,
  isTrulyEmpty,
}: {
  companyId: string;
  hasPlannerCapableAgent: boolean;
  isTrulyEmpty: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [draftPrompt, setDraftPrompt] = useState("");
  const [grillMode, setGrillMode] = useState<boolean>(loadGrillModePreference);
  // The prompt the questions were generated for; we draft against this exact
  // text so editing the box after grilling can't desync the appended Q&A.
  const [grilledPrompt, setGrilledPrompt] = useState("");
  const [resolvedQuestions, setResolvedQuestions] = useState<ResolvedGrillQuestion[]>([]);
  const [questionsOpen, setQuestionsOpen] = useState(false);

  useEffect(() => {
    persistGrillModePreference(grillMode);
  }, [grillMode]);

  const draftFromPrompt = useMutation({
    mutationFn: (prompt: string) => issuesApi.draftFromPrompt(companyId, { prompt }),
    onSuccess: () => {
      setDraftPrompt("");
      setQuestionsOpen(false);
      setResolvedQuestions([]);
      setGrilledPrompt("");
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  const grill = useMutation({
    mutationFn: (prompt: string) => issuesApi.draftGrill(companyId, { prompt }),
    onSuccess: (data, prompt) => {
      setGrilledPrompt(prompt);
      setResolvedQuestions(
        (data.questions ?? []).map((question) => ({ ...question, answer: question.recommendation })),
      );
      setQuestionsOpen(true);
    },
  });

  const trimmedDraftPrompt = draftPrompt.trim();
  const isBusy = draftFromPrompt.isPending || grill.isPending;

  const submit = useCallback(() => {
    if (!trimmedDraftPrompt || !hasPlannerCapableAgent || isBusy) return;
    if (grillMode) {
      grill.mutate(trimmedDraftPrompt);
    } else {
      draftFromPrompt.mutate(trimmedDraftPrompt);
    }
  }, [draftFromPrompt, grill, grillMode, hasPlannerCapableAgent, isBusy, trimmedDraftPrompt]);

  const draftWithAnswers = useCallback(() => {
    if (isBusy) return;
    const basePrompt = grilledPrompt || trimmedDraftPrompt;
    if (!basePrompt) return;
    draftFromPrompt.mutate(buildGrilledPrompt(basePrompt, resolvedQuestions));
  }, [draftFromPrompt, grilledPrompt, isBusy, resolvedQuestions, trimmedDraftPrompt]);

  const skipAndDraft = useCallback(() => {
    if (isBusy) return;
    const basePrompt = grilledPrompt || trimmedDraftPrompt;
    if (!basePrompt) return;
    draftFromPrompt.mutate(basePrompt);
  }, [draftFromPrompt, grilledPrompt, isBusy, trimmedDraftPrompt]);

  const updateAnswer = useCallback((index: number, answer: string) => {
    setResolvedQuestions((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, answer } : item)),
    );
  }, []);

  const grillReturnedNoQuestions =
    questionsOpen && resolvedQuestions.length === 0 && grilledPrompt.length > 0;

  const submitLabel = useMemo(() => {
    if (grillMode) {
      return grill.isPending
        ? t("grillMode.askingButtonPending", { defaultValue: "Asking…" })
        : t("grillMode.askButton", { defaultValue: "Ask first" });
    }
    return draftFromPrompt.isPending
      ? t("issues.draftButtonPending", { defaultValue: "Drafting…" })
      : t("issues.draftButton", { defaultValue: "Draft with Planner" });
  }, [draftFromPrompt.isPending, grill.isPending, grillMode, t]);

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          type="text"
          value={draftPrompt}
          onChange={(event) => setDraftPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t("issues.draftPlaceholder", {
            defaultValue: "Describe an idea — the planner will draft a structured issue…",
          })}
          aria-label={t("issues.draftAriaLabel", { defaultValue: "Draft an issue with the planner" })}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
        {/* Grill toggle (WC-184): mirrors the Pair chip styling in NewIssueDialog.
            When ON, submitting interrogates the user before drafting. */}
        <button
          type="button"
          data-testid="planner-grill-toggle"
          aria-pressed={grillMode}
          onClick={() => setGrillMode((value) => !value)}
          title={t("grillMode.toggleHint", {
            defaultValue:
              "Grill me first — the planner asks focused clarifying questions before drafting, each with a recommended answer.",
          })}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
            grillMode
              ? "border-violet-500/60 bg-violet-500/15 text-violet-800 hover:bg-violet-500/25 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
              : "border-border text-muted-foreground hover:bg-accent/50",
          )}
        >
          <MessagesSquare className="h-3 w-3" />
          {t("grillMode.toggle", { defaultValue: "Grill" })}
        </button>
        <button
          type="button"
          data-testid="planner-draft-submit"
          onClick={submit}
          disabled={!trimmedDraftPrompt || !hasPlannerCapableAgent || isBusy}
          title={
            hasPlannerCapableAgent
              ? undefined
              : t("issues.draftDisabledHint", {
                  defaultValue:
                    "Add an active agent with a planner, pm, or orchestrator role to enable drafting.",
                })
          }
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>

      {questionsOpen && (
        <div
          data-testid="planner-grill-questions"
          className="mt-2 space-y-3 rounded-md border border-border bg-muted/30 p-3"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <MessagesSquare className="h-3.5 w-3.5 text-violet-600 dark:text-violet-300" aria-hidden="true" />
            {t("grillMode.questionsHeading", {
              defaultValue: "Answer a few questions, then draft with the clarified intent",
            })}
          </div>

          {grillReturnedNoQuestions ? (
            <p className="text-xs text-muted-foreground">
              {t("grillMode.noQuestions", {
                defaultValue:
                  "The planner had no clarifying questions — your request looks well-specified. Draft it as-is.",
              })}
            </p>
          ) : (
            <ol className="space-y-3">
              {resolvedQuestions.map((item, index) => (
                <li key={index} className="space-y-1">
                  <p className="text-sm text-foreground">{item.question}</p>
                  <input
                    type="text"
                    data-testid={`planner-grill-answer-${index}`}
                    value={item.answer}
                    onChange={(event) => updateAnswer(index, event.target.value)}
                    aria-label={t("grillMode.answerAriaLabel", {
                      defaultValue: "Answer for: {{question}}",
                      question: item.question,
                    })}
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
                  />
                  {item.rationale && (
                    <p className="text-xs text-muted-foreground">
                      {t("grillMode.rationaleLabel", { defaultValue: "Why" })}: {item.rationale}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="planner-grill-draft-with-answers"
              onClick={draftWithAnswers}
              disabled={isBusy}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {draftFromPrompt.isPending
                ? t("issues.draftButtonPending", { defaultValue: "Drafting…" })
                : t("grillMode.draftWithAnswers", { defaultValue: "Draft with these answers" })}
            </button>
            <button
              type="button"
              data-testid="planner-grill-skip"
              onClick={skipAndDraft}
              disabled={isBusy}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
            >
              {t("grillMode.skipAndDraft", { defaultValue: "Skip and draft" })}
            </button>
          </div>
        </div>
      )}

      {grill.isError && (
        <p className="mt-1.5 pl-6 text-xs text-destructive">
          {t("grillMode.error", {
            defaultValue: "Couldn't fetch clarifying questions. Try again, or draft without them.",
          })}
        </p>
      )}

      {!isTrulyEmpty && !questionsOpen && (
        <p className="mt-1.5 pl-6 text-xs text-muted-foreground">
          {grillMode
            ? t("grillMode.helper", {
                defaultValue:
                  "Grill mode is on — the planner asks focused clarifying questions (each with a recommended answer) before it drafts.",
              })
            : t("issues.draftHelper", {
                defaultValue:
                  "Describe what you want done and the planner drafts a structured issue — with acceptance criteria and a proof surface — ready for an agent to pick up.",
              })}
        </p>
      )}
    </div>
  );
}
