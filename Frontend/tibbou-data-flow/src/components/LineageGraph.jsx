import { useCallback, useMemo, useRef, useState } from "react";
import { Database, Flag, Minus, Plus, Shuffle, X } from "lucide-react";

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

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

/**
 * Node role is inferred from graph topology, not stored data: a dataset
 * with no incoming edges is where data originates (Source), one with no
 * outgoing edges is where it ends up (Destination), and anything with
 * both is a step in between (Transformation).
 */
function classifyRole(nodeId, incoming, outgoing) {
  const hasIncoming = (incoming.get(nodeId) || []).length > 0;
  const hasOutgoing = (outgoing.get(nodeId) || []).length > 0;
  if (!hasIncoming) return "source";
  if (!hasOutgoing) return "destination";
  return "transformation";
}

function curvePath(source, target) {
  const x1 = source.x + 176;
  const y1 = source.y + 28;
  const x2 = target.x;
  const y2 = target.y + 28;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

export default function LineageGraph({ nodes = [], edges = [] }) {
  const [selectedNode, setSelectedNode] = useState(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const dragRef = useRef(null);
  const containerRef = useRef(null);

  const { laidOutNodes, incoming, outgoing } = useMemo(() => {
    if (!edges.length) {
      return { laidOutNodes: new Map(), incoming: new Map(), outgoing: new Map() };
    }

    const nodeLookup = new Map(nodes.map((node) => [node.id, node]));
    const graphNodeIds = new Set();
    const incomingMap = new Map();
    const outgoingMap = new Map();

    edges.forEach((edge) => {
      graphNodeIds.add(edge.upstream_dataset_id);
      graphNodeIds.add(edge.downstream_dataset_id);

      if (!outgoingMap.has(edge.upstream_dataset_id)) {
        outgoingMap.set(edge.upstream_dataset_id, []);
      }
      outgoingMap.get(edge.upstream_dataset_id).push(edge.downstream_dataset_id);

      if (!incomingMap.has(edge.downstream_dataset_id)) {
        incomingMap.set(edge.downstream_dataset_id, []);
      }
      incomingMap.get(edge.downstream_dataset_id).push(edge.upstream_dataset_id);
    });

    const roots = [...graphNodeIds].filter(
      (nodeId) => !incomingMap.has(nodeId) || incomingMap.get(nodeId).length === 0
    );
    const visited = new Set();
    const levelMap = new Map();
    const queue = roots.map((nodeId) => ({ nodeId, level: 0 }));

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.nodeId)) {
        continue;
      }

      visited.add(current.nodeId);
      levelMap.set(current.nodeId, current.level);

      (outgoingMap.get(current.nodeId) || []).forEach((childId) => {
        queue.push({ nodeId: childId, level: current.level + 1 });
      });
    }

    graphNodeIds.forEach((nodeId) => {
      if (!visited.has(nodeId)) {
        levelMap.set(nodeId, 0);
      }
    });

    const maxLevel = Math.max(...levelMap.values(), 0);
    const levels = [];
    for (let level = 0; level <= maxLevel; level += 1) {
      levels.push([...graphNodeIds].filter((nodeId) => levelMap.get(nodeId) === level));
    }

    const nextNodes = new Map();
    const columnWidth = 240;
    const rowHeight = 84;

    levels.forEach((levelNodes, columnIndex) => {
      levelNodes.forEach((nodeId, rowIndex) => {
        const node = nodeLookup.get(nodeId);

        nextNodes.set(nodeId, {
          id: nodeId,
          label: node?.name || "Unknown dataset",
          system: node?.system || "default",
          namespace: node?.namespace || null,
          role: classifyRole(nodeId, incomingMap, outgoingMap),
          x: columnIndex * columnWidth + 40,
          y: rowIndex * rowHeight + 40,
        });
      });
    });

    return { laidOutNodes: nextNodes, incoming: incomingMap, outgoing: outgoingMap };
  }, [edges, nodes]);

  const handleNodeClick = useCallback(
    (nodeId) => {
      setSelectedNode((current) => (current === nodeId ? null : nodeId));
    },
    []
  );

  const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  const handleWheel = useCallback((event) => {
    event.preventDefault();
    setView((current) => ({ ...current, zoom: clampZoom(current.zoom - event.deltaY * 0.001) }));
  }, []);

  const handlePointerDown = useCallback((event) => {
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
    containerRef.current?.setPointerCapture(event.pointerId);
  }, [view.x, view.y]);

  const handlePointerMove = useCallback((event) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setView((current) => ({ ...current, x: dragRef.current.originX + dx, y: dragRef.current.originY + dy }));
  }, []);

  const handlePointerUp = useCallback((event) => {
    dragRef.current = null;
    containerRef.current?.releasePointerCapture(event.pointerId);
  }, []);

  const zoomBy = (delta) => setView((current) => ({ ...current, zoom: clampZoom(current.zoom + delta) }));
  const resetView = () => setView({ zoom: 1, x: 0, y: 0 });

  if (!edges.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card p-12 text-center">
        <Database className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">No lineage relationships available yet</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Add dataset relationships to see the graph take shape.
        </p>
      </div>
    );
  }

  const maxX = Math.max(...[...laidOutNodes.values()].map((node) => node.x)) + 240;
  const maxY = Math.max(...[...laidOutNodes.values()].map((node) => node.y)) + 100;

  const connectedNodes = new Set();
  if (selectedNode) {
    connectedNodes.add(selectedNode);
    edges.forEach((edge) => {
      if (edge.upstream_dataset_id === selectedNode) {
        connectedNodes.add(edge.downstream_dataset_id);
      }
      if (edge.downstream_dataset_id === selectedNode) {
        connectedNodes.add(edge.upstream_dataset_id);
      }
    });
  }

  const selectedDetail = selectedNode ? laidOutNodes.get(selectedNode) : null;
  const selectedUpstream = selectedNode
    ? (incoming.get(selectedNode) || []).map((id) => laidOutNodes.get(id)?.label || "Unknown")
    : [];
  const selectedDownstream = selectedNode
    ? (outgoing.get(selectedNode) || []).map((id) => laidOutNodes.get(id)?.label || "Unknown")
    : [];

  return (
    <div className="flex gap-4">
      <div className="relative flex-1 overflow-hidden rounded-xl border border-border bg-card">
        {/* legend */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-4 rounded-lg border border-border bg-card/90 px-3 py-2 text-xs backdrop-blur">
          {Object.entries(roleConfig).map(([role, config]) => (
            <span key={role} className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", config.dot)} />
              <span className="text-muted-foreground">{config.label}</span>
            </span>
          ))}
        </div>

        {/* zoom controls */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 backdrop-blur">
          <button
            type="button"
            onClick={() => zoomBy(0.2)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(-0.2)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="px-1 font-mono text-[11px] text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
          <button
            type="button"
            onClick={resetView}
            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
          >
            Reset
          </button>
        </div>

        <div
          ref={containerRef}
          className="h-[560px] cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <svg
            width={maxX}
            height={maxY}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}
          >
            <defs>
              <marker id="lineage-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="hsl(var(--primary))" opacity="0.6" />
              </marker>
              <marker id="lineage-arrow-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="hsl(var(--primary))" />
              </marker>
            </defs>

            {edges.map((edge) => {
              const source = laidOutNodes.get(edge.upstream_dataset_id);
              const target = laidOutNodes.get(edge.downstream_dataset_id);
              if (!source || !target) {
                return null;
              }

              const isHighlighted =
                selectedNode &&
                connectedNodes.has(edge.upstream_dataset_id) &&
                connectedNodes.has(edge.downstream_dataset_id);
              const isDimmed = selectedNode && !isHighlighted;

              return (
                <path
                  key={edge.id}
                  d={curvePath(source, target)}
                  fill="none"
                  stroke={isHighlighted ? "hsl(var(--primary))" : "hsl(var(--border))"}
                  strokeWidth={isHighlighted ? 2.5 : 1.5}
                  opacity={isDimmed ? 0.15 : isHighlighted ? 1 : 0.5}
                  markerEnd={isHighlighted ? "url(#lineage-arrow-active)" : "url(#lineage-arrow)"}
                  className="transition-all duration-300"
                />
              );
            })}

            {[...laidOutNodes.values()].map((node) => {
              const config = roleConfig[node.role];
              const Icon = config.icon;
              const isSelected = selectedNode === node.id;
              const isConnected = connectedNodes.has(node.id);
              const isDimmed = selectedNode && !isConnected;

              return (
                <foreignObject
                  key={node.id}
                  x={node.x}
                  y={node.y}
                  width={176}
                  height={56}
                  className="cursor-pointer"
                  onClick={() => handleNodeClick(node.id)}
                >
                  <div
                    className={cn(
                      "flex h-full items-center gap-2 rounded-lg border px-3 transition-all duration-300",
                      config.border,
                      config.fill,
                      isSelected && "ring-2 ring-primary shadow-lg shadow-primary/10",
                      isDimmed && "opacity-20"
                    )}
                  >
                    <Icon className={cn("h-4 w-4 flex-shrink-0", config.text)} />
                    <div className="overflow-hidden">
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

      {/* detail panel */}
      {selectedDetail ? (
        <aside className="w-64 flex-shrink-0 rounded-xl border border-border bg-card p-4">
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

          <div className="mt-4 space-y-3 text-xs">
            <div>
              <p className="font-medium text-muted-foreground">Upstream ({selectedUpstream.length})</p>
              {selectedUpstream.length ? (
                <ul className="mt-1.5 space-y-1">
                  {selectedUpstream.map((name) => (
                    <li key={name} className="truncate rounded-md bg-secondary/20 px-2 py-1 text-foreground">
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground/60">Nothing feeds into this dataset.</p>
              )}
            </div>
            <div>
              <p className="font-medium text-muted-foreground">Downstream ({selectedDownstream.length})</p>
              {selectedDownstream.length ? (
                <ul className="mt-1.5 space-y-1">
                  {selectedDownstream.map((name) => (
                    <li key={name} className="truncate rounded-md bg-secondary/20 px-2 py-1 text-foreground">
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground/60">Nothing consumes this dataset.</p>
              )}
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
