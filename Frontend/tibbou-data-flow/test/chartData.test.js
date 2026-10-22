import assert from "node:assert/strict";
import test from "node:test";

import {
  OTHER_KEY,
  chooseGranularity,
  costByDataset,
  costByProject,
  costOverTime,
  creditsByDataset,
  datasetsOverTime,
  topGroups,
} from "../src/lib/chartData.js";

const datasetsById = {
  a: { id: "a", name: "orders", system: "dbt", namespace: "shop" },
  b: { id: "b", name: "customers", system: "dbt", namespace: "shop" },
  c: { id: "c", name: "events", system: "dbt", namespace: "web" },
};

function snapshot(datasetId, periodStart, costAmount) {
  return { dataset_id: datasetId, period_start: periodStart, cost_amount: String(costAmount) };
}

test("long histories are bucketed by month, short ones by day", () => {
  assert.equal(chooseGranularity(["2026-01-05T00:00:00Z", "2026-06-01T00:00:00Z"]), "month");
  assert.equal(chooseGranularity(["2026-06-01T00:00:00Z", "2026-06-20T00:00:00Z"]), "day");
  assert.equal(chooseGranularity([]), "month");
});

test("costs are totalled per dataset, highest first", () => {
  const rows = costByDataset(
    [snapshot("a", "2026-01-01T00:00:00Z", 10), snapshot("b", "2026-01-01T00:00:00Z", 30), snapshot("a", "2026-02-01T00:00:00Z", 5)],
    datasetsById
  );
  assert.deepEqual(rows.map((row) => [row.datasetName, row.total]), [["customers", 30], ["orders", 15]]);
});

test("cost over time stacks top datasets, folds the rest, and fills empty months", () => {
  const { granularity, rows, series } = costOverTime(
    [
      snapshot("a", "2026-01-01T00:00:00Z", 10),
      snapshot("b", "2026-01-15T00:00:00Z", 20),
      snapshot("c", "2026-04-01T00:00:00Z", 1),
    ],
    datasetsById,
    2
  );
  assert.equal(granularity, "month");
  assert.deepEqual(series.map((item) => item.label), ["customers", "orders", "Other datasets"]);
  assert.deepEqual(rows.map((row) => row.bucket), ["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.equal(rows[0].total, 30);
  assert.equal(rows[1].total, 0);
  assert.equal(rows[3][OTHER_KEY], 1);
});

test("an empty history draws nothing", () => {
  assert.deepEqual(costOverTime([], datasetsById), { granularity: "month", rows: [], series: [] });
});

test("cost is grouped by dbt project", () => {
  const groups = costByProject(
    [snapshot("a", "2026-01-01T00:00:00Z", 10), snapshot("b", "2026-01-01T00:00:00Z", 5), snapshot("c", "2026-01-01T00:00:00Z", 2)],
    datasetsById
  );
  assert.deepEqual(groups, [{ label: "shop", value: 15 }, { label: "web", value: 2 }]);
});

test("small groups are folded into Other", () => {
  const groups = topGroups(
    ["a", "b", "c", "d", "e"].map((label, index) => ({ label, value: 10 - index })),
    3
  );
  assert.deepEqual(groups, [{ label: "a", value: 10 }, { label: "b", value: 9 }, { label: "Other", value: 21 }]);
});

test("credits are ranked by total and empty rows dropped", () => {
  const rows = creditsByDataset([
    { dataset_name: "x", total_credits_attributed_compute: 1, total_credits_used_query_acceleration: null, attributed_query_count: 3 },
    { dataset_name: "y", total_credits_attributed_compute: 2, total_credits_used_query_acceleration: 1, attributed_query_count: 1 },
    { dataset_name: "z", total_credits_attributed_compute: null, total_credits_used_query_acceleration: null, attributed_query_count: 0 },
  ]);
  assert.deepEqual(rows.map((row) => [row.datasetName, row.total]), [["y", 3], ["x", 1]]);
});

test("datasets over time is a running total", () => {
  const rows = datasetsOverTime([
    { created_at: "2026-06-01T10:00:00Z" },
    { created_at: "2026-06-01T12:00:00Z" },
    { created_at: "2026-06-03T09:00:00Z" },
  ]);
  assert.deepEqual(rows.map((row) => [row.bucket, row.total]), [["2026-06-01", 2], ["2026-06-02", 2], ["2026-06-03", 3]]);
});
