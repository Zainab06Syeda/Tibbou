import { useEffect, useMemo, useState } from "react";
import { Database, DollarSign, GitBranch, Radio } from "lucide-react";

import { getDashboardData } from "@/api/tibbou";

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

export default function Dashboard() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await getDashboardData();
        if (active) {
          setDashboard(data);
        }
      } catch (requestError) {
        if (active) {
          setError(requestError.message || "Failed to load dashboard data.");
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

  const summary = useMemo(() => {
    if (!dashboard) {
      return {
        datasetCount: 0,
        lineageCount: 0,
        snapshotCount: 0,
        totalCost: 0,
      };
    }

    return {
      datasetCount: dashboard.datasets.length,
      lineageCount: dashboard.lineage.length,
      snapshotCount: dashboard.costs.length,
      totalCost: dashboard.costs.reduce(
        (sum, snapshot) => sum + Number(snapshot.cost_amount || 0),
        0
      ),
    };
  }, [dashboard]);

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
        <h1 className="text-xl font-semibold text-foreground">Dashboard unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }

  const datasetsById = Object.fromEntries(
    dashboard.datasets.map((dataset) => [dataset.id, dataset])
  );

  const recentCosts = dashboard.costs.slice(0, 5);
  const recentDatasets = dashboard.datasets.slice(0, 6);
  const systems = Object.entries(
    dashboard.datasets.reduce((accumulator, dataset) => {
      accumulator[dataset.system] = (accumulator[dataset.system] || 0) + 1;
      return accumulator;
    }, {})
  );

  return (
    <div className="w-full space-y-6">
      <section className="rounded-[28px] border border-border bg-[radial-gradient(circle_at_top_left,_rgba(6,182,212,0.18),_transparent_30%),linear-gradient(180deg,rgba(15,23,42,0.95),rgba(15,23,42,0.82))] p-6 lg:p-8">
        <div className="max-w-3xl">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">
            Tibbou overview
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
            Understand how your data moves and what it costs.
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Explore tracked datasets, follow dependencies, and review recent cost activity across
            the warehouse.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Datasets",
            value: summary.datasetCount,
            note: "Tracked assets across connected systems",
            icon: Database,
          },
          {
            label: "Lineage edges",
            value: summary.lineageCount,
            note: "Recorded dataset relationships",
            icon: GitBranch,
          },
          {
            label: "Cost snapshots",
            value: summary.snapshotCount,
            note: "Stored cost records",
            icon: DollarSign,
          },
          {
            label: "Recorded cost",
            value: formatCurrency(summary.totalCost),
            note: "Total across saved snapshots",
            icon: Radio,
          },
        ].map((card) => (
          <article
            key={card.label}
            className="rounded-2xl border border-border bg-card/90 p-5 shadow-lg shadow-black/10"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">{card.label}</p>
              <card.icon className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground">
              {card.value}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{card.note}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
        <article className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Recent datasets</h2>
              <p className="text-xs text-muted-foreground">
                Newly tracked datasets and where they come from.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Name
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    System
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Namespace
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentDatasets.length > 0 ? (
                  recentDatasets.map((dataset) => (
                    <tr key={dataset.id} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-3 text-sm font-medium text-foreground">
                        {dataset.name}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">{dataset.system}</td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">
                        {dataset.namespace || "—"}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">
                        {formatDate(dataset.created_at)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      No datasets have been stored yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Connected data flows</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Tibbou can bring in metadata and warehouse activity to keep this view current.
          </p>
          <div className="mt-4 space-y-3">
            {[
              {
                title: "dbt metadata refresh",
                note: "Loads models and dependencies from your dbt project.",
              },
              {
                title: "Snowflake activity sync",
                note: "Brings in recent query activity and staged warehouse credit signals.",
              },
            ].map((item) => (
              <div key={item.title} className="rounded-xl border border-border bg-secondary/20 p-4">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.note}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.9fr,1.1fr]">
        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">System coverage</h2>
          <div className="mt-4 space-y-3">
            {systems.map(([system, count]) => (
              <div key={system} className="rounded-xl border border-border bg-secondary/20 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">{system}</p>
                  <p className="text-sm text-primary">{count}</p>
                </div>
              </div>
            ))}
            {dashboard.datasets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No systems recorded yet.</p>
            ) : null}
          </div>
        </article>

        <article className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Recent cost snapshots</h2>
              <p className="text-xs text-muted-foreground">
                Saved cost records across the latest tracked datasets.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Dataset
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Amount
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Collected
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentCosts.length > 0 ? (
                  recentCosts.map((snapshot) => (
                    <tr key={snapshot.id} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-3 text-sm text-foreground">
                        {datasetsById[snapshot.dataset_id]?.name || snapshot.dataset_id}
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
                    <td colSpan={3} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      No cost snapshots are available yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </div>
  );
}
