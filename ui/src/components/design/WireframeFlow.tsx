import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, Maximize2, Star } from "lucide-react";
import type { DesignFlowScreen, DesignScreenLink } from "@workcell/shared";
import { cn } from "../../lib/utils";
import { toDisplayPreviewUrl } from "../../lib/previewUrl";

// Design-system redesign (R4) — a FIGMA-STYLE WIREFRAME of the app's screens.
// Unlike the generic radial GraphCanvas, this lays screens out as a left→right
// FLOW: entry/representative screen(s) on the left, following navigation links
// rightwards in layers. Each node is a real scaled screen frame (you SEE the
// screen, not just its name); links are directional ARROWS with labels.

const LABEL_H = 40;
const GAP_X = 96; // horizontal room between layers (for arrows)
const GAP_Y = 40;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

// Per-form-factor frame: on-canvas w×h + the virtual viewport width the 시안 renders
// into (scale = w / vw). Mobile portrait, desktop landscape, tablet between — so a
// wide admin screen isn't squeezed into the same portrait box as a phone screen.
const FORM_FACTOR_DIMS: Record<string, { w: number; h: number; vw: number }> = {
  mobile: { w: 188, h: 340, vw: 420 },
  tablet: { w: 300, h: 392, vw: 834 },
  desktop: { w: 392, h: 245, vw: 1366 },
};
function dimsFor(ff?: string | null): { w: number; h: number; vw: number } {
  return FORM_FACTOR_DIMS[ff ?? "mobile"] ?? FORM_FACTOR_DIMS.mobile;
}
// Uniform grid cell sized to the largest frame so nodes never overlap regardless of
// form factor; each node's actual frame renders top-left within its cell.
const CELL_W = 392;
const CELL_H = 392 + LABEL_H;

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

interface Placed {
  screen: DesignFlowScreen;
  x: number;
  y: number;
  isEntry: boolean;
}

const HOME_RE = /home|landing|main|start|학습자\s*홈|홈|시작|랜딩|메인/i;

