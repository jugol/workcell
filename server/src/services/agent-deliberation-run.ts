import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agentDeliberationRuns, agentDeliberationTurns } from "@workcell/db";
import {
  runAgentDeliberation,
  type DeliberationInvoke,
  type DeliberationTranscriptEntry,
} from "./agent-deliberation.js";

// WC-209 (deliberation async + persist): the persistence layer that turns the
// invoke-agnostic WC-204 engine into a durable, pollable async run.
//
// WHY: the synchronous POST /agents/:id/deliberate blocked ~5 min per run (each
// claude_local turn ~75s) and the transcript lived ONLY in the HTTP response —
// lost on a client/proxy timeout, after spending real money. This service:
//   1. inserts a run row (status "running") up front,
//   2. runs the engine with an `onTurn` that persists each transcript entry the
//      moment it is produced (and accumulates the per-turn cost), and
//   3. on return updates the run (completed + finalOutput/acceptedBy/rounds/
//      cost/completedAt); on throw marks it "failed" with the error.
// The route calls `start(...)` FIRE-AND-FORGET and returns 202 immediately; GET
// routes poll getRun()/listRuns().
//
// COST ATTRIBUTION: the engine never reports cost — the LIVE invoke does, via
// the `onCost` hook its factory accepts. So `start` takes a `buildInvoke(onCost)`
// FACTORY (not a raw invoke): the service supplies an `onCost` that books each
// turn's cents against the turn row the engine is about to push. The engine
// awaits invoke fully before pushing the entry, so the cost for turn N is in
// hand by the time onTurn persists turn N. A stub invoke that ignores onCost
// simply yields 0-cost turns.
//
// WC-211 (finding 3 — reaper): a server restart (or a stuck/hung turn that
// outlives the per-turn timeout window) used to leave a row stuck "running"
// forever — the fire-and-forget loop dies with the process and never finalizes
// the row. reapStaleDeliberationRuns (below) fails any "running" row older than a
// threshold; index.ts calls it once on startup so a crash/restart can't leave
// zombie "running" rows behind.

export interface AgentDeliberationStartInput {
  companyId: string;
  agentId: string;
  task: string;
  maxRoundsOverride?: number;
  // Snapshotted per-brain config (adapter + model) used for THIS run.
  brainA: { adapter?: string | null; model?: string | null };
  brainB: { adapter?: string | null; model?: string | null };
  maxRounds: number;
  // Factory for the engine's single-turn invoke. The service passes an `onCost`
  // the invoke reports each turn's billed cents to; the live factory
  // (buildLiveDeliberationInvoke) accepts exactly this. A test stub can ignore
  // the arg and return a deterministic invoke.
  buildInvoke: (onCost: (costCents: number) => void) => DeliberationInvoke;
}

// Default staleness threshold for the orphan reaper: a "running" deliberation
// run older than this is considered abandoned (server restart or a turn stuck
// past the per-turn timeout) and is failed. 20 min comfortably exceeds a healthy
// run (a few ~75s turns) plus the 120s per-turn timeout slack.
const DEFAULT_STALE_DELIBERATION_RUN_MS = 20 * 60 * 1000;

// WC-211 (finding 3): fail orphaned "running" deliberation runs. Marks every
// agent_deliberation_runs row that is still status='running' AND was created
// before (now - olderThanMs) as status='failed' with an "abandoned" error and
// completed_at=now. Called once on server startup (index.ts) so a crash/restart
// — which kills the fire-and-forget loop mid-run — does not leave zombie
// 'running' rows that poll forever. Returns the number of rows reaped.
export async function reapStaleDeliberationRuns(
  db: Db,
  opts?: { olderThanMs?: number },
): Promise<{ reaped: number }> {
  const olderThanMs = opts?.olderThanMs ?? DEFAULT_STALE_DELIBERATION_RUN_MS;
  const cutoff = new Date(Date.now() - olderThanMs);
  const reaped = await db
    .update(agentDeliberationRuns)
    .set({
      status: "failed",
      error: "abandoned (server restart or stuck turn)",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentDeliberationRuns.status, "running"),
        lt(agentDeliberationRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: agentDeliberationRuns.id });
  return { reaped: reaped.length };
}

