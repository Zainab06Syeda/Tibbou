// Numbers, insights and activity for the Dashboard. Pure functions, tested
// in test/dashboardInsights.test.js.
import { costByDataset } from "./chartData.js";
import { adjacency, downstreamOf } from "./lineageLayout.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function firstName(user) {
  const metadata = user?.user_metadata || {};
  const name = metadata.full_name || metadata.name || "";
  if (name.trim()) return name.trim().split(/\s+/)[0];
  // From the email only when it reads as a name (paapa.asare -> Paapa),
  // not a handle like paapais14.
  const local = (user?.email || "").split("@")[0].split(/[.+_-]/)[0];
  return /^[a-z]{2,}$/i.test(local) && /[.+_-]/.test((user?.email || "").split("@")[0])
    ? local[0].toUpperCase() + local.slice(1).toLowerCase()
    : "";
}

export function addedSince(datasets, days, now = new Date()) {
  const cutoff = now.getTime() - days * DAY_MS;
  return datasets.filter((dataset) => new Date(dataset.created_at).getTime() >= cutoff).length;
}

export function lineageCoverage(datasets, edges) {
  if (!datasets.length) return { connected: 0, share: 0 };
  const { ids } = adjacency(edges);
  const connected = datasets.filter((dataset) => ids.has(dataset.id)).length;
  return { connected, share: connected / datasets.length };
}

// The latest month's recorded cost against the calendar month before it.
// `change` is null when there's nothing to compare with.
export function costChange(costs) {
  const byMonth = new Map();
  for (const snapshot of costs) {
    if (!snapshot.period_start) continue;
    const month = new Date(snapshot.period_start).toISOString().slice(0, 7);
    const value = Number(snapshot.cost_amount || 0);
    byMonth.set(month, (byMonth.get(month) || 0) + (Number.isFinite(value) ? value : 0));
  }
  if (!byMonth.size) return { current: 0, previous: null, change: null, month: null };
  const month = [...byMonth.keys()].sort().pop();
  const [year, monthNumber] = month.split("-").map(Number);
  const before = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
  const current = byMonth.get(month);
  const previous = byMonth.has(before) ? byMonth.get(before) : null;
  const change = previous ? (current - previous) / previous : null;
  return { current, previous, change, month };
}

export function topCostDriver(costs, datasetsById) {
  const ranked = costByDataset(costs, datasetsById);
  const total = ranked.reduce((sum, row) => sum + row.total, 0);
  if (!ranked.length || total <= 0) return null;
  return { ...ranked[0], share: ranked[0].total / total };
}

// Datasets with the most other datasets downstream of them, however many
// steps away: the ones whose breakage would affect the most.
export function blastRadius(edges, datasetsById, limit = 6) {
  const { ids, outgoing } = adjacency(edges);
  return [...ids]
    .map((id) => ({
      id,
      name: datasetsById[id]?.name || "Unknown dataset",
      project: datasetsById[id]?.namespace || null,
      downstream: downstreamOf([id], outgoing).size,
    }))
    .filter((row) => row.downstream > 0)
    .sort((left, right) => right.downstream - left.downstream || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// Short, actionable notes, most important first. Each links to the page
// (with filters applied) where it can be dealt with.
export function insights({ datasets, edges, costs, connected, canManageConnection, latestManifest }) {
  const items = [];
  if (connected === false) {
    items.push({
      tone: "warning",
      text: canManageConnection
        ? "Snowflake isn't connected, so query costs and credits aren't being collected."
        : "Snowflake isn't connected yet. Ask an admin to connect it to collect costs.",
      to: canManageConnection ? "/settings/connection" : null,
      action: "Connect",
    });
  }
  if (latestManifest?.status === "failed") {
    items.push({ tone: "warning", text: "The last dbt manifest upload couldn't be processed.", to: "/lineage", action: "Review" });
  }
  if (!datasets.length) {
    items.push({ tone: "info", text: "No datasets yet. Upload a dbt manifest to map your lineage.", to: "/lineage", action: "Upload" });
    return items;
  }
  const { ids } = adjacency(edges);
  const unlinked = datasets.filter((dataset) => !ids.has(dataset.id)).length;
  if (unlinked) {
    items.push({
      tone: "info",
      text: `${plural(unlinked, "dataset")} ${unlinked === 1 ? "isn't" : "aren't"} connected to anything in the lineage.`,
      to: "/datasets?role=none",
      action: "View",
    });
  }
  const costed = new Set(costs.map((snapshot) => snapshot.dataset_id));
  const uncosted = datasets.filter((dataset) => !costed.has(dataset.id)).length;
  if (uncosted) {
    items.push({
      tone: "info",
      text: `${plural(uncosted, "dataset")} ${uncosted === 1 ? "has" : "have"} no recorded cost yet.`,
      to: "/datasets?cost=without",
      action: "View",
    });
  }
  const datasetsById = Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset]));
  const driver = topCostDriver(costs, datasetsById);
  if (driver && driver.share >= 0.4 && costed.size > 1) {
    items.push({
      tone: "info",
      text: `${driver.datasetName} accounts for ${Math.round(driver.share * 100)}% of recorded cost.`,
      to: "/costs",
      action: "Costs",
    });
  }
  if (!items.length) items.push({ tone: "success", text: "Everything looks healthy.", to: null });
  return items;
}

// One timeline from the different things that happen in a workspace.
export function recentActivity({ datasets, costs, latestManifest, connections, datasetsById, limit = 8 }) {
  const events = [];
  for (const dataset of datasets) {
    if (dataset.created_at) {
      events.push({ kind: "dataset", at: dataset.created_at, title: `${dataset.name} added`, detail: dataset.namespace || dataset.system, id: dataset.id });
    }
  }
  for (const snapshot of costs) {
    events.push({
      kind: "cost",
      at: snapshot.collected_at,
      title: `Cost recorded for ${datasetsById[snapshot.dataset_id]?.name || "a dataset"}`,
      amount: Number(snapshot.cost_amount || 0),
      id: snapshot.id,
    });
  }
  if (latestManifest?.finished_at) {
    events.push({
      kind: "manifest",
      at: latestManifest.finished_at,
      title: latestManifest.status === "failed" ? "dbt manifest upload failed" : "dbt manifest refreshed",
      detail:
        latestManifest.status === "failed"
          ? null
          : `${plural(latestManifest.datasets_processed, "model")}, ${plural(latestManifest.lineage_edges_processed, "relationship")}`,
      id: `manifest-${latestManifest.sync_run_id}`,
    });
  }
  for (const connection of connections || []) {
    if (connection.last_success_at) {
      events.push({ kind: "sync", at: connection.last_success_at, title: "Snowflake sync finished", detail: connection.name, id: `sync-${connection.id}` });
    }
  }
  // Datasets from one manifest arrive together; collapse same-second bursts
  // into one line so they don't crowd out everything else.
  const grouped = [];
  for (const event of events.sort((left, right) => new Date(right.at) - new Date(left.at))) {
    const previous = grouped[grouped.length - 1];
    if (
      previous &&
      event.kind === "dataset" &&
      previous.kind === "dataset" &&
      Math.abs(new Date(previous.at) - new Date(event.at)) < 60 * 1000
    ) {
      previous.count = (previous.count || 1) + 1;
      previous.title = `${previous.count} datasets added`;
      continue;
    }
    grouped.push({ ...event });
  }
  return grouped.slice(0, limit);
}
