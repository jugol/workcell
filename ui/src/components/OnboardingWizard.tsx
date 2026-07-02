import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_PLAN_REPORT_LANGUAGE,
  PLAN_REPORT_LANGUAGES,
  PAIR_GROUP_DEFAULT_MAX_ROUNDS
} from "@workcell/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { pairGroupsApi } from "../api/pair-groups";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId
} from "../lib/onboarding-launch";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@workcell/adapter-codex-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { WorkcellPrinciples } from "./WorkcellPrinciples";
import {
  AdapterModelPicker,
  AdapterThinkingEffortPicker,
  AdapterEnvCheck,
  type AdapterEnvCheckHandle,
} from "./OnboardingAdapterFields";
import { useTranslation } from "@/i18n";
import {
  Building2,
  Bot,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ChevronDown,
  Users,
  X
} from "lucide-react";


type Step = 1 | 2 | 3 | 4;
type AdapterType = string;

const DEFAULT_TASK_DESCRIPTION = `Here's the direction — turn it into a plan we can execute.

- Break the goal into issues with clear acceptance criteria and a proof surface
- Route each issue to the right role (engineering, design, QA, research)
- Bring the plan back for board approval before execution starts`;

/**
 * Build an adapter config for a Step-2 agent (owner or counterpart). Shared so
 * both agents serialize their adapter config identically. Mirrors the legacy
 * inline owner logic: claude/opencode skip permissions, codex bypasses the
 * sandbox, and claude can optionally unset ANTHROPIC_API_KEY.
 */
function buildStep2AdapterConfig(opts: {
  adapterType: string;
  model: string;
  command: string;
  args: string;
  url: string;
  thinkingEffort: string;
  forceUnsetAnthropicApiKey: boolean;
}): Record<string, unknown> {
  const adapter = getUIAdapter(opts.adapterType);
  const config = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType: opts.adapterType,
    model: opts.model,
    thinkingEffort: opts.thinkingEffort,
    command: opts.command,
    args: opts.args,
    url: opts.url,
    dangerouslySkipPermissions:
      opts.adapterType === "claude_local" ||
      opts.adapterType === "opencode_local",
    dangerouslyBypassSandbox:
      opts.adapterType === "codex_local"
        ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
        : defaultCreateValues.dangerouslyBypassSandbox,
  });
  if (opts.adapterType === "claude_local" && opts.forceUnsetAnthropicApiKey) {
    const env =
      typeof config.env === "object" &&
      config.env !== null &&
      !Array.isArray(config.env)
        ? { ...(config.env as Record<string, unknown>) }
        : {};
    env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
    config.env = env;
  }
  return config;
}

