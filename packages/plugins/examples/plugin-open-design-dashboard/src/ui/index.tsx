import { useEffect, useMemo, useState } from "react";
import type { PluginPageProps } from "@workcell/plugin-sdk/ui";
import { resolveCompareTarget } from "./compare.js";

// WC-31 + WC-47 + WC-49 (PLAN §9 #4): Open Design Dashboard page.
//
// WC-31: scaffold page slot
// WC-47: fetch + render artifact list
// WC-49: per-artifact iframe preview launcher + version compare view

interface DesignArtifact {
  id: string;
  companyId: string;
  issueId: string;
  type: string;
  provider: string;
  title: string;
  status: string;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string | null;
  body?: string | null;
}

// A real iframe URL would come from issue_work_products. For now, the
// scaffold synthesizes a per-artifact about:blank fallback so the
// preview surface is real even before authors attach a previewUrl.
function resolvePreviewUrl(artifact: DesignArtifact): string {
  if (artifact.previewUrl) return artifact.previewUrl;
  if (artifact.externalId && /^https?:\/\//i.test(artifact.externalId)) {
    return artifact.externalId;
  }
  return "about:blank";
}

// Tiny line-oriented diff for the compare view. Not as nice as
// jsdiff but stays dependency-free for the scaffold; full diff library
// can drop in later.
function lineDiff(prev: string, next: string): Array<{ side: "context" | "added" | "removed"; text: string }> {
  const prevLines = prev.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const result: Array<{ side: "context" | "added" | "removed"; text: string }> = [];
  for (const line of prevLines) {
    if (nextSet.has(line)) {
      result.push({ side: "context", text: line });
    } else {
      result.push({ side: "removed", text: line });
    }
  }
  for (const line of nextLines) {
    if (!prevSet.has(line)) {
      result.push({ side: "added", text: line });
    }
  }
  return result;
}

