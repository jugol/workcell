import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@workcell/db";
import { getServerAdapter } from "../adapters/index.js";
import { appendWithByteCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import {
  runAdapterSingleTurn,
  type SingleTurnAdapter,
} from "./adapter-single-turn.js";
import { billedCostCentsFromAdapterResult } from "./cost-mapping.js";
import { compactRunLogChunk } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { publishLiveEvent } from "./live-events.js";
import { pairRunRegistry } from "./pair-run-registry.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import {
  parsePairTurnResponse,
  type PairTurnInvokeFn,
} from "./pair-turn-executors.js";

// WC-58 (P2 §3 real LLM pair invoker): a real adapter-backed PairTurnInvokeFn.
//
// The orchestrator (WC-32) + prompt-aware executor (WC-33) already route a
// round through a pluggable `invoke` callback. WC-33 shipped only the
// deterministic stub; this is the live implementation that actually drives
// an LLM: it runs ONE adapter turn via the WC-57 runAdapterSingleTurn helper,
// then maps the AdapterExecutionResult into a PairTurnInvokeResult.
//
// FLAG-GATED: app.ts selects this only when WORKCELL_PAIR_LIVE_LLM is set;
// CI + the default app keep stubPairTurnInvoke so tests stay hermetic and the
// run-round route works without an LLM/API key. All tests here inject a
// mocked adapter via the resolveAdapter seam — the live CLI path is never
// exercised in CI.
//
// CONTEXT SCOPE: the round prompt rides on context.workcellTaskMarkdown (the
// key claude-local folds into its prompt), and the turn runs with the agent's
// configured adapterConfig — model selection via config.model (WC-97), an
// existing workspace cwd if any (WC-103), and env-secret bindings RESOLVED to
// plain values on the live path (WC-125, via the executor's resolveAdapterConfig
// option). JWT parity is implemented: when the registry adapter declares
// supportsLocalAgentJwt, the turn gets a local agent JWT (same issuance as
// heartbeat's createLocalAgentJwt call) so the spawned CLI can call the agent
// API instead of 401ing; if issuance fails we degrade to a token-less turn
// with a warn log. Remaining heartbeat-parity gaps (NEW workspace realization
// when the issue has none, session continuity) stay a documented follow-up;
// the value here is the correct result→ledger mapping + graceful failure
// handling. Issue grounding = WC-59; model parity = WC-97; env-secret parity
// = WC-125.
//
// REAL RUN RECORDS (pair turns promoted to heartbeat_runs): when `options.db`
// is provided (the production wiring via buildDefaultPairTurnExecutor), each
// pair turn creates a REAL heartbeat_runs row and uses its uuid as the runId
// for both the local agent JWT and the adapter invocation. This fixes the
// checkout 500: the JWT's run_id flows into issues.checkout_run_id (a uuid
// column with an FK to heartbeat_runs), so the previous synthetic
// "pair-<group>-r<round>-<role>-<uuid>" string made Drizzle throw on uuid
// parse. It also gives pair turns the same live observability heartbeat runs
// have, following heartbeat's own conventions for each surface:
//   - heartbeat_run_events: "lifecycle" start/finish events (the events table
//     is NOT used for raw log chunks — heartbeat itself never writes chunks
//     there; the silent-run liveness scan counts non-lifecycle events as
//     agent-API activity evidence, so flooding it with log rows would skew
//     that classification).
//   - run-log store (getRunLogStore): every onLog chunk is appended to the
//     run's NDJSON log (compacted + sensitive/user-redacted exactly like
//     heartbeat's onLog), so GET /heartbeat-runs/:runId/log works.
//   - live events: heartbeat.run.log per chunk + heartbeat.run.event for
//     lifecycle — the UI's live run stream shows the turn in real time.
//   - run-row output progress: lastOutputAt/Seq/Stream/Bytes flushed at most
//     once per PAIR_RUN_OUTPUT_FLUSH_INTERVAL_MS (heartbeat's interval), so
//     the silent-run watchdog sees genuine output recency.
//
// REAPER / WATCHDOG INTERACTION (deliberate non-change in heartbeat.ts):
//   - reapOrphanedRuns skips any "running" run present in the shared
//     runningProcesses map; the live pair adapters (claude_local/codex_local)
//     register their spawned child there keyed by THIS runId for the whole
//     turn, so an in-flight pair turn is never reaped. The staleness fallback
//     (updatedAt) is additionally kept fresh by the output-progress flush.
//     After a server crash a pair run stuck in "running" SHOULD be reaped to
//     "failed" — that is correct crash recovery, so no exclusion filter is
//     added.
//   - scanSilentActiveRuns only opens a watchdog evaluation after prolonged
//     output silence (coalesce(lastOutputAt, …) threshold) — accurate for a
//     genuinely stuck pair turn, so it is intentionally NOT excluded either.
// Run-record persistence is best-effort: any failure to write telemetry logs
// a warning and the turn still runs (a observability gap must not abort a
// billed round). Without `db` (pure unit tests) no records are written and
// the runId degrades to a plain randomUUID() — still uuid-shaped, so it can
// never re-introduce the checkout uuid-parse 500.

