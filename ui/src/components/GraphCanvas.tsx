import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";

// WC-181 (slice 3): a small, generic visual graph renderer — a pannable /
// zoomable SVG canvas that draws a set of nodes and the edges between them.
//
// It is deliberately data-shape-agnostic: callers pass plain { id, label } nodes
// and { fromNodeId, toNodeId } edges, plus presentation via props (a tint per
// node, optional edge labels, a selected id, click handler). The layout is a
// deterministic circular placement computed here so callers never compute
// coordinates. Extracted from the AgentMemory tab so any future node/edge view
// can reuse the same interaction + drawing code (the pan/zoom math mirrors the
// OrgChart canvas). Pure presentation — no data fetching, no domain knowledge.

export interface GraphCanvasNode {
  id: string;
  label: string;
  /** Optional shorter chip rendered above the label (e.g. a kind). */
  badge?: string;
  /**
   * Tailwind classes (semantic-token based) applied to the node card to tint it
   * by category. Falls back to a neutral surface when omitted.
   */
  tint?: string;
}

export interface GraphCanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Optional label drawn at the midpoint of the edge (e.g. the relation). */
  label?: string;
}

interface GraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  /** Background canvas click (i.e. not on a node) — e.g. to clear selection. */
  onBackgroundClick?: () => void;
  className?: string;
  /** Accessible label for the controls / region. */
  "aria-label"?: string;
}

const NODE_W = 168;
const NODE_H = 64;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const PADDING = 48;

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

interface Placed {
  node: GraphCanvasNode;
  x: number;
  y: number;
}

// Deterministic radial layout: a single node sits centered; multiple nodes are
// spread evenly on a circle whose radius grows with the node count so cards do
// not overlap. Stable across renders because it is a pure function of order.
function layout(nodes: GraphCanvasNode[]): { placed: Placed[]; width: number; height: number } {
  if (nodes.length === 0) return { placed: [], width: NODE_W, height: NODE_H };
  if (nodes.length === 1) {
    return {
      placed: [{ node: nodes[0]!, x: 0, y: 0 }],
      width: NODE_W,
      height: NODE_H,
    };
  }
  // Radius scales so neighbouring cards keep a comfortable gap on the ring.
  const circumferencePerNode = NODE_W * 1.6;
  const radius = Math.max(
    (circumferencePerNode * nodes.length) / (2 * Math.PI),
    NODE_W * 1.1,
  );
  const placed = nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return {
      node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  const width = radius * 2 + NODE_W;
  const height = radius * 2 + NODE_H;
  return { placed, width, height };
}

export function GraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onNodeClick,
  onBackgroundClick,
  className,
  "aria-label": ariaLabel,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const movedRef = useRef(false);

  const { placed, width, height } = useMemo(() => layout(nodes), [nodes]);

  const positions = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const p of placed) map.set(p.node.id, p);
    return map;
  }, [placed]);

  // Centre + fit the graph in the viewport. Coordinates from layout() are
  // centred on the origin, so we offset by half the content box.
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cW = el.clientWidth;
    const cH = el.clientHeight;
    const contentW = width + PADDING * 2;
    const contentH = height + PADDING * 2;
    const fitZoom = clampZoom(Math.min((cW || contentW) / contentW, (cH || contentH) / contentH, 1));
    setZoom(fitZoom);
    // Place the origin (graph centre) at the viewport centre.
    setPan({ x: (cW || contentW) / 2, y: (cH || contentH) / 2 });
  }, [width, height]);

  // Fit once on mount and whenever the node set size changes meaningfully.
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  const zoomToward = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      setZoom((z) => {
        const next = clampZoom(z * factor);
        const scale = next / z;
        setPan((p) => ({ x: cx - scale * (cx - p.x), y: cy - scale * (cy - p.y) }));
        return next;
      });
    },
    [],
  );

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => {
      const next = clampZoom(z * factor);
      const scale = next / z;
      setPan((p) => ({ x: mx - scale * (mx - p.x), y: my - scale * (my - p.y) }));
      return next;
    });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-graph-node]")) return;
      setDragging(true);
      movedRef.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (Math.hypot(dx, dy) > 3) movedRef.current = true;
      setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleBackgroundClick = useCallback(() => {
    // Suppress the click that ends a drag-pan.
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    onBackgroundClick?.();
  }, [onBackgroundClick]);

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div
      ref={containerRef}
      data-testid="graph-canvas"
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "relative overflow-hidden rounded-lg border border-border bg-muted/20",
        dragging ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onClick={handleBackgroundClick}
    >
      {/* Zoom controls */}
      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-foreground transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            zoomToward(1.2);
          }}
          aria-label="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-foreground transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            zoomToward(0.8);
          }}
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-foreground transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            fit();
          }}
          aria-label="Fit to screen"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Edge layer (SVG). Centred at the origin via a translate to viewport
          centre; positions are origin-relative. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <g style={{ transform, transformOrigin: "0 0" }}>
          {edges.map((edge) => {
            const from = positions.get(edge.fromNodeId);
            const to = positions.get(edge.toNodeId);
            if (!from || !to) return null;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            return (
              <g key={edge.id}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
                {edge.label ? (
                  <text
                    x={midX}
                    y={midY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-muted-foreground"
                    style={{ fontSize: 10 }}
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Node layer (HTML cards) */}
      <div className="absolute inset-0" style={{ transform, transformOrigin: "0 0" }}>
        {placed.map(({ node, x, y }) => {
          const selected = node.id === selectedNodeId;
          return (
            <button
              key={node.id}
              type="button"
              data-graph-node={node.id}
              className={cn(
                "absolute flex flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left shadow-sm transition-[border-color,box-shadow] hover:shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                node.tint ?? "border-border bg-card text-card-foreground",
                selected && "ring-[3px] ring-ring",
              )}
              style={{
                left: x - NODE_W / 2,
                top: y - NODE_H / 2,
                width: NODE_W,
                minHeight: NODE_H,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick?.(node.id);
              }}
            >
              {node.badge ? (
                <span className="text-[10px] font-medium uppercase tracking-wide opacity-80">
                  {node.badge}
                </span>
              ) : null}
              <span className="line-clamp-2 text-xs font-medium leading-tight">
                {node.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
