import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { closePairWorktrees, ensurePairWorkspace } from "../services/pair-workspace.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-131 ensurePairWorkspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const tempDirs: string[] = [];

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wc131-repo-"));
  tempDirs.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init"]);
  git(["config", "user.email", "test@workcell.dev"]);
  git(["config", "user.name", "Workcell Test"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return dir;
}

describeEmbeddedPostgres("WC-131 ensurePairWorkspace (D21 slice 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  const agent = { id: "agent-1", name: "Ada", companyId: "" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc131-pair-ws-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agent.companyId = companyId;
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, projects, project_workspaces, execution_workspaces, issues restart identity cascade" as never,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function seedProjectIssue(repoCwd: string | null): Promise<string> {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo project" });
    if (repoCwd) {
      await db.insert(projectWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        name: "primary",
        sourceType: "local_path",
        cwd: repoCwd,
        isPrimary: true,
      });
    }
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pair file-editing task",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      projectId,
      identifier: "WC-7",
    });
    return issueId;
  }

  it("realizes + registers an isolated worktree from the project's primary repo", async () => {
    const repo = await makeGitRepo();
    const issueId = await seedProjectIssue(repo);

    const result = await ensurePairWorkspace(db, { companyId, issueId, agent });
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(path.resolve(result!.cwd)).not.toBe(path.resolve(repo));

    // git registered the worktree, and it sits under the project repo.
    const toFwd = (p: string) => path.resolve(p).replace(/\\/g, "/");
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).replace(/\\/g, "/");
    expect(worktrees).toContain(toFwd(result!.cwd));

    // It was registered as an execution_workspace the WC-103 reuse query finds.
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].strategyType).toBe("git_worktree");
    expect(rows[0].cwd && path.resolve(rows[0].cwd)).toBe(path.resolve(result!.cwd));
  });

  it("reuses the existing execution_workspace on a second call (no duplicate row)", async () => {
    const repo = await makeGitRepo();
    const issueId = await seedProjectIssue(repo);

    const first = await ensurePairWorkspace(db, { companyId, issueId, agent });
    const second = await ensurePairWorkspace(db, { companyId, issueId, agent });

    expect(first!.created).toBe(true);
    expect(second!.created).toBe(false);
    expect(path.resolve(second!.cwd)).toBe(path.resolve(first!.cwd));
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(rows).toHaveLength(1); // reused, not duplicated
  });

  it("returns null (discussion-only) when the project has no primary repo checkout", async () => {
    const issueId = await seedProjectIssue(null); // project exists, no primary workspace
    const result = await ensurePairWorkspace(db, { companyId, issueId, agent });
    expect(result).toBeNull();
  });

  it("returns null when the issue has no project", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No project",
      status: "todo",
      priority: "low",
      workMode: "standard",
    });
    const result = await ensurePairWorkspace(db, { companyId, issueId, agent });
    expect(result).toBeNull();
  });

  // ---------- WC-133 (D21 slice 4): closePairWorktrees ----------

  it("WC-133: tags the created worktree with the pair group, and closePairWorktrees reaps it", async () => {
    const repo = await makeGitRepo();
    const issueId = await seedProjectIssue(repo);
    const pairGroupId = randomUUID();

    const ensured = await ensurePairWorkspace(db, { companyId, issueId, agent, pairGroupId });
    expect(ensured!.created).toBe(true);
    // the worktree is materialized on disk
    expect(existsSync(ensured!.cwd)).toBe(true);

    const before = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(before[0].status).toBe("active");
    const beforeMeta = before[0].metadata as
      | { createdByPairGroupId?: string; createdByRuntime?: boolean }
      | null;
    expect(beforeMeta?.createdByPairGroupId).toBe(pairGroupId);
    // M2: tagged createdByRuntime so cleanup also deletes the branch
    expect(beforeMeta?.createdByRuntime).toBe(true);

    const closed = await closePairWorktrees(db, companyId, pairGroupId);
    expect(closed).toBe(1);

    const after = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(after[0].status).toBe("closed");
    expect(after[0].cleanupEligibleAt).not.toBeNull();
    // H1: closePairWorktrees actually removes the worktree from disk (not just
    // flips DB columns) — previously this directory leaked on every pair.
    expect(existsSync(ensured!.cwd)).toBe(false);
  });

  it("WC-133: closePairWorktrees never touches a reused/untagged workspace", async () => {
    const repo = await makeGitRepo();
    const issueId = await seedProjectIssue(repo);
    const [iss] = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId));
    // A workspace from a NORMAL run (untagged) already exists for the issue.
    await db.insert(executionWorkspaces).values({
      companyId,
      projectId: iss.projectId!,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "normal-run-ws",
      status: "active",
      cwd: repo,
    });
    // The pair REUSES it (no new worktree, no tag).
    const ensured = await ensurePairWorkspace(db, { companyId, issueId, agent, pairGroupId: randomUUID() });
    expect(ensured!.created).toBe(false);

    // Reaping any pair group closes nothing — the untagged workspace is untouched.
    const closed = await closePairWorktrees(db, companyId, randomUUID());
    expect(closed).toBe(0);
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });
});
