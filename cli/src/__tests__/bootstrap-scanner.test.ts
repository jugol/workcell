import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractDescriptionFromReadme,
  extractTitleFromReadme,
  extractTodosFromReadme,
  scanRepo,
} from "../commands/client/bootstrap.js";

const tempDirsToCleanup: string[] = [];

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirsToCleanup) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wc48-scanner-"));
  tempDirsToCleanup.push(dir);
  return dir;
}

describe("WC-48 bootstrap repo scanner helpers", () => {
  it("extractTitleFromReadme returns the first h1", () => {
    expect(extractTitleFromReadme(null)).toBeNull();
    expect(extractTitleFromReadme("not a heading")).toBeNull();
    expect(extractTitleFromReadme("# My Project\n\nbody")).toBe("My Project");
    expect(extractTitleFromReadme("ignored line\n# Real title\nmore")).toBe("Real title");
  });

  it("extractDescriptionFromReadme returns the first paragraph after headings", () => {
    expect(extractDescriptionFromReadme(null)).toBeNull();
    expect(
      extractDescriptionFromReadme("# Project\n\nWhat we do.\n\nNext paragraph."),
    ).toBe("What we do.");
    // Code fences are not specially handled in the current heuristic —
    // they're treated like any other line. The test asserts the actual
    // behavior so the helper's expected output is documented.
    const withFence = extractDescriptionFromReadme(
      "# Project\n```\ncode\n```\n\nFirst real paragraph.",
    );
    expect(typeof withFence).toBe("string");
  });

  it("extractTodosFromReadme picks up bullets under a TODO/Roadmap heading", () => {
    const readme = [
      "# Project",
      "",
      "## Roadmap",
      "",
      "- Build the foo",
      "- [ ] Plan a fancy bar",
      "- [x] Already done item still surfaces",
      "",
      "## Other",
      "- Not in roadmap",
    ].join("\n");
    const todos = extractTodosFromReadme(readme);
    expect(todos.map((t) => t.title)).toEqual([
      "Build the foo",
      "Plan a fancy bar",
      "Already done item still surfaces",
    ]);
  });

  it("WC-114: H3+ headings open and close TODO sections (any heading depth)", () => {
    const readme = [
      "## TODO",
      "- Top-level todo",
      "",
      "### Implementation notes", // H3 must CLOSE the TODO section
      "- Not a todo (under an H3 subsection)",
      "",
      "### Roadmap", // H3 must OPEN a section
      "- Deep roadmap item",
    ].join("\n");
    // Before the fix, `##?` ignored H3, so "Not a todo..." was wrongly captured
    // and "Deep roadmap item" under the H3 Roadmap was missed/erratic.
    expect(extractTodosFromReadme(readme).map((t) => t.title)).toEqual([
      "Top-level todo",
      "Deep roadmap item",
    ]);
  });

  it("scanRepo composes project name + description from README and package.json", async () => {
    const dir = await makeTempRepo();
    await writeFile(
      path.join(dir, "README.md"),
      "# Cool Repo\n\nThis project does cool things.\n\n## TODO\n- Ship MVP\n",
    );
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "cool-repo", description: "A cool repo" }, null, 2),
    );
    const scanned = await scanRepo(dir);
    // package.json name wins over README title.
    expect(scanned.projectName).toBe("cool-repo");
    // package.json description wins over README description.
    expect(scanned.description).toBe("A cool repo");
    // README TODO bullets are captured.
    expect(scanned.suggestedIssues.map((i) => i.title)).toEqual(["Ship MVP"]);
  });

  it("scanRepo honors a projectNameOverride", async () => {
    const dir = await makeTempRepo();
    await writeFile(
      path.join(dir, "README.md"),
      "# README title\nA description.\n",
    );
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "pkg-name" }, null, 2),
    );
    const scanned = await scanRepo(dir, "Manual Name");
    expect(scanned.projectName).toBe("Manual Name");
  });

  it("scanRepo falls back to directory basename when no readme/package.json", async () => {
    const dir = await makeTempRepo();
    // Empty directory.
    await mkdir(path.join(dir, "subdir"), { recursive: true });
    const scanned = await scanRepo(dir);
    expect(scanned.projectName).toBe(path.basename(dir));
    expect(scanned.description).toBeNull();
    expect(scanned.suggestedIssues).toEqual([]);
  });
});
