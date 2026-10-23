import assert from "node:assert/strict";
import test from "node:test";

import {
  addedSince,
  blastRadius,
  costChange,
  firstName,
  greeting,
  insights,
  lineageCoverage,
  recentActivity,
  topCostDriver,
} from "../src/lib/dashboardInsights.js";

const now = new Date("2026-10-22T12:00:00Z");
const datasets = [
  { id: "a", name: "raw_orders", namespace: "shop", system: "dbt", created_at: "2026-10-20T10:00:00Z" },
  { id: "b", name: "stg_orders", namespace: "shop", system: "dbt", created_at: "2026-10-20T10:00:20Z" },
  { id: "c", name: "fct_orders", namespace: "shop", system: "dbt", created_at: "2026-05-01T00:00:00Z" },
  { id: "d", name: "summary", namespace: "shop", system: "dbt", created_at: "2026-05-01T00:00:00Z" },
  { id: "e", name: "loose", namespace: null, system: "csv", created_at: "2026-04-01T00:00:00Z" },
];
const byId = Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset]));
const edges = [
  { upstream_dataset_id: "a", downstream_dataset_id: "b" },
  { upstream_dataset_id: "b", downstream_dataset_id: "c" },
  { upstream_dataset_id: "c", downstream_dataset_id: "d" },
];
const costs = [
  { id: "1", dataset_id: "c", cost_amount: "60", period_start: "2026-08-01T00:00:00Z", collected_at: "2026-08-31T00:00:00Z" },
  { id: "2", dataset_id: "c", cost_amount: "90", period_start: "2026-09-01T00:00:00Z", collected_at: "2026-09-30T00:00:00Z" },
  { id: "3", dataset_id: "d", cost_amount: "30", period_start: "2026-09-01T00:00:00Z", collected_at: "2026-09-30T00:00:00Z" },
];

test("greeting follows the time of day", () => {
  assert.equal(greeting(new Date(2026, 9, 22, 9)), "Good morning");
  assert.equal(greeting(new Date(2026, 9, 22, 14)), "Good afternoon");
  assert.equal(greeting(new Date(2026, 9, 22, 20)), "Good evening");
});

test("first name prefers the profile, then the email", () => {
  assert.equal(firstName({ user_metadata: { full_name: "Paapa Asare" } }), "Paapa");
  assert.equal(firstName({ email: "ama.mensah@x.com" }), "Ama");
  assert.equal(firstName({ email: "paapais14+audit@gmail.com" }), "");
  assert.equal(firstName({ email: "kofi@x.com" }), "");
  assert.equal(firstName(null), "");
});

test("growth and coverage", () => {
  assert.equal(addedSince(datasets, 30, now), 2);
  assert.deepEqual(lineageCoverage(datasets, edges), { connected: 4, share: 0.8 });
});

test("cost change compares the latest month with the month before", () => {
  const result = costChange(costs);
  assert.deepEqual(result, { current: 120, previous: 60, change: 1, month: "2026-09" });
  assert.equal(costChange([]).change, null);
  // A gap month means there's nothing directly before to compare with.
  assert.equal(costChange([costs[0], { ...costs[1], period_start: "2026-10-01T00:00:00Z" }]).change, null);
});

test("top cost driver and its share", () => {
  const driver = topCostDriver(costs, byId);
  assert.equal(driver.datasetName, "fct_orders");
  assert.equal(Math.round(driver.share * 100), 83);
});

test("blast radius counts everything downstream", () => {
  assert.deepEqual(blastRadius(edges, byId).map((row) => [row.name, row.downstream]), [
    ["raw_orders", 3],
    ["stg_orders", 2],
    ["fct_orders", 1],
  ]);
});

test("insights point at what needs doing", () => {
  const items = insights({ datasets, edges, costs, connected: false, canManageConnection: true });
  assert.equal(items[0].to, "/settings/connection");
  assert.ok(items.some((item) => item.to === "/datasets?role=none" && item.text.startsWith("1 dataset isn't")));
  assert.ok(items.some((item) => item.to === "/datasets?cost=without" && item.text.startsWith("3 datasets have")));
  assert.ok(items.some((item) => item.text.includes("fct_orders accounts for 83%")));
  const viewer = insights({ datasets, edges, costs, connected: false, canManageConnection: false });
  assert.equal(viewer[0].to, null);
});

test("activity merges sources newest first and groups manifest bursts", () => {
  const events = recentActivity({
    datasets,
    costs,
    latestManifest: { sync_run_id: "r", status: "success", finished_at: "2026-10-21T00:00:00Z", datasets_processed: 4, lineage_edges_processed: 3 },
    connections: [],
    datasetsById: byId,
  });
  assert.equal(events[0].kind, "manifest");
  assert.equal(events[1].title, "2 datasets added");
  assert.equal(events[2].kind, "cost");
});
