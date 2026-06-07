import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
  PLAN_REPORT_LANGUAGES,
  DEFAULT_PLAN_REPORT_LANGUAGE,
} from "@workcell/shared";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings, CloudUpload, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
} from "../components/agent-config-primitives";

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  // WC-89: plan-report language is set at onboarding (WC-81); let the board
  // change it here afterwards.
  const [planReportLanguage, setPlanReportLanguage] = useState(DEFAULT_PLAN_REPORT_LANGUAGE);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
    setPlanReportLanguage(selectedCompany.planReportLanguage ?? DEFAULT_PLAN_REPORT_LANGUAGE);
  }, [selectedCompany]);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;
  const cloudSyncEnabled = experimentalSettings?.enableCloudSync === true;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) ||
      planReportLanguage !== (selectedCompany.planReportLanguage ?? DEFAULT_PLAN_REPORT_LANGUAGE));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
      planReportLanguage: string;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  // WC-198: company-level design-first gate toggle.
  const designFirstMutation = useMutation({
    mutationFn: (requireDesignFirst: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireDesignFirst
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  const unarchiveMutation = useMutation({
    mutationFn: (companyId: string) =>
      companiesApi.update(companyId, { status: "active" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteNameInput, setDeleteNameInput] = useState("");
  const deleteMutation = useMutation({
    mutationFn: ({
      companyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.remove(companyId),
    onSuccess: async (_result, { nextCompanyId }) => {
      setDeleteConfirmOpen(false);
      setDeleteNameInput("");
      // Switch to another active company when one exists; otherwise the
      // CompanyContext auto-clears the selection once the list refetches empty.
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companySettings.breadcrumbCompany", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("companySettings.breadcrumbSettings", { defaultValue: "Settings" }) }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name, t]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("companySettings.noCompany", { defaultValue: "No company selected. Select a company from the switcher above." })}
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      attachmentMaxBytes,
      planReportLanguage
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("companySettings.heading", { defaultValue: "Company Settings" })}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.general", { defaultValue: "General" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("companySettings.name.label", { defaultValue: "Company name" })}
            hint={t("companySettings.name.hint", { defaultValue: "The display name for your company." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.description.label", { defaultValue: "Description" })}
            hint={t("companySettings.description.hint", { defaultValue: "Optional description shown in the company profile." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("companySettings.description.placeholder", { defaultValue: "Optional company description" })}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.planLanguage.label", { defaultValue: "Plan report language" })}
            hint={t("companySettings.planLanguage.hint", { defaultValue: "The Orchestrator writes plan reports and issue drafts in this language." })}
          >
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={planReportLanguage}
              onChange={(e) => setPlanReportLanguage(e.target.value)}
            >
              {PLAN_REPORT_LANGUAGES.map((entry) => (
                <option key={entry.code} value={entry.code} className="bg-background text-foreground">
                  {entry.nativeLabel === entry.label
                    ? entry.label
                    : `${entry.nativeLabel} — ${entry.label}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.appearance", { defaultValue: "Appearance" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("companySettings.logo.label", { defaultValue: "Logo" })}
                hint={t("companySettings.logo.hint", { defaultValue: "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image." })}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? t("companySettings.logo.removing", { defaultValue: "Removing..." }) : t("companySettings.logo.remove", { defaultValue: "Remove logo" })}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("companySettings.logo.uploadFailed", { defaultValue: "Logo upload failed" }))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">{t("companySettings.logo.uploading", { defaultValue: "Uploading logo..." })}</span>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.brandColor.label", { defaultValue: "Brand color" })}
                hint={t("companySettings.brandColor.hint", { defaultValue: "Sets the hue for the company icon. Leave empty for auto-generated color." })}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={t("companySettings.brandColor.placeholder", { defaultValue: "Auto" })}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("companySettings.brandColor.clear", { defaultValue: "Clear" })}
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.attachment.label", { defaultValue: "Attachment size limit" })}
                hint={t("companySettings.attachment.hint", { defaultValue: "Accepted range: 1-{{max}} MiB.", max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <span className="text-xs text-destructive">
                      {t("companySettings.attachment.invalid", { defaultValue: "Enter a whole number from 1 to {{max}}.", max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
                    </span>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
          >
            {generalMutation.isPending ? t("companySettings.save.saving", { defaultValue: "Saving..." }) : t("companySettings.save.save", { defaultValue: "Save changes" })}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("companySettings.save.saved", { defaultValue: "Saved" })}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("companySettings.save.failed", { defaultValue: "Failed to save" })}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.hiring", { defaultValue: "Hiring" })}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("companySettings.hiring.label", { defaultValue: "Require board approval for new hires" })}
            hint={t("companySettings.hiring.hint", { defaultValue: "New agent hires stay pending until approved by board." })}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            disabled={settingsMutation.isPending}
            toggleTestId="company-settings-team-approval-toggle"
          />
          {settingsMutation.isError && (
            <p className="mt-2 text-xs text-destructive" data-testid="company-settings-team-approval-error">
              {t("companySettings.toggle.saveFailed", { defaultValue: "Couldn't save — try again." })}
            </p>
          )}
        </div>
        {/* WC-198: company-level design-first gate */}
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="디자인-우선 (Design-first)"
            hint="켜면 이 회사의 모든 이슈는 승인된 디자인이 없으면 완료할 수 없습니다. 이슈별로 '예외 처리'할 수 있습니다."
            checked={selectedCompany.requireDesignFirst ?? false}
            onChange={(v) => designFirstMutation.mutate(v)}
            disabled={designFirstMutation.isPending}
            toggleTestId="company-settings-design-first-toggle"
          />
          {designFirstMutation.isError && (
            <p className="mt-2 text-xs text-destructive" data-testid="company-settings-design-first-error">
              {t("companySettings.toggle.saveFailed", { defaultValue: "Couldn't save — try again." })}
            </p>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.packages", { defaultValue: "Company Packages" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.packages.movedPrefix", { defaultValue: "Import and export have moved to dedicated pages accessible from the " })}
            <a href="/org" className="underline hover:text-foreground">{t("companySettings.packages.orgChartLink", { defaultValue: "Org Chart" })}</a>
            {t("companySettings.packages.movedSuffix", { defaultValue: " header." })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cloudSyncEnabled ? (
              <Button size="sm" asChild>
                <a href="/company/settings/cloud-upstream">
                  <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                  {t("companySettings.packages.sendToCloud", { defaultValue: "Send to Workcell Cloud" })}
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.packages.export", { defaultValue: "Export" })}
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.packages.import", { defaultValue: "Import" })}
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("companySettings.section.dangerZone", { defaultValue: "Danger Zone" })}
        </div>
        <div className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          {/* Archive / Unarchive */}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {selectedCompany.status === "archived"
                ? t("companySettings.danger.archivedNote", { defaultValue: "This company is archived and hidden from the sidebar. Unarchive it to make it active again." })
                : t("companySettings.danger.description", { defaultValue: "Archive this company to hide it from the sidebar. This persists in the database." })}
            </p>
            <div className="flex items-center gap-2">
              {selectedCompany.status === "archived" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unarchiveMutation.isPending}
                  onClick={() => {
                    if (selectedCompanyId) unarchiveMutation.mutate(selectedCompanyId);
                  }}
                >
                  {unarchiveMutation.isPending
                    ? t("companySettings.danger.unarchiving", { defaultValue: "Unarchiving..." })
                    : t("companySettings.danger.unarchive", { defaultValue: "Unarchive company" })}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={archiveMutation.isPending}
                  onClick={() => {
                    if (!selectedCompanyId) return;
                    const confirmed = window.confirm(
                      t("companySettings.danger.confirm", {
                        defaultValue: 'Archive company "{{name}}"? It will be hidden from the sidebar.',
                        name: selectedCompany.name,
                      }),
                    );
                    if (!confirmed) return;
                    const nextCompanyId =
                      companies.find(
                        (company) =>
                          company.id !== selectedCompanyId &&
                          company.status !== "archived"
                      )?.id ?? null;
                    archiveMutation.mutate({
                      companyId: selectedCompanyId,
                      nextCompanyId
                    });
                  }}
                >
                  {archiveMutation.isPending
                    ? t("companySettings.danger.archiving", { defaultValue: "Archiving..." })
                    : t("companySettings.danger.archive", { defaultValue: "Archive company" })}
                </Button>
              )}
              {(archiveMutation.isError || unarchiveMutation.isError) && (
                <span className="text-xs text-destructive">
                  {t("companySettings.danger.failed", { defaultValue: "Action failed. Please try again." })}
                </span>
              )}
            </div>
          </div>

          <div className="border-t border-destructive/20" />

          {/* Delete (permanent) */}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("companySettings.danger.deleteDescription", { defaultValue: "Permanently delete this company and all of its agents, issues, and data. This cannot be undone." })}
            </p>
            {!deleteConfirmOpen ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {t("companySettings.danger.delete", { defaultValue: "Delete company" })}
              </Button>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs text-muted-foreground">
                  {t("companySettings.danger.deleteConfirmLabel", { defaultValue: "Type the company name to confirm:" })}{" "}
                  <span className="font-mono text-foreground">{selectedCompany.name}</span>
                </label>
                <Input
                  value={deleteNameInput}
                  onChange={(event) => setDeleteNameInput(event.target.value)}
                  placeholder={selectedCompany.name}
                  className="max-w-xs"
                  aria-label={t("companySettings.danger.deleteConfirmLabel", { defaultValue: "Type the company name to confirm:" })}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={
                      deleteMutation.isPending ||
                      deleteNameInput !== selectedCompany.name
                    }
                    onClick={() => {
                      if (!selectedCompanyId || deleteNameInput !== selectedCompany.name) return;
                      const nextCompanyId =
                        companies.find(
                          (company) =>
                            company.id !== selectedCompanyId &&
                            company.status !== "archived"
                        )?.id ?? null;
                      deleteMutation.mutate({
                        companyId: selectedCompanyId,
                        nextCompanyId
                      });
                    }}
                  >
                    {deleteMutation.isPending
                      ? t("companySettings.danger.deleting", { defaultValue: "Deleting..." })
                      : t("companySettings.danger.deleteConfirmButton", { defaultValue: "Permanently delete" })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      setDeleteConfirmOpen(false);
                      setDeleteNameInput("");
                    }}
                  >
                    {t("companySettings.danger.cancel", { defaultValue: "Cancel" })}
                  </Button>
                </div>
                {deleteMutation.isError && (
                  <span className="text-xs text-destructive">
                    {deleteMutation.error instanceof Error
                      ? deleteMutation.error.message
                      : t("companySettings.danger.deleteFailed", { defaultValue: "Failed to delete company" })}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
