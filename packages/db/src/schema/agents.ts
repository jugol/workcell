import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    // WC-204 (deliberation mode, slice 1): per-agent dual-brain internal
    // consensus config. Nullable — null/absent means deliberation is off and the
    // agent runs its single configured adapter as today. When set, the agent has
    // two independently-configured brains and its work runs through an internal
    // propose→review loop (see server/src/services/agent-deliberation.ts).
    //
    // WC-208 (per-brain adapter): each brain independently picks BOTH its adapter
    // and model (adapter/model null/absent = inherit the agent's own
    // adapterType / configured model). Column is jsonb (schemaless), so widening
    // the brain shape needs only this $type annotation — no migration.
    deliberation: jsonb("deliberation").$type<{
      enabled: boolean;
      brainA: { adapter?: string | null; model?: string | null };
      brainB: { adapter?: string | null; model?: string | null };
      maxRounds: number;
      // WC-REVMODE/WC-PANEL/WC-TRACK: optional review-mode upgrades (jsonb, no
      // migration). Absent ⇒ single brainB review, auto track — i.e. today's
      // behavior. See packages/shared/src/validators/agent-deliberation.ts.
      reviewMode?: "single" | "panel";
      panel?: {
        members: { adapter?: string | null; model?: string | null }[];
        minAgree?: number;
      } | null;
      track?: "auto" | "a" | "b";
    } | null>(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
  }),
);
