import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { useTranslation } from "@/i18n";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const RESTART_PENDING_RESET_MS = 30_000;

function formatRelativeTimestamp(value: string | null, t: TranslateFn): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return t("devRestartBanner.relativeTime.justNow", { defaultValue: "just now" });
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return t("devRestartBanner.relativeTime.minutesAgo", { defaultValue: "{{count}}m ago", count: deltaMinutes });
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return t("devRestartBanner.relativeTime.hoursAgo", { defaultValue: "{{count}}h ago", count: deltaHours });
  const deltaDays = Math.round(deltaHours / 24);
  return t("devRestartBanner.relativeTime.daysAgo", { defaultValue: "{{count}}d ago", count: deltaDays });
}

function describeReason(devServer: DevServerHealthStatus, t: TranslateFn): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return t("devRestartBanner.reason.backendChangesAndPendingMigrations", { defaultValue: "backend files changed and migrations are pending" });
  }
  if (devServer.reason === "pending_migrations") {
    return t("devRestartBanner.reason.pendingMigrations", { defaultValue: "pending migrations need a fresh boot" });
  }
  return t("devRestartBanner.reason.backendChanges", { defaultValue: "backend files changed since this server booted" });
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const [restartPending, setRestartPending] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    if (!restartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending]);

  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const currentDevServer = devServer;
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt, t);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunLabel = `${devServer.activeRunCount} live run${
    devServer.activeRunCount === 1 ? "" : "s"
  }`;

  async function requestRestartNow() {
    const warning =
      currentDevServer.activeRunCount > 0
        ? t("devRestartBanner.confirm.withRuns", { defaultValue: "Restart Workcell now? This may interrupt {{runs}}.", runs: activeRunLabel })
        : t("devRestartBanner.confirm.simple", { defaultValue: "Restart Workcell now?" });
    if (!window.confirm(warning)) return;

    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      window.alert(error instanceof Error ? error.message : t("devRestartBanner.error.requestFailed", { defaultValue: "Failed to request restart" }));
    }
  }

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("devRestartBanner.title", { defaultValue: "Restart Required" })}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {t("devRestartBanner.autoRestartOn", { defaultValue: "Auto-Restart On" })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer, t)}
            {changedAt ? t("devRestartBanner.updatedSuffix", { defaultValue: " · updated {{changedAt}}", changedAt }) : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {t("devRestartBanner.changedLabel", { defaultValue: "Changed:" })} {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? t("devRestartBanner.moreSuffix", { defaultValue: " +{{count}} more", count: devServer.changedPathCount - sample.length }) : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {t("devRestartBanner.pendingMigrationsLabel", { defaultValue: "Pending migrations:" })} {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? t("devRestartBanner.moreSuffix", { defaultValue: " +{{count}} more", count: devServer.pendingMigrations.length - 2 }) : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.waitingForRuns", { defaultValue: "Waiting for {{runs}} to finish", runs: activeRunLabel })}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.autoRestartIdle", { defaultValue: "Auto-restart will trigger when the instance is idle" })}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.manualRestartPrefix", { defaultValue: "Restart" })} <code>pnpm dev:once</code> {t("devRestartBanner.manualRestartSuffix", { defaultValue: "after the active work is safe to interrupt" })}</span>
            </div>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
            onClick={() => {
              void requestRestartNow();
            }}
            disabled={restartPending}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{restartPending ? t("devRestartBanner.button.requested", { defaultValue: "Restart requested" }) : t("devRestartBanner.button.restartNow", { defaultValue: "Restart now" })}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
