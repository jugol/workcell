import { describe, expect, it } from "vitest";
import {
  buildDesignReviewImageNote,
  readDesignReviewImagePaths,
} from "./design-review-prompt.js";

// WC-DSR (designer visual self-review): claude attaches the rendered 시안
// screenshot by naming its absolute path in the prompt for the Read tool.

describe("buildDesignReviewImageNote", () => {
  it("names the absolute PNG path(s) and instructs the agent to Read them", () => {
    const note = buildDesignReviewImageNote(["/abs/preview-a.png", "/abs/preview-b.png"]);
    expect(note).toContain("/abs/preview-a.png");
    expect(note).toContain("/abs/preview-b.png");
    // Must tell the agent to Read the local image (Claude Code renders it).
    expect(note).toMatch(/Read tool/);
    expect(note).toMatch(/시안/);
  });

  it("returns an empty string when there are no image paths (byte-identical prompt)", () => {
    expect(buildDesignReviewImageNote([])).toBe("");
    expect(buildDesignReviewImageNote(["", "   "])).toBe("");
  });
});

describe("readDesignReviewImagePaths", () => {
  it("extracts and trims the designReviewImagePaths context key", () => {
    expect(
      readDesignReviewImagePaths({ designReviewImagePaths: ["/a.png", "  ", "/b.png"] }),
    ).toEqual(["/a.png", "/b.png"]);
  });

  it("returns an empty array for a missing / non-array key", () => {
    expect(readDesignReviewImagePaths({})).toEqual([]);
    expect(readDesignReviewImagePaths({ designReviewImagePaths: "nope" })).toEqual([]);
  });
});
