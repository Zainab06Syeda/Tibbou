import { useEffect, useState } from "react";
import { Boxes, Filter, GitBranch, Search } from "lucide-react";

import {
  getDatasets,
  getLatestDbtManifestIngestionSummary,
  getLineageEdges,
  ingestDbtManifest,
} from "@/api/tibbou";
import LineageGraph from "@/components/LineageGraph";

function formatDate(value) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

export default function Lineage() {
  const [datasets, setDatasets] = useState([]);
  const [edges, setEdges] = useState([]);
  const [latestDbtIngestion, setLatestDbtIngestion] = useState(null);
  const [manifestText, setManifestText] = useState("");
  const [manifestError, setManifestError] = useState("");
  const [manifestSuccess, setManifestSuccess] = useState(null);
  const [submittingManifest, setSubmittingManifest] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterSystem, setFilterSystem] = useState("all");

  async function loadLineageData() {
    const [datasetRows, edgeRows] = await Promise.all([getDatasets(), getLineageEdges()]);
    let dbtSummary = null;

    try {
      dbtSummary = await getLatestDbtManifestIngestionSummary();
    } catch (summaryError) {
      const message = summaryError.message || "";
      if (!message.toLowerCase().includes("not found")) {
        throw summaryError;
      }
    }

    setDatasets(datasetRows);
    setEdges(edgeRows);
    setLatestDbtIngestion(dbtSummary);
  }

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [datasetRows, edgeRows] = await Promise.all([getDatasets(), getLineageEdges()]);
        let dbtSummary = null;

        try {
          dbtSummary = await getLatestDbtManifestIngestionSummary();
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
        setEdges(edgeRows);
        setLatestDbtIngestion(dbtSummary);
      } catch (requestError) {
        if (active) {
          setError(requestError.message || "Failed to load lineage data.");
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

  async function handleManifestFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      setManifestText(text);
      setManifestError("");
      setManifestSuccess(null);
    } catch {
      setManifestError("Failed to read the selected manifest file.");
    } finally {
      event.target.value = "";
    }
  }

  async function handleManifestSubmit(event) {
    event.preventDefault();
    setManifestError("");
    setManifestSuccess(null);

    let payload;
    try {
      payload = JSON.parse(manifestText);
    } catch {
      setManifestError("Enter valid JSON before starting the dbt manifest refresh.");
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      setManifestError("The manifest payload must be a JSON object.");
      return;
    }

    setSubmittingManifest(true);
    try {
      const response = await ingestDbtManifest(payload);
      setManifestSuccess(response);
      try {
        await loadLineageData();
      } catch (requestError) {
        setManifestError(
          requestError.message || "Manifest refresh was queued, but lineage data could not be reloaded."
        );
      }
    } catch (requestError) {
      setManifestError(requestError.message || "dbt manifest refresh failed.");
    } finally {
      setSubmittingManifest(false);
    }
  }

  const datasetById = Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset]));

  const filteredEdges = edges.filter((edge) => {
    const upstream = datasetById[edge.upstream_dataset_id];
    const downstream = datasetById[edge.downstream_dataset_id];
    const normalizedSearch = search.trim().toLowerCase();

    const matchesSearch =
      !normalizedSearch ||
      upstream?.name?.toLowerCase().includes(normalizedSearch) ||
      downstream?.name?.toLowerCase().includes(normalizedSearch);

    const matchesSystem =
      filterSystem === "all" ||
      upstream?.system === filterSystem ||
      downstream?.system === filterSystem;

    return matchesSearch && matchesSystem;
  });

  const connectedNodeIds = new Set(
    filteredEdges.flatMap((edge) => [edge.upstream_dataset_id, edge.downstream_dataset_id])
  );
  const graphNodes = datasets.filter((dataset) => connectedNodeIds.has(dataset.id));
  const systems = [...new Set(datasets.map((dataset) => dataset.system).filter(Boolean))];
  const visibleSystems = [
    ...new Set(graphNodes.map((dataset) => dataset.system).filter(Boolean)),
  ];

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
        <h1 className="text-xl font-semibold text-foreground">Lineage unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Lineage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Explore upstream and downstream dataset relationships across your environment.
        </p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Ingest dbt manifest</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Paste a dbt <span className="font-mono">manifest.json</span> payload or load a JSON
              file to refresh datasets and lineage relationships.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary/30">
            Load JSON file
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleManifestFileChange}
            />
          </label>
        </div>

        <form className="mt-4 space-y-4" onSubmit={handleManifestSubmit}>
          <textarea
            className="min-h-[220px] w-full rounded-xl border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            placeholder={`{\n  "nodes": {\n    "model.demo.stg_orders": {\n      "resource_type": "model",\n      "name": "stg_orders",\n      "package_name": "demo",\n      "depends_on": { "nodes": [] }\n    }\n  }\n}`}
            value={manifestText}
            onChange={(event) => setManifestText(event.target.value)}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={submittingManifest}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submittingManifest ? "Refreshing dbt metadata..." : "Run dbt manifest refresh"}
            </button>
            <p className="text-xs text-muted-foreground">
              The latest refresh summary and lineage graph will update after a successful run.
            </p>
          </div>
        </form>

        {manifestError ? (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
            {manifestError}
          </div>
        ) : null}

        {manifestSuccess ? (
          <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Manifest refresh queued</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  A background worker will validate and reconcile this artifact. Refresh this page to see completion details.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Run ID: {manifestSuccess.sync_run_id}
              </p>
            </div>

            <p className="mt-4 text-sm text-emerald-200">Status: {manifestSuccess.status}</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Latest dbt metadata refresh</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              These counts describe the most recent dbt manifest ingestion run, not the full graph
              shown below.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            Completed: {formatDate(latestDbtIngestion?.finished_at)}
          </div>
        </div>

        {latestDbtIngestion ? (
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <article className="rounded-xl border border-border bg-secondary/20 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">Models processed</p>
                <Boxes className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-3 text-2xl font-semibold text-foreground">
                {latestDbtIngestion.datasets_processed}
              </p>
            </article>

            <article className="rounded-xl border border-border bg-secondary/20 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">New datasets</p>
                <Boxes className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-3 text-2xl font-semibold text-foreground">
                {latestDbtIngestion.datasets_created}
              </p>
            </article>

            <article className="rounded-xl border border-border bg-secondary/20 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">
                  Relationships processed
                </p>
                <GitBranch className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-3 text-2xl font-semibold text-foreground">
                {latestDbtIngestion.lineage_edges_processed}
              </p>
            </article>

            <article className="rounded-xl border border-border bg-secondary/20 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">Relationships added</p>
                <GitBranch className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-3 text-2xl font-semibold text-foreground">
                {latestDbtIngestion.lineage_edges_created}
              </p>
            </article>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-secondary/10 p-4 text-sm text-muted-foreground">
            No dbt manifest refresh has been recorded yet.
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Current lineage graph</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Search and filter the currently stored graph below. Selecting a node highlights its
            connected upstream and downstream relationships.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr),220px]">
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full rounded-xl border border-border bg-card px-10 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
              placeholder="Search dataset names..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          <label className="relative block">
            <Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <select
              className="w-full appearance-none rounded-xl border border-border bg-card px-10 py-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              value={filterSystem}
              onChange={(event) => setFilterSystem(event.target.value)}
            >
              <option value="all">All systems</option>
              {systems.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <div className="rounded-lg border border-border bg-card px-4 py-2">
            <span className="text-muted-foreground">Visible relationships: </span>
            <span className="font-semibold text-foreground">{filteredEdges.length}</span>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-2">
            <span className="text-muted-foreground">Visible datasets: </span>
            <span className="font-semibold text-foreground">{graphNodes.length}</span>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-2">
            <span className="text-muted-foreground">Systems in view: </span>
            <span className="font-semibold text-foreground">{visibleSystems.length}</span>
          </div>
        </div>

        <LineageGraph nodes={graphNodes} edges={filteredEdges} />
      </section>
    </div>
  );
}
