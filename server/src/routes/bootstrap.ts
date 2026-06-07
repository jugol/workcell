import { Router } from "express";
import type { Db } from "@workcell/db";
import { issueService, projectService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// WC-212 (production-readiness Wave 1, fix #4): cap how much a single ingest can
// create so a member/agent cannot mint unbounded projects+issues in one call.
const MAX_BOOTSTRAP_ISSUES = 200;
const MAX_BOOTSTRAP_PROJECTS = 200;

// WC-41 (PLAN §9 #1): bootstrap-from-spec ingest.
//
// The spec calls for two kinds of project bootstrap:
//   - new project: plan + anchor + backlog + proof (greenfield)
//   - existing project: repo/tracker scan → current state + backlog
//
// Scanning local repo paths from the server is a sandboxing concern, so
// the chosen split is: clients (CLI, future UI scanner) build the
// project spec, this endpoint *ingests* it. That keeps the server's
// permission surface minimal and lets each scanner ship independently.
//
// Spec shape (open enum so future scanners can carry richer metadata):
//   {
//     project: { name, description? },
//     issues?: [{ title, description?, priority? }]
//   }
//
// Returns the created project + issues.
export function bootstrapRoutes(db: Db) {
  const router = Router();
  const projects = projectService(db);
  const issuesSvc = issueService(db);

  router.post(
    "/companies/:companyId/bootstrap/ingest",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      // Board-gate: bootstrap ingest is a privileged, high-volume write. Mirror
      // sibling board-gated company routes so a plain member/agent key cannot
      // create projects+issues here.
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const projectSpec = req.body?.project ?? null;
      if (!projectSpec?.name || typeof projectSpec.name !== "string") {
        res.status(400).json({ error: "project.name is required" });
        return;
      }

      // Cap payload size BEFORE creating anything so an over-cap request is
      // rejected wholesale rather than partially applied.
      const incomingIssues = Array.isArray(req.body?.issues) ? req.body.issues : [];
      if (incomingIssues.length > MAX_BOOTSTRAP_ISSUES) {
        res.status(400).json({
          error: `Too many issues: ${incomingIssues.length} exceeds the limit of ${MAX_BOOTSTRAP_ISSUES}`,
        });
        return;
      }
      const incomingProjects = Array.isArray(req.body?.projects) ? req.body.projects : [];
      if (incomingProjects.length > MAX_BOOTSTRAP_PROJECTS) {
        res.status(400).json({
          error: `Too many projects: ${incomingProjects.length} exceeds the limit of ${MAX_BOOTSTRAP_PROJECTS}`,
        });
        return;
      }

      const project = await projects.create(companyId, {
        name: projectSpec.name,
        description: projectSpec.description ?? null,
      });

      const issueSpecs: Array<{ title: string; description?: string; priority?: string }> =
        incomingIssues;
      const createdIssues = [];
      for (const spec of issueSpecs) {
        if (!spec || typeof spec.title !== "string" || spec.title.trim().length === 0) {
          continue; // skip malformed entries silently — caller can re-ingest with corrected payload
        }
        const issue = await issuesSvc.create(companyId, {
          title: spec.title,
          description: spec.description ?? null,
          status: "backlog",
          workMode: "standard",
          priority:
            spec.priority === "low" ||
            spec.priority === "medium" ||
            spec.priority === "high" ||
            spec.priority === "critical"
              ? spec.priority
              : "medium",
          projectId: project.id,
          originKind: "manual",
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        });
        createdIssues.push(issue);
      }

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId ?? "system",
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.bootstrap_ingested",
        entityType: "project",
        entityId: project.id,
        details: {
          projectId: project.id,
          createdIssueCount: createdIssues.length,
        },
      });

      res.status(201).json({ project, issues: createdIssues });
    },
  );

  return router;
}
