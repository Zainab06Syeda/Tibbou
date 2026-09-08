import { useEffect, useMemo, useState } from "react";
import { Layers3, Search } from "lucide-react";

import { getDatasets } from "@/api/tibbou";

function formatDate(value) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

export default function Datasets() {
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [systemFilter, setSystemFilter] = useState("all");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const rows = await getDatasets();
        if (active) {
          setDatasets(rows);
        }
      } catch (requestError) {
        if (active) {
          setError(requestError.message || "Failed to load datasets.");
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

  const systems = [...new Set(datasets.map((dataset) => dataset.system).filter(Boolean))];

  const filteredDatasets = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return datasets.filter((dataset) => {
      const matchesSearch =
        !normalizedSearch ||
        dataset.name.toLowerCase().includes(normalizedSearch) ||
        (dataset.namespace || "").toLowerCase().includes(normalizedSearch);

      const matchesSystem =
        systemFilter === "all" || dataset.system === systemFilter;

      return matchesSearch && matchesSystem;
    });
  }, [datasets, search, systemFilter]);

  const countsBySystem = useMemo(() => {
    return systems.map((system) => ({
      system,
      count: datasets.filter((dataset) => dataset.system === system).length,
    }));
  }, [datasets, systems]);

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
        <h1 className="text-xl font-semibold text-foreground">Datasets unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Datasets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse the datasets currently tracked in Tibbou.
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr),260px]">
        <label className="relative block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="w-full rounded-xl border border-border bg-card px-10 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            placeholder="Search name or namespace..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <select
          className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
          value={systemFilter}
          onChange={(event) => setSystemFilter(event.target.value)}
        >
          <option value="all">All systems</option>
          {systems.map((system) => (
            <option key={system} value={system}>
              {system}
            </option>
          ))}
        </select>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <article className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Total datasets</p>
            <Layers3 className="h-4 w-4 text-primary" />
          </div>
          <p className="mt-4 text-3xl font-semibold text-foreground">{datasets.length}</p>
        </article>

        {countsBySystem.slice(0, 2).map((item) => (
          <article key={item.system} className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-medium text-muted-foreground">{item.system}</p>
            <p className="mt-4 text-3xl font-semibold text-foreground">{item.count}</p>
          </article>
        ))}
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">Tracked datasets</h2>
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
              {filteredDatasets.length > 0 ? (
                filteredDatasets.map((dataset) => (
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
                    No datasets match the current filters.
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
