import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, heartbeatRuns, issues } from "@workcell/db";

// Non-terminal heartbeat run statuses. A run in any of these states means
// the agent has in-flight (or about-to-be-in-flight) work — including a
// QUEUED run that hasn't started yet, during which the agent still reads
// as "idle" and the issue's executionRunId is still null (it's stamped
// lazily at claim time). WC-55 excludes agents with such runs so the
// dispatcher doesn't re-select an already-queued issue.
const NON_TERMINAL_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

// WC-42 (PLAN §9 #5): identify issues that are dispatchable in parallel.
//
// Definition (first iteration — extensible without breaking callers):
//
//   An issue is dispatchable-in-parallel when ALL hold:
//     1. Status is "todo" or "backlog" (queued for work, not actively
//        running).
//     2. An assignee agent is set.
//     3. The assignee agent's status is "idle" (not currently busy with
//        another execution).
//     4. The issue's executionRunId is null (no in-flight run for this
//        issue itself).
//     5. The issue's executionWorkspaceId either is null or doesn't
//        collide with the workspace another dispatchable candidate is
//        already using.
//
// Returns a list of dispatchable issues + the per-workspace deduped set
// the dispatcher can hand to `heartbeat.wakeup` in parallel.
//
// Future refinement: per-agent budget cap, project-level concurrency
// limits, lane-affinity hints. The shape here is intentionally small so
// callers can layer policies on top without re-querying the DB.
export interface ParallelDispatchCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string;
  agentName: string;
  executionWorkspaceId: string | null;
}

export interface ParallelDispatchPlan {
  candidates: ParallelDispatchCandidate[];
  // dispatchable = candidates filtered so each (workspace) appears once.
  // Issues with executionWorkspaceId=null are all retained (no conflict).
  dispatchable: ParallelDispatchCandidate[];
}

export function parallelDispatchService(db: Db) {
  return {
    candidatesForCompany: async (
      companyId: string,
    ): Promise<ParallelDispatchPlan> => {
      // Fetch queued issues with an idle agent assignee.
      const queued = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          assigneeAgentId: issues.assigneeAgentId,
          executionWorkspaceId: issues.executionWorkspaceId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["todo", "backlog"]),
            isNotNull(issues.assigneeAgentId),
          ),
        );
      // Filter out anything with an in-flight execution run.
      const queuedClean = queued.filter((row) => row.executionRunId == null);
      if (queuedClean.length === 0) {
        return { candidates: [], dispatchable: [] };
      }

      // Resolve the assigneeAgent metadata + filter on agent status.
      const agentIds = Array.from(
        new Set(queuedClean.map((row) => row.assigneeAgentId).filter(Boolean) as string[]),
      );
      const agentRows = agentIds.length
        ? await db
            .select({ id: agents.id, name: agents.name, status: agents.status })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, companyId),
                inArray(agents.id, agentIds),
              ),
            )
        : [];
      // WC-55 (#11): an agent with a non-terminal heartbeat run (notably a
      // QUEUED run not yet claimed) still reads as "idle" and its issue's
      // executionRunId is still null, so without this the same issue keeps
      // re-surfacing as a candidate between /wake and claim. Exclude those
      // agents — mirrors the heartbeat legacy-run scan.
      const busyAgentRows = agentIds.length
        ? await db
            .select({ agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                inArray(heartbeatRuns.agentId, agentIds),
                inArray(heartbeatRuns.status, [...NON_TERMINAL_RUN_STATUSES]),
              ),
            )
        : [];
      const busyAgents = new Set(busyAgentRows.map((row) => row.agentId));

      const idleAgents = new Map(
        agentRows
          .filter((row) => row.status === "idle" && !busyAgents.has(row.id))
          .map((row) => [row.id, row.name]),
      );

      const candidates: ParallelDispatchCandidate[] = [];
      for (const row of queuedClean) {
        if (!row.assigneeAgentId) continue;
        const agentName = idleAgents.get(row.assigneeAgentId);
        if (!agentName) continue;
        candidates.push({
          issueId: row.issueId,
          identifier: row.identifier,
          title: row.title,
          assigneeAgentId: row.assigneeAgentId,
          agentName,
          executionWorkspaceId: row.executionWorkspaceId,
        });
      }

      // De-dupe the dispatchable set so a single batch fires at most one
      // wakeup per workspace AND per agent:
      //   - workspace: two issues sharing an execution workspace can't run
      //     in parallel without clobbering each other.
      //   - agent (WC-55 / #14): one idle agent shouldn't be handed multiple
      //     concurrent wakeups in the same batch — it drains its run queue
      //     sequentially, so extra wakeups just create redundant queued runs.
      // Null-workspace candidates skip the workspace check but still respect
      // the per-agent cap.
      const seenWorkspaces = new Set<string>();
      const seenAgents = new Set<string>();
      const dispatchable: ParallelDispatchCandidate[] = [];
      for (const cand of candidates) {
        if (seenAgents.has(cand.assigneeAgentId)) continue;
        const ws = cand.executionWorkspaceId;
        if (ws != null) {
          if (seenWorkspaces.has(ws)) continue;
          seenWorkspaces.add(ws);
        }
        seenAgents.add(cand.assigneeAgentId);
        dispatchable.push(cand);
      }

      return { candidates, dispatchable };
    },
  };
}
