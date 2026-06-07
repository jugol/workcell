import { z } from "zod";

// WC-204 (deliberation mode, slice 1): per-agent dual-brain internal consensus
// config. When enabled, the agent has TWO independently-modeled brains; its
// work runs through an internal propose→review loop until one brain accepts or
// maxRounds is hit. This validator defines the stored shape; the engine that
// consumes it lives in server/src/services/agent-deliberation.ts (and nothing
// reads it on the live execution path yet — that is a later slice).

const deliberationBrainSchema = z
  .object({
    // WC-208 (per-brain adapter): the adapter type this brain runs on (e.g.
    // "claude_local", "codex_local"). null/absent = inherit the agent's own
    // adapterType. Stored as a free string (validated against the live registry
    // at run time) so the schema stays adapter-agnostic.
    adapter: z.string().min(1).nullable().optional(),
    // The model id this brain runs (null/absent = inherit the agent's default
    // model). Layered onto the resolved adapter's config as config.model.
    model: z.string().min(1).nullable().optional(),
  })
  .strict();

export const agentDeliberationConfigSchema = z
  .object({
    enabled: z.boolean(),
    brainA: deliberationBrainSchema,
    brainB: deliberationBrainSchema,
    maxRounds: z.number().int().min(1).max(8).default(4),
  })
  .strict();

export type AgentDeliberationConfig = z.infer<typeof agentDeliberationConfigSchema>;

// WC-206 (deliberation mode, slice 3): request body for the LIVE deliberation
// run route (POST /agents/:id/deliberate). `task` is the work the dual brains
// deliberate over; `maxRoundsOverride` optionally caps the review rounds for
// this single run (otherwise the agent's stored deliberation.maxRounds applies).
export const deliberateAgentSchema = z
  .object({
    task: z.string().min(1).max(8000),
    maxRoundsOverride: z.number().int().min(1).max(8).optional(),
  })
  .strict();

export type DeliberateAgentRequest = z.infer<typeof deliberateAgentSchema>;
