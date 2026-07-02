/// <reference path="./types/express.d.ts" />
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  prepareEmbeddedPostgresNativeRuntime,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@workcell/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { resolveWorkcellEnvPath } from "./paths.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  backfillPrincipalAccessCompatibility,
  buildDefaultPairTurnExecutor,
  heartbeatService,
  instanceSettingsService,
  pairAutoRunTicker,
  pairRoundOrchestrator,
  reapStaleDeliberationRuns,
  reconcileCloudUpstreamRunsOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
  sweepLeakedWorktrees,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { terminateLocalService } from "./services/local-service-supervisor.js";
import { drainActiveWork } from "./services/shutdown-drain.js";
import { runningProcesses } from "./adapters/index.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { reapStalePluginJobRuns } from "./services/plugin-job-store.js";
import { createSingleFlightGuard } from "./services/single-flight.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { assessPostmasterLock } from "./embedded-postgres-lock.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

// Guard so repeated startServer() calls (e.g. in tests) don't stack duplicate
// process-level error handlers on the singleton process object.
let processErrorHandlersRegistered = false;

// Names of the process-level safety-net handlers this server installs. Exposed
// for a smoke assertion that startup wired them up.
export const PROCESS_SAFETY_NET_EVENTS = [
  "unhandledRejection",
  "uncaughtException",
] as const;

export function hasProcessSafetyNetHandlers(): boolean {
  return (
    processErrorHandlersRegistered &&
    PROCESS_SAFETY_NET_EVENTS.every((event) => process.listenerCount(event) > 0)
  );
}

/**
 * Install the process-level safety net. The app is full of fire-and-forget
 * `void fn().then().catch()` work; an unhandled rejection or a throw escaping
 * one of those would otherwise crash the process (Node's default for
 * uncaughtException) or, depending on the runtime, silently terminate.
 *
 * Policy:
 *   - unhandledRejection: ALWAYS log with context, then KEEP serving. A single
 *     dropped promise must not take the whole instance down.
 *   - uncaughtException: log, then attempt a graceful `shutdown` on a short
 *     bounded deadline (so a wedged shutdown can't hang forever) before exiting
 *     non-zero, so a supervisor (systemd/Docker/PM2) can restart from a known
 *     bad state.
 *
 * Idempotent: repeated calls (e.g. multiple startServer() in tests) are no-ops
 * after the first so handlers don't stack on the singleton process object.
 */
export function registerProcessSafetyNetHandlers(
  shutdown: (reason: string, exitCode: number) => Promise<void>,
  options?: { shutdownDeadlineMs?: number },
): boolean {
  if (processErrorHandlersRegistered) return false;
  processErrorHandlersRegistered = true;

  const shutdownDeadlineMs = options?.shutdownDeadlineMs ?? 3000;

  process.on("unhandledRejection", (reason, promise) => {
    logger.error(
      { err: reason, promise: String(promise) },
      "Unhandled promise rejection (server continues serving)",
    );
  });

  let handlingUncaughtException = false;
  process.on("uncaughtException", (err, origin) => {
    // If a second exception lands while we are already tearing down, log it and
    // exit immediately rather than recursing into shutdown again.
    if (handlingUncaughtException) {
      logger.error({ err, origin }, "Uncaught exception during shutdown; exiting now");
      process.exit(1);
      return;
    }
    handlingUncaughtException = true;
    logger.error({ err, origin }, "Uncaught exception; attempting graceful shutdown before exit");

    const forceExit = setTimeout(() => {
      logger.error("Graceful shutdown did not finish within deadline; forcing exit");
      process.exit(1);
    }, shutdownDeadlineMs);
    // Do not let this timer keep the event loop alive on its own.
    forceExit.unref?.();

    void shutdown("uncaughtException", 1).catch((shutdownErr) => {
      logger.error({ err: shutdownErr }, "Graceful shutdown failed after uncaught exception");
      process.exit(1);
    });
  });

  return true;
}

