import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@workcell/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback,
} from "../lib/model-utils";
import { useTranslation } from "@/i18n";
import { Check, ChevronDown } from "lucide-react";
import {
  claudeThinkingEffortOptions,
  codexThinkingEffortOptions,
} from "./AgentConfigForm";

/**
 * Shared Step-2 adapter fields for the onboarding wizard, used by BOTH the
 * owner (orchestrator) agent and the pair-mode counterpart so the two are
 * guaranteed to stay in sync. Extracted from OnboardingWizard so a single
 * component renders the model picker + environment probe identically — no
 * second hand-maintained copy to drift out of parity.
 */

export function AdapterModelPicker({
  companyId,
  adapterType,
  model,
  onModelChange,
  enabled,
}: {
  companyId: string | null;
  adapterType: string;
  model: string;
  onModelChange: (model: string) => void;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // The wizard doesn't expose an environment selector, so models always
  // resolve against the local Workcell host (environmentId = null).
  const { data: adapterModels } = useQuery({
    queryKey: companyId
      ? queryKeys.agents.adapterModels(companyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () =>
      agentsApi.adapterModels(companyId!, adapterType, { environmentId: null }),
    enabled: Boolean(companyId) && enabled,
  });

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);

  const filteredModels = useMemo(() => {
    // claude/codex (cloud OpenAI/Anthropic) have no real-time model list, so we
    // suppress the static one and offer only Default + a typed model id.
    if (adapterType !== "opencode_local") return [];
    const query = search.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterType, adapterModels, search]);

  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
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
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, adapterType]);

  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">
        {t("onboarding.modelLabel", { defaultValue: "Model" })}
      </label>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!model && "text-muted-foreground")}>
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {adapterType !== "opencode_local" && (
            <button
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                !model && "bg-accent"
              )}
              onClick={() => {
                onModelChange("");
                setOpen(false);
              }}
            >
              Default
            </button>
          )}
          {adapterType !== "opencode_local" && search.trim() ? (
            <button
              className="flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
              onClick={() => {
                onModelChange(search.trim());
                setOpen(false);
              }}
            >
              <span>
                {t("onboarding.useThisModel", {
                  defaultValue: "Use this model",
                })}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {search.trim()}
              </span>
            </button>
          ) : null}
          <div className="max-h-[240px] overflow-y-auto">
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
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
                      onModelChange(m.id);
                      setOpen(false);
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
                {t("onboarding.noModelsDiscovered", {
                  defaultValue: "No models discovered.",
                })}
              </p>
            )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Thinking-effort picker for the onboarding wizard (owner + counterpart).
 * Reuses the per-adapter option lists exported by AgentConfigForm so the
 * wizard and the full agent config form can never drift apart. Renders
 * nothing for adapters whose buildAdapterConfig ignores thinkingEffort.
 */
export function AdapterThinkingEffortPicker({
  adapterType,
  value,
  onChange,
}: {
  adapterType: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Only claude/codex map CreateConfigValues.thinkingEffort into their adapter
  // config (effort / modelReasoningEffort) — hide the field everywhere else.
  const options =
    adapterType === "codex_local"
      ? codexThinkingEffortOptions
      : adapterType === "claude_local"
        ? claudeThinkingEffortOptions
        : null;
  if (!options) return null;

  // Fall back to Auto when a stale value survives an adapter switch.
  const selected = options.find((o) => o.id === value) ?? options[0];

  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">
        {t("onboarding.thinkingEffortLabel", {
          defaultValue: "Thinking effort",
        })}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!selected.id && "text-muted-foreground")}>
              {selected.label}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-1"
          align="start"
        >
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === selected.id && "bg-accent"
              )}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export interface AdapterEnvCheckHandle {
  getResult: () => AdapterEnvironmentTestResult | null;
  runTest: () => Promise<AdapterEnvironmentTestResult | null>;
}

function applyAnthropicApiKeyUnset(
  config: Record<string, unknown>
): Record<string, unknown> {
  const env =
    typeof config.env === "object" &&
    config.env !== null &&
    !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {};
  env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
  return { ...config, env };
}

export const AdapterEnvCheck = forwardRef<
  AdapterEnvCheckHandle,
  {
    companyId: string | null;
    adapterType: string;
    /** Returns the adapter config to probe (parent owns model/command/etc). */
    buildConfig: () => Record<string, unknown>;
    /** Hired agent id, if any — used to persist the unset before retrying. */
    agentId: string | null;
    effectiveCommand: string;
    /** Changing this string clears the last probe result (adapter/model/etc). */
    resetSignal: string;
    /** Bubble the ANTHROPIC_API_KEY-unset choice up so hire config matches. */
    onForceUnsetChange: (value: boolean) => void;
    /** Bubble loading up so the wizard can disable Next while a probe runs. */
    onLoadingChange?: (loading: boolean) => void;
  }
