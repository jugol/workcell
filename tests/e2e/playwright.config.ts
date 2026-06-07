import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.WORKCELL_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WORKCELL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "workcell-e2e-home-"));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites target dedicated multi-user configurations/ports and are
  // intentionally not part of the default local_trusted e2e run.
  testIgnore: ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp WORKCELL_HOME.
  webServer: {
    command: `pnpm workcell onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active Workcell home/server.
    reuseExistingServer: false,
    // Default 120s; overridable for heavily-loaded hosts (Windows + embedded
    // Postgres onboard can exceed 120s under CPU/IO contention) via
    // WORKCELL_E2E_WEBSERVER_TIMEOUT without making the gate flaky elsewhere.
    timeout: Number(process.env.WORKCELL_E2E_WEBSERVER_TIMEOUT ?? 120_000),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      WORKCELL_HOME,
      WORKCELL_INSTANCE_ID: "playwright-e2e",
      WORKCELL_BIND: "loopback",
      WORKCELL_DEPLOYMENT_MODE: "local_trusted",
      WORKCELL_DEPLOYMENT_EXPOSURE: "private",
      // WC-146 made the live two-model pair exchange the default in normal
      // runtime. e2e has no real CLI, so force the deterministic stub here —
      // this keeps pair runs hermetic and lets the pair-flow test drive a real
      // round and assert recorded turns without an LLM.
      WORKCELL_PAIR_LIVE_LLM: "0",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