export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { t } = useTranslation();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const [routeDismissed, setRouteDismissed] = useState(false);

  // Sync disabled adapter types from server so adapter grid filters them out
  const disabledTypes = useDisabledAdaptersSync();

  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  const initialStep = effectiveOnboardingOptions.initialStep ?? 1;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");
  // Design-first by default: Workcell's philosophy treats the design system as
  // the project's source of truth, so new teams start with the design gate on.
  // The checkbox keeps it a visible, reversible choice (also in Settings).
  const [designFirst, setDesignFirst] = useState(true);
  // WC-81: language the Orchestrator writes plan reports / issue drafts in.
  // Pre-select the user's browser language when it's one we offer, else English.
  const [planReportLanguage, setPlanReportLanguage] = useState<string>(() => {
    const nav = typeof navigator !== "undefined" ? navigator.language : "";
    if (!nav) return DEFAULT_PLAN_REPORT_LANGUAGE;
    const exact = PLAN_REPORT_LANGUAGES.find(
      (entry) => entry.code.toLowerCase() === nav.toLowerCase(),
    );
    if (exact) return exact.code;
    const base = nav.split("-")[0]?.toLowerCase() ?? "";
    const baseMatch = PLAN_REPORT_LANGUAGES.find(
      (entry) => entry.code.toLowerCase() === base,
    );
    return baseMatch ? baseMatch.code : DEFAULT_PLAN_REPORT_LANGUAGE;
  });

  // Step 2
  const [agentName, setAgentName] = useState("Orchestrator");
  const [adapterType, setAdapterType] = useState<AdapterType>("claude_local");
  const [model, setModel] = useState("");
  // WC onboarding thinking effort — "" means Auto (adapter default), matching
  // defaultCreateValues.thinkingEffort and the AgentConfigForm dropdown.
  const [ownerThinkingEffort, setOwnerThinkingEffort] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);
  // Shared adapter env-check components expose an imperative runTest()/getResult()
  // so handleStep2Next can gate hiring on a passing probe (owner + counterpart).
  const ownerEnvRef = useRef<AdapterEnvCheckHandle>(null);
  const counterpartEnvRef = useRef<AdapterEnvCheckHandle>(null);
  // Mirror each env-check's loading so Next stays disabled mid-probe — parity
  // with the legacy owner behavior, now covering the counterpart too.
  const [ownerEnvBusy, setOwnerEnvBusy] = useState(false);
  const [counterpartEnvBusy, setCounterpartEnvBusy] = useState(false);

  // Step 2 — pair mode (WC pair onboarding). The first orchestrator can be a
  // PAIR of two collaborating agents instead of a single owner. Solo is the
  // default so the original single-agent flow is behavior-identical.
  const [agentMode, setAgentMode] = useState<"solo" | "pair">("solo");
  const [counterpartName, setCounterpartName] = useState("");
  // Default the counterpart to the OTHER recommended adapter (claude → codex).
  const [counterpartAdapterType, setCounterpartAdapterType] =
    useState<AdapterType>("codex_local");
  // WC-153: optional explicit model for the counterpart (parity with the owner).
  // Blank = the adapter's own default model, matching the WC-79 "Default" UX.
  const [counterpartModel, setCounterpartModel] = useState("");
  // Counterpart thinking effort — same "" = Auto semantics as the owner.
  const [counterpartThinkingEffort, setCounterpartThinkingEffort] =
    useState("");
  const [
    counterpartForceUnsetAnthropicApiKey,
    setCounterpartForceUnsetAnthropicApiKey,
  ] = useState(false);
  const [createdCounterpartAgentId, setCreatedCounterpartAgentId] = useState<
    string | null
  >(null);

  // Step 3 — defaults are localized so a non-English board sees native copy.
  // The original English text is kept as the i18n fallback (defaultValue), so
  // English/other-locale users still get the exact original wording.
  const defaultTaskTitle = t("onboarding.taskTitleDefault", {
    defaultValue: "Plan the first milestone",
  });
  const defaultTaskDescription = t("onboarding.taskDescriptionDefault", {
    defaultValue: DEFAULT_TASK_DESCRIPTION,
  });
  const [taskTitle, setTaskTitle] = useState(defaultTaskTitle);
  const [taskDescription, setTaskDescription] = useState(defaultTaskDescription);
  // First REAL project name — blank falls back to the team name, and only when
  // that's also missing do we use the legacy "Onboarding" project name.
  const [projectName, setProjectName] = useState("");

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >(null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    null
  );
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Sync step and company when onboarding opens with options.
  // Keep this independent from company-list refreshes so Step 1 completion
  // doesn't get reset after creating a company.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.companyId ?? null;
    setStep(effectiveOnboardingOptions.initialStep ?? 1);
    setCreatedCompanyId(cId);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedAgentId(null);
    setCreatedIssueRef(null);
    setOwnerThinkingEffort("");
    // Pair-mode onboarding state — clear so re-opening starts solo.
    setAgentMode("solo");
    setCounterpartName("");
    setCounterpartAdapterType("codex_local");
    setCounterpartModel("");
    setCounterpartThinkingEffort("");
    setCreatedCounterpartAgentId(null);
    setProjectName("");
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.companyId,
    effectiveOnboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Resize textarea when step 3 is shown or description changes
  useEffect(() => {
    if (step === 3) autoResizeTextarea();
  }, [step, taskDescription, autoResizeTextarea]);

  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapter = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;
  const counterpartCaps = getCapabilities(counterpartAdapterType);
  const counterpartIsLocalAdapter =
    counterpartCaps.supportsInstructionsBundle ||
    counterpartCaps.supportsSkills ||
    counterpartCaps.supportsLocalAgentJwt;

  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);
    const all = listUIAdapters()
      .filter((a) =>
        !SYSTEM_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  // Keep the pair counterpart on the OTHER recommended adapter than the owner.
  // When the owner adapter changes, re-pick a sensible default counterpart
  // (claude → codex). A manual counterpart selection persists until the next
  // owner change. Only relevant in pair mode.
  useEffect(() => {
    if (agentMode !== "pair") return;
    const other = recommendedAdapters.find((a) => a.type !== adapterType);
    setCounterpartAdapterType(other ? other.type : adapterType);
    // Effort options are adapter-specific, so a re-picked adapter starts Auto.
    setCounterpartThinkingEffort("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterType, agentMode, recommendedAdapters]);

  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));
  // Counterpart has no command field, so resolve straight from the placeholder.
  const effectiveCounterpartCommand =
    COMMAND_PLACEHOLDERS[counterpartAdapterType] ??
    counterpartAdapterType.replace(/_local$/, "");

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setAgentName("Orchestrator");
    setAdapterType("claude_local");
    setModel("");
    setOwnerThinkingEffort("");
    setCommand("");
    setArgs("");
    setUrl("");
    setForceUnsetAnthropicApiKey(false);
    setAgentMode("solo");
    setCounterpartName("");
    setCounterpartAdapterType("codex_local");
    setCounterpartModel("");
    setCounterpartThinkingEffort("");
    setCounterpartForceUnsetAnthropicApiKey(false);
    setCreatedCounterpartAgentId(null);
    setTaskTitle(defaultTaskTitle);
    setTaskDescription(defaultTaskDescription);
    setProjectName("");
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedAgentId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
  }

  const buildAdapterConfig = useCallback(
    (): Record<string, unknown> =>
      buildStep2AdapterConfig({
        adapterType,
        model,
        command,
        args,
        url,
        thinkingEffort: ownerThinkingEffort,
        forceUnsetAnthropicApiKey,
      }),
    [
      adapterType,
      model,
      command,
      args,
      url,
      ownerThinkingEffort,
      forceUnsetAnthropicApiKey,
    ]
  );

  const buildCounterpartAdapterConfig = useCallback(
    (): Record<string, unknown> =>
      buildStep2AdapterConfig({
        adapterType: counterpartAdapterType,
        model: counterpartModel,
        command: "",
        args: "",
        url: "",
        thinkingEffort: counterpartThinkingEffort,
        forceUnsetAnthropicApiKey: counterpartForceUnsetAnthropicApiKey,
      }),
    [
      counterpartAdapterType,
      counterpartModel,
      counterpartThinkingEffort,
      counterpartForceUnsetAnthropicApiKey,
    ]
  );

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({
        name: companyName.trim(),
        planReportLanguage,
        requireDesignFirst: designFirst,
      });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      if (companyGoal.trim()) {
        const parsedGoal = parseOnboardingGoalInput(companyGoal);
        const goal = await goalsApi.create(company.id, {
          title: parsedGoal.title,
          ...(parsedGoal.description
            ? { description: parsedGoal.description }
            : {}),
          level: "company",
          status: "active"
        });
        setCreatedCompanyGoalId(goal.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(company.id)
        });
      } else {
        setCreatedCompanyGoalId(null);
      }

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2Next() {
    if (!createdCompanyId) return;
    // WC-150: validate the counterpart name UP FRONT (before hiring anyone) so a
    // blank counterpart in pair mode fails fast. Previously the owner was hired
    // first and only then was the counterpart validated — so a blank counterpart
    // + retry created a DUPLICATE owner agent.
    if (agentMode === "pair" && !counterpartName.trim()) {
      setError(
        t("onboarding.counterpartNameRequired", {
          defaultValue: "Enter a name for the counterpart agent."
        })
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (isLocalAdapter) {
        const result =
          ownerEnvRef.current?.getResult() ??
          (await ownerEnvRef.current?.runTest());
        if (!result) return;
      }

      // WC-150: idempotent on retry — don't re-hire the owner if a previous
      // attempt already created it (e.g. a later step failed and the user
      // pressed Next again).
      if (!createdAgentId) {
        const hire = await agentsApi.hire(createdCompanyId, {
          name: agentName.trim(),
          role: "orchestrator",
          adapterType,
          adapterConfig: buildAdapterConfig(),
          runtimeConfig: buildNewAgentRuntimeConfig()
        });
        if (hire.approval) {
          await approvalsApi.approve(
            hire.approval.id,
            "Approved during onboarding first-agent setup."
          );
          queryClient.invalidateQueries({
            queryKey: queryKeys.approvals.list(createdCompanyId)
          });
        }
        setCreatedAgentId(hire.agent.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      // Pair mode: hire a SECOND (counterpart) agent that collaborates with the
      // orchestrator. Parity with the owner — it now runs its OWN environment
      // probe (when local) and serializes its full adapter config. Joins as a
      // "lead". Idempotent on retry (WC-150).
      if (agentMode === "pair" && !createdCounterpartAgentId) {
        if (counterpartIsLocalAdapter) {
          const counterpartResult =
            counterpartEnvRef.current?.getResult() ??
            (await counterpartEnvRef.current?.runTest());
          if (!counterpartResult) return;
        }
        const counterpartHire = await agentsApi.hire(createdCompanyId, {
          name: counterpartName.trim(),
          role: "lead",
          adapterType: counterpartAdapterType,
          adapterConfig: buildCounterpartAdapterConfig(),
          runtimeConfig: buildNewAgentRuntimeConfig()
        });
        if (counterpartHire.approval) {
          await approvalsApi.approve(
            counterpartHire.approval.id,
            "Approved during onboarding first-agent setup."
          );
          queryClient.invalidateQueries({
            queryKey: queryKeys.approvals.list(createdCompanyId)
          });
        }
        setCreatedCounterpartAgentId(counterpartHire.agent.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setError(null);
    setStep(4);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const project = await projectsApi.create(
          createdCompanyId,
          buildOnboardingProjectPayload(goalId, projectName.trim() || companyName.trim())
        );
        projectId = project.id;
        setCreatedProjectId(projectId);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.list(createdCompanyId)
        });
      }

      let issueRef = createdIssueRef;
      if (!issueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: taskTitle,
            description: taskDescription,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
          })
        );
        issueRef = issue.identifier ?? issue.id;
        setCreatedIssueRef(issueRef);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });

        // Pair mode: flip this freshly created issue into a pair group so the
        // two agents collaborate over it. pairGroupsApi.create needs the raw
        // issue.id UUID (issueRef above may be the human identifier). Guarded so
        // a pair-group failure never blocks navigation — the issue already
        // exists and the pair can be set up later from the issue page. This only
        // runs inside the freshly-created branch, so the createdIssueRef
        // early-return path won't re-create the pair group.
        if (agentMode === "pair" && createdAgentId && createdCounterpartAgentId) {
          try {
            await pairGroupsApi.create(issue.id, {
              ownerAgentId: createdAgentId,
              counterpartAgentId: createdCounterpartAgentId,
              maxRounds: PAIR_GROUP_DEFAULT_MAX_ROUNDS
            });
          } catch (pairErr) {
            console.warn(
              "Onboarding: failed to create pair group for issue; continuing to the issue.",
              pairErr
            );
          }
        }
      }

      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(
        createdCompanyPrefix
          ? `/${createdCompanyPrefix}/issues/${issueRef}?welcome=1`
          : `/issues/${issueRef}?welcome=1`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && companyName.trim()) handleStep1Next();
      else if (step === 2 && agentName.trim()) handleStep2Next();
      else if (step === 3 && taskTitle.trim()) handleStep3Next();
      else if (step === 4) handleLaunch();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          setRouteDismissed(true);
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">{t("onboarding.closeLabel", { defaultValue: "Close" })}</span>
          </button>

          {/* Left half — form */}
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
              step === 1 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border">
                {(
                  [
                    { step: 1 as Step, label: "Company", icon: Building2 },
                    { step: 2 as Step, label: "Agent", icon: Bot },
                    { step: 3 as Step, label: "Task", icon: ListTodo },
                    { step: 4 as Step, label: "Launch", icon: Rocket }
                  ] as const
                ).map(({ step: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      s === step
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(`onboarding.tabs.step${s}`, { defaultValue: label })}
                  </button>
                ))}
              </div>

              {/* Step content */}
              {step === 1 && (
                <div className="space-y-5">
                  <WorkcellPrinciples />
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {t("onboarding.step1.title", { defaultValue: "Name your team" })}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.step1.description", {
                          defaultValue: "This is the team your agents will work on, project by project.",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      {t("onboarding.companyNameLabel", { defaultValue: "Team name" })}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.companyNamePlaceholder", { defaultValue: "Acme Corp" })}
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyGoal.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      {t("onboarding.missionGoalLabel", { defaultValue: "Mission / goal (optional)" })}
                    </label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
                      placeholder={t("onboarding.missionGoalPlaceholder", { defaultValue: "What is this team trying to achieve?" })}
                      value={companyGoal}
                      onChange={(e) => setCompanyGoal(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs mb-1 block text-muted-foreground transition-colors group-focus-within:text-foreground">
                      {t("onboarding.planReportLanguageLabel", { defaultValue: "Plan report language" })}
                    </label>
                    <select
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                      value={planReportLanguage}
                      onChange={(e) => setPlanReportLanguage(e.target.value)}
                    >
                      {PLAN_REPORT_LANGUAGES.map((entry) => (
                        <option
                          key={entry.code}
                          value={entry.code}
                          className="bg-background text-foreground"
                        >
                          {entry.nativeLabel === entry.label
                            ? entry.label
                            : `${entry.nativeLabel} — ${entry.label}`}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("onboarding.planReportLanguageHint", {
                        defaultValue:
                          "Your Orchestrator will write plan reports and issue drafts in this language.",
                      })}
                    </p>
                  </div>
                  <div className="group">
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                        checked={designFirst}
                        onChange={(e) => setDesignFirst(e.target.checked)}
                      />
                      <span>
                        <span className="block text-sm">
                          {t("onboarding.designFirstLabel", {
                            defaultValue: "Design-first (recommended)",
                          })}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t("onboarding.designFirstHint", {
                            defaultValue:
                              "The design system is the project's source of truth: screen work waits for a board-approved design before implementation. Non-visual issues can opt out per issue.",
                          })}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {t("onboarding.step2.title", { defaultValue: "Create your first agent" })}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.step2.description", {
                          defaultValue: "Choose how this agent will run tasks.",
                        })}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("onboarding.step2.recommendedTeamHint", {
                          defaultValue:
                            "This first agent is your Orchestrator. After launch, hire an Engineer, a Designer, and a QA — Workcell's recommended development team.",
                        })}
                      </p>
                    </div>
                  </div>

                  {/* Solo / Pair mode selector — a pair creates a SECOND
                      collaborating agent alongside the orchestrator. */}
                  <div>
                    <div className="inline-flex rounded-md border border-border p-0.5">
                      <button
                        type="button"
                        onClick={() => setAgentMode("solo")}
                        className={cn(
                          "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                          agentMode === "solo"
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <Bot className="h-3.5 w-3.5" />
                        {t("onboarding.agentModeSolo", { defaultValue: "Solo" })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAgentMode("pair")}
                        className={cn(
                          "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                          agentMode === "pair"
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <Users className="h-3.5 w-3.5" />
                        {t("onboarding.agentModePair", { defaultValue: "Pair" })}
                      </button>
                    </div>
                    {agentMode === "pair" && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("onboarding.pairModeHint", {
                          defaultValue:
                            "Two agents take turns and collaborate to produce the result."
                        })}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {agentMode === "pair"
                        ? t("onboarding.ownerAgentNameLabel", {
                            defaultValue: "Agent 1 · Orchestrator name"
                          })
                        : t("onboarding.agentNameLabel", { defaultValue: "Agent name" })}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.agentNamePlaceholder", { defaultValue: "Orchestrator" })}
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      {t("onboarding.adapterTypeLabel", { defaultValue: "Adapter type" })}
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {recommendedAdapters.map((opt) => (
                        <button
                          key={opt.type}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.type
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.type;
                            setAdapterType(nextType);
                            // Reset to empty (= Default / local CLI's own model)
                            // on adapter change; no forced fallback model.
                            setModel("");
                            // Effort options differ per adapter — back to Auto.
                            setOwnerThinkingEffort("");
                          }}
                        >
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              {t("onboarding.recommendedBadge", { defaultValue: "Recommended" })}
                            </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.description}
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* WC-145: only show the "More adapter types" disclosure when there
                        are non-recommended adapters to reveal. After the adapter cleanup
                        the only visual adapters (claude/codex) are both recommended, so
                        moreAdapters is empty — the button would expand to nothing. */}
                    {moreAdapters.length > 0 && (
                      <button
                        className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => setShowMoreAdapters((v) => !v)}
                      >
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 transition-transform",
                            showMoreAdapters ? "rotate-0" : "-rotate-90"
                          )}
                        />
                        {t("onboarding.moreAdapterTypes", { defaultValue: "More Agent Adapter Types" })}
                      </button>
                    )}

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {moreAdapters.map((opt) => (
                           <button
                             key={opt.type}
                             disabled={!!opt.comingSoon}
                             className={cn(
                               "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                               opt.comingSoon
                                 ? "border-border opacity-40 cursor-not-allowed"
                                 : adapterType === opt.type
                                 ? "border-foreground bg-accent"
                                 : "border-border hover:bg-accent/50"
                             )}
                             onClick={() => {
                               if (opt.comingSoon) return;
                               const nextType = opt.type;
                              setAdapterType(nextType);
                              setModel("");
                              setOwnerThinkingEffort("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? opt.disabledLabel ?? t("onboarding.comingSoon", { defaultValue: "Coming soon" })
                                : opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Shared adapter setup — the SAME model picker + env probe
                      the counterpart uses (extracted to OnboardingAdapterFields),
                      so the two stay in parity by construction. */}
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <AdapterModelPicker
                        companyId={createdCompanyId}
                        adapterType={adapterType}
                        model={model}
                        onModelChange={setModel}
                        enabled={effectiveOnboardingOpen && step === 2}
                      />
                      <AdapterThinkingEffortPicker
                        adapterType={adapterType}
                        value={ownerThinkingEffort}
                        onChange={setOwnerThinkingEffort}
                      />
                    </div>
                  )}

                  {isLocalAdapter && (
                    <AdapterEnvCheck
                      ref={ownerEnvRef}
                      companyId={createdCompanyId}
                      adapterType={adapterType}
                      buildConfig={buildAdapterConfig}
                      agentId={createdAgentId}
                      effectiveCommand={effectiveAdapterCommand}
                      resetSignal={`${adapterType}|${model}|${ownerThinkingEffort}|${command}|${args}|${url}`}
                      onForceUnsetChange={setForceUnsetAnthropicApiKey}
                      onLoadingChange={setOwnerEnvBusy}
                    />
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? t("onboarding.gatewayUrlLabel", { defaultValue: "Gateway URL" })
                          : t("onboarding.webhookUrlLabel", { defaultValue: "Webhook URL" })}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}

                  {/* Pair mode: counterpart agent — name + adapter only. It uses
                      the Default model, so no model picker or env probe here. */}
                  {agentMode === "pair" && (
                    <div className="space-y-3 rounded-md border border-border p-3">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <p className="text-xs font-medium">
                          {t("onboarding.counterpartTitle", {
                            defaultValue: "Counterpart agent"
                          })}
                        </p>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.counterpartNameLabel", {
                            defaultValue: "Counterpart name"
                          })}
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder={t("onboarding.counterpartNamePlaceholder", {
                            defaultValue: "Reviewer"
                          })}
                          value={counterpartName}
                          onChange={(e) => setCounterpartName(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-2 block">
                          {t("onboarding.adapterTypeLabel", {
                            defaultValue: "Adapter type"
                          })}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          {recommendedAdapters.map((opt) => (
                            <button
                              key={opt.type}
                              type="button"
                              className={cn(
                                "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                                counterpartAdapterType === opt.type
                                  ? "border-foreground bg-accent"
                                  : "border-border hover:bg-accent/50"
                              )}
                              onClick={() => {
                                setCounterpartAdapterType(opt.type);
                                // Effort options differ per adapter — back to Auto.
                                setCounterpartThinkingEffort("");
                              }}
                            >
                              <opt.icon className="h-4 w-4" />
                              <span className="font-medium">{opt.label}</span>
                              <span className="text-muted-foreground text-[10px]">
                                {opt.description}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                      {counterpartIsLocalAdapter && (
                        <AdapterModelPicker
                          companyId={createdCompanyId}
                          adapterType={counterpartAdapterType}
                          model={counterpartModel}
                          onModelChange={setCounterpartModel}
                          enabled={effectiveOnboardingOpen && step === 2}
                        />
                      )}
                      {counterpartIsLocalAdapter && (
                        <AdapterThinkingEffortPicker
                          adapterType={counterpartAdapterType}
                          value={counterpartThinkingEffort}
                          onChange={setCounterpartThinkingEffort}
                        />
                      )}
                      {counterpartIsLocalAdapter && (
                        <AdapterEnvCheck
                          ref={counterpartEnvRef}
                          companyId={createdCompanyId}
                          adapterType={counterpartAdapterType}
                          buildConfig={buildCounterpartAdapterConfig}
                          agentId={createdCounterpartAgentId}
                          effectiveCommand={effectiveCounterpartCommand}
                          resetSignal={`${counterpartAdapterType}|${counterpartModel}|${counterpartThinkingEffort}`}
                          onForceUnsetChange={setCounterpartForceUnsetAnthropicApiKey}
                          onLoadingChange={setCounterpartEnvBusy}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <ListTodo className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {t("onboarding.step3.title", { defaultValue: "Give it something to do" })}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.step3.description", {
                          defaultValue:
                            "Give your agent a small task to start with — a bug fix, a research question, writing a script.",
                        })}
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.projectNameLabel", { defaultValue: "Project name" })}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={
                        companyName.trim() ||
                        t("onboarding.projectNamePlaceholder", { defaultValue: "First project" })
                      }
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("onboarding.projectNameHint", {
                        defaultValue:
                          "Your first real project — the design system and issues will live here.",
                      })}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.taskTitleLabel", { defaultValue: "Task title" })}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.taskTitlePlaceholder", { defaultValue: "e.g. Research competitor pricing" })}
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.descriptionLabel", { defaultValue: "Description (optional)" })}
                    </label>
                    <textarea
                      ref={textareaRef}
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[120px] max-h-[300px] overflow-y-auto"
                      placeholder={t("onboarding.descriptionPlaceholder", { defaultValue: "Add more detail about what the agent should do..." })}
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Rocket className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {t("onboarding.step4.title", { defaultValue: "Ready to launch" })}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.step4.description", {
                          defaultValue:
                            "Everything is set up. Launching now will create the starter task, wake the agent, and open the issue.",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="border border-border divide-y divide-border">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {companyName}
                        </p>
                        <p className="text-xs text-muted-foreground">{t("onboarding.summaryCompany", { defaultValue: "Team" })}</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {agentName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {getUIAdapter(adapterType).label}
                        </p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {taskTitle}
                        </p>
                        <p className="text-xs text-muted-foreground">{t("onboarding.summaryTask", { defaultValue: "Task" })}</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (onboardingOptions.initialStep ?? 1) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      {t("onboarding.back", { defaultValue: "Back" })}
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || loading}
                      onClick={handleStep1Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading
                        ? t("onboarding.creating", { defaultValue: "Creating..." })
                        : t("onboarding.next", { defaultValue: "Next" })}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() ||
                        loading ||
                        ownerEnvBusy ||
                        (agentMode === "pair" && counterpartEnvBusy)
                      }
                      onClick={handleStep2Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading
                        ? t("onboarding.creating", { defaultValue: "Creating..." })
                        : t("onboarding.next", { defaultValue: "Next" })}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!taskTitle.trim() || loading}
                      onClick={handleStep3Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading
                        ? t("onboarding.creating", { defaultValue: "Creating..." })
                        : t("onboarding.next", { defaultValue: "Next" })}
                    </Button>
                  )}
                  {step === 4 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading
                        ? t("onboarding.creating", { defaultValue: "Creating..." })
                        : t("onboarding.launch", { defaultValue: "Create & Open Issue" })}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-card transition-[width,opacity] duration-500 ease-in-out",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
