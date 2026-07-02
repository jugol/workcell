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
// A declared outbound navigation link from the attached screen to another screen
// (R3): "an element on THIS screen opens targetScreenKey". label describes the
// trigger (e.g. "로그인 버튼"). targetScreenKey may name a screen not yet designed
// — the flow dashboard renders it as a planned/stub node.
export const designScreenLinkInputSchema = z.object({
  label: z.string().max(120).optional().default(""),
  targetScreenKey: z.string().min(1).max(200),
});

export type DesignScreenLinkInput = z.infer<typeof designScreenLinkInputSchema>;

export const createDesignArtifactSchema = z.object({
  type: z.enum([...DESIGN_WORK_PRODUCT_TYPES]).default("design"),
  provider: z.string().min(1).default("workcell"),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  summary: z.string().optional().nullable(),
  isPrimary: z.boolean().optional().default(false),
  projectId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // Design-system redesign: SCREEN IDENTITY (one artifact = one screen) + the
  // screen's outbound navigation links. screenKey is derived from screenName
  // when omitted (route layer). Keep ONE screen per design artifact.
  screenKey: z.string().min(1).max(200).optional().nullable(),
  screenName: z.string().min(1).max(200).optional().nullable(),
  links: z.array(designScreenLinkInputSchema).optional().default([]),
  // R3: the paired "화면 기획" (screen plan) spec for this screen, authored
  // alongside the pure-screen 시안. Persisted as a separate non-design
  // 'screen_plan' work product keyed by the same canonical screenKey — NOT a
  // column on the mockup row. The 시안 HTML stays a pure rendered screen.
  planMarkdown: z.string().max(50_000).optional().nullable(),
  // Screen form factor — sizes the flow node (mobile portrait / desktop landscape / tablet).
  formFactor: z.enum(["mobile", "tablet", "desktop"]).optional().nullable(),
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