export interface RealPairTurnInvokeOptions {
  // Production wiring: enables real heartbeat_runs lifecycle records + log
  // streaming for each pair turn. Absent (pure unit tests), the turn runs
  // with an unpersisted random uuid runId and no telemetry writes.
  db?: Db;
  // Test seam: inject a fake adapter module. Defaults (in runAdapterSingleTurn)
  // to the real getServerAdapter registry lookup.
  resolveAdapter?: (type: string) => SingleTurnAdapter;
  // Test seam: inject a fake JWT issuer. Defaults to the same
  // createLocalAgentJwt heartbeat uses.
  issueLocalAgentJwt?: typeof createLocalAgentJwt;
}

// Heartbeat parity: ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS (heartbeat.ts)
// — the run-row output progress columns are written at most this often while
// chunks stream, which also keeps updatedAt fresh for the reaper's staleness
// fallback.
const PAIR_RUN_OUTPUT_FLUSH_INTERVAL_MS = 60 * 1000;
// Heartbeat parity: MAX_LIVE_LOG_CHUNK_BYTES (heartbeat.ts) — live event
// payload chunks are tail-truncated to this size.
const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

interface PairTurnRunFinalization {
  status: "succeeded" | "failed";
  outcome: "delivered" | "no_change" | "abort";
  errorMessage?: string | null;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  costUsd?: number | null;
  billingType?: string | null;
  model?: string | null;
  provider?: string | null;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
}

interface PairTurnRunRecord {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  finish: (final: PairTurnRunFinalization) => Promise<void>;
}

