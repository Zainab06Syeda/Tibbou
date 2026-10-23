// Rows, filters and sorting for the Datasets page. Pure functions, tested in
// test/datasetTable.test.js.
import { adjacency, classifyRole } from "./lineageLayout.js";

export const ROLE_LABELS = {
  source: "Source",
  transformation: "Transformation",
  destination: "Destination",
  none: "Not in lineage",
};

export const DEFAULT_FILTERS = { q: "", project: "all", role: "all", system: "all", cost: "all" };

// Where the dataset lives in the warehouse, as specifically as we know it.
export function datasetLocation(dataset) {
  const parts = [dataset.database_name, dataset.schema_name, dataset.object_name].filter(Boolean);
  if (parts.length) return parts.join(".");
  return dataset.relation_name || null;
}

export function buildDatasetRows(datasets, edges = [], costs = null) {
  const { ids, incoming, outgoing } = adjacency(edges);
  const costTotals = new Map();
  for (const snapshot of costs || []) {
    const value = Number(snapshot.cost_amount || 0);
    costTotals.set(snapshot.dataset_id, (costTotals.get(snapshot.dataset_id) || 0) + (Number.isFinite(value) ? value : 0));
  }
  return datasets.map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    project: dataset.namespace || null,
    system: dataset.system || "unknown",
    location: datasetLocation(dataset),
    role: ids.has(dataset.id) ? classifyRole(dataset.id, incoming, outgoing) : "none",
    upstreamIds: incoming.get(dataset.id) || [],
    downstreamIds: outgoing.get(dataset.id) || [],
    // null means costs haven't loaded (or failed), not "no cost".
    cost: costs ? (costTotals.has(dataset.id) ? costTotals.get(dataset.id) : 0) : null,
    hasCost: costTotals.has(dataset.id),
    createdAt: dataset.created_at,
    dataset,
  }));
}

export function filterRows(rows, filters) {
  const term = (filters.q || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.project && filters.project !== "all" && (row.project || "") !== (filters.project === "none" ? "" : filters.project)) {
      return false;
    }
    if (filters.role && filters.role !== "all" && row.role !== filters.role) return false;
    if (filters.system && filters.system !== "all" && row.system !== filters.system) return false;
    if (filters.cost === "with" && !row.hasCost) return false;
    if (filters.cost === "without" && row.hasCost) return false;
    if (!term) return true;
    return [row.name, row.project, row.location].some((value) => value && value.toLowerCase().includes(term));
  });
}

const SORT_VALUES = {
  name: (row) => row.name.toLowerCase(),
  project: (row) => (row.project || "￿").toLowerCase(),
  role: (row) => ["source", "transformation", "destination", "none"].indexOf(row.role),
  upstream: (row) => row.upstreamIds.length,
  downstream: (row) => row.downstreamIds.length,
  cost: (row) => row.cost ?? -1,
  created: (row) => new Date(row.createdAt || 0).getTime(),
};

export const SORT_KEYS = Object.keys(SORT_VALUES);

// Sorts by the chosen column, then by name so ties are stable.
export function sortRows(rows, key = "name", direction = "asc") {
  const value = SORT_VALUES[key] || SORT_VALUES.name;
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a < b) return -1 * sign;
    if (a > b) return 1 * sign;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

export function paginate(rows, page, pageSize) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return { page: current, pageCount, rows: rows.slice((current - 1) * pageSize, current * pageSize) };
}
