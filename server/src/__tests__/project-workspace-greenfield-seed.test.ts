import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, projects, projectWorkspaces } from "@workcell/db";
import { projectService } from "../services/projects.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Greenfield layout seeding: createWorkspace drops a project-root AGENTS.md with a
// folder convention into a brand-new EMPTY local workspace, so agents converge on
// one structure instead of improvising per task. Existing projects are untouched.
describe("projectService.createWorkspace — greenfield layout seed", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof projectService>;
  let companyId: string;
  let projectId: string;
  let scratch: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-greenfield-");
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
    scratch = await mkdtemp(path.join(os.tmpdir(), "wc-greenfield-"));
  });

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await rm(scratch, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seeds AGENTS.md with the layout convention into an empty local workspace", async () => {
    const cwd = path.join(scratch, "fresh");
    await mkdir(cwd, { recursive: true });
    const ws = await svc.createWorkspace(projectId, { cwd, sourceType: "non_git_path" });
    expect(ws).not.toBeNull();
    const agentsPath = path.join(cwd, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    const body = await readFile(agentsPath, "utf8");
    expect(body).toContain("Project layout (Workcell convention)");
    expect(body).toContain("src/");
    expect(body).toContain("Per-stack quick reference");
  });

  it("creates the directory and seeds when the path does not exist yet", async () => {
    const cwd = path.join(scratch, "not-created-yet");
    const ws = await svc.createWorkspace(projectId, { cwd, sourceType: "non_git_path" });
    expect(ws).not.toBeNull();
    expect(existsSync(path.join(cwd, "AGENTS.md"))).toBe(true);
  });

  it("ignores a lone .git directory and still seeds (empty repo is greenfield)", async () => {
    const cwd = path.join(scratch, "empty-git");
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await svc.createWorkspace(projectId, { cwd, sourceType: "local_path" });
    expect(existsSync(path.join(cwd, "AGENTS.md"))).toBe(true);
  });

  it("does NOT seed into a non-empty existing project (no clobber)", async () => {
    const cwd = path.join(scratch, "existing");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "index.js"), "console.log(1)", "utf8");
    await svc.createWorkspace(projectId, { cwd, sourceType: "local_path" });
    expect(existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("preserves an existing AGENTS.md", async () => {
    const cwd = path.join(scratch, "has-agents");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "KEEP ME", "utf8");
    await svc.createWorkspace(projectId, { cwd, sourceType: "non_git_path" });
    expect(await readFile(path.join(cwd, "AGENTS.md"), "utf8")).toBe("KEEP ME");
  });

  it("does not seed a repo-only (git_repo) workspace with no local cwd", async () => {
    const ws = await svc.createWorkspace(projectId, {
      repoUrl: "https://example.com/acme/app.git",
      sourceType: "git_repo",
    });
    expect(ws).not.toBeNull();
    // nothing to assert on disk; the guard simply returns early without throwing
  });
});
