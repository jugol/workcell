import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { pairGroupsApi } from "../api/pair-groups";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { indexPairBindingsByAgent } from "../lib/pair-bindings";
import { PairBadge } from "../components/PairBadge";
import type { AgentPairBinding } from "@workcell/shared";
import { agentUrl, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Download, Maximize2, Minus, Network, Plus, Upload } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@workcell/shared";
import { useTranslation } from "@/i18n";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const TOUCH_MOVE_THRESHOLD = 6;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Merged pair node: counterpart summary (see OrgNode.pair). */
  pair?: OrgNode["pair"];
  x: number;
  y: number;
  children: LayoutNode[];
}

interface Point {
  x: number;
  y: number;
}

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point;
  startPan: Point;
  startZoom: number;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    pair: node.pair ?? null,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  const totalW = roots.reduce((sum, r) => sum + subtreeWidth(r), 0);
  const gaps = (roots.length - 1) * GAP_X;
  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  // Compute bounds and return
  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function touchPoint(touch: React.Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { data: orgTree, isLoading, error: orgTreeError } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // WC-189: active pair bindings, used to (a) mark each paired node with a
  // "⇄ 페어" badge naming the counterpart + issue and (b) draw a violet
  // connector between the two paired nodes when both are laid out.
  const { data: pairBindings } = useQuery({
    queryKey: queryKeys.pairGroups.list(selectedCompanyId!, "active"),
    queryFn: () => pairGroupsApi.listForCompany(selectedCompanyId!, "active"),
    enabled: !!selectedCompanyId,
  });
  const activeBindings = useMemo<AgentPairBinding[]>(
    () => pairBindings?.bindings ?? [],
    [pairBindings],
  );
  const pairByAgent = useMemo(
    () => indexPairBindingsByAgent(activeBindings),
    [activeBindings],
  );

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: t("orgChart.breadcrumb", { defaultValue: "Org Chart" }) }]);
  }, [setBreadcrumbs, t]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // WC-189: pair connectors. For each active binding whose owner AND
  // counterpart are both present in the laid-out tree, build a segment between
  // the two node centers so the chart visibly links paired agents. Dedupe by
  // group id (a binding lists both directions). A binding with only one side
  // visible (the other is unassigned or filtered out) draws no connector — the
  // per-node badge still surfaces it. Mutually exclusive pairs are merged
  // server-side into ONE node (the counterpart never appears in nodePositions),
  // so they naturally draw no connector either.
  const nodePositions = useMemo(() => {
    const m = new Map<string, LayoutNode>();
    for (const n of allNodes) m.set(n.id, n);
    return m;
  }, [allNodes]);
  const pairConnectors = useMemo(() => {
    const seen = new Set<string>();
    const segments: Array<{
      id: string;
      a: LayoutNode;
      b: LayoutNode;
      label: string;
    }> = [];
    for (const b of activeBindings) {
      if (seen.has(b.pairGroupId)) continue;
      if (!b.ownerAgentId || !b.counterpartAgentId) continue;
      const ownerNode = nodePositions.get(b.ownerAgentId);
      const counterpartNode = nodePositions.get(b.counterpartAgentId);
      if (!ownerNode || !counterpartNode) continue;
      seen.add(b.pairGroupId);
      segments.push({
        id: b.pairGroupId,
        a: ownerNode,
        b: counterpartNode,
        label: b.issueIdentifier ?? b.issueTitle,
      });
    }
    return segments;
  }, [activeBindings, nodePositions]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  // WC-190: auto-fit tracking. The chart auto-fits to the viewport on load AND
  // on resize (see the ResizeObserver effect below, declared after fitToScreen),
  // until the user manually pans or zooms — after which we leave their view
  // alone. This replaces a one-shot fit that captured the container size a
  // single time and never recovered when the viewport later changed size
  // (window resize, panel toggle, monitor move), which stranded the chart in a
  // corner over an empty canvas with only the manual fit button to recover.
  const userAdjusted = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    userAdjusted.current = true;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    userAdjusted.current = true;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = clampZoom(zoom * factor);

    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  const zoomTowardPoint = useCallback((newZoom: number, point: Point) => {
    userAdjusted.current = true;
    const clampedZoom = clampZoom(newZoom);
    const scale = clampedZoom / zoom;
    setPan({
      x: point.x - scale * (point.x - pan.x),
      y: point.y - scale * (point.y - pan.y),
    });
    setZoom(clampedZoom);
  }, [zoom, pan]);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 40) / bounds.width;
    const scaleY = (cH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  // WC-190: keep the chart fitted to the viewport on first load AND whenever the
  // viewport resizes, until the user takes manual control. ResizeObserver is the
  // signal the one-shot fit lacked: without it, any size change after the
  // initial mount (window/panel/monitor resize) left the chart off-screen with
  // no recovery except the manual fit button. Guarded for environments without
  // ResizeObserver (jsdom): the initial fit still runs, just no resize tracking.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const maybeFit = () => {
      if (userAdjusted.current || allNodes.length === 0) return;
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitToScreen();
    };
    maybeFit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(maybeFit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [allNodes, bounds, fitToScreen]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length >= 2 && containerRef.current) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      touchGesture.current = {
        mode: "pinch",
        startPoint: { x: 0, y: 0 },
        startPan: pan,
        startZoom: zoom,
        startDistance: touchDistance(first, second),
        startCenter: touchCenter(first, second, containerRef.current),
        moved: false,
      };
      return;
    }

    const touch = e.touches[0];
    if (!touch) return;
    touchGesture.current = {
      mode: "pan",
      startPoint: touchPoint(touch),
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !touchGesture.current.mode) return;

    if (e.touches.length >= 2) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      const distance = touchDistance(first, second);
      const center = touchCenter(first, second, container);

      if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startPan: pan,
          startZoom: zoom,
          startDistance: distance,
          startCenter: center,
          moved: false,
        };
        return;
      }

      const gesture = touchGesture.current;
      const nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
      const scale = nextZoom / gesture.startZoom;
      const dx = center.x - gesture.startCenter.x;
      const dy = center.y - gesture.startCenter.y;
      gesture.moved =
        gesture.moved ||
        Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
        Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      if (gesture.moved) userAdjusted.current = true;
      setZoom(nextZoom);
      setPan({
        x: center.x - scale * (gesture.startCenter.x - gesture.startPan.x),
        y: center.y - scale * (gesture.startCenter.y - gesture.startPan.y),
      });
      return;
    }

    const touch = e.touches[0];
    if (!touch || touchGesture.current.mode !== "pan") return;
    const dx = touch.clientX - touchGesture.current.startPoint.x;
    const dy = touch.clientY - touchGesture.current.startPoint.y;
    touchGesture.current.moved = touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
    if (touchGesture.current.moved) userAdjusted.current = true;
    setPan({
      x: touchGesture.current.startPan.x + dx,
      y: touchGesture.current.startPan.y + dy,
    });
  }, [pan, zoom]);

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = {
      mode: null,
      startPoint: { x: 0, y: 0 },
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message={t("orgChart.emptyNoCompany", { defaultValue: "Select a team to view the org chart." })} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTreeError) {
    return <EmptyState icon={Network} message={t("orgChart.loadError", { defaultValue: "Failed to load the org chart. Try again." })} />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message={t("orgChart.emptyNoHierarchy", { defaultValue: "No organizational hierarchy defined." })} />;
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[420px] flex-col md:h-full md:min-h-0">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-start gap-2">
        <Link to="/company/import">
          <Button variant="outline" size="sm">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {t("orgChart.importCompany", { defaultValue: "Import team" })}
          </Button>
        </Link>
        <Link to="/company/export">
          <Button variant="outline" size="sm">
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t("orgChart.exportCompany", { defaultValue: "Export team" })}
          </Button>
        </Link>
      </div>
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Zoom controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 1.2, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title={t("orgChart.zoomIn", { defaultValue: "Zoom in" })}
            aria-label={t("orgChart.zoomIn", { defaultValue: "Zoom in" })}
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 0.8, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title={t("orgChart.zoomOut", { defaultValue: "Zoom out" })}
            aria-label={t("orgChart.zoomOut", { defaultValue: "Zoom out" })}
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-[10px] transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              // Explicit fit re-enables auto-fit so the chart tracks later resizes again.
              userAdjusted.current = false;
              fitToScreen();
            }}
            title={t("orgChart.fitToScreen", { defaultValue: "Fit to screen" })}
            aria-label={t("orgChart.fitChartToScreen", { defaultValue: "Fit chart to screen" })}
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>

        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;

              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
              );
            })}
            {/* WC-189: pair connectors — a violet dashed link between two paired
                agent nodes, with a "⇄" marker + the issue ref at the midpoint. */}
            {pairConnectors.map(({ id, a, b, label }) => {
              const x1 = a.x + CARD_W / 2;
              const y1 = a.y + CARD_H / 2;
              const x2 = b.x + CARD_W / 2;
              const y2 = b.y + CARD_H / 2;
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              return (
                <g key={`pair-${id}`} data-testid="org-pair-connector" data-pair-group-id={id}>
                  <path
                    d={`M ${x1} ${y1} L ${x2} ${y2}`}
                    fill="none"
                    stroke="rgb(139 92 246)"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    opacity={0.7}
                  />
                  <text
                    x={mx}
                    y={my - 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill="rgb(139 92 246)"
                  >
                    {`⇄ ${label}`}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;
            const nodePairs = pairByAgent.get(node.id);
            // Merged pair node: one card, two brains. Show both names joined
            // by ⇄ and one status dot per member; the issue ref replaces the
            // PairBadge (the merged card itself already says "pair").
            const pairDotColor = node.pair
              ? statusDotColor[node.pair.status] ?? defaultDotColor
              : null;
            const displayName = node.pair ? `${node.name} ⇄ ${node.pair.name}` : node.name;
            const pairIssueRefs = node.pair && nodePairs && nodePairs.length > 0
              ? nodePairs.map((p) => p.issueIdentifier ?? p.issueTitle).join(", ")
              : null;

            return (
              <div
                key={node.id}
                data-org-card
                className="absolute bg-card border border-border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none"
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                }}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div className="flex items-center px-4 py-3 gap-3">
                  {/* Agent icon + status dot(s) — merged pair nodes get one dot per member */}
                  <div className="relative shrink-0">
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                      <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                    </div>
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                      style={{ backgroundColor: dotColor }}
                    />
                    {pairDotColor && (
                      <span
                        data-testid="org-pair-status-dot"
                        className="absolute -bottom-0.5 right-2 h-3 w-3 rounded-full border-2 border-card"
                        style={{ backgroundColor: pairDotColor }}
                      />
                    )}
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span
                      className={cn(
                        "text-sm font-semibold text-foreground leading-tight",
                        node.pair && "w-full truncate",
                      )}
                      title={node.pair ? displayName : undefined}
                    >
                      {displayName}
                    </span>
                    <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      {agent?.title ?? roleLabel(node.role)}
                    </span>
                    {/* WC-189: pair marker. A merged node already reads as a pair,
                        so it shows only the issue ref(s); unmerged paired nodes
                        keep the badge naming the counterpart. */}
                    {node.pair ? (
                      pairIssueRefs && (
                        <span
                          data-testid="org-pair-issue-ref"
                          className="mt-1 text-[10px] font-medium leading-tight text-violet-700 dark:text-violet-300"
                          title={pairIssueRefs}
                        >
                          {`⇄ ${pairIssueRefs}`}
                        </span>
                      )
                    ) : (
                      <PairBadge bindings={nodePairs} compact className="mt-1" />
                    )}
                    {agent && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                    )}
                    {agent && agent.capabilities && (
                      <span className="text-[10px] text-muted-foreground/80 leading-tight mt-1 line-clamp-2">
                        {agent.capabilities}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
