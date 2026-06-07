import { getServerAdapter } from "../adapters/index.js";
import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntime,
  ServerAdapterModule,
} from "../adapters/index.js";

// WC-57 (P2 §3 real-LLM groundwork): a thin, reusable single-turn adapter
// invocation.
//
// This is the minimal seam the real pair-turn invoker (WC-58) uses to run ONE
// adapter turn and collect its text output. It mirrors the *core* of the
// heartbeat run path — getServerAdapter(type) → adapter.execute(ctx) →
// accumulate stdout — WITHOUT heartbeat's heavy run-record / workspace /
// session / secret machinery. Callers supply the agent + runtime + config +
// context + executionTarget; assembling those richer fields stays the
// caller's concern, and fuller parity with heartbeat (sessions, workspace
// services, JWT) is a documented follow-up.
//
// IMPORTANT: this helper is deliberately NOT wired into heartbeat.ts — the
// production run path is large and battle-tested, and refactoring its hot
// loop to adopt this seam would risk a regression for no gain. This exists
// purely as the lightweight entry point for new single-turn callers.
//
// The `resolveAdapter` seam lets tests inject a fake adapter module so the
// contract is verified hermetically (no real CLI / LLM).

type AdapterExecutionTarget = AdapterExecutionContext["executionTarget"];

// Minimal adapter surface this helper needs — `execute` only. Lets callers
// (and tests) pass a fake without implementing the full ServerAdapterModule.
export type SingleTurnAdapter = Pick<ServerAdapterModule, "execute">;

export interface AdapterSingleTurnInput {
  adapterType: string;
  runId: string;
  agent: AdapterAgent;
  runtime?: AdapterRuntime;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  executionTarget?: AdapterExecutionTarget;
  authToken?: string;
  // Test seam: inject a fake adapter. Defaults to the real registry lookup.
  resolveAdapter?: (type: string) => SingleTurnAdapter;
}

export interface AdapterSingleTurnResult {
  stdout: string;
  stderr: string;
  result: AdapterExecutionResult;
}

const EMPTY_RUNTIME: AdapterRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

// Run a single adapter turn. Resolves the adapter, calls execute() with a
// minimal context, accumulates stdout/stderr via the onLog callback, and
// returns the collected text alongside the raw AdapterExecutionResult.
export async function runAdapterSingleTurn(
  input: AdapterSingleTurnInput,
): Promise<AdapterSingleTurnResult> {
  const resolve = input.resolveAdapter ?? getServerAdapter;
  const adapter = resolve(input.adapterType);

  let stdout = "";
  let stderr = "";
  const result = await adapter.execute({
    runId: input.runId,
    agent: input.agent,
    runtime: input.runtime ?? EMPTY_RUNTIME,
    config: input.config ?? {},
    context: input.context ?? {},
    executionTarget: input.executionTarget ?? null,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    },
    authToken: input.authToken,
  });

  return { stdout, stderr, result };
}
