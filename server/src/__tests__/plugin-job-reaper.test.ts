import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, plugins, pluginJobs, pluginJobRuns } from "@workcell/db";
import type { WorkcellPluginManifestV1 } from "@workcell/shared";
import { reapStalePluginJobRuns } from "../services/plugin-job-store.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Production-readiness Wave 2 (REL — plugin-job boot reaper): embedded-pg test
// for reapStalePluginJobRuns. `markRunning` is a plain UPDATE (no CAS), so a
// crash mid-run leaves the row 'running' forever and the scheduler's overlap
// check then permanently blocks that job. The boot reaper must fail STALE
// 'running' rows (started before the threshold) while leaving FRESH ones — and
// never touch already-terminal rows. Mirrors the WC-211 deliberation reaper test.

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";
process.env.WORKCELL_IN_WORKTREE ??= "false";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-job reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function manifest(): WorkcellPluginManifestV1 {
  return {
    id: "workcell.plugin-job-reaper-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Plugin Job Reaper Test",
    description: "Test plugin",
    author: "Workcell",
    categories: ["automation"],
    capabilities: ["jobs.schedule"],
    entrypoints: { worker: "./dist/worker.js" },
  };
}

describeEmbeddedPostgres("reapStalePluginJobRuns", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;
  let jobId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-plugin-job-reaper-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    pluginId = randomUUID();
    jobId = randomUUID();
    const pluginManifest = manifest();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `${pluginManifest.id}-${pluginId.slice(0, 8)}`,
      packageName: "@workcell/plugin-job-reaper-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "nightly",
      schedule: "0 3 * * *",
      status: "active",
    });
  });

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fails stale 'running' runs (started before the threshold), leaves fresh ones", async () => {
    const olderThanMs = 20 * 60 * 1000; // 20 min

    // STALE: running, started 30 min ago (older than the threshold).
    const [stale] = await db
      .insert(pluginJobRuns)
      .values({
        jobId,
        pluginId,
        trigger: "scheduled",
        status: "running",
        startedAt: new Date(Date.now() - 30 * 60 * 1000),
      })
      .returning({ id: pluginJobRuns.id });

    // FRESH: running, just started (within the threshold).
    const [fresh] = await db
      .insert(pluginJobRuns)
      .values({
        jobId,
        pluginId,
        trigger: "scheduled",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: pluginJobRuns.id });

    const result = await reapStalePluginJobRuns(db, { olderThanMs });
    expect(result.reaped).toBe(1);

    const [staleAfter] = await db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.id, stale!.id));
    expect(staleAfter!.status).toBe("failed");
    expect(staleAfter!.error).toBe("abandoned (server restart or stuck run)");
    expect(staleAfter!.finishedAt).toBeTruthy();

    const [freshAfter] = await db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.id, fresh!.id));
    expect(freshAfter!.status).toBe("running");
    expect(freshAfter!.finishedAt).toBeNull();
  });

  it("reaps a stale 'running' run that never recorded started_at (falls back to created_at)", async () => {
    const olderThanMs = 20 * 60 * 1000;

    // running, no startedAt, created 30 min ago → eligible via created_at fallback.
    const [noStart] = await db
      .insert(pluginJobRuns)
      .values({
        jobId,
        pluginId,
        trigger: "scheduled",
        status: "running",
        startedAt: null,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      })
      .returning({ id: pluginJobRuns.id });

    const result = await reapStalePluginJobRuns(db, { olderThanMs });
    expect(result.reaped).toBe(1);

    const [after] = await db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.id, noStart!.id));
    expect(after!.status).toBe("failed");
  });

  it("never touches already-terminal runs (succeeded/failed/cancelled)", async () => {
    const olderThanMs = 20 * 60 * 1000;
    const old = new Date(Date.now() - 30 * 60 * 1000);

    const terminal = await db
      .insert(pluginJobRuns)
      .values([
        { jobId, pluginId, trigger: "scheduled", status: "succeeded", startedAt: old },
        { jobId, pluginId, trigger: "scheduled", status: "failed", startedAt: old },
        { jobId, pluginId, trigger: "scheduled", status: "cancelled", startedAt: old },
      ])
      .returning({ id: pluginJobRuns.id, status: pluginJobRuns.status });

    const result = await reapStalePluginJobRuns(db, { olderThanMs });
    expect(result.reaped).toBe(0);

    for (const row of terminal) {
      const [after] = await db
        .select()
        .from(pluginJobRuns)
        .where(eq(pluginJobRuns.id, row.id));
      expect(after!.status).toBe(row.status);
    }
  });
});
