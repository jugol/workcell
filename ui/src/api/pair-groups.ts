import type { AgentPairBinding, PairGroup, PairGroupStatus, PairTurn } from "@workcell/shared";
import { api } from "./client";

// WC-46 (§9 #3 UI): typed client for the WC-26 + WC-32/33 pair-group
// routes. Methods mirror the routes 1:1.
export const pairGroupsApi = {
  getActiveForIssue: (issueId: string) =>
    api.get<{ group: PairGroup | null }>(`/issues/${issueId}/pair-group`),

  // WC-189: list pair bindings for a company (agent-side shape). Defaults to
  // active bindings — the only ones worth surfacing on the agent list / org
  // chart.
  listForCompany: (companyId: string, status: PairGroupStatus = "active") =>
    api.get<{ bindings: AgentPairBinding[] }>(
      `/companies/${companyId}/pair-groups?status=${status}`,
    ),

  // Standing mutually-exclusive pairs across ALL statuses (latest binding per
  // agent pair — the org chart's single-node semantics). Powers the assignee
  // picker's merged "Owner ⇄ Counterpart" option.
  listStanding: (companyId: string) =>
    api.get<{ bindings: AgentPairBinding[] }>(
      `/companies/${companyId}/pair-groups?scope=standing`,
    ),

  create: (
    issueId: string,
    data: {
      ownerAgentId?: string | null;
      counterpartAgentId?: string | null;
      maxRounds?: number;
      stopPolicy?: {
        maxRounds?: number;
        abortOn?: string[];
        requireConvergence?: boolean;
      } | null;
      // Auto-run rounds via the server scheduler. Omitted ⇒ server default (true).
      autoRunEnabled?: boolean;
    },
  ) => api.post<{ group: PairGroup }>(`/issues/${issueId}/pair-group`, data),

  listTurns: (groupId: string) =>
    api.get<{ turns: PairTurn[] }>(`/pair-groups/${groupId}/turns`),

  runRound: (groupId: string, maxRoundsToRun = 1) =>
    api.post<{ results: any[] }>(`/pair-groups/${groupId}/run-round`, {
      maxRoundsToRun,
    }),

  patch: (
    groupId: string,
    data: {
      status?: "active" | "completed" | "aborted";
      stopReason?: string | null;
      // Toggle scheduler auto-run; may be sent alone (without status).
      autoRunEnabled?: boolean;
    },
  ) => api.patch<{ group: PairGroup }>(`/pair-groups/${groupId}`, data),
};
