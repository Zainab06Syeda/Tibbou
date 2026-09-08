import { useCallback, useMemo, useState } from "react";
import { Boxes, Database } from "lucide-react";

import { cn } from "@/lib/utils";

const nodeTypeConfig = {
  dbt: {
    color: "border-primary/40 bg-primary/15 text-primary",
    icon: Boxes,
    label: "dbt",
  },
  snowflake: {
    color: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    icon: Database,
    label: "Snowflake",
  },
  default: {
    color: "border-border bg-secondary/70 text-foreground",
    icon: Database,
    label: "Dataset",
  },
};

export default function LineageGraph({ nodes = [], edges = [] }) {
  const [selectedNode, setSelectedNode] = useState(null);

  const { laidOutNodes } = useMemo(() => {
    if (!edges.length) {
      return { laidOutNodes: new Map() };
    }

    const nodeLookup = new Map(nodes.map((node) => [node.id, node]));
    const graphNodeIds = new Set();
    const incoming = new Map();
    const outgoing = new Map();

    edges.forEach((edge) => {
      graphNodeIds.add(edge.upstream_dataset_id);
      graphNodeIds.add(edge.downstream_dataset_id);

      if (!outgoing.has(edge.upstream_dataset_id)) {
        outgoing.set(edge.upstream_dataset_id, []);
      }
      outgoing.get(edge.upstream_dataset_id).push(edge.downstream_dataset_id);

      if (!incoming.has(edge.downstream_dataset_id)) {
        incoming.set(edge.downstream_dataset_id, []);
      }
      incoming.get(edge.downstream_dataset_id).push(edge.upstream_dataset_id);
    });

    const roots = [...graphNodeIds].filter(
      (nodeId) => !incoming.has(nodeId) || incoming.get(nodeId).length === 0
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

      (outgoing.get(current.nodeId) || []).forEach((childId) => {
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
    const columnWidth = 220;
    const rowHeight = 76;

    levels.forEach((levelNodes, columnIndex) => {
      levelNodes.forEach((nodeId, rowIndex) => {
        const node = nodeLookup.get(nodeId);

        nextNodes.set(nodeId, {
          id: nodeId,
          label: node?.name || "Unknown dataset",
          system: node?.system || "default",
          namespace: node?.namespace || null,
          x: columnIndex * columnWidth + 40,
          y: rowIndex * rowHeight + 40,
        });
      });
    });

    return { laidOutNodes: nextNodes };
  }, [edges, nodes]);

  const handleNodeClick = useCallback(
    (nodeId) => {
      setSelectedNode(selectedNode === nodeId ? null : nodeId);
    },
    [selectedNode]
  );

  if (!edges.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card p-12 text-center">
        <Boxes className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">No lineage relationships available yet</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Add dataset relationships to see the graph take shape.
        </p>
      </div>
    );
  }

  const maxX = Math.max(...[...laidOutNodes.values()].map((node) => node.x)) + 220;
  const maxY = Math.max(...[...laidOutNodes.values()].map((node) => node.y)) + 90;

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

  return (
    <div className="overflow-auto rounded-xl border border-border bg-card">
      <svg width={maxX} height={maxY} className="min-w-full">
        <defs>
          <marker id="lineage-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="hsl(var(--primary))" opacity="0.6" />
          </marker>
          <marker
            id="lineage-arrow-active"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
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
            <line
              key={edge.id}
              x1={source.x + 160}
              y1={source.y + 24}
              x2={target.x}
              y2={target.y + 24}
              stroke={isHighlighted ? "hsl(var(--primary))" : "hsl(var(--border))"}
              strokeWidth={isHighlighted ? 2 : 1}
              strokeDasharray={isHighlighted ? "none" : "4 4"}
              opacity={isDimmed ? 0.15 : isHighlighted ? 1 : 0.45}
              markerEnd={isHighlighted ? "url(#lineage-arrow-active)" : "url(#lineage-arrow)"}
              className="transition-all duration-300"
            />
          );
        })}

        {[...laidOutNodes.values()].map((node) => {
          const config = nodeTypeConfig[node.system] || nodeTypeConfig.default;
          const Icon = config.icon;
          const isSelected = selectedNode === node.id;
          const isConnected = connectedNodes.has(node.id);
          const isDimmed = selectedNode && !isConnected;

          return (
            <foreignObject
              key={node.id}
              x={node.x}
              y={node.y}
              width={160}
              height={52}
              className="cursor-pointer"
              onClick={() => handleNodeClick(node.id)}
            >
              <div
                className={cn(
                  "flex h-full items-center gap-2 rounded-lg border px-3 transition-all duration-300",
                  config.color,
                  isSelected && "ring-2 ring-primary shadow-lg shadow-primary/10",
                  isDimmed && "opacity-20"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <div className="overflow-hidden">
                  <p className="truncate text-xs font-medium text-foreground">{node.label}</p>
                  <p className="truncate text-[10px] opacity-70">
                    {node.namespace ? `${config.label} · ${node.namespace}` : config.label}
                  </p>
                </div>
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}
