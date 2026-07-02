// Pair-round in-flight registry.
//
// A pair round is expensive (two real LLM turns), so exactly ONE driver may
// advance a given pair group at a time — whether that driver is the manual
// POST /pair-groups/:id/run-round route or the auto-run heartbeat ticker.
// WC-128's recordTurn dedup only prevents duplicate LEDGER rows; by the time
// it fires, the duplicate LLM calls have already been billed. This registry
// closes that gap at the entry points: acquire before running, release after.
//
// Scope note: this is a MODULE-LEVEL SINGLETON and therefore only correct for
// the local single-process deployment Workcell currently targets. If the
// server ever runs multiple processes, this must move to a DB- or
// Redis-backed lease.

export type PairRunSource = "manual" | "auto_run";

export interface PairRunEntry {
  source: PairRunSource;
  startedAt: Date;
  // WC-58 follow-up (pair turns as real heartbeat runs): the heartbeat_runs.id
  // of the pair TURN currently executing inside the in-flight round, set by
  // the live invoker when it creates the run record and cleared when the turn
  // settles. Null between turns (e.g. owner finished, counterpart not started)
  // and on the stub path (no run record is created there).
  runId?: string | null;
}

export interface PairRunRegistry {
  // Returns false (and does NOT overwrite) when a run is already in flight
  // for the group; true when the caller acquired the slot.
  tryAcquire(pairGroupId: string, source: PairRunSource): boolean;
  release(pairGroupId: string): void;
  get(pairGroupId: string): PairRunEntry | null;
  // No-op when no run is in flight for the group (the entry is owned by the
  // acquiring driver; a turn can only annotate it, never create it).
  setRunId(pairGroupId: string, runId: string | null): void;
}

// Factory exists for unit tests; production code uses the singleton below so
// the manual route and the auto-run ticker see the same in-flight state.
export function createPairRunRegistry(): PairRunRegistry {
  const inFlight = new Map<string, PairRunEntry>();
  return {
    tryAcquire(pairGroupId, source) {
      if (inFlight.has(pairGroupId)) return false;
      inFlight.set(pairGroupId, { source, startedAt: new Date() });
      return true;
    },
    release(pairGroupId) {
      inFlight.delete(pairGroupId);
    },
    get(pairGroupId) {
      return inFlight.get(pairGroupId) ?? null;
    },
    setRunId(pairGroupId, runId) {
      const entry = inFlight.get(pairGroupId);
      if (entry) entry.runId = runId;
    },
  };
}

export const pairRunRegistry: PairRunRegistry = createPairRunRegistry();
