import { useEffect, useMemo, useState } from "react";
import { DollarSign, Layers3, Wallet } from "lucide-react";

import {
  getCostSnapshots,
  getDatasets,
  getLatestSnowflakeDatasetCreditSummaries,
} from "@/api/tibbou";

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

function formatCredits(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  }).format(Number(value));
}

export default function CostTracking() {
  const [datasets, setDatasets] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [latestSnowflakeSummary, setLatestSnowflakeSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [datasetRows, snapshotRows] = await Promise.all([
          getDatasets(),
          getCostSnapshots(),
        ]);
        let snowflakeSummary = null;

        try {
          snowflakeSummary = await getLatestSnowflakeDatasetCreditSummaries();
        } catch (summaryError) {
          const message = summaryError.message || "";
          if (!message.toLowerCase().includes("not found")) {
            throw summaryError;
          }
        }

        if (!active) {
          return;
        }

        setDatasets(datasetRows);
        setSnapshots(snapshotRows);
        setLatestSnowflakeSummary(snowflakeSummary);
      } catch (requestError) {
        if (active) {
          setError(requestError.message || "Failed to load cost snapshots.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  const datasetById = Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset]));

  const summary = useMemo(() => {
    const totalCost = snapshots.reduce(
      (sum, snapshot) => sum + Number(snapshot.cost_amount || 0),
      0
    );

    return {
      totalCost,
      snapshotCount: snapshots.length,
      datasetCount: new Set(snapshots.map((snapshot) => snapshot.dataset_id)).size,
    };
  }, [snapshots]);

  const costByDataset = useMemo(() => {
    const totals = new Map();

    snapshots.forEach((snapshot) => {
      const current = totals.get(snapshot.dataset_id) || 0;
      totals.set(snapshot.dataset_id, current + Number(snapshot.cost_amount || 0));
    });

    return [...totals.entries()]
      .map(([datasetId, total]) => ({
        datasetId,
        datasetName: datasetById[datasetId]?.name || datasetId,
        system: datasetById[datasetId]?.system || "unknown",
        total,
      }))
      .sort((left, right) => right.total - left.total);
  }, [datasetById, snapshots]);

  const stagedSummary = latestSnowflakeSummary?.dataset_credit_summaries || [];

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full rounded-2xl border border-red-500/20 bg-red-500/10 p-6">
        <h1 className="text-xl font-semibold text-foreground">Costs unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Costs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review saved cost records alongside the latest Snowflake credit activity.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            label: "Total recorded cost",
            value: formatCurrency(summary.totalCost),
            icon: Wallet,
          },
          {
            label: "Cost snapshots",
            value: summary.snapshotCount,
            icon: Layers3,
          },
          {
            label: "Datasets with costs",
            value: summary.datasetCount,
            icon: DollarSign,
          },
          {
            label: "Staged credit summaries",
            value: latestSnowflakeSummary?.dataset_credit_summary_count || 0,
            icon: Layers3,
          },
        ].map((card) => (
          <article key={card.label} className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">{card.label}</p>
              <card.icon className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground">
              {card.value}
            </p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.85fr,1.15fr]">
        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Highest-cost datasets</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Totals based on the stored cost records for each dataset.
          </p>
          <div className="mt-4 space-y-3">
            {costByDataset.length > 0 ? (
              costByDataset.slice(0, 8).map((item) => {
                const maxValue = costByDataset[0]?.total || 1;
                const width = `${Math.max((item.total / maxValue) * 100, 6)}%`;

                return (
                  <div key={item.datasetId} className="space-y-2 rounded-xl border border-border bg-secondary/20 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-foreground">{item.datasetName}</p>
                        <p className="text-xs text-muted-foreground">{item.system}</p>
                      </div>
                      <p className="text-sm font-medium text-primary">
                        {formatCurrency(item.total)}
                      </p>
                    </div>
                    <div className="h-2 rounded-full bg-background/70">
                      <div
                        className="h-2 rounded-full bg-primary"
                        style={{ width }}
                      />
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">No costs recorded yet.</p>
            )}
          </div>
        </article>

        <article className="rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">Stored cost snapshots</h2>
            <p className="text-xs text-muted-foreground">
              Saved cost history for tracked datasets.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Dataset
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Period
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Cost
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Collected
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshots.length > 0 ? (
                  snapshots.map((snapshot) => (
                    <tr key={snapshot.id} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-3 text-sm text-foreground">
                        {datasetById[snapshot.dataset_id]?.name || snapshot.dataset_id}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">
                        {formatDate(snapshot.period_start)} to {formatDate(snapshot.period_end)}
                      </td>
                      <td className="px-5 py-3 text-sm text-foreground">
                        {formatCurrency(Number(snapshot.cost_amount || 0))}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">
                        {formatDate(snapshot.collected_at)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      No cost snapshots are available yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">
            Latest staged Snowflake dataset credit summaries
          </h2>
          <p className="text-xs text-muted-foreground">
            The latest available Snowflake credit totals grouped by dataset.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Bounded period: {formatDate(latestSnowflakeSummary?.period_start)} to{" "}
            {formatDate(latestSnowflakeSummary?.period_end)}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Dataset
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Compute credits
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Query accel.
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Queries
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Period
                </th>
              </tr>
            </thead>
            <tbody>
              {stagedSummary.length > 0 ? (
                stagedSummary.map((summaryRow) => (
                  <tr
                    key={summaryRow.dataset_id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-5 py-3 text-sm text-foreground">
                      {summaryRow.dataset_name}
                    </td>
                    <td className="px-5 py-3 text-sm text-foreground">
                      {formatCredits(summaryRow.total_credits_attributed_compute)}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">
                      {formatCredits(summaryRow.total_credits_used_query_acceleration)}
                    </td>
                    <td className="px-5 py-3 text-sm text-foreground">
                      {summaryRow.attributed_query_count}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">
                      {formatDate(summaryRow.period_start)} to{" "}
                      {formatDate(summaryRow.period_end)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-muted-foreground">
                    No staged Snowflake dataset credit summaries are available yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
