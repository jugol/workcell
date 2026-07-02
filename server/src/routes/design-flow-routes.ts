import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { projects } from "@workcell/db";
import { isUuidLike, type DesignScope } from "@workcell/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { designFlowService, designGuideService, assetService } from "../services/index.js";
import { resolveSianHtml } from "./issues.js";
import type { StorageService } from "../storage/types.js";

const addLinkSchema = z.object({
  fromScreenKey: z.string().trim().min(1).max(200),
  toScreenKey: z.string().trim().min(1).max(200),
  label: z.string().trim().max(120).optional(),
});

const updateGuideSchema = z.object({
  notesMarkdown: z.string().max(50_000),
});

const setPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

// Design-system redesign — the wireframe flow dashboard (R4) + cross-screen nav
// links (R3) + the design guide page (R1). Screens are derived from design work
// products; links live in design_screen_links; the guide layers board notes over
// auto-extracted tokens. project_id NULL = the company-level "default app".
export function designFlowRoutes(db: Db, storageService: StorageService) {
  const router = Router();
  const flow = designFlowService(db);
  const guide = designGuideService(db);

  // In-process 시안 HTML resolver (data: url or short asset url), company-scoped.
  const resolveHtml = (url: string | null, companyId: string): Promise<string | null> =>
    resolveSianHtml(
      {
        getAsset: async (id) => {
          const a = await assetService(db).getById(id);
          return a
            ? { companyId: a.companyId, objectKey: a.objectKey, contentType: a.contentType }
            : null;
        },
        getObject: (cid, objectKey) => storageService.getObject(cid, objectKey),
      },
      url,
      companyId,
    );

  async function resolveProject(projectId: string) {
    if (!isUuidLike(projectId)) return null;
    const [project] = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return project ?? null;
  }

  function actorFor(req: Parameters<typeof getActorInfo>[0]) {
    const actor = getActorInfo(req);
    return { kind: actor.actorType, id: actor.actorId ?? actor.agentId ?? null };
  }

  // ── Flow dashboard ────────────────────────────────────────────────────────
  router.get("/companies/:companyId/design-flow", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await flow.getFlow(companyId, { kind: "company" }));
  });

  router.get("/projects/:projectId/design-flow", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const scope: DesignScope = { kind: "project", projectId: project.id };
    res.json(await flow.getFlow(project.companyId, scope));
  });

  // ── Screen plan (R4: the "화면 기획" behind a screen) ──────────────────────
  // Read one screen's paired plan by its node key. Returns null when none exists
  // yet (legacy/unauthored screen → empty state on the client). Read-only access.
  router.get("/companies/:companyId/screens/:screenKey/plan", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await flow.getScreenPlan(companyId, { kind: "company" }, req.params.screenKey as string));
  });

  router.get("/projects/:projectId/screens/:screenKey/plan", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const scope: DesignScope = { kind: "project", projectId: project.id };
    res.json(await flow.getScreenPlan(project.companyId, scope, req.params.screenKey as string));
  });

  // ── Board link CRUD ───────────────────────────────────────────────────────
  router.post("/companies/:companyId/design-screen-links", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = addLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid link", details: parsed.error.flatten() });
      return;
    }
    const link = await flow.addLink({
      companyId,
      projectId: null,
      fromScreenKey: parsed.data.fromScreenKey,
      toScreenKey: parsed.data.toScreenKey,
      label: parsed.data.label ?? "",
      createdByKind: "board",
    });
    res.status(201).json(link);
  });

  router.post("/projects/:projectId/design-screen-links", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    assertBoard(req);
    const parsed = addLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid link", details: parsed.error.flatten() });
      return;
    }
    const link = await flow.addLink({
      companyId: project.companyId,
      projectId: project.id,
      fromScreenKey: parsed.data.fromScreenKey,
      toScreenKey: parsed.data.toScreenKey,
      label: parsed.data.label ?? "",
      createdByKind: "board",
    });
    res.status(201).json(link);
  });

  router.delete("/companies/:companyId/design-screen-links/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const removed = await flow.removeLink(req.params.id as string, companyId);
    if (!removed) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    res.json({ ok: true, deletedId: req.params.id });
  });

  // ── Screen positions (R5: drag-to-reposition, persisted) ───────────────────
  // PUT upserts one screen's canvas position. Keyed by the screen_key in the path
  // (the same key the flow node carries). Board-gated, like link edits. Express
  // already URL-decodes :screenKey.
  router.put("/companies/:companyId/design-screen-positions/:screenKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = setPositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid position", details: parsed.error.flatten() });
      return;
    }
    const actor = actorFor(req);
    const result = await flow.setPosition({
      companyId,
      projectId: null,
      screenKey: req.params.screenKey as string,
      x: parsed.data.x,
      y: parsed.data.y,
      updatedByKind: actor.kind,
      updatedById: actor.id,
    });
    res.json(result);
  });

  router.put("/projects/:projectId/design-screen-positions/:screenKey", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    assertBoard(req);
    const parsed = setPositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid position", details: parsed.error.flatten() });
      return;
    }
    const actor = actorFor(req);
    const result = await flow.setPosition({
      companyId: project.companyId,
      projectId: project.id,
      screenKey: req.params.screenKey as string,
      x: parsed.data.x,
      y: parsed.data.y,
      updatedByKind: actor.kind,
      updatedById: actor.id,
    });
    res.json(result);
  });

  // ── Design guide (R1) ─────────────────────────────────────────────────────
  router.get("/companies/:companyId/design-guide", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await guide.getGuide(companyId, { kind: "company" }, resolveHtml));
  });

  router.get("/projects/:projectId/design-guide", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const scope: DesignScope = { kind: "project", projectId: project.id };
    res.json(await guide.getGuide(project.companyId, scope, resolveHtml));
  });

  router.put("/companies/:companyId/design-guide", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = updateGuideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid guide", details: parsed.error.flatten() });
      return;
    }
    const result = await guide.updateNotes(
      companyId,
      { kind: "company" },
      parsed.data.notesMarkdown,
      actorFor(req),
    );
    res.json(result);
  });

  router.put("/projects/:projectId/design-guide", async (req, res) => {
    const project = await resolveProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    assertBoard(req);
    const parsed = updateGuideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid guide", details: parsed.error.flatten() });
      return;
    }
    const scope: DesignScope = { kind: "project", projectId: project.id };
    const result = await guide.updateNotes(
      project.companyId,
      scope,
      parsed.data.notesMarkdown,
      actorFor(req),
    );
    res.json(result);
  });

  return router;
}
