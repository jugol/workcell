import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  designGuides,
  designScreenLinks,
  designScreenPositions,
  issueWorkProducts,
  issues,
  projects,
} from "@workcell/db";
import { designFlowService } from "../services/design-flow.ts";
import { designGuideService } from "../services/design-guide.ts";
import { workProductService } from "../services/work-products.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("design flow + guide services (design-system redesign)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let flow: ReturnType<typeof designFlowService>;
  let guide: ReturnType<typeof designGuideService>;
  let companyId: string;
  let projectId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-flow-");
    db = createDb(tempDb.connectionString);
    flow = designFlowService(db);
    guide = designGuideService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "active" });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Screens",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
    });
  });

  afterEach(async () => {
    await db.delete(designScreenPositions);
    await db.delete(designScreenLinks);
    await db.delete(designGuides);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addScreen(overrides: Partial<typeof issueWorkProducts.$inferInsert> & { screenKey: string }) {
    const [row] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        projectId,
        provider: "workcell",
        type: "design",
        title: overrides.screenKey,
        status: "active",
        ...overrides,
      })
      .returning();
    return row;
  }

  it("getFlow groups design work products into one node per screen, scoped to the project", async () => {
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved", url: "https://x/login" });
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: false, reviewState: "approved", url: "https://x/login-old" });
    await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "needs_board_review", url: "https://x/home" });

    const result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens).toHaveLength(2); // login + home (login versions collapsed)
    const login = result.screens.find((s) => s.screenKey === "login");
    expect(login?.approved).toBe(true);
    expect(login?.previewUrl).toBe("https://x/login"); // primary is current
    const home = result.screens.find((s) => s.screenKey === "home");
    expect(home?.approved).toBe(false);
  });

  it("declareLinks is idempotent, skips self-links, and normalizes keys", async () => {
    const first = await flow.declareLinks({
      companyId,
      projectId,
      fromScreenKey: "Login",
      sourceWorkProductId: null,
      links: [
        { label: "시작 버튼", targetScreenKey: "Home" },
        { label: "self", targetScreenKey: "login" }, // self-link → skipped
      ],
    });
    expect(first).toBe(1); // only login→home inserted
    // Re-declaring the same link is a no-op (idempotent via unique index).
    const second = await flow.declareLinks({
      companyId,
      projectId,
      fromScreenKey: "login",
      sourceWorkProductId: null,
      links: [{ label: "시작 버튼", targetScreenKey: "home" }],
    });
    expect(second).toBe(0);

    const links = await flow.listLinks(companyId, { kind: "project", projectId });
    expect(links).toHaveLength(1);
    expect(links[0].fromScreenKey).toBe("login");
    expect(links[0].toScreenKey).toBe("home");
  });

  it("addLink / removeLink supports board editing of the flow", async () => {
    const link = await flow.addLink({
      companyId,
      projectId,
      fromScreenKey: "home",
      toScreenKey: "settings",
      label: "설정",
      createdByKind: "board",
    });
    expect(link?.createdByKind).toBe("board");
    expect(link?.id).toBeTruthy();

    const removed = await flow.removeLink(link!.id, companyId);
    expect(removed).toBe(true);
    expect(await flow.listLinks(companyId, { kind: "project", projectId })).toHaveLength(0);
  });

  it("getFlow returns both screens and links for the wireframe dashboard", async () => {
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" });
    await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved" });
    await flow.addLink({ companyId, projectId, fromScreenKey: "login", toScreenKey: "home", label: "go", createdByKind: "board" });

    const result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens).toHaveLength(2);
    expect(result.links).toHaveLength(1);
    expect(result.links[0].fromScreenKey).toBe("login");
  });

  it("design guide: notes upsert + auto-extracts tokens from APPROVED screens only", async () => {
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved", url: "https://x/login" });
    await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "needs_board_review", url: "https://x/home" });

    // notes upsert
    const saved = await guide.updateNotes(companyId, { kind: "project", projectId }, "# 가이드\n버튼은 파랑", { kind: "user", id: "board" });
    expect(saved.notesMarkdown).toContain("가이드");
    const reread = await guide.getNotes(companyId, { kind: "project", projectId });
    expect(reread.notesMarkdown).toContain("버튼은 파랑");

    // token aggregation pulls only from the APPROVED screen's HTML
    const resolveHtml = async (url: string | null) =>
      url === "https://x/login"
        ? `<div style="color:#1d4ed8;font-family:Inter;font-size:16px;padding:8px"><button>A</button><!-- UX: Peak-End Rule, 근접성 --></div>`
        : `<div style="color:#ff0000">should-not-be-scanned · Hick's Law</div>`;
    const full = await guide.getGuide(companyId, { kind: "project", projectId }, resolveHtml);
    expect(full.tokens.colors).toContain("#1d4ed8"); // from the approved login screen
    expect(full.tokens.colors).not.toContain("#ff0000"); // home is not approved → skipped
    expect(full.tokens.components).toContain("button");
    // principles detected ONLY from the approved screen's annotations
    expect(full.principles).toContain("Peak-End Rule");
    expect(full.principles).toContain("근접성");
    expect(full.principles).not.toContain("Hick's Law"); // home (unapproved) skipped
    expect(full.screenCount).toBe(2);
    expect(full.notesMarkdown).toContain("버튼은 파랑");
  });

  it("setPosition persists per-screen coords; getFlow merges them; positions survive a revision (screenKey-stable)", async () => {
    const v1 = await addScreen({
      screenKey: "home",
      screenName: "홈",
      isPrimary: true,
      reviewState: "approved",
      url: "https://x/home-v1",
    });
    await flow.setPosition({
      companyId,
      projectId,
      screenKey: "home",
      x: 320,
      y: 140,
      updatedByKind: "user",
      updatedById: "board",
    });

    let result = await flow.getFlow(companyId, { kind: "project", projectId });
    let home = result.screens.find((s) => s.screenKey === "home");
    expect(home?.x).toBe(320);
    expect(home?.y).toBe(140);
    expect(home?.workProductId).toBe(v1.id);

    // A screen with no stored position → x/y null (the client auto-lays it out).
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" });
    result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens.find((s) => s.screenKey === "login")?.x).toBeNull();

    // Revise the screen: a NEW primary version supersedes v1, so the node's
    // current workProductId changes — but the position (keyed by the stable
    // screen_key, not the work-product id) is retained.
    await db.update(issueWorkProducts).set({ isPrimary: false }).where(eq(issueWorkProducts.id, v1.id));
    const v2 = await addScreen({
      screenKey: "home",
      screenName: "홈",
      isPrimary: true,
      reviewState: "approved",
      url: "https://x/home-v2",
    });
    result = await flow.getFlow(companyId, { kind: "project", projectId });
    home = result.screens.find((s) => s.screenKey === "home");
    expect(home?.workProductId).toBe(v2.id); // current version changed…
    expect(home?.x).toBe(320); // …but the position survived the revision
    expect(home?.y).toBe(140);

    // Re-dragging upserts in place (no duplicate row).
    await flow.setPosition({ companyId, projectId, screenKey: "home", x: 500, y: 200 });
    const positions = await flow.listPositions(companyId, { kind: "project", projectId });
    expect(positions).toHaveLength(1);
    result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens.find((s) => s.screenKey === "home")?.x).toBe(500);
  });

  it("R3: a screen plan pairs by screenKey; getFlow exposes planWorkProductId; getScreenPlan reads it; upsert is in place", async () => {
    const wp = workProductService(db);
    const mockup = await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved", url: "https://x/home" });
    const planId = await wp.upsertScreenPlan({ issueId, companyId, projectId, screenKey: "home", screenName: "홈", planMarkdown: "# 홈 기획\n- 목적" });
    expect(planId).toBeTruthy();

    // The plan is NOT a flow node (screen_plan is not a design type), but the
    // node carries a pointer to it.
    const f = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(f.screens).toHaveLength(1);
    expect(f.screens[0].workProductId).toBe(mockup.id); // node = the mockup, not the plan
    expect(f.screens[0].planWorkProductId).toBe(planId);

    // getScreenPlan returns the body for the detail page.
    const plan = await flow.getScreenPlan(companyId, { kind: "project", projectId }, "home");
    expect(plan?.planMarkdown).toContain("홈 기획");
    expect(plan?.workProductId).toBe(planId);

    // Re-upsert (revised mockup) updates the SAME row — no fork.
    const planId2 = await wp.upsertScreenPlan({ issueId, companyId, projectId, screenKey: "home", screenName: "홈", planMarkdown: "# 홈 기획 v2" });
    expect(planId2).toBe(planId);
    expect((await flow.getScreenPlan(companyId, { kind: "project", projectId }, "home"))?.planMarkdown).toContain("v2");

    // A screen with no plan → getScreenPlan null, node.planWorkProductId null.
    await addScreen({ screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" });
    expect(await flow.getScreenPlan(companyId, { kind: "project", projectId }, "login")).toBeNull();
    const f2 = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(f2.screens.find((s) => s.screenKey === "login")?.planWorkProductId ?? null).toBeNull();
  });

  it("R3 lifecycle: plan survives a mockup revision (sweep-immune); removed only when the last mockup is deleted", async () => {
    const wp = workProductService(db);
    const v1 = await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved" });
    await wp.upsertScreenPlan({ issueId, companyId, projectId, screenKey: "home", screenName: "홈", planMarkdown: "plan" });

    // Revise: a new primary mockup; sweeping superseded versions (keeper = v2)
    // deletes v1 but NOT the screen_plan (immune — it is not a design type).
    const v2 = await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved" });
    const swept = await wp.autoDeleteSupersededDesigns(v2.id);
    expect(swept).toContain(v1.id);
    expect(await flow.getScreenPlan(companyId, { kind: "project", projectId }, "home")).not.toBeNull();

    // Deleting the LAST remaining mockup of the screen removes the orphaned plan.
    await wp.deleteDesign(v2.id);
    expect(await flow.getScreenPlan(companyId, { kind: "project", projectId }, "home")).toBeNull();
  });

  it("getFlow drops 시안 owned by blocked/cancelled issues and auto-restores them on unblock", async () => {
    // The shared issue is in_progress → its screen is part of the live blueprint.
    await addScreen({ screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved" });

    // A blocked issue carrying its own screen.
    const blockedIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockedIssueId, companyId, projectId, title: "Blocked", status: "blocked", priority: "medium", workMode: "standard",
    });
    await db.insert(issueWorkProducts).values({
      companyId, issueId: blockedIssueId, projectId, provider: "workcell", type: "design",
      title: "settings", screenKey: "settings", screenName: "설정", isPrimary: true, reviewState: "approved", status: "active",
    });

    // A cancelled issue carrying its own screen.
    const cancelledIssueId = randomUUID();
    await db.insert(issues).values({
      id: cancelledIssueId, companyId, projectId, title: "Cancelled", status: "cancelled", priority: "medium", workMode: "standard",
    });
    await db.insert(issueWorkProducts).values({
      companyId, issueId: cancelledIssueId, projectId, provider: "workcell", type: "design",
      title: "legacy", screenKey: "legacy", screenName: "레거시", isPrimary: true, reviewState: "approved", status: "active",
    });

    // Blocked + cancelled screens are filtered out — only the active issue's screen shows.
    let result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens.map((s) => s.screenKey).sort()).toEqual(["home"]);

    // Unblock the blocked issue → its screen returns (non-destructive auto-restore);
    // the cancelled issue's screen stays hidden.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, blockedIssueId));
    result = await flow.getFlow(companyId, { kind: "project", projectId });
    expect(result.screens.map((s) => s.screenKey).sort()).toEqual(["home", "settings"]);
  });
});
