import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@workcell/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  approvals,
  approvalComments,
  assets,
  capabilityAssignments,
  costEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
  issueThreadInteractions,
  joinRequests,
  pairGroups,
  pairTurns,
  projects,
  routines,
} from "@workcell/db";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, isUuidLike, normalizeAgentUrlKey } from "@workcell/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const DEFAULT_MAX_AGENTS_PER_COMPANY = 500;

/**
 * Per-company cap on live (non-terminated) agents, from
 * WORKCELL_MAX_AGENTS_PER_COMPANY. Defaults to a generous 500 so no real tenant
 * breaks; 0 or negative (or a non-numeric value) disables the cap entirely.
 * Returns null when unlimited.
 */
function resolveMaxAgentsPerCompany(): number | null {
  const raw = process.env.WORKCELL_MAX_AGENTS_PER_COMPANY?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_AGENTS_PER_COMPANY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_AGENTS_PER_COMPANY;
  const cap = Math.floor(parsed);
  return cap > 0 ? cap : null;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    defaultEnvironmentId: row.defaultEnvironmentId,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function parseFiniteNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRuntimeConfigForNewAgent(runtimeConfig: unknown): Record<string, unknown> {
  const normalizedRuntimeConfig = isPlainRecord(runtimeConfig) ? { ...runtimeConfig } : {};
  const heartbeat = isPlainRecord(normalizedRuntimeConfig.heartbeat)
    ? { ...normalizedRuntimeConfig.heartbeat }
    : {};
  if (parseFiniteNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  }
  normalizedRuntimeConfig.heartbeat = heartbeat;
  return normalizedRuntimeConfig;
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    defaultEnvironmentId:
      typeof snapshot.defaultEnvironmentId === "string" || snapshot.defaultEnvironmentId === null
        ? snapshot.defaultEnvironmentId
        : null,
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

// ── Org chart pair merging ────────────────────────────────────────────────
//
// A pair (owner ⇄ counterpart) behaves like ONE agent, so the org chart should
// render it as a single node with two "brains" instead of two separate cards
// joined by a dashed connector. The pairing is durable: pair groups are
// issue-scoped (they complete/abort when the issue converges), but the two
// agents stay one org node across issues — so the merge considers groups of
// EVERY status and, per agent pair, only the most recent group counts (see
// latestBindingPerPair). On top of that the merge stays conservative: it only
// fires for MUTUALLY EXCLUSIVE pairs — owner and counterpart each appear in
// latest bindings with exactly each other and nobody else. An agent whose
// latest groups span several partners (or who sits in a half-open binding
// with an unassigned side) keeps the old two-node rendering, which is always
// safe.

/** Minimal pair-binding row needed to merge paired agents in the org tree. */
export interface OrgPairBindingRow {
  ownerAgentId: string | null;
  counterpartAgentId: string | null;
}

/**
 * Reduce createdAt-DESC-ordered pair bindings to the most recent binding per
 * unordered agent pair (the first row seen wins). Rows with swapped
 * owner/counterpart count as the same pair, so the newest group also decides
 * which side is primary. Half-open bindings (one or both sides unassigned)
 * keep their own key and survive dedup, so they still mark the assigned agent
 * as ambiguous in mergeMutualPairsForOrg.
 */
export function latestBindingPerPair<T extends OrgPairBindingRow>(bindings: T[]): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];
  for (const binding of bindings) {
    const key = [binding.ownerAgentId ?? "", binding.counterpartAgentId ?? ""]
      .sort()
      .join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(binding);
  }
  return latest;
}

/**
 * Reduce latest-per-pair bindings (latestBindingPerPair output) to the
 * MUTUALLY EXCLUSIVE standing pairs: both sides assigned and distinct, and
 * each member appears in latest bindings with exactly each other and nobody
 * else. Agents touched by a half-open binding (one side unassigned) or a
 * self-binding are ambiguous and never qualify; an agent whose latest
 * bindings span several partners disqualifies every pair it sits in.
 * Duplicate bindings between the same two agents yield the pair once (first
 * row — i.e. newest — wins). This is the single source of truth for the
 * "standing pair" notion shared by the org-chart merge
 * (mergeMutualPairsForOrg) and the assignee-picker pair options
 * (listStandingMutualBindings).
 */
