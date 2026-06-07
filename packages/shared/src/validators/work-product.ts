import { z } from "zod";
import { DESIGN_WORK_PRODUCT_TYPES } from "../types/design-artifact.js";

export const issueWorkProductTypeSchema = z.enum([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
  "proof",
]);

export const issueWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const issueWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

export const createIssueWorkProductSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  type: issueWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: issueWorkProductStatusSchema.default("active"),
  reviewState: issueWorkProductReviewStateSchema.optional().default("none"),
  isPrimary: z.boolean().optional().default(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).optional().default("unknown"),
  summary: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  createdByRunId: z.string().uuid().optional().nullable(),
});

export type CreateIssueWorkProduct = z.infer<typeof createIssueWorkProductSchema>;

export const updateIssueWorkProductSchema = createIssueWorkProductSchema.partial();

export type UpdateIssueWorkProduct = z.infer<typeof updateIssueWorkProductSchema>;

// WC-182 / D22: in-product creation of a design-type work product (the
// source-of-truth design candidate). Unlike createIssueWorkProductSchema, the
// `type` is constrained to the design-type set (defaulting to "design") so the
// standard work-product create path stays narrow while design artifacts gain a
// first-class in-product creation path (previously only the external Open
// Design daemon or a direct DB insert could produce them). status/reviewState
// are NOT accepted from the client — the route pins them to active/none.
export const createDesignArtifactSchema = z.object({
  type: z.enum([...DESIGN_WORK_PRODUCT_TYPES]).default("design"),
  provider: z.string().min(1).default("workcell"),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  summary: z.string().optional().nullable(),
  isPrimary: z.boolean().optional().default(false),
  projectId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateDesignArtifact = z.infer<typeof createDesignArtifactSchema>;

// WC-183a / D22 / D13: extract a design system from a captured UI sample and
// store the result as a design-type work product. The body carries the raw
// captured UI markup (`html`) plus an optional artifact title; the issue is the
// URL param (NOT the body). The 2 MB ceiling keeps a single scanned page within
// a sane request size while remaining generous for a real-world DOM dump.
export const extractDesignSystemSchema = z.object({
  html: z.string().min(1).max(2_000_000),
  title: z.string().min(1).optional(),
});

export type ExtractDesignSystemInput = z.infer<typeof extractDesignSystemSchema>;
