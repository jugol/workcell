import { describe, it, expect } from "vitest";
import {
  resolvePlanReportLanguageLabel,
  isDefaultPlanReportLanguage,
  normalizePlanReportLanguage,
  DEFAULT_PLAN_REPORT_LANGUAGE,
} from "@workcell/shared";
import {
  buildPlannerDraftInstruction,
  buildPlannerGrillInstruction,
  parsePlannerGrillQuestions,
} from "../routes/issues.js";

// WC-81 (reality-check #6): plan-report language threading. The pure pieces —
// resolving a code to an instruction label and injecting it into the planner
// prompt — are tested here without a DB.

describe("resolvePlanReportLanguageLabel", () => {
  it("returns null for English / unset so no directive is added", () => {
    expect(resolvePlanReportLanguageLabel(null)).toBeNull();
    expect(resolvePlanReportLanguageLabel(undefined)).toBeNull();
    expect(resolvePlanReportLanguageLabel("")).toBeNull();
    expect(resolvePlanReportLanguageLabel(DEFAULT_PLAN_REPORT_LANGUAGE)).toBeNull();
  });

  it("maps known codes to their English label", () => {
    expect(resolvePlanReportLanguageLabel("ko")).toBe("Korean");
    expect(resolvePlanReportLanguageLabel("pt-BR")).toBe("Portuguese (Brazil)");
    expect(resolvePlanReportLanguageLabel("ja")).toBe("Japanese");
  });

  it("passes an unknown but non-empty code through unchanged", () => {
    expect(resolvePlanReportLanguageLabel("xx-YY")).toBe("xx-YY");
  });
});

describe("isDefaultPlanReportLanguage / normalizePlanReportLanguage", () => {
  it("treats unset and English as default", () => {
    expect(isDefaultPlanReportLanguage(null)).toBe(true);
    expect(isDefaultPlanReportLanguage("en")).toBe(true);
    expect(isDefaultPlanReportLanguage("ko")).toBe(false);
  });

  it("normalizes blank input to the default and trims", () => {
    expect(normalizePlanReportLanguage("  ")).toBe(DEFAULT_PLAN_REPORT_LANGUAGE);
    expect(normalizePlanReportLanguage(undefined)).toBe(DEFAULT_PLAN_REPORT_LANGUAGE);
    expect(normalizePlanReportLanguage(" ko ")).toBe("ko");
  });
});

describe("buildPlannerDraftInstruction", () => {
  it("omits any language directive when no label is given", () => {
    const out = buildPlannerDraftInstruction("Add dark mode");
    expect(out).toContain("## Acceptance Criteria");
    expect(out).toContain("Request:\nAdd dark mode");
    expect(out).not.toContain("Write the body text of every section in");
  });

  it("injects a translate-body directive while keeping English headings", () => {
    const out = buildPlannerDraftInstruction("Add dark mode", "Korean");
    expect(out).toContain("Write the body text of every section in Korean.");
    // Headings stay in English so the draft document can still be parsed.
    expect(out).toContain("## Acceptance Criteria");
    expect(out).toContain("## Proof Surface");
    // The request is still appended last.
    expect(out.trimEnd().endsWith("Add dark mode")).toBe(true);
  });
});

// WC-184 (CP0 "Grill mode"): the grill instruction asks for clarifying
// questions (NOT a draft) and the parser is robust to messy model replies.
describe("buildPlannerGrillInstruction", () => {
  it("asks for a JSON array of questions and never a draft", () => {
    const out = buildPlannerGrillInstruction("Add SSO support");
    // It explicitly forbids drafting / implementation.
    expect(out).toContain("Do NOT draft an issue");
    // It asks for the three-key JSON object shape.
    expect(out).toContain('"question"');
    expect(out).toContain('"recommendation"');
    expect(out).toContain('"rationale"');
    // It prefers a small number of questions.
    expect(out).toContain("5 questions or fewer");
    // It must NOT carry the draft document's section headings.
    expect(out).not.toContain("## Acceptance Criteria");
    // No language directive when no label is given.
    expect(out).not.toContain("Write the question, recommendation, and rationale text in");
    // The request is appended last.
    expect(out.trimEnd().endsWith("Add SSO support")).toBe(true);
  });

  it("injects a translate directive while keeping JSON keys in English", () => {
    const out = buildPlannerGrillInstruction("Add SSO support", "Korean");
    expect(out).toContain("Write the question, recommendation, and rationale text in Korean.");
    // Keys stay in English so the reply parses deterministically.
    expect(out).toContain('"question"');
    expect(out).toContain('"recommendation"');
    expect(out.trimEnd().endsWith("Add SSO support")).toBe(true);
  });
});

describe("parsePlannerGrillQuestions", () => {
  it("parses a clean JSON array of well-formed questions", () => {
    const raw = JSON.stringify([
      { question: "Which IdPs?", recommendation: "Okta + Google", rationale: "Most common." },
      { question: "Self-serve?", recommendation: "Admin-only first", rationale: "Smaller surface." },
    ]);
    const out = parsePlannerGrillQuestions(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      question: "Which IdPs?",
      recommendation: "Okta + Google",
      rationale: "Most common.",
    });
  });

  it("tolerates prose and ```json fences around the array", () => {
    const raw = [
      "Sure! Here are the questions I'd ask:",
      "```json",
      JSON.stringify([{ question: "Scope?", recommendation: "MVP", rationale: "Ship sooner." }]),
      "```",
      "Let me know if you'd like more.",
    ].join("\n");
    const out = parsePlannerGrillQuestions(raw);
    expect(out).toEqual([{ question: "Scope?", recommendation: "MVP", rationale: "Ship sooner." }]);
  });

  it("drops malformed entries but keeps the well-formed ones", () => {
    const raw = JSON.stringify([
      { question: "Keep me", recommendation: "yes", rationale: "ok" },
      { recommendation: "no question key" },
      "a bare string",
      { question: "   ", recommendation: "blank question" },
      { question: "Also keep", recommendation: "", rationale: "" },
    ]);
    const out = parsePlannerGrillQuestions(raw);
    expect(out).toEqual([
      { question: "Keep me", recommendation: "yes", rationale: "ok" },
      { question: "Also keep", recommendation: "", rationale: "" },
    ]);
  });

  it("returns an empty list for a malformed / non-array / empty reply", () => {
    expect(parsePlannerGrillQuestions("not json at all")).toEqual([]);
    expect(parsePlannerGrillQuestions("{ \"question\": \"obj not array\" }")).toEqual([]);
    expect(parsePlannerGrillQuestions("[ { unterminated ")).toEqual([]);
    expect(parsePlannerGrillQuestions("")).toEqual([]);
    expect(parsePlannerGrillQuestions("[]")).toEqual([]);
  });
});
