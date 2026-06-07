import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@workcell/db";
import type { DeploymentExposure, DeploymentMode } from "@workcell/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { pairGroupRoutes } from "./routes/pair-groups.js";
import { buildPairTurnExecutor, buildRealPairTurnInvoke, stubPairTurnInvoke, coercePairTurnAdapterConfig, ensurePairWorkspace, secretService, mcpClientRegistry } from "./services/index.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { knowledgeGraphRoutes } from "./routes/knowledge-graph.js";
import { agentMemoryRoutes } from "./routes/agent-memory.js";
import { designArtifactRoutes } from "./routes/design-artifacts.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { parallelDispatchRoutes } from "./routes/parallel-dispatch.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { routineRoutes } from "./routes/routines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { authRoutes } from "./routes/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@workcell/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";
import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./http/body-limits.js";
import { COMPANY_IMPORT_API_PATH } from "./routes/company-import-paths.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function isDatabaseConnectionUnavailableError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (error?.code === "ECONNREFUSED") return true;
  return Boolean(error?.cause && isDatabaseConnectionUnavailableError(error.cause));
}

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::") return undefined;
  return bindHost;
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export function shouldEnablePrivateHostnameGuard(opts: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
}): boolean {
  return (
    opts.deploymentExposure === "private" &&
    (opts.deploymentMode === "local_trusted" || opts.deploymentMode === "authenticated")
  );
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    databaseBackupService?: InstanceDatabaseBackupService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    pluginMigrationDb?: Db;
    pluginWorkerManager?: PluginWorkerManager;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  app.use(COMPANY_IMPORT_API_PATH, express.json({
    limit: PORTABLE_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({
    limit: DEFAULT_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled = shouldEnablePrivateHostnameGuard({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.use("/api/auth", authRoutes(db));
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = opts.pluginWorkerManager ?? createPluginWorkerManager();

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
  }));
  // WC-33 / WC-58 / WC-146: wire pair-group routes with a turn executor.
  // The real two-model exchange (buildRealPairTurnInvoke) is now the DEFAULT in
  // normal runtime, so pair collaboration "just works" once a local CLI agent
  // (claude/codex) is configured — no env flag needed. Determinism is preserved:
  //   - under test (VITEST / NODE_ENV=test) it falls back to the deterministic
  //     stub so route/orchestrator tests need no LLM/API key, and
  //   - WORKCELL_PAIR_LIVE_LLM=0 is an explicit opt-out (e.g. to avoid token
  //     spend); WORKCELL_PAIR_LIVE_LLM=1 forces live even under test.
  // A live turn that cannot reach a model (no CLI / not logged in) aborts
  // gracefully and the round timeline shows the stop reason.
  const pairLiveEnv = process.env.WORKCELL_PAIR_LIVE_LLM;
  const pairUnderTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const pairLiveLlm =
    pairLiveEnv === "0"
      ? false
      : pairLiveEnv && pairLiveEnv !== "0"
        ? true
        : !pairUnderTest;
  const pairTurnInvoke = pairLiveLlm ? buildRealPairTurnInvoke() : stubPairTurnInvoke;
  // WC-125 (pair env-secret parity): on the live path, resolve the agent's
  // adapterConfig env-secret bindings (companyId-scoped) into plain values via
  // the same resolver the heartbeat run path uses, so a live pair turn runs with
  // the agent's configured credentials. Off the live path the executor keeps the
  // safe env-stripping default (stub needs no secrets).
  // D21 (WC-132): give live pairs a real isolated worktree so the two agents can
  // edit files together. Gated behind a SEPARATE flag (WORKCELL_PAIR_LIVE_WORKSPACE)
  // on top of the live-LLM flag — text-collaboration pairs need no worktree, and
  // worktree creation is a heavier, filesystem side-effecting step. Reuses
  // ensurePairWorkspace (resolve repo -> reuse-or-realize -> register); touches
  // no lease/JWT machinery.
  const pairLiveWorkspace =
    pairLiveLlm &&
    Boolean(process.env.WORKCELL_PAIR_LIVE_WORKSPACE) &&
    process.env.WORKCELL_PAIR_LIVE_WORKSPACE !== "0";
  const pairExecutorOptions = pairLiveLlm
    ? {
        resolveAdapterConfig: async (companyId: string, rawAdapterConfig: unknown) => {
          const { config } = await secretService(db).resolveAdapterConfigForRuntime(
            companyId,
            coercePairTurnAdapterConfig(rawAdapterConfig),
          );
          return config;
        },
        ...(pairLiveWorkspace
          ? {
              ensureWorkspace: (
                companyId: string,
                issueId: string,
                agent: { id: string | null; name: string; companyId: string },
                pairGroupId: string,
              ) => ensurePairWorkspace(db, { companyId, issueId, agent, pairGroupId }),
            }
          : {}),
      }
    : undefined;
  api.use(
    pairGroupRoutes(db, {
      pairTurnExecutor: buildPairTurnExecutor(db, pairTurnInvoke, pairExecutorOptions),
    }),
  );
  api.use(capabilityRoutes(db));
  // WC-61/63: one app-scoped MCP client registry (cache + telemetry persist
  // across requests). Wired into the KG enrichment route; future consumers
  // (OD plugin host RPC) share the same instance.
  const mcpRegistry = mcpClientRegistry(db);
  api.use(knowledgeGraphRoutes(db, mcpRegistry));
  // WC-181 (slice 2): per-agent memory graph routes. Agents manage their own
  // memory via their agent key; board users manage any in-company agent's.
  api.use(agentMemoryRoutes(db));
  api.use(designArtifactRoutes(db));
  api.use(bootstrapRoutes(db));
  api.use(parallelDispatchRoutes(db));
  api.use(issueTreeControlRoutes(db));
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(environmentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(secretRoutes(db));
  api.use(costRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(resourceMembershipRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  if (opts.databaseBackupService) {
    api.use(instanceDatabaseBackupRoutes(opts.databaseBackupService));
  }
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  const loader = pluginLoader(
    db,
    {
      localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
      migrationDb: opts.pluginMigrationDb,
    },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, {
          pluginWorkerManager: workerManager,
          manifest,
        });
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(readBrandedStaticIndexHtml(uiDist));
      });
    } else {
      console.warn("[workcell] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const hmrHost = resolveViteHmrHost(opts.bindHost);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          ...(hmrHost ? { host: hmrHost } : {}),
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  let feedbackExportShuttingDown = false;
  let feedbackExportTimer: ReturnType<typeof setInterval> | null = null;
  const disableFeedbackExportFlushes = () => {
    feedbackExportShuttingDown = true;
    if (feedbackExportTimer) {
      clearInterval(feedbackExportTimer);
      feedbackExportTimer = null;
    }
  };
  const flushPendingFeedbackExports = async () => {
    if (feedbackExportShuttingDown) return;
    try {
      await opts.feedbackExportService?.flushPendingFeedbackTraces();
    } catch (err) {
      if (isDatabaseConnectionUnavailableError(err)) {
        disableFeedbackExportFlushes();
        logger.warn({ err }, "Disabling pending feedback export flushes because the database is unavailable");
        return;
      }
      logger.error({ err }, "Failed to flush pending feedback exports");
    }
  };

  feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void flushPendingFeedbackExports();
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void flushPendingFeedbackExports();
  }
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = createPluginDevWatcher(
    lifecycle,
    async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
  );
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  let appServicesShutdown = false;
  const shutdownAppServices = () => {
    if (appServicesShutdown) return;
    appServicesShutdown = true;
    disableFeedbackExportFlushes();
    devWatcher?.close();
    viteHtmlRenderer?.dispose();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  };
  app.locals.workcellShutdown = shutdownAppServices;

  process.once("exit", shutdownAppServices);
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
