import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@workcell/db";
import {
  agentMemoryService,
  MEMORY_NODE_KINDS,
} from "../services/agent-memory.js";
import { agentService } from "../services/agents.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, assertBoard } from "./authz.js";

// WC-181 (slice 2): HTTP surface for the per-agent memory graph.
//
// Two caller classes share these routes:
//   - an AGENT (authenticated by its own agent API key / JWT) managing ITS OWN
//     memory at runtime — remember (POST node), recall (GET), forget (DELETE);
//   - a BOARD user (company member / instance admin) viewing or managing any
//     agent's memory WITHIN THEIR COMPANY.
//
// Authorization is the load-bearing requirement. We never trust the URL
// `:agentId` blindly — we derive an EFFECTIVE (companyId, agentId) from the
// authenticated actor via resolveMemoryScope():
//   - AGENT actor: the effective agentId is FORCED to the authenticated agent's
//     own id. If the URL `:agentId` names a different agent → 403 (an agent may
//     ONLY touch its own memory — "각자 본인 Agent가 자기 메모리만 관리"). The
//     effective companyId is the agent's own company (assertCompanyAccess
//     additionally rejects an agent key whose company differs).
//   - BOARD actor (or local_trusted implicit board): any `:agentId` is allowed,
//     but the agent must EXIST and BELONG to a company the board may access
//     (assertCompanyAccess on the resolved agent.companyId rejects cross-company
//     and read-only/viewer mutations).
// The resolved (companyId, agentId) is always passed into the service, whose own
// companyId+agentId filter is the second line of defense behind this gate.
//
// This mirrors the agent-self-or-board pattern already used by the wakeup /
// heartbeat-invoke routes in routes/agents.ts (the 403 "Agent can only invoke
// itself" gate + assertCompanyAccess), reusing the same authz helpers.

const metadataSchema = z.record(z.unknown());

const upsertNodeBodySchema = z.object({
  kind: z.enum(MEMORY_NODE_KINDS),
  label: z.string().min(1, "label must be a non-empty string"),
  content: z.string().min(1, "content must be a non-empty string"),
  metadata: metadataSchema.optional(),
  sourceRunId: z.string().uuid().nullish(),
});

const createEdgeBodySchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  relation: z.string().min(1, "relation must be a non-empty string"),
  metadata: metadataSchema.optional(),
});

interface MemoryScope {
  companyId: string;
  agentId: string;
}

export function agentMemoryRoutes(db: Db) {
  const router = Router();
  const memory = agentMemoryService(db);
  const agents = agentService(db);

  // Resolve the effective (companyId, agentId) for the requested `:agentId`,
  // enforcing the identity gate. Returns null after writing the appropriate
  // error response (404/403) — callers must `return` when it is null.
  //
  // assertCompanyAccess throws an HttpError (401/403) that the shared
  // errorHandler renders; the agent-only-own-memory 403 is written inline so its
  // message is explicit and unambiguous, mirroring routes/agents.ts.
  async function resolveMemoryScope(
    req: Request,
    res: Response,
    urlAgentId: string,
  ): Promise<MemoryScope | null> {
    const agent = await agents.getById(urlAgentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }

    // Rejects an agent key whose company differs, and a board user without
    // access to (or mutation rights on) the agent's company.
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      // An agent may ONLY manage its own memory — the URL param cannot widen
      // the authenticated identity.
      if (req.actor.agentId !== urlAgentId) {
        res.status(403).json({ error: "Agent can only manage its own memory" });
        return null;
      }
    } else {
      // Board path: must be a real board actor (not "none"); company access was
      // already asserted above against the resolved agent's company.
      assertBoard(req);
    }

    return { companyId: agent.companyId, agentId: agent.id };
  }

  // Recall: the agent's whole memory graph { nodes, edges }.
  router.get("/agents/:agentId/memory", async (req, res) => {
    const scope = await resolveMemoryScope(req, res, req.params.agentId as string);
    if (!scope) return;
    const graph = await memory.listGraph(scope.companyId, scope.agentId);
    res.json(graph);
  });

  // Remember: idempotent upsert of a memory node.
  router.post(
    "/agents/:agentId/memory/nodes",
    validate(upsertNodeBodySchema),
    async (req, res) => {
      const scope = await resolveMemoryScope(req, res, req.params.agentId as string);
      if (!scope) return;
      const body = req.body as z.infer<typeof upsertNodeBodySchema>;
      const node = await memory.upsertNode({
        companyId: scope.companyId,
        agentId: scope.agentId,
        kind: body.kind,
        label: body.label,
        content: body.content,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}),
      });
      res.status(201).json(node);
    },
  );

  // Link: idempotent typed edge between two of the agent's nodes.
  router.post(
    "/agents/:agentId/memory/edges",
    validate(createEdgeBodySchema),
    async (req, res) => {
      const scope = await resolveMemoryScope(req, res, req.params.agentId as string);
      if (!scope) return;
      const body = req.body as z.infer<typeof createEdgeBodySchema>;
      const edge = await memory.createEdge({
        companyId: scope.companyId,
        agentId: scope.agentId,
        fromNodeId: body.fromNodeId,
        toNodeId: body.toNodeId,
        relation: body.relation,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      res.status(201).json(edge);
    },
  );

  // Forget a node (cascades its incident edges). 404 when it does not belong to
  // this agent's scope.
  router.delete("/agents/:agentId/memory/nodes/:nodeId", async (req, res) => {
    const scope = await resolveMemoryScope(req, res, req.params.agentId as string);
    if (!scope) return;
    const deleted = await memory.deleteNode(
      scope.companyId,
      scope.agentId,
      req.params.nodeId as string,
    );
    if (!deleted) {
      res.status(404).json({ error: "Memory node not found" });
      return;
    }
    res.json(deleted);
  });

  // Forget an edge. 404 when it does not belong to this agent's scope.
  router.delete("/agents/:agentId/memory/edges/:edgeId", async (req, res) => {
    const scope = await resolveMemoryScope(req, res, req.params.agentId as string);
    if (!scope) return;
    const deleted = await memory.deleteEdge(
      scope.companyId,
      scope.agentId,
      req.params.edgeId as string,
    );
    if (!deleted) {
      res.status(404).json({ error: "Memory edge not found" });
      return;
    }
    res.json(deleted);
  });

  return router;
}