// Create the heartbeat_runs row for one pair turn and return the telemetry
// hooks the invoker streams through. Everything after the initial INSERT is
// best-effort (warn + continue); the INSERT itself is the caller's decision
// point — without the row the runId must not be handed to the JWT as a
// persisted run.
async function beginPairTurnRunRecord(
  db: Db,
  input: {
    runId: string;
    companyId: string;
    agentId: string;
    pairGroupId: string;
    round: number;
    role: string;
    issueId: string | null;
  },
): Promise<PairTurnRunRecord> {
  const { runId, companyId, agentId } = input;
  const startedAt = new Date();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    // Free-text column (no DB constraint); "pair_round" is added to the shared
    // HEARTBEAT_INVOCATION_SOURCES union so typed consumers stay honest.
    invocationSource: "pair_round",
    triggerDetail: `pair_group:${input.pairGroupId} round:${input.round + 1} role:${input.role}`,
    status: "running",
    startedAt,
    // issueId mirrors heartbeat's contextSnapshot convention so the run shows
    // up under GET /issues/:issueId/live-runs and issue-level liveness sees
    // the pair as active work on the issue. pairTurn marks provenance.
    contextSnapshot: {
      pairTurn: true,
      pairGroupId: input.pairGroupId,
      round: input.round,
      role: input.role,
      ...(input.issueId ? { issueId: input.issueId } : {}),
    },
  });

  let redactionOptions: CurrentUserRedactionOptions | undefined;
  try {
    redactionOptions = {
      enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
    };
  } catch (err) {
    logger.warn({ runId, err }, "pair turn: failed to load log redaction settings; using defaults");
  }

  // This run is brand new and single-writer, so a local seq counter replaces
  // heartbeat's nextRunEventSeq() max-query.
  let eventSeq = 0;
  const appendEvent = async (event: {
    level: "info" | "warn" | "error";
    message: string;
    payload?: Record<string, unknown>;
  }) => {
    eventSeq += 1;
    const seq = eventSeq;
    try {
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId,
        seq,
        eventType: "lifecycle",
        stream: "system",
        level: event.level,
        message: event.message,
        payload: event.payload,
      });
      publishLiveEvent({
        companyId,
        type: "heartbeat.run.event",
        payload: {
          runId,
          agentId,
          seq,
          eventType: "lifecycle",
          stream: "system",
          level: event.level,
          color: null,
          message: event.message,
          payload: event.payload ?? null,
        },
      });
    } catch (err) {
      logger.warn({ runId, err }, "pair turn: failed to append run lifecycle event");
    }
  };

  const logStore = getRunLogStore();
  let logHandle: RunLogHandle | null = null;
  try {
    logHandle = await logStore.begin({ companyId, agentId, runId });
    await db
      .update(heartbeatRuns)
      .set({ logStore: logHandle.store, logRef: logHandle.logRef, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
  } catch (err) {
    logHandle = null;
    logger.warn({ runId, err }, "pair turn: failed to open run log store; turn runs without a persisted log");
  }

  await appendEvent({
    level: "info",
    message: "pair turn started",
    payload: { pairGroupId: input.pairGroupId, round: input.round, role: input.role },
  });

  let stdoutExcerpt = "";
  let stderrExcerpt = "";
  let persistedLogBytes = 0;
  let outputSeq = 0;
  let lastOutputFlushAt: number | null = null;
  let pendingOutputProgress: {
    at: Date;
    seq: number;
    stream: "stdout" | "stderr";
    bytes: number;
  } | null = null;

  const flushOutputProgress = async (force = false) => {
    if (!pendingOutputProgress) return;
    const shouldFlush =
      force ||
      lastOutputFlushAt === null ||
      pendingOutputProgress.at.getTime() - lastOutputFlushAt >= PAIR_RUN_OUTPUT_FLUSH_INTERVAL_MS;
    if (!shouldFlush) return;
    const progress = pendingOutputProgress;
    pendingOutputProgress = null;
    lastOutputFlushAt = progress.at.getTime();
    await db
      .update(heartbeatRuns)
      .set({
        lastOutputAt: progress.at,
        lastOutputSeq: progress.seq,
        lastOutputStream: progress.stream,
        lastOutputBytes: progress.bytes,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));
  };

  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    try {
      // Same write-path sanitation heartbeat's onLog applies: secret-pattern +
      // inline-image redaction with size compaction, then current-user
      // redaction per instance settings.
      const sanitizedChunk = compactRunLogChunk(redactCurrentUserText(chunk, redactionOptions));
      if (stream === "stdout") stdoutExcerpt = appendWithByteCap(stdoutExcerpt, sanitizedChunk, MAX_EXCERPT_BYTES);
      else stderrExcerpt = appendWithByteCap(stderrExcerpt, sanitizedChunk, MAX_EXCERPT_BYTES);

      const ts = new Date().toISOString();
      if (logHandle) {
        persistedLogBytes += await logStore.append(logHandle, { stream, chunk: sanitizedChunk, ts });
      }
      outputSeq += 1;
      pendingOutputProgress = {
        at: new Date(ts),
        seq: outputSeq,
        stream,
        bytes: persistedLogBytes,
      };
      await flushOutputProgress();

      const payloadChunk =
        sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
          ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
          : sanitizedChunk;
      publishLiveEvent({
        companyId,
        type: "heartbeat.run.log",
        payload: {
          runId,
          agentId,
          ts,
          stream,
          chunk: payloadChunk,
          truncated: payloadChunk.length !== sanitizedChunk.length,
        },
      });
    } catch (err) {
      // Telemetry must never fail the billed turn.
      logger.warn({ runId, err }, "pair turn: failed to persist run log chunk");
    }
  };

  const finish = async (final: PairTurnRunFinalization) => {
    let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
    if (logHandle) {
      try {
        logSummary = await logStore.finalize(logHandle);
      } catch (err) {
        logger.warn({ runId, err }, "pair turn: failed to finalize run log");
      }
    }
    if (pendingOutputProgress && logSummary) {
      pendingOutputProgress.bytes = logSummary.bytes;
    }
    await flushOutputProgress(true);

    const finishedAt = new Date();
    const usageJson =
      final.costUsd != null || final.model || final.billingType
        ? {
            ...(final.costUsd != null ? { costUsd: final.costUsd } : {}),
            ...(final.billingType ? { billingType: final.billingType } : {}),
            model: final.model ?? "unknown",
            provider: final.provider ?? "unknown",
          }
        : null;
    await db
      .update(heartbeatRuns)
      .set({
        status: final.status,
        finishedAt,
        error: final.errorMessage ?? null,
        errorCode: final.errorCode ?? null,
        exitCode: final.exitCode ?? null,
        signal: final.signal ?? null,
        usageJson,
        resultJson: {
          ...(final.resultJson ?? {}),
          ...(final.summary ? { summary: final.summary } : {}),
          pairTurn: {
            pairGroupId: input.pairGroupId,
            round: input.round,
            role: input.role,
            outcome: final.outcome,
          },
        },
        stdoutExcerpt: stdoutExcerpt || null,
        stderrExcerpt: stderrExcerpt || null,
        ...(logSummary
          ? {
              logBytes: logSummary.bytes,
              logSha256: logSummary.sha256,
              logCompressed: logSummary.compressed,
            }
          : {}),
        updatedAt: finishedAt,
      })
      .where(eq(heartbeatRuns.id, runId));

    await appendEvent({
      level: final.status === "succeeded" ? "info" : "error",
      message: `pair turn ${final.status}`,
      payload: {
        status: final.status,
        outcome: final.outcome,
        ...(final.exitCode != null ? { exitCode: final.exitCode } : {}),
        ...(final.errorMessage ? { error: final.errorMessage } : {}),
      },
    });
  };

  return { onLog, finish };
}