// ---- Embedded PostgreSQL readiness (recovering-orphan tolerance) ----
// A dirty shutdown can leave the embedded postmaster orphaned mid-crash-recovery.
// The next boot reuses it (postmaster.pid alive) but the FIRST admin query then
// failed with "the database system is starting up" (SQLSTATE 57P03) and the whole
// server start aborted — the recurring boot failure after any unclean stop.
// Recovery normally completes in seconds, so the right behavior is to WAIT; and
// if the reused postmaster never becomes ready, kill it and start our own
// (interrupting WAL replay is safe — it is idempotent and redone on next start).
export function isEmbeddedPostgresNotReadyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && ["57P03", "ECONNREFUSED", "ECONNRESET"].includes(code)) {
    return true;
  }
  if (typeof message !== "string") return false;
  return /database system is (starting up|shutting down|in recovery)|connect ECONNREFUSED/i.test(
    message,
  );
}

export async function retryUntilPostgresReady<T>(
  attempt: () => Promise<T>,
  opts: { timeoutMs: number; delayMs?: number; onWaiting?: () => void },
): Promise<T> {
  const delayMs = opts.delayMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let waiting = false;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      // Non-transient errors and deadline overruns propagate to the caller —
      // the reuse path turns a still-transient error into the takeover fallback.
      if (!isEmbeddedPostgresNotReadyError(err) || Date.now() + delayMs > deadline) throw err;
      if (!waiting) {
        waiting = true;
        opts.onWaiting?.();
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}

export async function startServer(): Promise<StartedServer> {
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.WORKCELL_SECRETS_PROVIDER === undefined) {
    process.env.WORKCELL_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.WORKCELL_SECRETS_STRICT_MODE === undefined) {
    process.env.WORKCELL_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.WORKCELL_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.WORKCELL_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }

  // Zero-config agent credentials for local_trusted: without
  // WORKCELL_AGENT_JWT_SECRET (or BETTER_AUTH_SECRET) every JWT mint silently
  // returns null, so NO agent run ever receives WORKCELL_API_KEY — agents then
  // either launder the board's identity or (post identity-rule) hard-block on
  // their first real action. Local single-user installs should never trip on
  // this, so generate and persist the secret on first boot.
  if (
    config.deploymentMode === "local_trusted" &&
    !process.env.WORKCELL_AGENT_JWT_SECRET?.trim() &&
    !process.env.BETTER_AUTH_SECRET?.trim() &&
    // never write real user files from the test runner
    !process.env.VITEST
  ) {
    try {
      const envPath = resolveWorkcellEnvPath();
      const generatedSecret = randomBytes(32).toString("hex");
      await mkdir(dirname(envPath), { recursive: true });
      await appendFile(envPath, `WORKCELL_AGENT_JWT_SECRET=${generatedSecret}\n`, "utf8");
      process.env.WORKCELL_AGENT_JWT_SECRET = generatedSecret;
      logger.info({ envPath }, "Generated WORKCELL_AGENT_JWT_SECRET for local_trusted — agent runs now receive API credentials");
    } catch (err) {
      logger.warn({ err }, "Failed to auto-provision WORKCELL_AGENT_JWT_SECRET — agent runs will have no API credentials");
    }
  }

  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.WORKCELL_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.WORKCELL_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set WORKCELL_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set WORKCELL_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function isPostgresConnectionString(connectionString: string): boolean {
    try {
      const parsed = new URL(connectionString);
      return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
    } catch {
      return false;
    }
  }

  function assertCloudDatabaseContract(): void {
    if (config.deploymentMode !== "authenticated" || config.deploymentExposure !== "public") {
      return;
    }
    if (!config.databaseUrl) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL or config.database.connectionString; refusing embedded PostgreSQL fallback",
      );
    }
    if (!isPostgresConnectionString(config.databaseUrl)) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
      );
    }
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
      if (!parsed.port) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@workcell.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let pluginMigrationDb;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  assertCloudDatabaseContract();
  if (config.databaseUrl) {
    const migrationUrl = config.databaseMigrationUrl ?? config.databaseUrl;
    migrationSummary = await ensureMigrations(migrationUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    pluginMigrationDb = config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
    await prepareEmbeddedPostgresNativeRuntime();
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.WORKCELL_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    // Start our own postmaster on the embedded data dir. Shared by the normal
    // fresh-start path and the recovering-orphan takeover below.
    const startFreshEmbeddedPostgres = async () => {
      const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "workcell",
          password: "workcell",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        // Only remove postmaster.pid when it is genuinely stale. If a prior
        // server died dirty, its embedded postmaster may still be alive
        // (orphaned), holding this data dir's shared memory. Deleting a *live*
        // postmaster's pid file strands it: pg_ctl stop needs that file to find
        // the cluster, so removal escalates a recoverable orphan into one needing
        // an elevated kill / reboot. assessPostmasterLock treats EPERM/unknown as
        // "live" (the orphan can't be inspected), so the conservative path here
        // surfaces an actionable error instead of silently orphaning a postmaster.
        const lock = assessPostmasterLock({ pidFilePath: postmasterPidFile });
        if (lock.state === "stale") {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        } else if (lock.state === "live") {
          throw formatEmbeddedPostgresError(
            new Error("Embedded PostgreSQL lock file refers to a live postmaster"),
            {
              fallbackMessage: `A previous embedded PostgreSQL postmaster (PID ${lock.pid}) is still running and holds ${dataDir}. Terminate that process (it may require elevated privileges) or start with a fresh WORKCELL_HOME. Not deleting its lock file (doing so would orphan it).`,
              recentLogs: logBuffer.getRecentLogs(),
            },
          );
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
    };

    let reusedExistingPostmasterPid: number | null = null;
    const runningPid = getRunningPid();
    if (runningPid) {
      // The postmaster may be an orphan of a dirty shutdown still replaying WAL
      // ("the database system is starting up") — the first-query wait below
      // tolerates that, and a wedged orphan is taken over instead of aborting.
      reusedExistingPostmasterPid = runningPid;
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://workcell:workcell@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "workcell");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        await startFreshEmbeddedPostgres();
      }
    }

    // First admin query. A reused postmaster may still be in crash recovery —
    // wait for it instead of aborting the whole server start on 57P03; if it
    // never becomes ready, kill the wedged orphan and start our own (WAL replay
    // is idempotent, so interrupting a recovering postmaster is safe).
    const embeddedPgReadyTimeoutMs = (() => {
      const raw = Number.parseInt(process.env.WORKCELL_EMBEDDED_PG_READY_TIMEOUT_MS ?? "", 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
    })();
    const ensureWorkcellDbWhenReady = () =>
      retryUntilPostgresReady(
        () => ensurePostgresDatabase(`postgres://workcell:workcell@127.0.0.1:${port}/postgres`, "workcell"),
        {
          timeoutMs: embeddedPgReadyTimeoutMs,
          onWaiting: () =>
            logger.info(
              "Embedded PostgreSQL is still starting up (crash recovery after an unclean shutdown?); waiting for it to accept connections",
            ),
        },
      );
    let dbStatus: Awaited<ReturnType<typeof ensurePostgresDatabase>>;
    try {
      dbStatus = await ensureWorkcellDbWhenReady();
    } catch (err) {
      if (reusedExistingPostmasterPid === null || !isEmbeddedPostgresNotReadyError(err)) {
        throw err;
      }
      logger.warn(
        { pid: reusedExistingPostmasterPid, err },
        "Reused embedded PostgreSQL never became ready; terminating the wedged postmaster and starting a fresh one",
      );
      await terminateLocalService(
        { pid: reusedExistingPostmasterPid, processGroupId: null },
        { forceAfterMs: 5_000 },
      );
      const lockAfterKill = assessPostmasterLock({ pidFilePath: postmasterPidFile });
      if (lockAfterKill.state === "stale") {
        rmSync(postmasterPidFile, { force: true });
      } else if (lockAfterKill.state === "live") {
        throw formatEmbeddedPostgresError(
          new Error("Embedded PostgreSQL postmaster survived termination"),
          {
            fallbackMessage: `The wedged embedded PostgreSQL postmaster (PID ${reusedExistingPostmasterPid}) could not be terminated (elevated privileges may be required). Terminate it manually, then restart Workcell.`,
            recentLogs: logBuffer.getRecentLogs(),
          },
        );
      }
      await startFreshEmbeddedPostgres();
      dbStatus = await ensureWorkcellDbWhenReady();
    }
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: workcell");
    }
  
    const embeddedConnectionString = `postgres://workcell:workcell@127.0.0.1:${port}/workcell`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    pluginMigrationDb = db;
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }

  const requestedListenPort = config.port;
  const listenPort = await detectPort(requestedListenPort);
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
  if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
    logger.info(accessBackfill, "Backfilled principal access compatibility records");
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config, { listenPort });
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }

  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const backupSettingsSvc = instanceSettingsService(db);
  let databaseBackupInFlight = false;
  const runServerDatabaseBackup = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "scheduled" ? "Automatic" : "Manual";
    try {
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;

      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retention,
        filenamePrefix: "workcell",
      });
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: config.databaseBackupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    databaseBackupService: {
      runManualBackup: async () => {
        const result = await runServerDatabaseBackup("manual");
        if (!result) {
          throw conflict("Database backup already in progress");
        }
        return result;
      },
    },
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== requestedListenPort) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiUrl = choosePrimaryRuntimeApiUrl({
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  const configuredApiUrl = process.env.WORKCELL_API_URL?.trim() || runtimeApiUrl;
  const runtimeApiCandidates = buildRuntimeApiCandidateUrls({
    preferredApiUrl: configuredApiUrl,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.WORKCELL_LISTEN_HOST = runtimeListenHost;
  process.env.WORKCELL_LISTEN_PORT = String(listenPort);
  process.env.WORKCELL_RUNTIME_API_URL = runtimeApiUrl;
  process.env.WORKCELL_RUNTIME_API_CANDIDATES_JSON = JSON.stringify(runtimeApiCandidates);
  process.env.WORKCELL_API_URL = configuredApiUrl;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  void reconcileCloudUpstreamRunsOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled cloud upstream runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of cloud upstream runs failed");
    });

  // WC-211 (finding 3): fail orphaned "running" deliberation runs left behind by
  // a crash/restart (the fire-and-forget loop dies with the process) so they do
  // not poll forever. Mirrors the cloud-upstream startup reconciliation above.
  void reapStaleDeliberationRuns(db as any)
    .then((result) => {
      if (result.reaped > 0) {
        logger.warn(
          { reaped: result.reaped },
          "reaped orphaned 'running' deliberation runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reaping of orphaned deliberation runs failed");
    });

  // Production-readiness Wave 2 (REL — plugin-job boot reaper): fail orphaned
  // 'running' plugin job runs left behind by a crash/restart. `markRunning` is a
  // plain UPDATE (no CAS), so a process death mid-run leaves the row 'running'
  // forever and the scheduler's overlap check then permanently blocks that job.
  // Run once at startup while in-memory scheduler state is empty (mirrors the
  // deliberation reaper above).
  void reapStalePluginJobRuns(db as any)
    .then((result) => {
      if (result.reaped > 0) {
        logger.warn(
          { reaped: result.reaped },
          "reaped orphaned 'running' plugin job runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reaping of orphaned plugin job runs failed");
    });

  // WC-219 (Item 1): periodically prune leaked git worktrees. `git worktree
  // prune` (admin-metadata GC for already-missing worktrees) always runs; orphan
  // worktree DIRECTORIES (unregistered + unreferenced by any active workspace)
  // are LOGGED by default and only deleted when aged past the threshold AND
  // WORKCELL_WORKTREE_SWEEP_DELETE=1 is set. Runs once at startup, then on an
  // env-gated interval. Single-flight so a slow sweep never overlaps itself.
  const runWorktreeSweep = () =>
    sweepLeakedWorktrees(db as any, {
      maxAgeMs: config.worktreeSweepMaxAgeMs,
      deleteEnabled: config.worktreeSweepDeleteEnabled,
      logger,
    })
      .then((result) => {
        if (result.orphans > 0 || result.deleted > 0) {
          logger.warn({ ...result }, "worktree sweep completed");
        } else {
          logger.debug({ ...result }, "worktree sweep completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "worktree sweep failed");
      });

  void runWorktreeSweep();
  const worktreeSweepGuard = createSingleFlightGuard(() => {
    logger.warn({}, "worktree sweep skipped: previous sweep still in flight");
  });
  // Declared here (above the heartbeat/backup handles) so the shutdown drain can
  // clearInterval() it; see clearIntervals() below.
  const worktreeSweepInterval: ReturnType<typeof setInterval> = setInterval(() => {
    void worktreeSweepGuard.run(() => runWorktreeSweep());
  }, config.worktreeSweepIntervalMs);

  // WC-216: capture the scheduler + backup interval handles at this outer scope
  // so the graceful-shutdown drain can clearInterval() them to stop intake
  // before terminating in-flight heartbeat run processes. They stay undefined
  // when the corresponding feature is disabled (clearInterval(undefined) is a
  // harmless no-op).
  let heartbeatSchedulerInterval: ReturnType<typeof setInterval> | undefined;
  let pairAutoRunInterval: ReturnType<typeof setInterval> | undefined;
  let databaseBackupInterval: ReturnType<typeof setInterval> | undefined;

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any, { pluginWorkerManager });
    const routines = routineService(db as any, { pluginWorkerManager });
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    // reason:"startup" => treat these as interrupted-by-restart (resume), not crashed.
    void heartbeat
      .reapOrphanedRuns({ reason: "startup" })
      .then(() => heartbeat.promoteDueScheduledRetries())
      .then(async (promotion) => {
        await heartbeat.resumeQueuedRuns();
        const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
        if (
          promotion.promoted > 0 ||
          reconciled.assignmentDispatched > 0 ||
          reconciled.dispatchRequeued > 0 ||
          reconciled.continuationRequeued > 0 ||
          reconciled.successfulRunHandoffEscalated > 0 ||
          reconciled.escalated > 0
        ) {
          logger.warn(
            { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
            "startup heartbeat recovery changed assigned issue state",
          );
        }
      })
      .then(async () => {
        const reconciled = await heartbeat.reconcileIssueGraphLiveness();
        if (reconciled.escalationsCreated > 0) {
          logger.warn({ ...reconciled }, "startup issue-graph liveness reconciliation created escalations");
        }
      })
      .then(async () => {
        const scanned = await heartbeat.scanSilentActiveRuns();
        if (scanned.created > 0 || scanned.escalated > 0) {
          logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
        }
      })
      .then(async () => {
        const reviewed = await heartbeat.reconcileProductivityReviews();
        if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
          logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
    // Production-readiness Wave 2 (REL — tick re-entrancy guard): the periodic
    // tick fans out several reconcilers (timer enqueue, routine triggers,
    // orphan-reap → resume → stranded-issue → liveness → silent-run → productivity).
    // Under load a single tick can outlast the interval; without a guard the next
    // tick starts while the previous is still in flight, so concurrent recovery
    // passes race (e.g. read-then-insert dedup double-creates escalation issues).
    // The single-flight guard makes ticks non-overlapping: a tick that fires while
    // the previous one is still running is skipped (and warn-logged) instead of
    // piling on. The guard releases only after every branch settles, so a rejection
    // cannot wedge it; each reconciler also keeps its own catch so one failing
    // branch neither aborts the others nor leaks a rejection.
    const heartbeatTickGuard = createSingleFlightGuard(() => {
      logger.warn(
        {},
        "heartbeat tick skipped: previous tick still in flight (interval too short or a reconciler is slow)",
      );
    });
    heartbeatSchedulerInterval = setInterval(() => {
      void heartbeatTickGuard.run(() => {
        const timerTick = heartbeat
          .tickTimers(new Date())
          .then((result) => {
            if (result.enqueued > 0) {
              logger.info({ ...result }, "heartbeat timer tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "heartbeat timer tick failed");
          });

        const routineTick = routines
          .tickScheduledTriggers(new Date())
          .then((result) => {
            if (result.triggered > 0) {
              logger.info({ ...result }, "routine scheduler tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "routine scheduler tick failed");
          });

        // Periodically reap orphaned runs (5-min staleness threshold) and make sure
        // persisted queued work is still being driven forward.
        const recoveryTick = heartbeat
          .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
          .then(() => heartbeat.promoteDueScheduledRetries())
          .then(async (promotion) => {
            await heartbeat.resumeQueuedRuns();
            const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
            if (
              promotion.promoted > 0 ||
              reconciled.assignmentDispatched > 0 ||
              reconciled.dispatchRequeued > 0 ||
              reconciled.continuationRequeued > 0 ||
              reconciled.successfulRunHandoffEscalated > 0 ||
              reconciled.escalated > 0
            ) {
              logger.warn(
                { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
                "periodic heartbeat recovery changed assigned issue state",
              );
            }
          })
          .then(async () => {
            const reconciled = await heartbeat.reconcileIssueGraphLiveness();
            if (reconciled.escalationsCreated > 0) {
              logger.warn({ ...reconciled }, "periodic issue-graph liveness reconciliation created escalations");
            }
          })
          .then(async () => {
            const scanned = await heartbeat.scanSilentActiveRuns();
            if (scanned.created > 0 || scanned.escalated > 0) {
              logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
            }
          })
          .then(async () => {
            const reviewed = await heartbeat.reconcileProductivityReviews();
            if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
              logger.warn({ ...reviewed }, "periodic productivity reconciliation created or updated review work");
            }
          })
          .catch((err) => {
            logger.error({ err }, "periodic heartbeat recovery failed");
          });

        // Resolve only once every fan-out branch has settled, so the guard stays
        // held (and the next interval is skipped) until this whole tick completes.
        // allSettled never rejects and each branch already swallows its own errors.
        return Promise.allSettled([timerTick, routineTick, recoveryTick]);
      });
    }, config.heartbeatSchedulerIntervalMs);

    // Pair auto-run: active+autoRunEnabled pair groups advance ONE round per
    // tick automatically (pairs are auto-run by default; users opt out via
    // PATCH autoRunEnabled=false). Deliberately a SEPARATE interval + SEPARATE
    // single-flight guard from the heartbeat tick above: an LLM pair round can
    // take minutes, and folding it into heartbeatTickGuard would hold that
    // guard for the whole round and starve the timer/routine/recovery
    // reconcilers. The ticker's own per-group in-flight set plus this guard
    // keep rounds non-overlapping; maxRounds/stopPolicy/abort inside
    // recordTurn/runRound remain the spend safety net.
    const pairTicker = pairAutoRunTicker(
      db as any,
      pairRoundOrchestrator(db as any, buildDefaultPairTurnExecutor(db as any)),
      { logger },
    );
    const pairAutoRunGuard = createSingleFlightGuard(() => {
      logger.warn(
        {},
        "pair auto-run tick skipped: previous tick still in flight (an LLM round is still running)",
      );
    });
    pairAutoRunInterval = setInterval(() => {
      void pairAutoRunGuard.run(() =>
        pairTicker
          .tick()
          .then((result) => {
            if (result.groupsRun > 0 || result.errors.length > 0) {
              logger.info(
                { groupsRun: result.groupsRun, errors: result.errors },
                "pair auto-run tick advanced pair groups",
              );
            }
          })
          .catch((err) => {
            logger.error({ err }, "pair auto-run tick failed");
          }),
      );
    }, config.heartbeatSchedulerIntervalMs);
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    databaseBackupInterval = setInterval(() => {
      void runServerDatabaseBackup("scheduled").catch(() => {
        // runServerDatabaseBackup already logs the failure with context.
      });
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.WORKCELL_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
        printStartupBanner({
          bind: config.bind,
          host: config.host,
          deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: requestedListenPort,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  {
    // WC-216: terminate one heartbeat run's spawned CLI child process and remove
    // it from the live registry. This mirrors the cancel-run kill path
    // (cancelRunInternal) — it reuses the same shared termination primitive
    // (terminateLocalService: SIGTERM -> bounded grace -> SIGKILL) — but
    // deliberately does NOT run the heavy cancel-run DB writes (setRunStatus /
    // releaseIssueExecutionAndPromote / startNextQueuedRunForAgent), since during
    // shutdown PostgreSQL is about to stop and "start next queued run" would fight
    // the drain. The stuck 'running' rows are reconciled by the orphan-reaper on
    // the next process start. terminateLocalService never throws.
    const terminateRunProcess = async (runId: string): Promise<void> => {
      const running = runningProcesses.get(runId);
      try {
        if (running) {
          await terminateLocalService(
            { pid: running.child.pid ?? 0, processGroupId: running.processGroupId },
            { forceAfterMs: Math.max(1, running.graceSec) * 1000 },
          );
        }
      } finally {
        runningProcesses.delete(runId);
      }
    };

    // WC-216: bounded drain of in-flight heartbeat runs on graceful shutdown.
    // Idempotent across the SIGTERM/SIGINT/uncaught-exception paths via this flag
    // (process.once de-dupes a single signal, not a second path calling shutdown);
    // a second call also finds the registry already emptied, so it is a clean
    // no-op either way.
    const drainDeadlineMs = (() => {
      const raw = Number.parseInt(process.env.WORKCELL_SHUTDOWN_DRAIN_DEADLINE_MS ?? "", 10);
      return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
    })();
    let draining = false;
    const drainInFlightWork = async (reason: string): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        await drainActiveWork({
          runningProcesses,
          terminateRun: terminateRunProcess,
          clearIntervals: () => {
            clearInterval(heartbeatSchedulerInterval);
            clearInterval(pairAutoRunInterval);
            clearInterval(databaseBackupInterval);
            clearInterval(worktreeSweepInterval);
          },
          deadlineMs: drainDeadlineMs,
          logger,
        });
      } catch (err) {
        // drainActiveWork is contractually non-throwing, but never let an
        // unexpected error here block PG-stop + exit.
        logger.error({ err, signal: reason }, "shutdown drain raised unexpectedly; proceeding to exit");
      }
    };

    const shutdown = async (reason: string, exitCode: number) => {
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      const appShutdown = (app as { locals?: { workcellShutdown?: () => void } }).locals?.workcellShutdown;
      appShutdown?.();

      // WC-216: drain in-flight heartbeat runs (terminate their CLI children on a
      // bounded deadline) BEFORE stopping embedded PostgreSQL / exiting, so live
      // claude/codex processes die with us instead of being orphaned.
      await drainInFlightWork(reason);

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal: reason }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      process.exit(exitCode);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT", 0);
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM", 0);
    });

    // Install the process-level safety net (unhandledRejection keeps serving;
    // uncaughtException attempts a bounded graceful shutdown then exits 1).
    //
    // WC-216 deadline layering (INTENTIONAL — do not "align" these): the
    // SIGTERM/SIGINT paths run shutdown() with no backstop, so the in-flight run
    // drain gets its full WORKCELL_SHUTDOWN_DRAIN_DEADLINE_MS (10s default) and
    // children are reliably SIGTERM->SIGKILL'd before exit — the common
    // deploy/restart path, where process state is healthy. The uncaughtException
    // path instead bounds the WHOLE shutdown with the 3s force-exit above, so the
    // drain there is best-effort (fast children die, then force-exit): after an
    // uncaught throw the process state is suspect, so a fast bounded exit beats a
    // full async drain. Raising this to match the drain would make a crashed
    // process linger ~10s — the opposite of what a crash backstop is for.
    registerProcessSafetyNetHandlers(shutdown);
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Workcell server failed to start");
    process.exit(1);
  });
}
