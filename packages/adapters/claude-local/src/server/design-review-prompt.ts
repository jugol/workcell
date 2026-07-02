import { asStringArray } from "@workcell/adapter-utils/server-utils";

// WC-DSR (designer visual self-review): the claude CLI has no image flag, but
// Claude Code's built-in Read tool renders a LOCAL image file when given its
// path. So for a designer self-review wake we name the absolute PNG path(s) the
// heartbeat put on the wake context and instruct the agent to Read them. This is
// the claude-side counterpart to codex's `--image` attachment.
//
// Pure + total: returns "" for an empty/absent path list, so the default prompt
// is byte-identical when there is no design-review image.
export function buildDesignReviewImageNote(imagePaths: readonly string[]): string {
  const paths = imagePaths.filter((p) => typeof p === "string" && p.trim().length > 0);
  if (paths.length === 0) return "";
  return [
    "Rendered screenshot(s) of YOUR 시안 to review (visual self-review):",
    ...paths.map((p) => `- ${p}`),
    "Use the Read tool on the absolute path(s) above to view the actual rendered pixels of the design you attached.",
    "Assess it against the visual quality bar and the project's design-system tokens (palette, type scale, spacing): hierarchy, spacing/alignment, type system, color system, and every state (default/empty/loading/error/interaction).",
    "If it falls short, revise the 시안 and re-attach (design_attach). If it clears the bar, submit it for board review (design_submit_for_review). Do NOT submit a design you have not visually reviewed.",
  ].join("\n");
}

// Read + normalize the designReviewImagePaths context key into a clean string[].
export function readDesignReviewImagePaths(context: Record<string, unknown>): string[] {
  return asStringArray(context.designReviewImagePaths).filter((p) => p.trim().length > 0);
}
