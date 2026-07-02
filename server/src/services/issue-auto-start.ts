import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issues } from "@workcell/db";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

// System-side issue auto-start: when work ACTUALLY begins (a pair round runs,
// or a scoped heartbeat run is claimed), flip the issue to in_progress so the
// board reflects reality instead of waiting for the agent to self-checkout.
//
// Deliberately a DIRECT conditional UPDATE + activity log, NOT
// issueService.update — system transitions must not trigger user-mutation
// side effects (assignment wakeups, re-queues). This mirrors the existing
// watchdog/recovery convention (see recovery/service.ts, heartbeat.ts).
//
// Both helpers are best-effort and idempotent:
//   - the UPDATE carries the expected current status in its WHERE clause, so
//     a concurrent transition makes this a no-op instead of clobbering state;
//   - any failure is logged and swallowed — auto-start must never break the
//     pair round or the heartbeat claim path.

const AUTO_START_TARGET_STATUS = "in_progress" as const;

async function logAutoStart(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    from: string;
    agentId?: string | null;
    runId?: string | null;
    details: Record<string, unknown>;
  },
) {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "system",
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    action: "issue.status_changed",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      from: input.from,
      to: AUTO_START_TARGET_STATUS,
      ...input.details,
    },
  });
}

// [A] Pair rounds: a round actually running on the issue means the work has
// started — backlog AND todo both move to in_progress (a pair group is an
// explicit instruction to work the issue, so backlog is fair game here).
export async function autoStartIssueForPairRound(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    pairGroupId: string;
    ownerAgentId?: string | null;
  },
): Promise<{ issueId: string; from: string } | null> {
  try {
    const current = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!current) return null;
    if (current.status !== "backlog" && current.status !== "todo") return null;

    // Conditional on the status we just read → concurrency-safe + idempotent.
    const [updated] = await db
      .update(issues)
      .set({ status: AUTO_START_TARGET_STATUS, updatedAt: new Date() })
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.issueId),
          eq(issues.status, current.status),
        ),
      )
      .returning({ id: issues.id });
    if (!updated) return null;

    await logAutoStart(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      from: current.status,
      agentId: input.ownerAgentId ?? null,
      details: { autoStarted: "pair_round", pairGroupId: input.pairGroupId },
    });
    return { issueId: input.issueId, from: current.status };
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, issueId: input.issueId, pairGroupId: input.pairGroupId },
      "pair round issue auto-start failed",
    );
    return null;
  }
}

export interface AutoStartRunLike {
  id: string;
  companyId: string;
  agentId: string;
  contextSnapshot: unknown;
}

// [B] Heartbeat run claim: the run scoped to an issue just transitioned to
// "running". Strictly narrower than [A]:
//   - "todo" ONLY (backlog stays a deliberate human queue — a stray context
//     run must not pull backlog items into flight);
//   - the issue must be assigned to the SAME agent the run belongs to
//     (mention/context runs over someone else's issue do not start it);
//   - no human co-assignee (assigneeUserId null) — a human on the issue means
//     a human decides when it starts.
export async function autoStartScopedIssue(
  db: Db,
  run: AutoStartRunLike,
): Promise<{ issueId: string } | null> {
  try {
    const context = parseObject(run.contextSnapshot);
    const issueId =
      typeof context.issueId === "string" && context.issueId.trim().length > 0
        ? context.issueId
        : null;
    if (!issueId) return null;

    const [updated] = await db
      .update(issues)
      .set({ status: AUTO_START_TARGET_STATUS, updatedAt: new Date() })
      .where(
        and(
          eq(issues.companyId, run.companyId),
          eq(issues.id, issueId),
          eq(issues.status, "todo"),
          eq(issues.assigneeAgentId, run.agentId),
          isNull(issues.assigneeUserId),
        ),
      )
      .returning({ id: issues.id });
    if (!updated) return null;

    await logAutoStart(db, {
      companyId: run.companyId,
      issueId,
      from: "todo",
      agentId: run.agentId,
      runId: run.id,
      details: { autoStarted: "run_claim", runId: run.id },
    });
    return { issueId };
  } catch (err) {
    logger.warn(
      { err, companyId: run.companyId, runId: run.id },
      "run claim issue auto-start failed",
    );
    return null;
  }
}
