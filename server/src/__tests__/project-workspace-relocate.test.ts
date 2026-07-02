import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, projects, projectWorkspaces } from "@workcell/db";
import { projectService } from "../services/projects.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// In-UI repo relocate: move a local workspace's source folder + update its cwd.
describe("projectService.relocateWorkspace", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof projectService>;
  let companyId: string;
  let projectId: string;
  let workspaceId: string;
  let scratch: string;
  let srcDir: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-relocate-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "WC",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "active" });

    scratch = await mkdtemp(path.join(os.tmpdir(), "wc-relocate-"));
    srcDir = path.join(scratch, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "marker.txt"), "hi", "utf8");

    workspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "ws",
      sourceType: "local_path",
      cwd: srcDir,
      isPrimary: true,
    });
  });

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await rm(scratch, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("moves the source folder and updates cwd (next run re-resolves the new path)", async () => {
    const dest = path.join(scratch, "moved");
    const result = await svc.relocateWorkspace(projectId, workspaceId, { targetPath: dest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.cwd).toBe(dest);
    expect(existsSync(path.join(dest, "marker.txt"))).toBe(true);
    expect(existsSync(srcDir)).toBe(false);
  });

  it("rejects a non-absolute target (422) and leaves the source intact", async () => {
    const result = await svc.relocateWorkspace(projectId, workspaceId, { targetPath: "relative/path" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(existsSync(path.join(srcDir, "marker.txt"))).toBe(true);
  });

  it("refuses (409) while an active execution workspace is using the folder", async () => {
    await db.insert(executionWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "ew",
      status: "active",
      cwd: srcDir,
    });
    const dest = path.join(scratch, "moved");
    const result = await svc.relocateWorkspace(projectId, workspaceId, { targetPath: dest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(existsSync(srcDir)).toBe(true); // not moved
  });

  it("refuses (422) when the target exists and is non-empty (no-clobber)", async () => {
    const dest = path.join(scratch, "occupied");
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "x.txt"), "x", "utf8");
    const result = await svc.relocateWorkspace(projectId, workspaceId, { targetPath: dest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(existsSync(srcDir)).toBe(true);
  });
});