export function buildRealPairTurnInvoke(
  options: RealPairTurnInvokeOptions = {},
): PairTurnInvokeFn {
  return async ({ request, promptText, agent, issue, workspaceCwd }) => {
    const adapterType = agent.adapter ?? "claude_local";
    // The runId IS a heartbeat_runs.id on the persisted path; either way it is
    // uuid-shaped so downstream uuid columns (issues.checkout_run_id) parse.
    const runId = randomUUID();

    let runRecord: PairTurnRunRecord | null = null;
    if (options.db) {
      try {
        runRecord = await beginPairTurnRunRecord(options.db, {
          runId,
          companyId: request.companyId,
          agentId: agent.id,
          pairGroupId: request.pairGroupId,
          round: request.round,
          role: request.role,
          issueId: issue?.id ?? null,
        });
      } catch (err) {
        // Degrade to a record-less turn: the runId stays uuid-shaped, so a
        // checkout would be cleanly rejected (run not found) instead of 500ing.
        logger.warn(
          { companyId: request.companyId, agentId: agent.id, runId, err },
          "pair turn: failed to create heartbeat run record; running turn without run persistence",
        );
        runRecord = null;
      }
    }
    // Surface the executing turn's run on the in-flight registry entry so
    // GET /issues/:id/pair-group can link straight to the live run. No-op when
    // this turn is not driven through the registry (direct executor tests).
    if (runRecord) pairRunRegistry.setRunId(request.pairGroupId, runId);

    // WC-97: run the turn with the agent's configured adapter settings (model
    // lives in adapterConfig.model). NOTE (review L2): on the LIVE path the
    // adapterConfig env carries RESOLVED secret VALUES (WC-125), not stripped
    // bindings — only the stub/default executor path strips env. They are fed to
    // the child process env, never written into the worktree.
    // WC-103: if the issue has an existing execution workspace, run the turn in
    // that cwd so the model can see the repo — claude-local resolves cwd as
    // `config.cwd` when no live workspace context is supplied (which a pair turn
    // does not supply). Absent → the adapter's process cwd (prior behavior).
    const baseConfig = agent.adapterConfig ?? {};
    const config = workspaceCwd ? { ...baseConfig, cwd: workspaceCwd } : baseConfig;

    // JWT parity with heartbeat (heartbeat.ts, supportsLocalAgentJwt block):
    // the spawned CLI calls the agent API with WORKCELL_API_KEY, which the
    // adapter injects from ctx.authToken. Without it every pair turn 401s.
    // The capability check uses the same source heartbeat uses — the server
    // adapter registry — NOT the (possibly faked) resolveAdapter test seam.
    let authToken: string | null = null;
    if (getServerAdapter(adapterType).supportsLocalAgentJwt) {
      const issueJwt = options.issueLocalAgentJwt ?? createLocalAgentJwt;
      authToken = issueJwt(agent.id, request.companyId, adapterType, runId);
      if (!authToken) {
        // Same degrade as heartbeat: run the turn without an injected key.
        logger.warn(
          { companyId: request.companyId, agentId: agent.id, runId, adapterType },
          "local agent jwt secret missing or invalid; running pair turn without injected WORKCELL_API_KEY",
        );
      }
    }

    // Set by every exit path below; consumed in finally so the run record is
    // closed on success, adapter failure AND thrown exceptions alike.
    let finalization: PairTurnRunFinalization | null = null;
    try {
      const { result } = await runAdapterSingleTurn({
        adapterType,
        runId,
        agent: {
          id: agent.id,
          companyId: request.companyId,
          name: agent.name,
          adapterType,
          adapterConfig: config,
        },
        // claude-local reads model from `config` (asString(config.model)) and
        // cwd from config.cwd; both now apply to the pair turn. The round prompt
        // rides on context.workcellTaskMarkdown (execute.ts folds it in).
        config,
        context: { workcellTaskMarkdown: promptText },
        authToken: authToken ?? undefined,
        onLog: runRecord?.onLog,
        resolveAdapter: options.resolveAdapter,
      });

      const costCents = billedCostCentsFromAdapterResult({
        costUsd: result.costUsd,
        billingType: result.billingType,
      });

      // Adapter-level failure (timeout / non-zero exit / error message) →
      // abort the pair gracefully instead of recording a bogus "delivered"
      // turn. The cost (if any) is still billed.
      if (result.timedOut || (result.exitCode ?? 0) !== 0 || result.errorMessage) {
        const reason = result.timedOut
          ? "timed out"
          : (result.errorMessage ?? `exit code ${result.exitCode}`);
        finalization = {
          status: "failed",
          outcome: "abort",
          errorMessage: reason,
          errorCode: result.timedOut ? "timeout" : (result.errorCode ?? "adapter_failed"),
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          costUsd: result.costUsd ?? null,
          billingType: result.billingType ?? null,
          model: result.model ?? null,
          provider: result.provider ?? null,
          resultJson: result.resultJson ?? null,
        };
        return {
          summary: `[adapter failure] ${agent.name} as ${request.role}: ${reason}`,
          outcome: "abort",
          costCents,
          metadata: {
            live: true,
            adapterType,
            adapterFailure: true,
            exitCode: result.exitCode ?? null,
            ...(runRecord ? { runId } : {}),
          },
        };
      }

      // WC-210 (finding D / same bug WC-207 fixed for deliberation): parse the
      // adapter's CLEAN assistant TEXT (result.summary), NOT raw stdout. For
      // stream-json adapters (claude-local) stdout is the NDJSON protocol stream
      // (hook/init/result events), so feeding it to parsePairTurnResponse made
      // the pair "summary" protocol garbage and the OUTCOME marker undetectable.
      // claude-local sets result.summary to the final assistant text
      // (parsedStream.summary || result.result); codex-local likewise. An adapter
      // that produced no summary → "" → parse yields an empty "(no output)"
      // delivered turn, the same safe degrade as before.
      const parsed = parsePairTurnResponse(result.summary ?? "");
      finalization = {
        status: "succeeded",
        outcome: parsed.outcome,
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        costUsd: result.costUsd ?? null,
        billingType: result.billingType ?? null,
        model: result.model ?? null,
        provider: result.provider ?? null,
        summary: result.summary ?? null,
        resultJson: result.resultJson ?? null,
      };
      return {
        summary: parsed.summary.length > 0 ? parsed.summary : "(no output)",
        outcome: parsed.outcome,
        costCents,
        metadata: { live: true, adapterType, ...(runRecord ? { runId } : {}) },
      };
    } catch (err) {
      // Never let an adapter exception bubble up as a 500 — convert it into a
      // clean abort so the orchestrator stops the pair gracefully.
      const message = err instanceof Error ? err.message : String(err);
      finalization = {
        status: "failed",
        outcome: "abort",
        errorMessage: message,
        errorCode: "adapter_error",
      };
      return {
        summary: `[adapter error] ${agent.name} as ${request.role}: ${message}`,
        outcome: "abort",
        costCents: 0,
        metadata: { live: true, adapterType, adapterError: true, ...(runRecord ? { runId } : {}) },
      };
    } finally {
      if (runRecord) {
        await runRecord
          .finish(
            finalization ?? {
              status: "failed",
              outcome: "abort",
              errorMessage: "pair turn ended without a recorded outcome",
              errorCode: "adapter_error",
            },
          )
          .catch((err) => {
            logger.warn(
              { companyId: request.companyId, agentId: agent.id, runId, err },
              "pair turn: failed to finalize heartbeat run record",
            );
          });
        pairRunRegistry.setRunId(request.pairGroupId, null);
      }
    }
  };
}
