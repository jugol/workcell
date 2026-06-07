import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAIR_GROUP_DEFAULT_MAX_ROUNDS } from "@workcell/shared";
import { useTranslation } from "@/i18n";
import { pairGroupsApi } from "../api/pair-groups";

type PairAgent = { id: string; name: string; status?: string | null };

// WC-78 (§9 #3 UI): makes pair collaboration a real, discoverable feature.
// Shown on an issue that is NOT yet a pair. Lets a board user turn the issue
// into a PAIR — two agents that take turns over up to N rounds to produce the
// result together. pairGroupsApi.create() also flips the issue's
// workOwnerKind to "pair" and stamps the group, so the round timeline appears.
export function PairSetupPanel({
  issueId,
  agents,
  defaultOwnerAgentId,
  defaultOpen,
  onCreated,
}: {
  issueId: string;
  agents: PairAgent[];
  defaultOwnerAgentId?: string | null;
  defaultOpen?: boolean;
  onCreated?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  // WC-185: expand reactively when the deep-link signal flips on (e.g. the
  // issue-detail assignee picker chooses "Pair" while this panel is already
  // mounted). Only opens — never force-closes a panel the user opened.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const [ownerId, setOwnerId] = useState<string>(defaultOwnerAgentId ?? "");
  const [counterpartId, setCounterpartId] = useState<string>("");
  const [maxRounds, setMaxRounds] = useState<number>(PAIR_GROUP_DEFAULT_MAX_ROUNDS);
  const [error, setError] = useState<string | null>(null);

  const selectable = agents.filter((a) => a.status !== "terminated");

  const create = useMutation({
    mutationFn: () =>
      pairGroupsApi.create(issueId, {
        ownerAgentId: ownerId || null,
        counterpartAgentId: counterpartId || null,
        maxRounds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pair-group", issueId] });
      onCreated?.();
    },
    onError: (e) =>
      setError(
        e instanceof Error
          ? e.message
          : t("pairSetup.error.failed", { defaultValue: "Failed to start pair collaboration" }),
      ),
  });

  function submit() {
    setError(null);
    if (!ownerId || !counterpartId) {
      setError(t("pairSetup.error.pickBoth", { defaultValue: "Pick both agents." }));
      return;
    }
    if (ownerId === counterpartId) {
      setError(t("pairSetup.error.mustDiffer", { defaultValue: "The two agents must be different." }));
      return;
    }
    create.mutate();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-violet-400/60 hover:text-foreground"
        data-testid="pair-setup-cta"
      >
        <Users className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        {t("pairSetup.cta", {
          defaultValue: "Set up pair collaboration — have two agents work this issue together",
        })}
      </button>
    );
  }

  const selectClass =
    "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";

  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="pair-setup-panel">
      <header className="flex items-start gap-2">
        <Users className="mt-0.5 h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {t("pairSetup.title", { defaultValue: "Pair collaboration" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("pairSetup.description", {
              defaultValue:
                "Two agents take turns over up to {{maxRounds}} rounds to produce the result together, instead of a single owner.",
              maxRounds,
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("pairSetup.close", { defaultValue: "Close" })}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("pairSetup.ownerAgent", { defaultValue: "Owner agent" })}</span>
          <select
            className={selectClass}
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          >
            <option value="">{t("pairSetup.selectAgent", { defaultValue: "Select an agent…" })}</option>
            {selectable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("pairSetup.counterpartAgent", { defaultValue: "Counterpart agent" })}</span>
          <select
            className={selectClass}
            value={counterpartId}
            onChange={(e) => setCounterpartId(e.target.value)}
          >
            <option value="">{t("pairSetup.selectAgent", { defaultValue: "Select an agent…" })}</option>
            {selectable
              .filter((a) => a.id !== ownerId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("pairSetup.maxRounds", { defaultValue: "Max rounds" })}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={maxRounds}
          onChange={(e) => setMaxRounds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </label>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8" disabled={create.isPending} onClick={submit}>
          {create.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {t("pairSetup.starting", { defaultValue: "Starting…" })}
            </>
          ) : (
            t("pairSetup.start", { defaultValue: "Start pair collaboration" })
          )}
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)}>
          {t("pairSetup.cancel", { defaultValue: "Cancel" })}
        </Button>
      </div>
    </section>
  );
}
