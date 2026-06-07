import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  readGraphJson,
  resolveGraphifyOutPath,
  summarizeGraphifyExport,
} from "../commands/client/code-graph.js";

const tempDirsToCleanup: string[] = [];

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirsToCleanup) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("WC-122 code-graph producer helpers", () => {
  it("resolveGraphifyOutPath points at <repo>/graphify-out/graph.json", () => {
    const out = resolveGraphifyOutPath("/some/repo");
    expect(out).toBe(path.join(path.resolve("/some/repo"), "graphify-out", "graph.json"));
  });

  it("summarizeGraphifyExport counts nodes + links (NetworkX node-link)", () => {
    expect(
      summarizeGraphifyExport({
        nodes: [{ id: "a" }, { id: "b" }],
        links: [{ source: "a", target: "b" }],
      }),
    ).toEqual({ nodes: 2, links: 1 });
  });

  it("summarizeGraphifyExport falls back to `edges` and tolerates junk", () => {
    expect(summarizeGraphifyExport({ nodes: [{ id: "a" }], edges: [{}, {}] })).toEqual({
      nodes: 1,
      links: 2,
    });
    expect(summarizeGraphifyExport(null)).toEqual({ nodes: 0, links: 0 });
    expect(summarizeGraphifyExport("nope")).toEqual({ nodes: 0, links: 0 });
    expect(summarizeGraphifyExport({})).toEqual({ nodes: 0, links: 0 });
  });

  it("readGraphJson reads + parses a real-shaped graph.json from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wc122-codegraph-"));
    tempDirsToCleanup.push(dir);
    const file = path.join(dir, "graph.json");
    const realShape = {
      nodes: [{ id: "a_greet", label: "greet()", file_type: "code", source_file: "a.js" }],
      links: [{ source: "b_main", target: "a_greet", relation: "calls" }],
    };
    await writeFile(file, JSON.stringify(realShape), "utf8");

    const parsed = await readGraphJson(file);
    expect(parsed).toEqual(realShape);
    expect(summarizeGraphifyExport(parsed)).toEqual({ nodes: 1, links: 1 });
  });

  it("readGraphJson rejects on malformed JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wc122-codegraph-bad-"));
    tempDirsToCleanup.push(dir);
    const file = path.join(dir, "graph.json");
    await writeFile(file, "{ not valid json", "utf8");
    await expect(readGraphJson(file)).rejects.toThrow();
  });
});