// Pick the app's REPRESENTATIVE / entry screen: prefer a home/landing-named
// screen, else the most-outbound / least-inbound one, else the first. App flows
// have back-links (e.g. "닫기" → home), so "no inbound" alone is unreliable.
export function pickEntry(
  screens: DesignFlowScreen[],
  outbound: Map<string, number>,
  inbound: Map<string, number>,
): string | null {
  if (screens.length === 0) return null;
  const home = screens.find((s) => HOME_RE.test(s.screenKey) || HOME_RE.test(s.screenName));
  if (home) return home.screenKey;
  let best = screens[0];
  let bestScore = -Infinity;
  for (const s of screens) {
    const score = (outbound.get(s.screenKey) ?? 0) - (inbound.get(s.screenKey) ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.screenKey;
}

// Layered (left→right) layout via BFS SHORTEST-PATH from the representative
// screen — robust to cycles (a lesson loop / "닫기" back-link won't push the home
// screen rightwards). Screens unreachable from the entry become secondary roots
// (their own left-edge column) so every screen still shows.
export function layout(screens: DesignFlowScreen[], links: DesignScreenLink[]) {
  const keys = new Set(screens.map((s) => s.screenKey));
  const realLinks = links.filter((l) => keys.has(l.fromScreenKey) && keys.has(l.toScreenKey));
  const adj = new Map<string, string[]>();
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const s of screens) {
    inbound.set(s.screenKey, 0);
    outbound.set(s.screenKey, 0);
  }
  for (const l of realLinks) {
    if (l.fromScreenKey === l.toScreenKey) continue;
    (adj.get(l.fromScreenKey) ?? adj.set(l.fromScreenKey, []).get(l.fromScreenKey)!).push(l.toScreenKey);
    inbound.set(l.toScreenKey, (inbound.get(l.toScreenKey) ?? 0) + 1);
    outbound.set(l.fromScreenKey, (outbound.get(l.fromScreenKey) ?? 0) + 1);
  }
  const entryKey = pickEntry(screens, outbound, inbound);
  const layer = new Map<string, number>();
  const bfs = (root: string) => {
    const q: string[] = [root];
    layer.set(root, layer.get(root) ?? 0);
    while (q.length) {
      const cur = q.shift()!;
      for (const to of adj.get(cur) ?? []) {
        if (!layer.has(to)) {
          layer.set(to, (layer.get(cur) ?? 0) + 1);
          q.push(to);
        }
      }
    }
  };
  if (entryKey) bfs(entryKey);
  // Secondary roots (unreached) — order so the most-connected go first.
  const remaining = screens
    .filter((s) => !layer.has(s.screenKey))
    .sort((a, b) => (outbound.get(b.screenKey) ?? 0) - (outbound.get(a.screenKey) ?? 0));
  for (const s of remaining) if (!layer.has(s.screenKey)) bfs(s.screenKey);

  const byLayer = new Map<number, DesignFlowScreen[]>();
  for (const s of screens) {
    const L = layer.get(s.screenKey) ?? 0;
    const arr = byLayer.get(L);
    if (arr) arr.push(s);
    else byLayer.set(L, [s]);
  }
  const layersSorted = [...byLayer.keys()].sort((a, b) => a - b);

  // Within-layer ordering to MINIMIZE arrow crossings (barycenter heuristic):
  // align each screen with the average row of the screens that link into it, so
  // the main path (home → lesson → result) reads as a straight horizontal line.
  const preds = new Map<string, string[]>();
  for (const l of realLinks) {
    if (l.fromScreenKey === l.toScreenKey) continue;
    const arr = preds.get(l.toScreenKey);
    if (arr) arr.push(l.fromScreenKey);
    else preds.set(l.toScreenKey, [l.fromScreenKey]);
  }
  const rowOf = new Map<string, number>();
  const firstLayer = layersSorted[0];
  for (const L of layersSorted) {
    byLayer.get(L)!.sort((a, b) => {
      if (L === firstLayer) {
        if (a.screenKey === entryKey) return -1;
        if (b.screenKey === entryKey) return 1;
      }
      return a.screenName.localeCompare(b.screenName);
    });
    byLayer.get(L)!.forEach((s, i) => rowOf.set(s.screenKey, i));
  }
  const baryc = (key: string): number => {
    const ps = (preds.get(key) ?? []).map((p) => rowOf.get(p)).filter((r): r is number => r != null);
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : (rowOf.get(key) ?? 0);
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (const L of layersSorted) {
      if (L === firstLayer) continue;
      byLayer.get(L)!.sort((a, b) => baryc(a.screenKey) - baryc(b.screenKey));
      byLayer.get(L)!.forEach((s, i) => rowOf.set(s.screenKey, i));
    }
  }

  const placed: Placed[] = [];
  let maxRows = 1;
  layersSorted.forEach((L, layerIdx) => {
    const col = byLayer.get(L)!;
    maxRows = Math.max(maxRows, col.length);
    col.forEach((screen) => {
      placed.push({
        screen,
        x: layerIdx * (CELL_W + GAP_X),
        y: (rowOf.get(screen.screenKey) ?? 0) * (CELL_H + GAP_Y),
        isEntry: screen.screenKey === entryKey,
      });
    });
  });
  const width = Math.max(1, layersSorted.length) * (CELL_W + GAP_X);
  const height = maxRows * (CELL_H + GAP_Y);
  return { placed, realLinks, width, height };
}

export function WireframeFlow({
  screens,
  links,
  selectedKey,
  onSelect,
  onPersistPosition,
  className,
}: {
  screens: DesignFlowScreen[];
  links: DesignScreenLink[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onPersistPosition?: (screenKey: string, x: number, y: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(0.7);
  const [panDragging, setPanDragging] = useState(false);
  const [nodeDragging, setNodeDragging] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const nodeDragRef = useRef<
    { key: string; sx: number; sy: number; ox: number; oy: number; curX: number; curY: number } | null
  >(null);
  const movedRef = useRef(false);
  // R5: live/optimistic drag overrides, so a just-dragged node doesn't flash back
  // to its auto-layout slot in the gap before the persisted x/y refetch lands.
  const [localPos, setLocalPos] = useState<Record<string, { x: number; y: number }>>({});

  const { placed, realLinks, width, height } = useMemo(() => layout(screens, links), [screens, links]);

  // R5: persisted positions from the server, keyed by screenKey.
  const persisted = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const s of screens) {
      if (typeof s.x === "number" && typeof s.y === "number") m.set(s.screenKey, { x: s.x, y: s.y });
    }
    return m;
  }, [screens]);

  // Effective node position: live drag → persisted → auto-layout fallback. BOTH
  // the screen frames and the arrows read this, so connectors track a drag.
  const effPos = useMemo(() => {
    const m = new Map<string, { x: number; y: number; isEntry: boolean; screen: DesignFlowScreen }>();
    for (const p of placed) {
      const key = p.screen.screenKey;
      const e = localPos[key] ?? persisted.get(key) ?? { x: p.x, y: p.y };
      m.set(key, { x: e.x, y: e.y, isEntry: p.isEntry, screen: p.screen });
    }
    return m;
  }, [placed, persisted, localPos]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cW = el.clientWidth || width;
    const cH = el.clientHeight || height;
    const z = clampZoom(Math.min(cW / (width + 80), cH / (height + 80), 1));
    setZoom(z);
    setPan({ x: 40, y: 40 });
  }, [width, height]);

  // Fit ONCE when screens first arrive. A refetch (e.g. after a drag-save) must
  // NOT re-fit — that was the old "resets every time" pain. The 맞춤 button still
  // lets the user re-fit on demand.
  const didFitRef = useRef(false);
  useLayoutEffect(() => {
    if (didFitRef.current || screens.length === 0) return;
    fit();
    didFitRef.current = true;
  }, [screens.length, fit]);

  // Zoom toward a point (cursor or center), keeping that point stationary.
  const zoomAt = useCallback((factor: number, mx: number, my: number) => {
    setZoom((z) => {
      const next = clampZoom(z * factor);
      const scale = next / z;
      setPan((p) => ({ x: mx - scale * (mx - p.x), y: my - scale * (my - p.y) }));
      return next;
    });
  }, []);
  const zoomByCenter = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
    },
    [zoomAt],
  );

  // R6: plain-wheel zoom anchored at the cursor. Native non-passive listener so
  // preventDefault reliably stops the page scrolling under the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomAt]);

  const onCanvasDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-wf-node]")) return; // node handles its own drag
      setPanDragging(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  // R5: start dragging a single node (ox/oy = its current content-space position).
  const onNodeDown = useCallback((e: React.MouseEvent, key: string, ox: number, oy: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    nodeDragRef.current = { key, sx: e.clientX, sy: e.clientY, ox, oy, curX: ox, curY: oy };
    movedRef.current = false;
    setNodeDragging(true);
  }, []);

  const onMove = useCallback(
    (e: React.MouseEvent) => {
      const nd = nodeDragRef.current;
      if (nd) {
        const ddx = e.clientX - nd.sx;
        const ddy = e.clientY - nd.sy;
        if (Math.hypot(ddx, ddy) > 3) movedRef.current = true;
        // Mouse delta is in screen px; content is scaled by zoom → divide.
        nd.curX = nd.ox + ddx / zoom;
        nd.curY = nd.oy + ddy / zoom;
        setLocalPos((prev) => ({ ...prev, [nd.key]: { x: nd.curX, y: nd.curY } }));
        return;
      }
      if (!panDragging) return;
      setPan({
        x: panStart.current.panX + (e.clientX - panStart.current.x),
        y: panStart.current.panY + (e.clientY - panStart.current.y),
      });
    },
    [panDragging, zoom],
  );

  // A node release is a CLICK (select → navigate) when it didn't move, else a
  // drag end → persist the new position.
  const endDrag = useCallback(() => {
    const nd = nodeDragRef.current;
    if (nd) {
      if (movedRef.current) onPersistPosition?.(nd.key, Math.round(nd.curX), Math.round(nd.curY));
      else onSelect?.(nd.key);
      nodeDragRef.current = null;
      setNodeDragging(false);
      return;
    }
    setPanDragging(false);
  }, [onPersistPosition, onSelect]);

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div
      ref={containerRef}
      data-testid="wireframe-flow"
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-[var(--muted)]/30",
        panDragging ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
      onMouseDown={onCanvasDown}
      onMouseMove={onMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
        <CanvasBtn onClick={() => zoomByCenter(1.2)} label={t("wireframeFlow.zoomIn", { defaultValue: "Zoom in" })}><Plus className="h-3.5 w-3.5" /></CanvasBtn>
        <CanvasBtn onClick={() => zoomByCenter(0.8)} label={t("wireframeFlow.zoomOut", { defaultValue: "Zoom out" })}><Minus className="h-3.5 w-3.5" /></CanvasBtn>
        <CanvasBtn onClick={fit} label={t("wireframeFlow.fit", { defaultValue: "Fit" })}><Maximize2 className="h-3.5 w-3.5" /></CanvasBtn>
      </div>

      {/* Arrow layer */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
          </marker>
        </defs>
        <g style={{ transform, transformOrigin: "0 0" }}>
          {realLinks.map((l) => {
            const a = effPos.get(l.fromScreenKey);
            const b = effPos.get(l.toScreenKey);
            if (!a || !b) return null;
            const da = dimsFor(a.screen.formFactor);
            const db = dimsFor(b.screen.formFactor);
            const sx = a.x + da.w;
            const sy = a.y + da.h / 2;
            const tx = b.x;
            const ty = b.y + db.h / 2;
            const forward = tx >= sx;
            // Forward: smooth left→right cubic. Back/same: dip below.
            const midX = (sx + tx) / 2;
            const d = forward
              ? `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`
              : `M ${sx} ${sy} C ${sx + 80} ${sy + 120}, ${tx - 80} ${ty + 120}, ${tx} ${ty}`;
            const lx = forward ? midX : (sx + tx) / 2;
            const ly = forward ? (sy + ty) / 2 - 6 : Math.max(sy, ty) + 70;
            return (
              <g key={l.id}>
                <path d={d} fill="none" stroke="var(--primary)" strokeWidth={1.75} markerEnd="url(#wf-arrow)" opacity={0.85} />
                {l.label ? (
                  <text x={lx} y={ly} textAnchor="middle" className="fill-foreground" style={{ fontSize: 11, paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 3 }}>
                    {l.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Screen-frame layer */}
      <div className="absolute inset-0" style={{ transform, transformOrigin: "0 0" }}>
        {placed.map(({ screen, isEntry }) => {
          const e = effPos.get(screen.screenKey);
          const x = e ? e.x : 0;
          const y = e ? e.y : 0;
          const selected = screen.screenKey === selectedKey;
          const src = toDisplayPreviewUrl(screen.previewUrl);
          const dims = dimsFor(screen.formFactor);
          const scale = dims.w / dims.vw;
          return (
            <div
              key={screen.screenKey}
              data-wf-node={screen.screenKey}
              role="button"
              tabIndex={0}
              aria-label={screen.screenName}
              title={t("wireframeFlow.nodeTooltip", { defaultValue: "{{screenName}} — drag to move, click to open the screen plan", screenName: screen.screenName })}
              onMouseDown={(ev) => onNodeDown(ev, screen.screenKey, x, y)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect?.(screen.screenKey);
                }
              }}
              className={cn(
                "absolute select-none outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                nodeDragging ? "cursor-grabbing" : "cursor-grab",
              )}
              style={{ left: x, top: y, width: dims.w }}
            >
              <div
                className={cn(
                  "block w-full overflow-hidden rounded-xl border-2 bg-white shadow-sm transition-[border-color,box-shadow] hover:shadow-md",
                  selected ? "border-primary ring-2 ring-primary/40" : isEntry ? "border-primary/60" : "border-border",
                )}
                style={{ height: dims.h }}
              >
                {src ? (
                  <iframe
                    sandbox=""
                    src={src}
                    title={screen.screenName}
                    tabIndex={-1}
                    loading="lazy"
                    className="pointer-events-none origin-top-left"
                    style={{ width: dims.vw, height: Math.round(dims.h / scale), transform: `scale(${scale})` }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("wireframeFlow.noPreview", { defaultValue: "No preview" })}</div>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1" style={{ height: LABEL_H }}>
                {isEntry ? (
                  <span title={t("wireframeFlow.entryScreen", { defaultValue: "Representative / entry screen" })} className="shrink-0 rounded-full border border-primary/50 bg-primary/10 p-0.5 text-primary">
                    <Star className="h-3 w-3" />
                  </span>
                ) : null}
                <span className="truncate text-xs font-medium" title={screen.screenName}>
                  {screen.screenName}
                </span>
                <span
                  className={cn(
                    "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                    screen.approved ? "bg-emerald-500" : screen.reviewState === "needs_board_review" ? "bg-amber-500" : "bg-muted-foreground/40",
                  )}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CanvasBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded border border-border bg-background text-foreground transition-colors hover:bg-accent"
    >
      {children}
    </button>
  );
}
