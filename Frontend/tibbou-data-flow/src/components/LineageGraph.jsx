import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Flag, Maximize2, Minus, Plus, Shuffle, X } from "lucide-react";

import { downstreamOf, layoutLineage, upstreamOf } from "@/lib/lineageLayout";
import { cn } from "@/lib/utils";

const roleConfig = {
  source: {
    label: "Source",
    icon: Database,
    dot: "bg-primary",
    text: "text-primary",
    border: "border-primary/40",
    fill: "bg-primary/15",
  },
  transformation: {
    label: "Transformation",
    icon: Shuffle,
    dot: "bg-[hsl(var(--chart-4))]",
    text: "text-[hsl(var(--chart-4))]",
    border: "border-[hsl(var(--chart-4))]/40",
    fill: "bg-[hsl(var(--chart-4))]/15",
  },
  destination: {
    label: "Destination",
    icon: Flag,
    dot: "bg-accent",
    text: "text-accent",
    border: "border-accent/40",
    fill: "bg-accent/15",
  },
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;
const COLUMN_WIDTH = 272;
const ROW_HEIGHT = 80;
const PADDING = 24;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const DRAG_THRESHOLD_PX = 4;

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function curvePath(source, target) {
  const x1 = source.x + NODE_WIDTH;
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_HEIGHT / 2;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function NameList({ ids, nodes, onSelect, empty }) {
  if (!ids.length) return <p className="mt-1 text-muted-foreground/60">{empty}</p>;
  return (
    <ul className="mt-1.5 space-y-1">
      {ids.map((id) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => onSelect(id)}
            className="w-full truncate rounded-md bg-secondary/20 px-2 py-1 text-left text-foreground transition-colors hover:bg-secondary/40"
            title={nodes.get(id)?.label}
          >
            {nodes.get(id)?.label || "Unknown"}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Left-to-right lineage graph in its own scroll area. The wheel scrolls the
// graph (and stops there instead of scrolling the page); Ctrl/⌘ + wheel or
// the buttons zoom; dragging the background pans.
export default function LineageGraph({ nodes = [], edges = [], highlightIds = null, costByDataset = null, formatCost }) {
  const [selectedNode, setSelectedNode] = useState(null);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const layout = useMemo(() => {
    const datasetById = new Map(nodes.map((node) => [node.id, node]));
    const nameOf = (id) => datasetById.get(id)?.name || "";
    const { nodes: placed, incoming, outgoing, rowCount, columnCount } = layoutLineage(edges, { nameOf });
    const laidOut = new Map();
    for (const item of placed.values()) {
      const dataset = datasetById.get(item.id);
      laidOut.set(item.id, {
        ...item,
        label: dataset?.name || "Unknown dataset",
        system: dataset?.system || "default",
        namespace: dataset?.namespace || null,
        x: PADDING + item.column * COLUMN_WIDTH,
        y: PADDING + item.row * ROW_HEIGHT,
      });
    }
    return {
      nodes: laidOut,
      incoming,
      outgoing,
      width: PADDING * 2 + Math.max(columnCount - 1, 0) * COLUMN_WIDTH + NODE_WIDTH,
      height: PADDING * 2 + Math.max(rowCount - 1, 0) * ROW_HEIGHT + NODE_HEIGHT,
    };
  }, [edges, nodes]);

  // Drop a selection that a new search or filter removed from the graph.
  useEffect(() => {
    if (selectedNode && !layout.nodes.has(selectedNode)) setSelectedNode(null);
  }, [layout, selectedNode]);

  const lineage = useMemo(() => {
    if (!selectedNode) return null;
    return {
      upstream: upstreamOf([selectedNode], layout.incoming),
      downstream: downstreamOf([selectedNode], layout.outgoing),
    };
  }, [layout, selectedNode]);

  // Zoom while keeping the point under `anchor` (viewport coords) in place.
  const zoomTo = useCallback((nextZoom, anchor) => {
    const container = containerRef.current;
    const previous = zoomRef.current;
    const target = clampZoom(nextZoom);
    if (!container || target === previous) return;
    const anchorX = anchor?.x ?? container.clientWidth / 2;
    const anchorY = anchor?.y ?? container.clientHeight / 2;
    const graphX = (container.scrollLeft + anchorX) / previous;
    const graphY = (container.scrollTop + anchorY) / previous;
    zoomRef.current = target;
    setZoom(target);
    requestAnimationFrame(() => {
      container.scrollLeft = graphX * target - anchorX;
      container.scrollTop = graphY * target - anchorY;
    });
  }, []);

  // React registers wheel listeners as passive, so preventDefault() there is
  // ignored; this one has to be added by hand to stop the browser zooming
  // the page on Ctrl + wheel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    function onWheel(event) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomTo, edges.length]);

  const fitToView = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const fit = Math.min(1, container.clientWidth / layout.width, container.clientHeight / layout.height);
    zoomRef.current = clampZoom(fit);
    setZoom(zoomRef.current);
    requestAnimationFrame(() => container.scrollTo({ left: 0, top: 0 }));
  }, [layout]);

  const scrollToNode = useCallback((id) => {
    const container = containerRef.current;
    const node = layout.nodes.get(id);
    if (!container || !node) return;
    container.scrollTo({
      left: (node.x + NODE_WIDTH / 2) * zoomRef.current - container.clientWidth / 2,
      top: (node.y + NODE_HEIGHT / 2) * zoomRef.current - container.clientHeight / 2,
      behavior: "smooth",
    });
  }, [layout]);

  const selectFromPanel = useCallback((id) => {
    setSelectedNode(id);
    scrollToNode(id);
  }, [scrollToNode]);

  // Bring the first search match into view when the search changes.
  const firstHighlight = highlightIds ? [...highlightIds].find((id) => layout.nodes.has(id)) : null;
  useEffect(() => {
    if (firstHighlight) scrollToNode(firstHighlight);
  }, [firstHighlight, scrollToNode]);

  // Mouse drag pans by scrolling. Touch uses the browser's own scrolling.
  // Capture is only taken once the pointer moves, so node clicks still fire.
  function handlePointerDown(event) {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const container = containerRef.current;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      pointerId: event.pointerId,
      dragging: false,
    };
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      containerRef.current?.setPointerCapture(drag.pointerId);
    }
    containerRef.current.scrollLeft = drag.scrollLeft - dx;
    containerRef.current.scrollTop = drag.scrollTop - dy;
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    // The click that follows a drag shouldn't clear the selection.
    draggedRef.current = Boolean(drag?.dragging);
    if (drag?.dragging && containerRef.current?.hasPointerCapture(drag.pointerId)) {
      containerRef.current.releasePointerCapture(drag.pointerId);
    }
  }

  if (!edges.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card p-12 text-center">
        <Database className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">No lineage relationships to show</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Upload a dbt manifest, or clear the search and filter, to see the graph.
        </p>
      </div>
    );
  }

  const isInLineage = (id) => !lineage || id === selectedNode || lineage.upstream.has(id) || lineage.downstream.has(id);
  const selectedDetail = selectedNode ? layout.nodes.get(selectedNode) : null;
  const directUpstream = selectedNode ? layout.incoming.get(selectedNode) || [] : [];
  const directDownstream = selectedNode ? layout.outgoing.get(selectedNode) || [] : [];
  const selectedCost = selectedNode && costByDataset ? costByDataset.get(selectedNode) : undefined;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            {Object.entries(roleConfig).map(([role, config]) => (
              <span key={role} className="flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-full", config.dot)} />
                <span className="text-muted-foreground">{config.label}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-2 hidden text-[11px] text-muted-foreground/70 xl:inline">
              Scroll to move · Ctrl + scroll to zoom · drag to pan
            </span>
            <button
              type="button"
              onClick={() => zoomTo(zoom - 0.2)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
              aria-label="Zoom out"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-10 text-center font-mono text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => zoomTo(zoom + 0.2)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
              aria-label="Zoom in"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={fitToView}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" /> Fit
            </button>
            <button
              type="button"
              onClick={() => zoomTo(1, { x: 0, y: 0 })}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
            >
              Reset
            </button>
          </div>
        </div>

        <div
          ref={containerRef}
          className="lineage-scroll h-[60vh] max-h-[720px] min-h-[360px] cursor-grab overflow-auto overscroll-contain active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={(event) => {
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            if (event.target === event.currentTarget || event.target.tagName === "svg") setSelectedNode(null);
          }}
        >
          <svg
            width={layout.width * zoom}
            height={layout.height * zoom}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="block"
          >
            <defs>
              <marker id="lineage-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="hsl(var(--muted-foreground))" opacity="0.7" />
              </marker>
              <marker id="lineage-arrow-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="hsl(var(--primary))" />
              </marker>
            </defs>

            {edges.map((edge) => {
              const source = layout.nodes.get(edge.upstream_dataset_id);
              const target = layout.nodes.get(edge.downstream_dataset_id);
              if (!source || !target) return null;
              const isHighlighted =
                lineage && isInLineage(edge.upstream_dataset_id) && isInLineage(edge.downstream_dataset_id);
              const isDimmed = lineage && !isHighlighted;
              const path = curvePath(source, target);
              return (
                <g key={edge.id} opacity={isDimmed ? 0.1 : 1} className="transition-opacity duration-300">
                  <path
                    d={path}
                    pathLength={1}
                    fill="none"
                    stroke={isHighlighted ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
                    strokeWidth={isHighlighted ? 2.5 : 1.5}
                    opacity={isHighlighted ? 1 : 0.4}
                    markerEnd={isHighlighted ? "url(#lineage-arrow-active)" : "url(#lineage-arrow)"}
                    className="lineage-draw"
                    style={{ animationDelay: `${source.column * 120 + 150}ms` }}
                  />
                  {/* Moving dashes show which way data flows; faster along the selected chain. */}
                  <path
                    d={path}
                    fill="none"
                    stroke="hsl(var(--primary))"
                    strokeWidth={isHighlighted ? 2.5 : 1.5}
                    strokeLinecap="round"
                    opacity={isHighlighted ? 0.9 : isDimmed ? 0 : 0.35}
                    className={isHighlighted ? "lineage-flow-active" : "lineage-flow"}
                  />
                </g>
              );
            })}

            {[...layout.nodes.values()].map((node) => {
              const config = roleConfig[node.role];
              const Icon = config.icon;
              const isSelected = selectedNode === node.id;
              const isMatch = highlightIds?.has(node.id);
              const isDimmed = lineage && !isInLineage(node.id);
              return (
                <foreignObject key={node.id} x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT}>
                  <div
                    role="button"
                    tabIndex={0}
                    title={`${node.label}${node.namespace ? ` (${node.namespace})` : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedNode((current) => (current === node.id ? null : node.id))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedNode((current) => (current === node.id ? null : node.id));
                      }
                    }}
                    style={{ animationDelay: `${node.column * 120}ms` }}
                    className={cn(
                      "lineage-node-in flex h-full cursor-pointer items-center gap-2 rounded-lg border px-3 outline-none transition-all duration-300 hover:brightness-125 focus-visible:ring-2 focus-visible:ring-primary",
                      config.border,
                      config.fill,
                      isMatch && "border-foreground/70",
                      isSelected && "ring-2 ring-primary shadow-lg shadow-primary/10",
                      isDimmed && "opacity-20"
                    )}
                  >
                    <Icon className={cn("h-4 w-4 flex-shrink-0", config.text)} />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{node.label}</p>
                      <p className={cn("truncate text-[10px]", config.text)}>
                        {config.label}
                        {node.namespace ? ` · ${node.namespace}` : ""}
                      </p>
                    </div>
                  </div>
                </foreignObject>
              );
            })}
          </svg>
        </div>
      </div>

      {selectedDetail ? (
        <aside
          key={selectedNode}
          className="w-full flex-shrink-0 rounded-xl border border-border bg-card p-4 duration-300 animate-in fade-in slide-in-from-right-4 lg:w-72"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              {(() => {
                const Icon = roleConfig[selectedDetail.role].icon;
                return <Icon className={cn("h-4 w-4", roleConfig[selectedDetail.role].text)} />;
              })()}
              <span className={cn("text-[11px] font-medium uppercase tracking-wide", roleConfig[selectedDetail.role].text)}>
                {roleConfig[selectedDetail.role].label}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedNode(null)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
              aria-label="Close details"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-3 break-words text-sm font-semibold text-foreground">{selectedDetail.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {selectedDetail.system}
            {selectedDetail.namespace ? ` · ${selectedDetail.namespace}` : ""}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-secondary/20 p-2">
              <dt className="text-muted-foreground">Feeds into</dt>
              <dd className="mt-1 text-base font-semibold text-foreground">{lineage.downstream.size}</dd>
              <dd className="text-[10px] text-muted-foreground">datasets downstream</dd>
            </div>
            <div className="rounded-lg bg-secondary/20 p-2">
              <dt className="text-muted-foreground">Depends on</dt>
              <dd className="mt-1 text-base font-semibold text-foreground">{lineage.upstream.size}</dd>
              <dd className="text-[10px] text-muted-foreground">datasets upstream</dd>
            </div>
            {costByDataset ? (
              <div className="col-span-2 rounded-lg bg-secondary/20 p-2">
                <dt className="text-muted-foreground">Recorded cost</dt>
                <dd className="mt-1 text-base font-semibold text-foreground">
                  {selectedCost === undefined ? "None recorded" : formatCost(selectedCost)}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="mt-4 space-y-3 text-xs">
            <div>
              <p className="font-medium text-muted-foreground">Directly upstream ({directUpstream.length})</p>
              <NameList ids={directUpstream} nodes={layout.nodes} onSelect={selectFromPanel} empty="Nothing feeds into this dataset." />
            </div>
            <div>
              <p className="font-medium text-muted-foreground">Directly downstream ({directDownstream.length})</p>
              <NameList ids={directDownstream} nodes={layout.nodes} onSelect={selectFromPanel} empty="Nothing uses this dataset." />
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
