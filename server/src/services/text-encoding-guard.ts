// WC: reject mojibake at the API boundary instead of silently storing it.
//
// Background: on Korean Windows an agent that pipes Korean text through a
// CP949 shell (PowerShell/cmd + curl) produces request bodies whose bytes are
// CP949, which express decodes as UTF-8 — every Hangul syllable collapses to
// U+FFFD replacement characters (plus stray lone surrogates), and characters
// CP949 can't represent (e.g. em-dash) arrive as "?". By then the original
// bytes are unrecoverable, so the only correct move is to reject the write
// with an actionable error the agent can read and self-correct from.
export interface MojibakeFinding {
  kind: "replacement_character" | "lone_surrogate";
  index: number;
}

export function findMojibake(text: string): MojibakeFinding | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) {
      return { kind: "replacement_character", index: i };
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate must be followed by a low surrogate.
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid astral pair — skip the low half
        continue;
      }
      return { kind: "lone_surrogate", index: i };
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate with no preceding high surrogate.
      return { kind: "lone_surrogate", index: i };
    }
  }
  return null;
}

// Recursively walk a JSON request body and return the path of the first
// corrupted string, or null. Arrays/objects are traversed; non-strings skipped.
export function findMojibakeDeep(
  value: unknown,
  path = "body",
): { path: string; finding: MojibakeFinding } | null {
  if (typeof value === "string") {
    const finding = findMojibake(value);
    return finding ? { path, finding } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findMojibakeDeep(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findMojibakeDeep(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

const MOJIBAKE_GUARD_EXEMPT = /\/(events|logs|telemetry|metrics)(\/|$)/;

// Express middleware: reject any mutating JSON request whose body carries
// mojibake, instance-wide. This is the systemic version of the per-route
// guards — agents on Korean Windows corrupted documents AND agent
// instructions through CP949 shell pipes, so every prose write path needs
// the same protection. Paths that may legitimately relay raw terminal
// output (events/logs/telemetry) are exempt.
export function mojibakeRequestGuard() {
  return (
    req: { method: string; path: string; body?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
      next();
      return;
    }
    if (MOJIBAKE_GUARD_EXEMPT.test(req.path)) {
      next();
      return;
    }
    const hit = findMojibakeDeep(req.body);
    if (hit) {
      res.status(400).json({
        error:
          `Request field "${hit.path}" contains broken text (${hit.finding.kind} at index ${hit.finding.index}). ` +
          "The request body was sent in a non-UTF-8 encoding (typical cause: piping Korean text " +
          "through a CP949 Windows shell with curl/Invoke-RestMethod, or reading a UTF-8 file as ANSI). " +
          "Re-send as UTF-8 — write the JSON payload to a file and use " +
          '`curl --data-binary @file.json -H "Content-Type: application/json"`, ' +
          "or use the Workcell MCP issue tools instead of a raw shell HTTP call.",
        code: "mojibake_detected",
        field: hit.path,
      });
      return;
    }
    next();
  };
}

// Scan named text fields and return a ready-to-send 400 payload for the first
// corrupted one, or null when everything is clean. Routes call this before
// persisting agent-supplied prose (documents, comments).
export function buildMojibakeRejection(
  fields: Record<string, string | null | undefined>,
): { error: string; code: "mojibake_detected"; field: string } | null {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const finding = findMojibake(value);
    if (finding) {
      return {
        error:
          `Field "${field}" contains broken text (${finding.kind} at index ${finding.index}). ` +
          "The request body was sent in a non-UTF-8 encoding (typical cause: piping Korean text " +
          "through a CP949 Windows shell with curl/Invoke-RestMethod). Re-send the request as UTF-8 — " +
          "write the JSON payload to a file and use `curl --data-binary @file.json -H \"Content-Type: application/json\"`, " +
          "or use the Workcell MCP issue tools instead of a raw shell HTTP call.",
        code: "mojibake_detected",
        field,
      };
    }
  }
  return null;
}