export function mutuallyExclusivePairBindings<T extends OrgPairBindingRow>(bindings: T[]): T[] {
  // Partner sets per agent across ALL given bindings. Agents in a half-open
  // binding (one side unassigned) or a self-binding are ambiguous: never pair.
  const partners = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  const addPartner = (agentId: string, partnerId: string) => {
    const set = partners.get(agentId) ?? new Set<string>();
    set.add(partnerId);
    partners.set(agentId, set);
  };
  for (const binding of bindings) {
    const ownerId = binding.ownerAgentId;
    const counterpartId = binding.counterpartAgentId;
    if (ownerId && counterpartId && ownerId !== counterpartId) {
      addPartner(ownerId, counterpartId);
      addPartner(counterpartId, ownerId);
    } else {
      if (ownerId) ambiguous.add(ownerId);
      if (counterpartId) ambiguous.add(counterpartId);
    }
  }

  const mutual: T[] = [];
  const used = new Set<string>();
  for (const binding of bindings) {
    const ownerId = binding.ownerAgentId;
    const counterpartId = binding.counterpartAgentId;
    if (!ownerId || !counterpartId || ownerId === counterpartId) continue;
    // Duplicate bindings between the SAME two agents qualify once.
    if (used.has(ownerId) || used.has(counterpartId)) continue;
    if (ambiguous.has(ownerId) || ambiguous.has(counterpartId)) continue;
    if (partners.get(ownerId)?.size !== 1 || partners.get(counterpartId)?.size !== 1) continue;
    used.add(ownerId);
    used.add(counterpartId);
    mutual.push(binding);
  }
  return mutual;
}