>(function AdapterEnvCheck(
  {
    companyId,
    adapterType,
    buildConfig,
    agentId,
    effectiveCommand,
    resetSignal,
    onForceUnsetChange,
    onLoadingChange,
  },
  ref
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<AdapterEnvironmentTestResult | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsetLoading, setUnsetLoading] = useState(false);

  // Clear the probe result whenever the adapter/model/command changes.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [resetSignal]);

  // Surface loading to the parent so Next can be disabled mid-probe.
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  const runTest = useCallback(
    async (
      configOverride?: Record<string, unknown>
    ): Promise<AdapterEnvironmentTestResult | null> => {
      if (!companyId) {
        setError(
          "Create or select a company before testing adapter environment."
        );
        return null;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await agentsApi.testEnvironment(companyId, adapterType, {
          adapterConfig: configOverride ?? buildConfig(),
        });
        setResult(res);
        return res;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Adapter environment test failed"
        );
        return null;
      } finally {
        setLoading(false);
      }
    },
    [companyId, adapterType, buildConfig]
  );

  useImperativeHandle(
    ref,
    () => ({
      getResult: () => result,
      runTest: () => runTest(),
    }),
    [result, runTest]
  );

  const hasAnthropicApiKeyOverrideCheck =
    result?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    result?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;

  async function handleUnsetAnthropicApiKey() {
    if (!companyId || unsetLoading) return;
    setUnsetLoading(true);
    setError(null);
    // Remember the choice so the parent's hire config also unsets the key.
    onForceUnsetChange(true);

    const configWithUnset = applyAnthropicApiKeyUnset(buildConfig());

    try {
      if (agentId) {
        await agentsApi.update(
          agentId,
          { adapterConfig: configWithUnset },
          companyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(companyId),
        });
      }
      const res = await runTest(configWithUnset);
      if (res?.status === "fail") {
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
      setUnsetLoading(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium">
            {t("onboarding.adapterEnvCheckTitle", {
              defaultValue: "Adapter environment check",
            })}
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
          disabled={loading}
          onClick={() => void runTest()}
        >
          {loading
            ? t("onboarding.adapterEnvTesting", { defaultValue: "Testing..." })
            : t("onboarding.adapterEnvTestNow", { defaultValue: "Test now" })}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {result && result.status === "pass" ? (
        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">
            {t("onboarding.adapterEnvPassed", { defaultValue: "Passed" })}
          </span>
        </div>
      ) : result ? (
        <AdapterEnvironmentResult result={result} />
      ) : null}

      {shouldSuggestUnsetAnthropicApiKey && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
          <p className="text-[11px] text-amber-900/90 leading-relaxed">
            {t("onboarding.anthropicKeyNoticePrefix", {
              defaultValue: "Claude failed while",
            })}{" "}
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
            disabled={loading || unsetLoading}
            onClick={() => void handleUnsetAnthropicApiKey()}
          >
            {unsetLoading
              ? t("onboarding.anthropicKeyRetrying", {
                  defaultValue: "Retrying...",
                })
              : t("onboarding.anthropicKeyUnset", {
                  defaultValue: "Unset ANTHROPIC_API_KEY",
                })}
          </Button>
        </div>
      )}

      {result && result.status === "fail" && (
        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
          <p className="font-medium">
            {t("onboarding.manualDebug", { defaultValue: "Manual debug" })}
          </p>
          <p className="text-muted-foreground font-mono break-all">
            {adapterType === "cursor"
              ? `${effectiveCommand} -p --mode ask --output-format json \"Respond with hello.\"`
              : adapterType === "codex_local"
              ? `${effectiveCommand} exec --json -`
              : adapterType === "gemini_local"
              ? `${effectiveCommand} --output-format json "Respond with hello."`
              : adapterType === "opencode_local"
              ? `${effectiveCommand} run --format json "Respond with hello."`
              : `${effectiveCommand} --print - --output-format stream-json --verbose`}
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
              {t("onboarding.authFailsSet", {
                defaultValue: "If auth fails, set",
              })}{" "}
              <span className="font-mono">
                {adapterType === "cursor"
                  ? "CURSOR_API_KEY"
                  : adapterType === "gemini_local"
                  ? "GEMINI_API_KEY"
                  : "OPENAI_API_KEY"}
              </span>{" "}
              {t("onboarding.authFailsInEnvOrRun", {
                defaultValue: "in env or run",
              })}{" "}
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
              {t("onboarding.loginRequiredRun", {
                defaultValue: "If login is required, run",
              })}{" "}
              <span className="font-mono">claude login</span>{" "}
              {t("onboarding.loginRequiredAndRetry", {
                defaultValue: "and retry.",
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

function AdapterEnvironmentResult({
  result,
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
                {t("onboarding.hintPrefix", { defaultValue: "Hint:" })}{" "}
                {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
