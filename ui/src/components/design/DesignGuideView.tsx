import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Palette, Type, Ruler, Component, Sparkles, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DesignGuide } from "@workcell/shared";
import { designGuideApi } from "../../api/design-flow";

// Design-system redesign (R1): the single canonical "design system guide" page.
// PHILOSOPHY-first — the board-authored intent/principles lead; the auto-extracted
// design tokens (color/type/spacing/components) are a SECONDARY reference below.
// Principles detected in the approved 시안 (Peak-End, 근접성, …) bridge the two.
export type GuideScope = { kind: "company" } | { kind: "project"; projectId: string };

const philosophyTemplate = (t: TFunction) =>
  t("designGuide.philosophyTemplate", {
    defaultValue: `## Design Philosophy
Describe the experience this app aims to give users in a sentence or two. (e.g., lower the learner's cognitive load and let them experience small wins often.)

## Core Principles
1. One screen, one task — ask only one thing at a time.
2. Immediate feedback — a clear response to every action.
3. Peak-End — finish on a positive note.

## Voice & Tone
A warm, encouraging tone. Plain words instead of jargon.

## Do / Don't
- Do: always show progress.
- Don't: don't put more than 5 options on one screen.`,
  });

export function DesignGuideView({
  companyId,
  scope,
}: {
  companyId: string;
  scope: GuideScope;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const queryKey = ["design-guide", scope.kind === "project" ? scope.projectId : `company:${companyId}`];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      scope.kind === "project"
        ? designGuideApi.getForProject(scope.projectId)
        : designGuideApi.getForCompany(companyId),
    enabled: Boolean(companyId),
  });

  // Seed the editor from the server once (don't clobber in-progress edits).
  useEffect(() => {
    if (data && !dirty) setNotes(data.notesMarkdown ?? "");
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: (md: string) =>
      scope.kind === "project"
        ? designGuideApi.updateForProject(scope.projectId, md)
        : designGuideApi.updateForCompany(companyId, md),
    onSuccess: () => {
      setErr(null);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("designGuide.loading", { defaultValue: "Loading guide…" })}
      </div>
    );
  }

  const guide: DesignGuide | undefined = data;
  const tokens = guide?.tokens;
  const principles = guide?.principles ?? [];

  return (
    <div className="space-y-6" data-testid="design-guide-view">
      {err ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      ) : null}

      {/* ── PHILOSOPHY (primary, board-authored) ───────────────────────────── */}
      <section className="rounded-xl border border-border bg-card p-4" data-testid="design-guide-philosophy">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <BookOpen className="h-4 w-4 text-primary" />
            {t("designGuide.philosophyHeading", { defaultValue: "Design Philosophy & Principles" })}
          </h3>
          <button
            type="button"
            onClick={() => save.mutate(notes)}
            disabled={save.isPending || !dirty}
            data-testid="design-guide-save"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> {t("designGuide.save", { defaultValue: "Save" })}
          </button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("designGuide.philosophyHelp", {
            defaultValue:
              "Write this app's design philosophy, principles, and voice yourself (the auto-extracted tokens below are for reference). Markdown is supported.",
          })}
        </p>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setDirty(true);
          }}
          data-testid="design-guide-notes"
          rows={notes.trim() ? 12 : 8}
          placeholder={philosophyTemplate(t)}
          className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-sm leading-relaxed focus:border-primary focus:outline-none"
        />
        {!notes.trim() ? (
          <button
            type="button"
            onClick={() => {
              setNotes(philosophyTemplate(t));
              setDirty(true);
            }}
            data-testid="design-guide-template"
            className="mt-2 text-xs text-primary hover:underline"
          >
            {t("designGuide.startFromTemplate", { defaultValue: "Start from template" })}
          </button>
        ) : null}
      </section>

      {/* ── PRINCIPLES detected in the approved 시안 ────────────────────────── */}
      {principles.length > 0 ? (
        <section className="rounded-xl border border-border bg-card p-4" data-testid="design-guide-principles">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("designGuide.principlesHeading", {
              defaultValue: "Design principles detected in mockups",
            })}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("designGuide.principlesHelp", {
              defaultValue:
                "UX principles found in the annotations of approved screen mockups — check whether they match the philosophy above.",
            })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {principles.map((p) => (
              <span
                key={p}
                className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
              >
                {p}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── AUTO-EXTRACTED TOKENS (secondary reference) ────────────────────── */}
      <section>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("designGuide.tokensHelp", {
            defaultValue:
              "Auto-extracted tokens · for reference — colors, typography, spacing, and components mechanically pulled from {{count}} approved screens.",
            count: guide?.screenCount ?? 0,
          })}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <TokenCard
            icon={<Palette className="h-4 w-4" />}
            title={t("designGuide.tokenColors", { defaultValue: "Colors" })}
            testid="guide-colors"
          >
            {tokens && tokens.colors.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tokens.colors.map((c) => (
                  <div key={c} className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-1">
                    <span className="h-4 w-4 rounded-sm border border-border" style={{ background: c }} />
                    <code className="text-[11px]">{c}</code>
                  </div>
                ))}
              </div>
            ) : (
              <Empty />
            )}
          </TokenCard>

          <TokenCard
            icon={<Type className="h-4 w-4" />}
            title={t("designGuide.tokenTypography", { defaultValue: "Typography" })}
            testid="guide-typography"
          >
            {tokens && (tokens.fontFamilies.length > 0 || tokens.fontSizes.length > 0) ? (
              <div className="space-y-2">
                <TokenChips items={tokens.fontFamilies} />
                <TokenChips items={tokens.fontSizes} />
              </div>
            ) : (
              <Empty />
            )}
          </TokenCard>

          <TokenCard
            icon={<Ruler className="h-4 w-4" />}
            title={t("designGuide.tokenSpacing", { defaultValue: "Spacing" })}
            testid="guide-spacing"
          >
            {tokens && tokens.spacing.length > 0 ? <TokenChips items={tokens.spacing} /> : <Empty />}
          </TokenCard>

          <TokenCard
            icon={<Component className="h-4 w-4" />}
            title={t("designGuide.tokenComponents", { defaultValue: "Components" })}
            testid="guide-components"
          >
            {tokens && tokens.components.length > 0 ? (
              <TokenChips items={tokens.components} prefix="<" suffix=">" />
            ) : (
              <Empty />
            )}
          </TokenCard>
        </div>
      </section>
    </div>
  );
}

function TokenCard({
  icon,
  title,
  testid,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid={testid}>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function TokenChips({ items, prefix, suffix }: { items: string[]; prefix?: string; suffix?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <code key={it} className="rounded-sm border border-border bg-muted/30 px-1.5 py-0.5 text-[11px]">
          {prefix}
          {it}
          {suffix}
        </code>
      ))}
    </div>
  );
}

function Empty() {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {t("designGuide.empty", { defaultValue: "No items extracted from approved screens." })}
    </p>
  );
}
