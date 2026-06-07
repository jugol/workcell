import { describe, expect, it } from "vitest";
import { mapGraphifyGraphToImport } from "../services/graphify-import.ts";

// WC-121 (D20 S4): this is the VERBATIM output of a real
// `graphify update <dir> --no-cluster` run (graphifyy 0.8.28) on a two-file JS
// sample (a.js exports greet(); b.js imports + calls it). Pinning the real
// export shape keeps the mapper honest against the actual tool.
const REAL_GRAPHIFY_EXPORT = {
  nodes: [
    { id: "a", label: "a.js", file_type: "code", source_file: "a.js", source_location: "L1" },
    { id: "a_greet", label: "greet()", file_type: "code", source_file: "a.js", source_location: "L1" },
    { id: "b", label: "b.js", file_type: "code", source_file: "b.js", source_location: "L1" },
    { id: "b_main", label: "main()", file_type: "code", source_file: "b.js", source_location: "L2" },
  ],
  input_tokens: 0,
  output_tokens: 0,
  links: [
    { source: "a", target: "a_greet", relation: "contains", confidence: "EXTRACTED", source_file: "a.js", source_location: "L1", weight: 1.0 },
    { source: "b", target: "a", relation: "imports_from", context: "import", confidence: "EXTRACTED", source_file: "b.js", source_location: "L1", weight: 1.0 },
    { source: "b", target: "a_greet", relation: "imports", context: "import", confidence: "EXTRACTED", source_file: "b.js", source_location: "L1", weight: 1.0 },
    { source: "b", target: "b_main", relation: "contains", confidence: "EXTRACTED", source_file: "b.js", source_location: "L2", weight: 1.0 },
    { source: "b_main", target: "a_greet", relation: "calls", context: "call", confidence: "EXTRACTED", confidence_score: 1.0, source_file: "b.js", source_location: "L2", weight: 1.0 },
  ],
};

describe("WC-121 mapGraphifyGraphToImport (real Graphify node-link schema)", () => {
  it("maps a real graphify export into CodeGraphImport (nodes: key/label/symbolKind/filePath/metadata)", () => {
    const result = mapGraphifyGraphToImport(REAL_GRAPHIFY_EXPORT);

    expect(result.nodes).toEqual([
      { key: "a", label: "a.js", symbolKind: "code", filePath: "a.js", metadata: { source_location: "L1" } },
      { key: "a_greet", label: "greet()", symbolKind: "code", filePath: "a.js", metadata: { source_location: "L1" } },
      { key: "b", label: "b.js", symbolKind: "code", filePath: "b.js", metadata: { source_location: "L1" } },
      { key: "b_main", label: "main()", symbolKind: "code", filePath: "b.js", metadata: { source_location: "L2" } },
    ]);
  });

  it("maps `links` into edges with the real Graphify `relation` as kind", () => {
    const result = mapGraphifyGraphToImport(REAL_GRAPHIFY_EXPORT);
    expect(result.edges).toEqual([
      { fromKey: "a", toKey: "a_greet", kind: "contains" },
      { fromKey: "b", toKey: "a", kind: "imports_from" },
      { fromKey: "b", toKey: "a_greet", kind: "imports" },
      { fromKey: "b", toKey: "b_main", kind: "contains" },
      { fromKey: "b_main", toKey: "a_greet", kind: "calls" },
    ]);
  });

  it("also accepts an `edges` key (non-NetworkX exporters)", () => {
    const result = mapGraphifyGraphToImport({
      nodes: [{ id: "x", label: "x" }],
      edges: [{ source: "x", target: "x", relation: "calls" }],
    });
    expect(result.edges).toEqual([{ fromKey: "x", toKey: "x", kind: "calls" }]);
  });

  it("defensively skips malformed entries and never throws", () => {
    const result = mapGraphifyGraphToImport({
      nodes: [
        { label: "no-id" }, // dropped — no id
        "not-an-object",
        { id: "ok", label: "ok" },
      ],
      links: [
        { source: "ok" }, // dropped — no target
        { target: "ok" }, // dropped — no source
        { source: "ok", target: "ok", relation: "calls" },
      ],
    });
    expect(result.nodes).toEqual([{ key: "ok", label: "ok" }]);
    expect(result.edges).toEqual([{ fromKey: "ok", toKey: "ok", kind: "calls" }]);
  });

  it("returns an empty import for non-object / empty input", () => {
    expect(mapGraphifyGraphToImport(null)).toEqual({ nodes: [], edges: [] });
    expect(mapGraphifyGraphToImport("nope")).toEqual({ nodes: [], edges: [] });
    expect(mapGraphifyGraphToImport({})).toEqual({ nodes: [], edges: [] });
  });
});
