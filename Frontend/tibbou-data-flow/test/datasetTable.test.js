import assert from "node:assert/strict";
import test from "node:test";

import { buildDatasetRows, datasetLocation, filterRows, paginate, sortRows } from "../src/lib/datasetTable.js";

const datasets = [
  { id: "1", name: "raw_orders", system: "dbt", namespace: "shop", created_at: "2026-01-01T00:00:00Z", database_name: "RAW", schema_name: "SHOP", object_name: "ORDERS" },
  { id: "2", name: "stg_orders", system: "dbt", namespace: "shop", created_at: "2026-02-01T00:00:00Z", relation_name: "analytics.stg_orders" },
  { id: "3", name: "orders_summary", system: "dbt", namespace: "shop", created_at: "2026-03-01T00:00:00Z" },
  { id: "4", name: "page_views", system: "dbt", namespace: "web", created_at: "2026-04-01T00:00:00Z" },
  { id: "5", name: "legacy_extract", system: "cost-test", namespace: null, created_at: "2026-05-01T00:00:00Z" },
];
const edges = [
  { upstream_dataset_id: "1", downstream_dataset_id: "2" },
  { upstream_dataset_id: "2", downstream_dataset_id: "3" },
];
const costs = [
  { dataset_id: "2", cost_amount: "10.5" },
  { dataset_id: "2", cost_amount: "4.5" },
  { dataset_id: "4", cost_amount: "100" },
];

const rows = buildDatasetRows(datasets, edges, costs);
const byName = (list) => list.map((row) => row.name);

test("rows carry lineage role, neighbour counts and total cost", () => {
  const stg = rows.find((row) => row.name === "stg_orders");
  assert.equal(stg.role, "transformation");
  assert.deepEqual([stg.upstreamIds, stg.downstreamIds], [["1"], ["3"]]);
  assert.equal(stg.cost, 15);
  assert.equal(rows.find((row) => row.name === "page_views").role, "none");
  assert.equal(rows.find((row) => row.name === "raw_orders").hasCost, false);
});

test("cost is unknown, not zero, when costs didn't load", () => {
  assert.equal(buildDatasetRows(datasets, edges, null)[0].cost, null);
});

test("location prefers database.schema.object, then the relation name", () => {
  assert.equal(datasetLocation(datasets[0]), "RAW.SHOP.ORDERS");
  assert.equal(datasetLocation(datasets[1]), "analytics.stg_orders");
  assert.equal(datasetLocation(datasets[2]), null);
});

test("filters combine", () => {
  assert.deepEqual(byName(filterRows(rows, { project: "shop", role: "source" })), ["raw_orders"]);
  assert.deepEqual(byName(filterRows(rows, { cost: "with" })), ["stg_orders", "page_views"]);
  assert.deepEqual(byName(filterRows(rows, { project: "none" })), ["legacy_extract"]);
  assert.deepEqual(byName(filterRows(rows, { system: "cost-test" })), ["legacy_extract"]);
});

test("search looks at name, project and location", () => {
  assert.deepEqual(byName(filterRows(rows, { q: "WEB" })), ["page_views"]);
  assert.deepEqual(byName(filterRows(rows, { q: "raw.shop" })), ["raw_orders"]);
});

test("sorting by a column, with name breaking ties", () => {
  assert.deepEqual(byName(sortRows(rows, "cost", "desc")).slice(0, 2), ["page_views", "stg_orders"]);
  assert.deepEqual(byName(sortRows(rows, "created", "asc")), ["raw_orders", "stg_orders", "orders_summary", "page_views", "legacy_extract"]);
  assert.deepEqual(byName(sortRows(rows, "role")).slice(0, 1), ["raw_orders"]);
});

test("pagination clamps to the available pages", () => {
  assert.deepEqual(paginate(rows, 9, 2).page, 3);
  assert.equal(paginate(rows, 3, 2).rows.length, 1);
  assert.equal(paginate([], 1, 25).pageCount, 1);
});