/** Counterpart summary attached to a merged org node as `pair`. */
export interface OrgPairInfo {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface OrgMergeableRow {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
}

/**
 * Merge mutually-exclusive pairs into single org rows. Callers feed it the
 * latest binding per agent pair (latestBindingPerPair), regardless of group
 * status — a pair stays merged after its group completes or aborts.
 *
 * For each merged pair the owner stays as the primary row and the counterpart
 * row is removed; the counterpart's summary is returned in `pairByPrimary`
 * keyed by the primary id. Subordinates of EITHER member are re-pointed at the
 * primary, and the merged node's own reportsTo prefers the owner's manager,
 * falling back to the counterpart's — a reportsTo pointing inside the pair is
 * treated as null (cycle prevention). With no bindings the input rows are
 * returned untouched, so the org output is byte-identical to the pre-merge
 * behavior.
 */
export function mergeMutualPairsForOrg<T extends OrgMergeableRow>(
  rows: T[],
  bindings: OrgPairBindingRow[],
): { rows: T[]; pairByPrimary: Map<string, OrgPairInfo> } {
  const pairByPrimary = new Map<string, OrgPairInfo>();
  if (bindings.length === 0) return { rows, pairByPrimary };

  const byId = new Map(rows.map((row) => [row.id, row]));

  const removedIds = new Set<string>();
  const remapToPrimary = new Map<string, string>(); // removed counterpart id -> primary id
  const reportsToOverride = new Map<string, string | null>(); // primary id -> merged reportsTo
  // The mutual-exclusivity rules (half-open/self bindings poison their agents,
  // multi-partner agents never merge, duplicates qualify once) live in
  // mutuallyExclusivePairBindings so the standing-pair API shares them.
  for (const binding of mutuallyExclusivePairBindings(bindings)) {
    const ownerId = binding.ownerAgentId!;
    const counterpartId = binding.counterpartAgentId!;
    const owner = byId.get(ownerId);
    const counterpart = byId.get(counterpartId);
    // Both sides must be live rows in this tree (terminated agents are
    // excluded upstream) or the merge would orphan reports.
    if (!owner || !counterpart) continue;

    // Cycle safety: a reportsTo pointing INSIDE the pair counts as null.
    const sanitize = (value: string | null) =>
      value && value !== ownerId && value !== counterpartId ? value : null;
    reportsToOverride.set(ownerId, sanitize(owner.reportsTo) ?? sanitize(counterpart.reportsTo));
    removedIds.add(counterpartId);
    remapToPrimary.set(counterpartId, ownerId);
    pairByPrimary.set(ownerId, {
      id: counterpart.id,
      name: counterpart.name,
      role: counterpart.role,
      status: counterpart.status,
    });
  }

  if (removedIds.size === 0) return { rows, pairByPrimary };

  const mergedRows = rows
    .filter((row) => !removedIds.has(row.id))
    .map((row) => {
      let reportsTo = reportsToOverride.has(row.id)
        ? reportsToOverride.get(row.id) ?? null
        : row.reportsTo;
      // Anyone reporting to a removed counterpart (including another merged
      // node whose manager was a counterpart) now reports to that pair's
      // primary node.
      if (reportsTo && remapToPrimary.has(reportsTo)) {
        reportsTo = remapToPrimary.get(reportsTo)!;
      }
      return reportsTo === row.reportsTo ? row : { ...row, reportsTo };
    });

  return { rows: mergedRows, pairByPrimary };
}

export function agentService(db: Db) {
  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [hydrated] = await hydrateAgentSpend([row]);
    return normalizeAgentRow(hydrated);
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          companyId: normalizedUpdated.companyId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      const hydrated = await hydrateAgentSpend(rows);
      return hydrated.map(normalizeAgentRow);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      // Per-company live-agent cap (WORKCELL_MAX_AGENTS_PER_COMPANY). Count only
      // non-terminated agents so churn doesn't permanently consume the budget;
      // this matches how the codebase distinguishes live vs terminated agents.
      const maxAgentsPerCompany = resolveMaxAgentsPerCompany();
      if (maxAgentsPerCompany !== null) {
        const liveAgentCount = existingAgents.filter((agent) => agent.status !== "terminated").length;
        if (liveAgentCount >= maxAgentsPerCompany) {
          throw conflict(
            `Company has reached the maximum of ${maxAgentsPerCompany} active agents `
              + `(WORKCELL_MAX_AGENTS_PER_COMPANY). Terminate an existing agent or raise the limit.`,
          );
        }
      }

      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
      const created = await db
        .insert(agents)
        .values({ ...data, name: uniqueName, companyId, role, permissions: normalizedPermissions, runtimeConfig })
        .returning()
        .then((rows) => rows[0]);

      return normalizeAgentRow(created);
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        // WC-116: opt into the activity_log purge exception for THIS transaction
        // only — the 0096 append-only trigger otherwise rejects the scoped
        // activity_log delete below and rolls back the entire agent removal.
        await tx.execute(sql`SET LOCAL workcell.allow_activity_log_purge = 'on'`);
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        // WC-124 / WC-171: heartbeat_run_events.agent_id has a non-cascading FK to
        // agents, so events THIS agent authored — including ones in another
        // agent's run (e.g. a pair counterpart) — must be purged before the agent
        // row is deleted below. The run_id FK now CASCADES (migration 0106), so
        // events on this agent's own runs are also removed when those runs are
        // deleted, which additionally closes a race where the live run executor
        // wrote an event between this purge and the run delete (the FK violation
        // there used to roll back the whole agent removal). cost_events /
        // finance_events SET NULL on delete (migration 0102) and are intentionally
        // not purged — a company's historical spend must survive agent removal.
        // Only the agent_id branch is load-bearing: events on THIS agent's own
        // runs are removed by the run_id cascade (migration 0106) when those runs
        // are deleted below — including events a pair counterpart authored in this
        // agent's run. The agent_id FK is still non-cascading, so events this agent
        // authored in ANOTHER agent's run must be purged explicitly here.
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        // WC-137: billing is PRESERVED, not purged. cost_events / finance_events
        // now carry ON DELETE SET NULL on both agent_id and heartbeat_run_id
        // (migration 0102), so deleting this agent's runs (below) and the agent
        // itself nulls those links while the financial rows survive with
        // company_id + cost_cents/amount_cents intact — a company's historical
        // spend must not shrink when an agent is removed (consistent with the
        // issue/project/goal billing-preservation discipline, WC-134/135).
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        // WC-141: detach (null) the remaining no-onDelete agent FK references so
        // the agent hard-deletes without an FK violation while the PARENT records
        // survive with the agent link cleared — consistent with the issue
        // assignee/creator detach above and the WC-124/134/135/137 discipline
        // (preserve the record, drop the dead pointer). Every column below is
        // nullable; columns with ON DELETE SET NULL are handled by the DB and
        // intentionally omitted.
        await tx.update(pairGroups).set({ ownerAgentId: null }).where(eq(pairGroups.ownerAgentId, id));
        await tx
          .update(pairGroups)
          .set({ counterpartAgentId: null })
          .where(eq(pairGroups.counterpartAgentId, id));
        await tx.update(pairTurns).set({ actorAgentId: null }).where(eq(pairTurns.actorAgentId, id));
        // WC-158: an "active" routine REQUIRES a default agent (assertRoutineCanEnable /
        // normalizeDraftRoutineStatus). Nulling the assignee here would otherwise leave an
        // active routine with no agent — a zombie that tickScheduledTriggers re-selects every
        // tick and fails with "Default agent required", logging an error forever. Demote any
        // still-active routine to "paused" (the canonical no-agent status) in the same
        // statement; non-active statuses (draft/paused/archived) are left untouched.
        await tx
          .update(routines)
          .set({
            assigneeAgentId: null,
            status: sql`case when ${routines.status} = 'active' then 'paused' else ${routines.status} end`,
            updatedAt: new Date(),
          })
          .where(eq(routines.assigneeAgentId, id));
        await tx
          .update(capabilityAssignments)
          .set({ grantedByAgentId: null })
          .where(eq(capabilityAssignments.grantedByAgentId, id));
        await tx.update(projects).set({ leadAgentId: null }).where(eq(projects.leadAgentId, id));
        await tx.update(assets).set({ createdByAgentId: null }).where(eq(assets.createdByAgentId, id));
        await tx
          .update(approvals)
          .set({ requestedByAgentId: null })
          .where(eq(approvals.requestedByAgentId, id));
        await tx
          .update(approvalComments)
          .set({ authorAgentId: null })
          .where(eq(approvalComments.authorAgentId, id));
        await tx.update(joinRequests).set({ createdAgentId: null }).where(eq(joinRequests.createdAgentId, id));
        await tx
          .update(issueThreadInteractions)
          .set({ createdByAgentId: null })
          .where(eq(issueThreadInteractions.createdByAgentId, id));
        await tx
          .update(issueThreadInteractions)
          .set({ resolvedByAgentId: null })
          .where(eq(issueThreadInteractions.resolvedByAgentId, id));
        await tx.update(goals).set({ ownerAgentId: null }).where(eq(goals.ownerAgentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        return { agent: normalizeAgentRow(updated), activated: true };
      }

      const existing = await getById(id);
      return existing ? { agent: existing, activated: false } : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions({ ...existing.permissions, ...permissions }, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    getKeyById: async (keyId: string) =>
      db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          companyId: agentApiKeys.companyId,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .then((rows) => rows[0] ?? null),

    revokeKey: async (agentId: string, keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows = rows.map(normalizeAgentRow);

      // Pair bindings across ALL statuses: once two agents have worked as a
      // pair they keep rendering as ONE node ("Owner ⇄ Counterpart") even
      // after the issue-scoped group completes or aborts — the pair is a
      // durable two-brain unit, not transient group state. Per unordered
      // agent pair only the most recent group (createdAt DESC) participates;
      // mergeMutualPairsForOrg then applies the conservative
      // mutually-exclusive merge rules on those latest bindings.
      // agent_pair only: dual_brain groups are one agent's internal
      // self-review (owner === counterpart) — as bindings they would only
      // poison the merge's ambiguity rules. Same filter as fetchBindingRows.
      const pairRows = await db
        .select({
          ownerAgentId: pairGroups.ownerAgentId,
          counterpartAgentId: pairGroups.counterpartAgentId,
        })
        .from(pairGroups)
        .where(and(eq(pairGroups.companyId, companyId), eq(pairGroups.kind, "agent_pair")))
        .orderBy(desc(pairGroups.createdAt));

      const { rows: mergedRows, pairByPrimary } = mergeMutualPairsForOrg(
        normalizedRows,
        latestBindingPerPair(pairRows),
      );

      // Dangling reportsTo (manager deleted/terminated, e.g. an old
      // Orchestrator that was replaced) must not silently drop the whole
      // subtree from the chart — treat those agents as roots instead.
      const liveIds = new Set(mergedRows.map((row) => row.id));
      const byManager = new Map<string | null, typeof mergedRows>();
      for (const row of mergedRows) {
        const key = row.reportsTo && liveIds.has(row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => {
          const pair = pairByPrimary.get(member.id);
          return {
            ...member,
            ...(pair ? { pair } : {}),
            reports: build(member.id),
          };
        });
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
