import { and, eq } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issues } from "@workcell/db";
import { issueService } from "./issues.js";

// WC-13 (D19 follow-up sweep): parse the "## 5. Follow-up issues" markdown
// section of a compound-checklist body and surface each bullet line as a
// candidate issue title.
//
// Format expectations match the WC-12 COMPOUND_CHECKLIST_TEMPLATE exactly:
//   ## 5. Follow-up issues
//
//   - First follow-up
//   - Second follow-up
//
// Bullet markers handled: `-` and `*` (the two markdown conventions). Empty
// lines, blockquotes, code fences, headings, and any line that doesn't start
// with a bullet marker are ignored. Trailing whitespace and the template
// placeholder line ("(discovered debt …)") are filtered out so the obviously
// unfilled boilerplate never spawns issues.
//
// Parser intentionally stays line-oriented and pattern-based rather than a
// proper markdown AST — the inputs are predictable single-issue checklists
// where heavy parsing would just add risk. Anything weird falls through to
// "ignored line" rather than throwing.
export function parseChecklistFollowupTitles(checklistBody: string): string[] {
  const lines = checklistBody.split(/\r?\n/);
  const titles: string[] = [];
  let inFollowupSection = false;
  let inCodeFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Track fenced code blocks anywhere in the doc — bullets inside a code
    // fence aren't real markdown bullets and shouldn't spawn issues.
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    // Section detection: enter the follow-up section on its heading; exit on
    // the next heading at any level (including a deeper sub-heading).
    if (/^#{1,6}\s+/.test(line)) {
      inFollowupSection = /^#{1,6}\s+5\.?\s*follow[- ]?up\s+issues\b/i.test(line);
      continue;
    }
    if (!inFollowupSection) continue;
    // Recognize "- text" or "* text" bullets. Indented bullets (sub-items)
    // also count; we treat each bullet as a leaf title regardless of depth.
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (!bulletMatch) continue;
    const title = bulletMatch[1].trim();
    if (title.length === 0) continue;
    // The template's placeholder line starts with "(" — filter it out so the
    // boilerplate isn't turned into an issue.
    if (title.startsWith("(") && title.endsWith(")")) continue;
    titles.push(title);
  }
  return titles;
}

export function compoundFollowupService(db: Db) {
  const issueSvc = issueService(db);

  return {
    parseChecklistFollowupTitles,

    // Process a compound-checklist body: extract follow-up titles, dedup against
    // existing children spawned by previous runs (same parent + same origin kind
    // + same title), and create the missing ones as draft/backlog issues.
    //
    // Returns the IDs of the newly-created issues. Idempotent: calling twice
    // with the same body returns IDs from the FIRST call only — the second call
    // creates nothing because every title now matches an existing child.
    processChecklist: async (input: {
      parentIssueId: string;
      companyId: string;
      checklistBody: string;
      actorAgentId?: string | null;
      actorUserId?: string | null;
    }): Promise<string[]> => {
      const titles = parseChecklistFollowupTitles(input.checklistBody);
      if (titles.length === 0) return [];

      // Pull every existing compound-followup child for the parent so we can
      // dedupe by exact title match. One query per process call regardless of
      // bullet count keeps this O(1) for the caller's perspective.
      const existing = await db
        .select({ title: issues.title })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.parentId, input.parentIssueId),
            eq(issues.originKind, "compound_followup"),
          ),
        );
      const existingTitles = new Set(existing.map((row) => row.title));

      const created: string[] = [];
      for (const title of titles) {
        if (existingTitles.has(title)) continue;
        const issue = await issueSvc.create(input.companyId, {
          title,
          status: "backlog",
          priority: "medium",
          workMode: "standard",
          parentId: input.parentIssueId,
          originKind: "compound_followup",
          createdByAgentId: input.actorAgentId ?? null,
          createdByUserId: input.actorUserId ?? null,
        });
        if (issue) {
          created.push(issue.id);
          // Update the local seen-set so a duplicate bullet appearing twice in
          // the same body doesn't try to create the same issue twice.
          existingTitles.add(title);
        }
      }
      return created;
    },
  };
}
