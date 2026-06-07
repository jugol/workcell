import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@workcell/shared";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
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
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");
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
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);

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
    // Pair-mode onboarding state — clear so re-opening starts solo.
    setAgentMode("solo");
    setCounterpartName("");
    setCounterpartAdapterType("codex_local");
    setCounterpartModel("");
    setCreatedCounterpartAgentId(null);
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

  const { data: adapterModels } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Workcell host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapter = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;

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

  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    // claude/codex (cloud OpenAI/Anthropic) have no real-time model list, so we
    // suppress the static one and offer only Default + a typed model id.
    if (adapterType !== "opencode_local") return [];
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterType, adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setAgentName("Orchestrator");
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setAgentMode("solo");
    setCounterpartName("");
    setCounterpartAdapterType("codex_local");
    setCounterpartModel("");
    setCreatedCounterpartAgentId(null);
    setTaskTitle(defaultTaskTitle);
    setTaskDescription(defaultTaskDescription);
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

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
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

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({
        name: companyName.trim(),
        planReportLanguage,
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
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
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
      // orchestrator. The counterpart uses the Default model (no env test, no
      // model picker) and joins as a "lead". Idempotent on retry (WC-150).
      if (agentMode === "pair" && !createdCounterpartAgentId) {
        const counterpartHire = await agentsApi.hire(createdCompanyId, {
          name: counterpartName.trim(),
          role: "lead",
          adapterType: counterpartAdapterType,
          adapterConfig: { model: counterpartModel.trim() },
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

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
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
          buildOnboardingProjectPayload(goalId)
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
                        {t("onboarding.step1.title", { defaultValue: "Name your company" })}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.step1.description", {
                          defaultValue: "This is the organization your agents will work for.",
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
                      {t("onboarding.companyNameLabel", { defaultValue: "Company name" })}
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
                      placeholder={t("onboarding.missionGoalPlaceholder", { defaultValue: "What is this company trying to achieve?" })}
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

                  {/* Conditional adapter fields */}
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.modelLabel", { defaultValue: "Model" })}
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-[var(--radix-popover-trigger-width)] p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder={
                                adapterType === "opencode_local"
                                  ? "Search models..."
                                  : "Type a model id (e.g. claude-opus-4-8)…"
                              }
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            {adapterType !== "opencode_local" && modelSearch.trim() ? (
                              <button
                                className="flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
                                onClick={() => {
                                  setModel(modelSearch.trim());
                                  setModelOpen(false);
                                }}
                              >
                                <span>{t("onboarding.useThisModel", { defaultValue: "Use this model" })}</span>
                                <span className="font-mono text-xs text-muted-foreground">
                                  {modelSearch.trim()}
                                </span>
                              </button>
                            ) : null}
                            <div className="max-h-[240px] overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {adapterType === "opencode_local" &&
                              filteredModels.length === 0 && (
                                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                  {t("onboarding.noModelsDiscovered", { defaultValue: "No models discovered." })}
                                </p>
                              )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            {t("onboarding.adapterEnvCheckTitle", { defaultValue: "Adapter environment check" })}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {t("onboarding.adapterEnvCheckDescription", {
                              defaultValue:
                                "Runs a live probe that asks the adapter CLI to respond with hello.",
                            })}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading
                            ? t("onboarding.adapterEnvTesting", { defaultValue: "Testing..." })
                            : t("onboarding.adapterEnvTestNow", { defaultValue: "Test now" })}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">{t("onboarding.adapterEnvPassed", { defaultValue: "Passed" })}</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            {t("onboarding.anthropicKeyNoticePrefix", { defaultValue: "Claude failed while" })}{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            {t("onboarding.anthropicKeyNoticeSuffix", {
                              defaultValue:
                                "is set. You can clear it in this agent's adapter config and retry the probe.",
                            })}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? t("onboarding.anthropicKeyRetrying", { defaultValue: "Retrying..." })
                              : t("onboarding.anthropicKeyUnset", { defaultValue: "Unset ANTHROPIC_API_KEY" })}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                          <p className="font-medium">{t("onboarding.manualDebug", { defaultValue: "Manual debug" })}</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            {t("onboarding.promptLabel", { defaultValue: "Prompt:" })}{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              {t("onboarding.authFailsSet", { defaultValue: "If auth fails, set" })}{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              {t("onboarding.authFailsInEnvOrRun", { defaultValue: "in env or run" })}{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              {t("onboarding.loginRequiredRun", { defaultValue: "If login is required, run" })}{" "}
                              <span className="font-mono">claude login</span>{" "}
                              {t("onboarding.loginRequiredAndRetry", { defaultValue: "and retry." })}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
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
                              onClick={() => setCounterpartAdapterType(opt.type)}
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
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.counterpartModelLabel", { defaultValue: "Model (optional)" })}
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder={t("onboarding.counterpartModelPlaceholder", {
                            defaultValue: "Default (the adapter's own model)"
                          })}
                          value={counterpartModel}
                          onChange={(e) => setCounterpartModel(e.target.value)}
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          {t("onboarding.counterpartModelHint", {
                            defaultValue: "Leave blank to use the adapter's default model."
                          })}
                        </p>
                      </div>
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
                        <p className="text-xs text-muted-foreground">{t("onboarding.summaryCompany", { defaultValue: "Company" })}</p>
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
                        !agentName.trim() || loading || adapterEnvLoading
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

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const { t } = useTranslation();
  const statusLabel =
    result.status === "pass"
      ? t("onboarding.adapterEnvPassed", { defaultValue: "Passed" })
      : result.status === "warn"
      ? t("onboarding.adapterEnvWarnings", { defaultValue: "Warnings" })
      : t("onboarding.adapterEnvFailed", { defaultValue: "Failed" });
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                {t("onboarding.hintPrefix", { defaultValue: "Hint:" })} {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
