import { Router } from "express";
import type { Db } from "@workcell/db";
import {
  knowledgeGraphService,
  type CodeGraphImport,
  type KnowledgeGraphMcpRegistry,
} from "../services/knowledge-graph.js";
import { mapGraphifyGraphToImport } from "../services/graphify-import.js";
import { assertCompanyAccess } from "./authz.js";

// WC-39 (D12 populator): minimal routes for the Knowledge Graph PoC.
// Read access for the graph + a backfill action that mirrors all
// company issues into the graph. Edges for parent/child issues are
// auto-created by the populator.
// WC-63: an optional mcpRegistry enables ?enriched=true outbound MCP
// enrichment on the neighborhood route (graceful when absent).
export function knowledgeGraphRoutes(db: Db, mcpRegistry?: KnowledgeGraphMcpRegistry) {
  const router = Router();
  const svc = knowledgeGraphService(db, { mcpRegistry });

  router.get(
    "/companies/:companyId/knowledge-graph/nodes",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const kind = (req.query.kind as string | undefined) ?? "issue";
      const items = await svc.listNodesByKind(companyId, kind as any);
      res.json({ items });
    },
  );

  router.get(
    "/companies/:companyId/knowledge-graph/neighborhood/:nodeId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const nodeId = req.params.nodeId as string;
      assertCompanyAccess(req, companyId);
      const enriched = req.query.enriched === "true" || req.query.enriched === "1";
      const result = await svc.neighborhood(companyId, nodeId, { enriched });
      res.json(result);
    },
  );

  // WC-123 (D12 S5): issue-centric knowledge-graph view for the UI. Resolves
  // the issue's kind="issue" node, then returns its 1-hop connections — each
  // neighbor joined with the edge kind + direction that links it to the issue.
  // GRACEFUL: an issue not yet mirrored into the graph returns
  // { node: null, connections: [] } so the UI renders an empty state, never 404.
  router.get(
    "/companies/:companyId/knowledge-graph/issues/:issueId/neighborhood",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const issueId = req.params.issueId as string;
      assertCompanyAccess(req, companyId);
      const node = await svc.findNode(companyId, "issue", issueId);
      if (!node) {
        res.json({ node: null, connections: [] });
        return;
      }
      const { edges, neighbors } = await svc.neighborhood(companyId, node.id);
      const byId = new Map(neighbors.map((n) => [n.id, n]));
      const connections = edges
        .map((edge) => {
          const direction = edge.fromNodeId === node.id ? ("out" as const) : ("in" as const);
          const neighborId = direction === "out" ? edge.toNodeId : edge.fromNodeId;
          const neighbor = byId.get(neighborId);
          if (!neighbor) return null;
          return {
            id: neighbor.id,
            kind: neighbor.nodeKind,
            label: neighbor.label,
            entityRef: neighbor.entityRef,
            edgeKind: edge.edgeKind,
            direction,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      res.json({ node: { id: node.id, kind: node.nodeKind, label: node.label }, connections });
    },
  );

  router.post(
    "/companies/:companyId/knowledge-graph/sync-issues",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.backfillCompanyIssues(companyId);
      res.json(result);
    },
  );

  // WC-110 (D20 / D12 S1): ingest a normalized code graph into kind="code"
  // nodes + edges. The producer (a Graphify graph.json mapper, the WC-48 repo
  // scanner, or a CI job) POSTs a CodeGraphImport. Idempotent (ON CONFLICT
  // upserts). Light shape validation -> 400 so a malformed payload never 500s.
  router.post(
    "/companies/:companyId/knowledge-graph/code-graph/ingest",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = (req.body ?? {}) as { nodes?: unknown; edges?: unknown; projectId?: unknown };
      if (!Array.isArray(body.nodes)) {
        res.status(400).json({ error: "code-graph ingest requires a `nodes` array" });
        return;
      }
      for (const node of body.nodes) {
        if (typeof node?.key !== "string" || typeof node?.label !== "string") {
          res.status(400).json({ error: "each code-graph node requires string `key` and `label`" });
          return;
        }
      }
      if (body.edges !== undefined && !Array.isArray(body.edges)) {
        res.status(400).json({ error: "`edges` must be an array when provided" });
        return;
      }
      for (const edge of (Array.isArray(body.edges) ? body.edges : [])) {
        if (typeof edge?.fromKey !== "string" || typeof edge?.toKey !== "string") {
          res.status(400).json({ error: "each code-graph edge requires string `fromKey` and `toKey`" });
          return;
        }
      }
      const graph: CodeGraphImport = {
        nodes: body.nodes as CodeGraphImport["nodes"],
        edges: Array.isArray(body.edges) ? (body.edges as CodeGraphImport["edges"]) : undefined,
      };
      const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
      const result = await svc.ingestCodeGraph(companyId, graph, projectId ? { projectId } : undefined);
      res.json(result);
    },
  );

  // WC-122 (D20 S4 operational): ingest a RAW Graphify export (graph.json).
  // The server maps it via mapGraphifyGraphToImport (the single, unit-tested
  // source of truth for Graphify's NetworkX node-link schema) and then ingests.
  // The CLI `code-graph from-repo` producer runs `graphify update` and POSTs the
  // resulting graph.json verbatim here, so the client never has to know the
  // CodeGraphImport contract or Graphify's exact field names — refining the
  // mapper later upgrades every producer at once.
  router.post(
    "/companies/:companyId/knowledge-graph/code-graph/ingest-graphify",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = (req.body ?? {}) as { graph?: unknown; projectId?: unknown };
      const graph = body.graph;
      // A real Graphify export is a NetworkX node-link object: `{ nodes: [...],
      // links|edges: [...] }`. Validate that envelope so a wrong payload 400s
      // instead of silently ingesting nothing.
      if (!graph || typeof graph !== "object" || !Array.isArray((graph as { nodes?: unknown }).nodes)) {
        res.status(400).json({
          error: "graphify ingest requires a `graph` object with a `nodes` array (a NetworkX node-link graph.json)",
        });
        return;
      }
      const mapped = mapGraphifyGraphToImport(graph);
      const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
      const result = await svc.ingestCodeGraph(companyId, mapped, projectId ? { projectId } : undefined);
      res.json({ ...result, mappedNodes: mapped.nodes.length, mappedEdges: mapped.edges?.length ?? 0 });
    },
  );

  // WC-110 (D20 / D12 S3): ephemeral code-graph overlay for a node ref. Queries
  // the external engine (Graphify) MCP; GRACEFUL — returns { available:false }
  // when no engine is configured. `ref` is a code node's entityRef (= the
  // engine's node key). Passed as a query param since refs contain "/" and "#".
  router.get(
    "/companies/:companyId/knowledge-graph/code-graph/neighbors",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;
      if (!ref) {
        res.status(400).json({ error: "code-graph neighbors requires a `ref` query parameter" });
        return;
      }
      const tool = typeof req.query.tool === "string" ? req.query.tool : undefined;
      const result = await svc.codeGraphNeighbors(companyId, ref, tool ? { tool } : undefined);
      res.json(result);
    },
  );

  return router;
}
