import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@workcell/db";
import { instanceSettingsService, normalizeExperimentalSettings } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping instance-settings service DB tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      autonomousMode: false,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });
});

// WC-161: updateGeneral/updateExperimental previously did a JS read-modify-write of
// the whole jsonb blob, so two admins patching DISTINCT keys concurrently could lose
// one change. The fix merges atomically via `jsonb ||`. These tests assert merge
// semantics (a patch preserves untouched keys) AND that concurrent distinct-key
// updates both survive (deterministic with the atomic merge; flaky/lossy without it).
describeEmbeddedPostgres("WC-161: instance settings atomic jsonb merge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-instance-settings-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("preserves untouched general keys when patching a single key", async () => {
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ censorUsernameInLogs: true });
    await svc.updateGeneral({ keyboardShortcuts: true });

    const result = await svc.getGeneral();
    expect(result.censorUsernameInLogs).toBe(true);
    expect(result.keyboardShortcuts).toBe(true);
  });

  it("keeps both changes when two distinct general keys are patched concurrently", async () => {
    const svc = instanceSettingsService(db);
    await svc.get(); // ensure the singleton row exists before the race

    await Promise.all([
      svc.updateGeneral({ censorUsernameInLogs: true }),
      svc.updateGeneral({ keyboardShortcuts: true }),
    ]);

    const result = await svc.getGeneral();
    expect(result.censorUsernameInLogs).toBe(true);
    expect(result.keyboardShortcuts).toBe(true);
  });

  it("keeps both changes when two distinct experimental flags are toggled concurrently", async () => {
    const svc = instanceSettingsService(db);
    await svc.get();

    await Promise.all([
      svc.updateExperimental({ enableEnvironments: true }),
      svc.updateExperimental({ enableCloudSync: true }),
    ]);

    const result = await svc.getExperimental();
    expect(result.enableEnvironments).toBe(true);
    expect(result.enableCloudSync).toBe(true);
  });
});