export function OpenDesignDashboardPage({ context }: PluginPageProps) {
  const [items, setItems] = useState<DesignArtifact[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ current: DesignArtifact; previous: DesignArtifact } | null>(null);

  useEffect(() => {
    if (!context.companyId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/companies/${context.companyId}/design-artifacts`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: DesignArtifact[] };
        if (!cancelled) setItems(data.items ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.companyId]);

  const groups = useMemo(() => {
    const byTitle = new Map<string, DesignArtifact[]>();
    for (const item of items) {
      const arr = byTitle.get(item.title) ?? [];
      arr.push(item);
      byTitle.set(item.title, arr);
    }
    return Array.from(byTitle.entries()).map(([title, arr]) => ({
      title,
      versions: arr.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    }));
  }, [items]);

  return (
    <main
      aria-label="Open Design Dashboard"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        maxWidth: 1080,
        margin: "0 auto",
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Design</h1>
        <p style={{ marginTop: 8, color: "rgba(0,0,0,0.6)" }}>
          Design artifacts for company{" "}
          <code style={{ fontFamily: "monospace" }}>{context.companyId ?? "—"}</code>.
        </p>
      </header>

      {loading ? (
        <p style={{ color: "rgba(0,0,0,0.55)" }}>Loading artifacts…</p>
      ) : error ? (
        <p style={{ color: "rgb(180, 30, 30)" }}>Failed to load artifacts: {error}</p>
      ) : groups.length === 0 ? (
        <section
          aria-label="Empty state"
          style={{
            border: "1px dashed rgba(0,0,0,0.18)",
            borderRadius: 12,
            padding: 24,
          }}
        >
          <p style={{ margin: 0 }}>No design artifacts yet for this company.</p>
          <p style={{ marginTop: 12, color: "rgba(0,0,0,0.55)", fontSize: 13 }}>
            Attach a work product with type <code>design</code>,{" "}
            <code>ui_preview</code>, <code>mockup</code>, <code>screenshot</code>,
            or <code>figma_frame</code> to an issue and it'll appear here.
          </p>
        </section>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
          {groups.map((group) => (
            <li
              key={group.title}
              style={{
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 12,
                padding: 16,
                background: "rgba(0,0,0,0.02)",
              }}
            >
              <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{group.title}</h2>
                <span style={{ fontSize: 12, color: "rgba(0,0,0,0.55)" }}>
                  {group.versions.length} version{group.versions.length === 1 ? "" : "s"}
                </span>
              </header>
              <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
                {group.versions.map((artifact, idx) => {
                  const isExpanded = expandedId === artifact.id;
                  return (
                    <li key={artifact.id} style={{ border: "1px solid rgba(0,0,0,0.06)", borderRadius: 8 }}>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 12,
                          alignItems: "center",
                          padding: 8,
                          background: "rgba(0,0,0,0.04)",
                          fontSize: 13,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "monospace",
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            color: idx === 0 ? "rgb(20, 110, 60)" : "rgba(0,0,0,0.45)",
                          }}
                        >
                          {idx === 0 ? "Current" : "Older"}
                        </span>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(0,0,0,0.55)" }}>
                          {artifact.type} · {artifact.provider}
                        </span>
                        <span style={{ marginLeft: "auto", color: "rgba(0,0,0,0.55)" }}>
                          {new Date(artifact.createdAt).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : artifact.id)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid rgba(0,0,0,0.18)",
                            background: isExpanded ? "rgba(20,110,60,0.08)" : "transparent",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          {isExpanded ? "Hide preview" : "Preview"}
                        </button>
                        {resolveCompareTarget(group.versions, idx) ? (
                          <button
                            type="button"
                            onClick={() => {
                              const previous = resolveCompareTarget(group.versions, idx);
                              if (!previous) return;
                              setCompare({ current: artifact, previous });
                            }}
                            style={{
                              padding: "2px 8px",
                              borderRadius: 4,
                              border: "1px solid rgba(0,0,0,0.18)",
                              background: "transparent",
                              fontSize: 11,
                              cursor: "pointer",
                            }}
                          >
                            Compare
                          </button>
                        ) : null}
                      </div>
                      {isExpanded ? (
                        <div style={{ padding: 8 }}>
                          <iframe
                            title={`Preview ${artifact.title} (${artifact.id})`}
                            src={resolvePreviewUrl(artifact)}
                            // Sandbox: no scripts, no top navigation, no popups. The
                            // host runtime treats plugin UI as trusted same-origin
                            // already; this sandbox is the in-iframe perimeter for
                            // the artifact's own content.
                            sandbox="allow-same-origin"
                            style={{
                              width: "100%",
                              minHeight: 320,
                              border: "1px solid rgba(0,0,0,0.12)",
                              borderRadius: 6,
                              background: "white",
                            }}
                          />
                          <p style={{ marginTop: 8, fontSize: 11, color: "rgba(0,0,0,0.55)" }}>
                            previewUrl:{" "}
                            <code style={{ fontFamily: "monospace" }}>{resolvePreviewUrl(artifact)}</code>
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {compare ? (
        <section
          aria-label="Version diff"
          style={{
            border: "1px solid rgba(0,0,0,0.18)",
            borderRadius: 12,
            padding: 16,
            background: "rgba(255,255,255,0.85)",
          }}
        >
          <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Compare versions</h2>
            <span style={{ fontSize: 12, color: "rgba(0,0,0,0.55)" }}>
              {new Date(compare.previous.createdAt).toLocaleString()} → {new Date(compare.current.createdAt).toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => setCompare(null)}
              style={{
                marginLeft: "auto",
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "transparent",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </header>
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 6,
              background: "rgba(0,0,0,0.04)",
              fontSize: 12,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {lineDiff(
              compare.previous.body ?? `${compare.previous.title} (${compare.previous.id})`,
              compare.current.body ?? `${compare.current.title} (${compare.current.id})`,
            ).map((part, i) => (
              <span
                key={i}
                style={{
                  display: "block",
                  background:
                    part.side === "added"
                      ? "rgba(20,140,80,0.18)"
                      : part.side === "removed"
                      ? "rgba(200,40,40,0.18)"
                      : "transparent",
                  color: part.side === "removed" ? "rgb(140,30,30)" : "inherit",
                }}
              >
                {part.side === "added" ? "+ " : part.side === "removed" ? "- " : "  "}
                {part.text}
              </span>
            ))}
          </pre>
        </section>
      ) : null}
    </main>
  );
}
