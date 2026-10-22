import assert from "node:assert/strict";
import test from "node:test";

import { adjacency, downstreamOf, layoutLineage, lineageClosure, upstreamOf } from "../src/lib/lineageLayout.js";

function edge(from, to) {
  return { id: `${from}-${to}`, upstream_dataset_id: from, downstream_dataset_id: to };
}

// raw_orders -> stg_orders -> fct_orders -> orders_summary
//                                    \-> customer_revenue
// raw_customers -> stg_customers -> customer_revenue
const shop = [
  edge("raw_orders", "stg_orders"),
  edge("stg_orders", "fct_orders"),
  edge("fct_orders", "orders_summary"),
  edge("fct_orders", "customer_revenue"),
  edge("raw_customers", "stg_customers"),
  edge("stg_customers", "customer_revenue"),
];

test("every arrow points to a later column, even with uneven path lengths", () => {
  const { nodes } = layoutLineage(shop);
  for (const item of shop) {
    assert.ok(
      nodes.get(item.upstream_dataset_id).column < nodes.get(item.downstream_dataset_id).column,
      `${item.upstream_dataset_id} should sit left of ${item.downstream_dataset_id}`
    );
  }
  assert.equal(nodes.get("customer_revenue").column, 3);
});

test("roles come from position in the graph", () => {
  const { nodes } = layoutLineage(shop);
  assert.equal(nodes.get("raw_orders").role, "source");
  assert.equal(nodes.get("fct_orders").role, "transformation");
  assert.equal(nodes.get("orders_summary").role, "destination");
});

test("separate graphs get separate bands instead of interleaving", () => {
  const { nodes, rowCount } = layoutLineage([...shop, edge("a", "b"), edge("c", "d")]);
  const shopRows = ["raw_orders", "raw_customers", "stg_orders", "stg_customers"].map((id) => nodes.get(id).row);
  const otherRows = ["a", "b", "c", "d"].map((id) => nodes.get(id).row);
  assert.ok(Math.max(...shopRows) < Math.min(...otherRows));
  assert.equal(rowCount, 4);
});

test("children are ordered next to their parents", () => {
  const { nodes } = layoutLineage([edge("x1", "y2"), edge("x2", "y1")], { nameOf: (id) => id });
  // y1's parent x2 is below x1, so y1 should end up below y2.
  assert.ok(nodes.get("y1").row > nodes.get("y2").row);
});

test("a cycle doesn't hang the layout", () => {
  const { nodes } = layoutLineage([edge("a", "b"), edge("b", "a"), edge("a", "c")]);
  assert.equal(nodes.size, 3);
});

test("upstream and downstream follow the whole chain", () => {
  const { incoming, outgoing } = adjacency(shop);
  assert.deepEqual([...upstreamOf(["customer_revenue"], incoming)].sort(), [
    "fct_orders",
    "raw_customers",
    "raw_orders",
    "stg_customers",
    "stg_orders",
  ]);
  assert.deepEqual([...downstreamOf(["stg_orders"], outgoing)].sort(), ["customer_revenue", "fct_orders", "orders_summary"]);
});

test("closure keeps a dataset with everything up and downstream of it", () => {
  assert.deepEqual([...lineageClosure(shop, ["stg_customers"])].sort(), [
    "customer_revenue",
    "raw_customers",
    "stg_customers",
  ]);
});
