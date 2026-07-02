import { describe, expect, it } from "vitest";
import {
  buildWorkcellTaskMarkdown,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

describe("buildWorkcellTaskMarkdown", () => {
  it("injects the team report-language directive only when a label is set", () => {
    const base = {
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Implement widget",
        workMode: "standard",
        description: null,
      },
    };
    const korean = buildWorkcellTaskMarkdown({ ...base, reportLanguageLabel: "Korean" });
    expect(korean).toContain("Language directive:");
    expect(korean).toContain("Write ALL user-facing output in Korean");

    const defaultLanguage = buildWorkcellTaskMarkdown(base);
    expect(defaultLanguage).not.toContain("Language directive:");
  });

  it("always injects the completion discipline (verify the result + capture the lesson) for every agent/run", () => {
    const md = buildWorkcellTaskMarkdown({
      issue: { id: "i", identifier: "PAP-9", title: "Build a screen", workMode: "standard", description: null },
    });
    expect(md).toContain("Before you mark this done:");
    // verify-the-actual-result discipline (the "look at the rendered UI" rule)
    expect(md).toContain("VERIFY the actual result");
    expect(md).toContain("render it and LOOK");
    // capture-the-lesson discipline (record corrections/lessons to memory)
    expect(md).toContain("memory_remember");
    expect(md).toContain("Capture the lesson, not just the progress log.");
  });

  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });

  it("adds a proof-of-work directive for standard (execution) issues but not for planning issues", () => {
    const execution = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "WC-10",
        title: "Build the export button",
        workMode: "standard",
        description: "Add a CSV export button.",
      },
    });

    // The execution task prompt tells the agent to leave a proof bundle, and points
    // at the real work-products route with type "proof".
    expect(execution).toContain("Proof-of-work directive:");
    expect(execution).toContain("/issues/:id/work-products");
    expect(execution).toContain("cannot be moved to Done");
    // It must not be confused with planning guidance.
    expect(execution).not.toContain("Make the plan only.");
    expect(execution).not.toContain("- Work mode: \"planning\"");

    // Planning issues get planning guidance and must NOT be told to attach proof.
    const planning = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-3",
        identifier: "WC-11",
        title: "Plan the export feature",
        workMode: "planning",
        description: null,
      },
    });
    expect(planning).toContain("Make the plan only. Do not write code or perform implementation work.");
    expect(planning).not.toContain("Proof-of-work directive:");
  });

  it("injects the design-gate directive into execution task prompts", () => {
    const baseIssue = {
      id: "issue-4",
      identifier: "WC-20",
      title: "Build the onboarding screen",
      workMode: "standard",
      description: null,
    };

    // HOLD: design required, none attached — the directive must reach the prompt.
    const hold = buildWorkcellTaskMarkdown({
      issue: baseIssue,
      designGate: {
        directive: "HOLD development: a design is REQUIRED before work proceeds on this issue, and no design artifact exists yet.",
        approved: false,
        developmentHold: true,
        authoritativeDesign: null,
      },
    });
    expect(hold).toContain("Design directive:");
    expect(hold).toContain("HOLD development: a design is REQUIRED");
    // Unapproved design must not claim the proof needs design-match evidence.
    expect(hold).not.toContain("design-gated: the proof");

    // Approved: build-against directive + proof must include design-match evidence.
    const approved = buildWorkcellTaskMarkdown({
      issue: baseIssue,
      designGate: {
        directive: 'The approved source-of-truth design for this issue is "Onboarding v2". Build and verify against it; do not deviate from the design.',
        approved: true,
        developmentHold: false,
        authoritativeDesign: { id: "wp-1", title: "Onboarding v2", url: "https://example.test/design", reviewState: "approved" },
      },
    });
    expect(approved).toContain("Design directive:");
    expect(approved).toContain("Build and verify against it");
    expect(approved).toContain("screenshot evidence that the implemented screen matches the approved source-of-truth design");

    // No gate provided (fetch failure / non-screen issue) → byte-identical prompt.
    const without = buildWorkcellTaskMarkdown({ issue: baseIssue });
    expect(without).not.toContain("Design directive:");
  });

  it("flips to the QA design-verification directive during the review stage — only for the reviewer", () => {
    const reviewGate = {
      directive: 'The approved source-of-truth design for this issue is "Onboarding v2".',
      approved: true,
      developmentHold: false,
      authoritativeDesign: { id: "wp-1", title: "Onboarding v2", url: "https://example.test/design", reviewState: "approved" },
    };
    const inReviewIssue = {
      id: "issue-5",
      identifier: "WC-21",
      title: "Build the onboarding screen",
      status: "in_review",
      workMode: "standard",
      description: null,
    };

    // The current review-stage participant (reviewer) gets the QA-compare copy.
    const reviewer = buildWorkcellTaskMarkdown({
      issue: inReviewIssue,
      designGate: reviewGate,
      isReviewParticipant: true,
    });
    expect(reviewer).toContain("Design verification directive (review stage):");
    expect(reviewer).toContain('"Onboarding v2" (https://example.test/design)');
    expect(reviewer).toContain("compare the implemented in-app screen against this design");
    expect(reviewer).toContain("do NOT approve");
    expect(reviewer).not.toContain("Design directive:");

    // A NON-reviewer woken by a comment during in_review (e.g. the original
    // implementer) must NOT get the reviewer-only QA-compare instructions — it
    // falls back to the plain build-against directive.
    const implementer = buildWorkcellTaskMarkdown({
      issue: inReviewIssue,
      designGate: reviewGate,
      isReviewParticipant: false,
    });
    expect(implementer).not.toContain("Design verification directive (review stage):");
    expect(implementer).not.toContain("do NOT approve");
    expect(implementer).toContain("Design directive:");
  });

  it("planning issues never get a design directive even when a gate is passed", () => {
    const planning = buildWorkcellTaskMarkdown({
      issue: {
        id: "issue-6",
        identifier: "WC-22",
        title: "Plan the onboarding flow",
        workMode: "planning",
        description: null,
      },
      designGate: {
        directive: "HOLD development: a design is REQUIRED before work proceeds on this issue.",
        approved: false,
        developmentHold: true,
        authoritativeDesign: null,
      },
    });
    expect(planning).not.toContain("Design directive:");
    expect(planning).not.toContain("Design verification directive");
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves accepted-plan interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      workcellWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        workcellWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});