export function agentDeliberationRunService(db: Db) {
  // Insert the "running" header row and return its id. Extracted so `start` can
  // create the row, hand the id back to the route for an immediate 202, THEN
  // run the loop fire-and-forget.
  async function insertRunRow(input: AgentDeliberationStartInput): Promise<string> {
    const [row] = await db
      .insert(agentDeliberationRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        task: input.task,
        status: "running",
        maxRounds: input.maxRoundsOverride ?? input.maxRounds,
        brainA: { adapter: input.brainA.adapter ?? null, model: input.brainA.model ?? null },
        brainB: { adapter: input.brainB.adapter ?? null, model: input.brainB.model ?? null },
      })
      .returning({ id: agentDeliberationRuns.id });
    return row!.id;
  }

  // Drive the engine for an EXISTING run row: persist each turn as it is
  // produced, attribute its cost, and finalize the run on completion/failure.
  // Resolves when the run reaches a terminal state. Never throws — engine
  // failures are recorded on the row as status "failed".
  async function runLoop(runId: string, input: AgentDeliberationStartInput): Promise<void> {
    let totalCostCents = 0;
    // Cents reported for the in-flight turn, captured by the onCost hook and
    // consumed (zeroed) when the corresponding turn row is written.
    let pendingCostCents = 0;
    const onCost = (costCents: number) => {
      pendingCostCents += costCents;
    };
    const invoke = input.buildInvoke(onCost);

    const onTurn = async (entry: DeliberationTranscriptEntry): Promise<void> => {
      const costCents = pendingCostCents;
      pendingCostCents = 0;
      totalCostCents += costCents;
      await db.insert(agentDeliberationTurns).values({
        runId,
        round: entry.round,
        brain: entry.brain,
        action: entry.action,
        content: entry.content,
        feedback: entry.feedback,
        costCents,
      });
    };

    try {
      const result = await runAgentDeliberation({
        task: input.task,
        brainA: { adapter: input.brainA.adapter ?? null, model: input.brainA.model ?? null },
        brainB: { adapter: input.brainB.adapter ?? null, model: input.brainB.model ?? null },
        maxRounds: input.maxRoundsOverride ?? input.maxRounds,
        invoke,
        onTurn,
      });

      await db
        .update(agentDeliberationRuns)
        .set({
          status: "completed",
          finalOutput: result.finalOutput,
          acceptedBy: result.acceptedBy,
          rounds: result.rounds,
          totalCostCents,
          completedAt: new Date(),
        })
        .where(eq(agentDeliberationRuns.id, runId));
    } catch (err) {
      await db
        .update(agentDeliberationRuns)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          totalCostCents,
          completedAt: new Date(),
        })
        .where(eq(agentDeliberationRuns.id, runId));
    }
  }

  return {
    // Insert the run row up front and return { runId, run } so the route can
    // 202 immediately. Does NOT run the loop — the route calls `run(runId,...)`
    // fire-and-forget after responding.
    create: insertRunRow,

    run: runLoop,

    // Create the row then run the loop to completion, returning the runId.
    // Convenience for synchronous callers / tests; the route prefers
    // create()+run() so it can respond before the loop settles.
    start: async (input: AgentDeliberationStartInput): Promise<string> => {
      const runId = await insertRunRow(input);
      await runLoop(runId, input);
      return runId;
    },

    // Fetch one run + its ordered turns, company-scoped. Returns null when the
    // run is missing or belongs to another company (→ cross-tenant 404).
    getRun: async (companyId: string, runId: string) => {
      const run = await db
        .select()
        .from(agentDeliberationRuns)
        .where(
          and(
            eq(agentDeliberationRuns.companyId, companyId),
            eq(agentDeliberationRuns.id, runId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!run) return null;
      const turns = await db
        .select()
        .from(agentDeliberationTurns)
        .where(eq(agentDeliberationTurns.runId, runId))
        .orderBy(agentDeliberationTurns.round, agentDeliberationTurns.createdAt);
      return { run, turns };
    },

    // List recent runs for an agent within a company (newest first).
    listRuns: async (companyId: string, agentId: string, limit = 20) => {
      return db
        .select()
        .from(agentDeliberationRuns)
        .where(
          and(
            eq(agentDeliberationRuns.companyId, companyId),
            eq(agentDeliberationRuns.agentId, agentId),
          ),
        )
        .orderBy(desc(agentDeliberationRuns.createdAt))
        .limit(Math.max(1, Math.min(100, Math.trunc(limit))));
    },
  };
}
