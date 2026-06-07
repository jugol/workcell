import { api } from "./client";

// WC-123 (D12 S5): typed client for the issue-centric knowledge-graph view.
// Mirrors the WC-123 route 1:1.

// A 1-hop connection: a neighbor node joined with the edge that links it to the
// issue. `kind` is a GraphNodeKind (issue|code|plan_section|decision|run|skill|
// plugin|capability); `edgeKind` is a GraphEdgeKind (implements|depends_on|
// references|spawned_by|supersedes|related); `direction` is relative to the
// issue node ("out" = issue → neighbor, "in" = neighbor → issue).
export interface KnowledgeGraphConnection {
  id: string;
  kind: string;
  label: string;
  entityRef: string;
  edgeKind: string;
  direction: "out" | "in";
}

export interface IssueNeighborhood {
  node: { id: string; kind: string; label: string } | null;
  connections: KnowledgeGraphConnection[];
}

export const knowledgeGraphApi = {
  // GRACEFUL: an issue not yet mirrored into the graph returns
  // { node: null, connections: [] } (the server never 404s here).
  issueNeighborhood: (companyId: string, issueId: string) =>
    api.get<IssueNeighborhood>(
      `/companies/${companyId}/knowledge-graph/issues/${issueId}/neighborhood`,
    ),
};
