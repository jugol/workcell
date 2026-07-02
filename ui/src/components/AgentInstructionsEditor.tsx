import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { useToastActions } from "../context/ToastContext";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * WC-186 (CP4): inline "Custom instructions" editor mounted on the agent config
 * surface. Lets a user type/paste a custom behaviour charter for an agent without
 * the file picker, then persists it to the MANAGED instructions bundle entry file
 * (the AGENTS.md-equivalent the agent reads first).
 *
 * It reuses the existing instructions-bundle routes:
 *   - GET  /agents/:id/instructions-bundle        (resolve mode + entry file)
 *   - GET  /agents/:id/instructions-bundle/file    (load current entry content)
 *   - PUT  /agents/:id/instructions-bundle/file    (save typed content; managed)
 *
 * The file-picker / external-mode flow (PathInstructionsModal + the Instructions
 * tab on AgentDetail) stays intact — this surface only edits managed charter text.
 */
export function AgentInstructionsEditor({
  agentId,
  companyId,
  agentRouteId,
}: {
  agentId: string;
  companyId?: string;
  /** Route ref used to invalidate the agent detail query; falls back to agentId. */
  agentRouteId?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const { data: bundle, isLoading: bundleLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agentId),
    queryFn: () => agentsApi.instructionsBundle(agentId, companyId),
    enabled: Boolean(agentId),
  });

  const entryFile = bundle?.entryFile ?? "AGENTS.md";
  // Managed mode (or a not-yet-configured bundle) edits the charter inline. When
  // an external bundle is configured we don't take over its files here — that is
  // the file-picker's domain — so the inline editor is hidden for external mode.
  const isExternal = bundle?.mode === "external";
  const entryFileExists = Boolean(bundle?.files.some((file) => file.path === entryFile));

  const { data: fileDetail, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agentId, entryFile),
    queryFn: () => agentsApi.instructionsFile(agentId, entryFile, companyId),
    enabled: Boolean(agentId && bundle && !isExternal && entryFileExists),
  });

  const currentContent = entryFileExists ? (fileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const isDirty = draft !== null && draft !== currentContent;

  // Drop a stale draft once the freshly saved content lands so the editor tracks
  // the persisted value again (mirrors the AgentDetail prompts editor).
  useEffect(() => {
    if (draft !== null && draft === currentContent) {
      setDraft(null);
    }
  }, [currentContent, draft]);

  useEffect(() => {
    if (!justSaved) return;
    const handle = window.setTimeout(() => setJustSaved(false), 2500);
    return () => window.clearTimeout(handle);
  }, [justSaved]);

  const saveFile = useMutation({
    mutationFn: (content: string) =>
      agentsApi.saveInstructionsFile(
        agentId,
        {
          path: entryFile,
          content,
          clearLegacyPromptTemplate:
            Boolean(bundle?.legacyPromptTemplateActive) ||
            Boolean(bundle?.legacyBootstrapPromptTemplateActive),
        },
        companyId,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agentId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agentId, entryFile) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      if (agentRouteId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRouteId) });
      setDraft(null);
      setJustSaved(true);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("agentInstructionsEditor.saveErrorTitle", { defaultValue: "Couldn't save instructions" }),
        body: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!companyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(companyId, file, namespace);
    },
  });

  const showLoading = bundleLoading || (fileLoading && entryFileExists && !fileDetail);

  return (
    <div className="space-y-2" data-testid="agent-instructions-editor">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground">
            {t("agentInstructionsEditor.label", { defaultValue: "Custom instructions" })}
          </label>
          <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground">
            {entryFile}
          </code>
        </div>
        <div className="flex items-center gap-2">
          {justSaved && !isDirty && (
            <span className="text-xs text-muted-foreground" data-testid="agent-instructions-saved">
              {t("agentInstructionsEditor.saved", { defaultValue: "Saved" })}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={() => saveFile.mutate(displayValue)}
            disabled={!isDirty || saveFile.isPending || isExternal}
          >
            {saveFile.isPending
              ? t("agentInstructionsEditor.saving", { defaultValue: "Saving..." })
              : t("agentInstructionsEditor.save", { defaultValue: "Save" })}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("agentInstructionsEditor.help", {
          defaultValue: "Tell this agent how to behave. Saved to its managed instructions; the agent reads this first.",
        })}
      </p>

      {isExternal ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("agentInstructionsEditor.externalNotice", {
            defaultValue:
              "This agent uses an external instructions file. Edit it where it lives on disk, or switch to managed mode in the Instructions tab to author it inline.",
          })}
        </div>
      ) : showLoading ? (
        <div className="min-h-[160px] animate-pulse rounded-md border border-border bg-muted/30" />
      ) : (
        <MarkdownEditor
          key={`${agentId}:${entryFile}`}
          value={displayValue}
          onChange={(value) => setDraft(value ?? "")}
          placeholder={t("agentInstructionsEditor.placeholder", {
            defaultValue: "# How this agent should behave\n\nWrite custom instructions here...",
          })}
          className={cn("min-w-0 overflow-hidden")}
          contentClassName="min-h-[160px] max-w-full break-words text-sm font-mono"
          imageUploadHandler={async (file) => {
            const namespace = `agents/${agentId}/instructions/${entryFile.replaceAll("/", "-")}`;
            const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
            return asset.contentPath;
          }}
        />
      )}
    </div>
  );
}
