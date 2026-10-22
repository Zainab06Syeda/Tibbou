import { useEffect, useMemo, useState } from "react";
import { Boxes, ChevronDown, Filter, GitBranch, Search, Upload } from "lucide-react";

import {
  getCostSnapshots,
  getDatasets,
  getLatestDbtManifestIngestionSummary,
  getLineageEdges,
  ingestDbtManifest,
} from "@/api/tibbou";
import LineageGraph from "@/components/LineageGraph";
import { useOrganization } from "@/contexts/OrganizationContext";
import { costByDataset } from "@/lib/chartData";
import { lineageClosure } from "@/lib/lineageLayout";
import { hasPermission } from "@/lib/permissions";

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

export default function Lineage() {
  const { organization } = useOrganization();
  const canUpload = hasPermission(organization?.role, "upload_dbt_manifest");
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
  const [filterProject, setFilterProject] = useState("all");
  const [costs, setCosts] = useState(null);

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
    // Cost is optional detail for the side panel, so it never blocks the page.
    getCostSnapshots()
      .then((rows) => active && setCosts(rows))
      .catch(() => {});

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

  const datasetById = useMemo(
    () => Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset])),
    [datasets]
  );
  const projects = useMemo(
    () => [...new Set(datasets.map((dataset) => dataset.namespace).filter(Boolean))].sort(),
    [datasets]
  );

  // The project filter keeps relationships touching that project. Search
  // keeps each matching dataset with its whole upstream and downstream
  // chain, so the result still shows where the data comes from and goes.
  const { filteredEdges, matchIds } = useMemo(() => {
    const projectEdges = edges.filter((edge) => {
      if (filterProject === "all") return true;
      return (
        datasetById[edge.upstream_dataset_id]?.namespace === filterProject ||
        datasetById[edge.downstream_dataset_id]?.namespace === filterProject
      );
    });
    const term = search.trim().toLowerCase();
    if (!term) return { filteredEdges: projectEdges, matchIds: null };
    const ids = new Set(projectEdges.flatMap((edge) => [edge.upstream_dataset_id, edge.downstream_dataset_id]));
    const matches = new Set([...ids].filter((id) => datasetById[id]?.name?.toLowerCase().includes(term)));
    const keep = lineageClosure(projectEdges, matches);
    return {
      filteredEdges: projectEdges.filter(
        (edge) => keep.has(edge.upstream_dataset_id) && keep.has(edge.downstream_dataset_id)
      ),
      matchIds: matches,
    };
  }, [datasetById, edges, filterProject, search]);

  const graphNodeIds = new Set(
    filteredEdges.flatMap((edge) => [edge.upstream_dataset_id, edge.downstream_dataset_id])
  );
  const graphNodes = datasets.filter((dataset) => graphNodeIds.has(dataset.id));
  const costMap = useMemo(
    () => (costs ? new Map(costByDataset(costs, datasetById).map((row) => [row.datasetId, row.total])) : null),
    [costs, datasetById]
  );

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
          See where each dataset comes from, what depends on it, and what it costs.
        </p>
      </div>

      <section className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),240px]">
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full rounded-xl border border-border bg-card px-10 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
              placeholder="Find a dataset and everything connected to it..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          <label className="relative block">
            <Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <select
              className="w-full appearance-none rounded-xl border border-border bg-card px-10 py-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              value={filterProject}
              onChange={(event) => setFilterProject(event.target.value)}
            >
              <option value="all">All dbt projects</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{graphNodes.length}</span> datasets
          </span>
          <span>
            <span className="font-semibold text-foreground">{filteredEdges.length}</span> relationships
          </span>
          {matchIds ? (
            <span>
              <span className="font-semibold text-foreground">{matchIds.size}</span> matching &ldquo;{search.trim()}&rdquo;,
              shown with everything upstream and downstream
            </span>
          ) : (
            <span>Click a dataset to trace everything upstream and downstream of it.</span>
          )}
        </div>

        <LineageGraph
          nodes={graphNodes}
          edges={filteredEdges}
          highlightIds={matchIds}
          costByDataset={costMap}
          formatCost={formatCurrency}
        />
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

        {latestDbtIngestion && !["success", "partial"].includes(latestDbtIngestion.status) ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-secondary/10 p-4 text-sm text-muted-foreground">
            {latestDbtIngestion.status === "failed"
              ? "The most recent manifest could not be processed. Check that it is a valid dbt manifest.json and upload it again."
              : "Your most recent manifest is waiting to be processed. Counts and the graph below update once it finishes; refresh this page to check."}
          </div>
        ) : latestDbtIngestion ? (
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

      {canUpload ? (
      <details
        className="group rounded-2xl border border-border bg-card p-5"
        open={edges.length === 0 || Boolean(manifestSuccess) || Boolean(manifestError) || undefined}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Upload className="h-4 w-4 text-primary" />
            Upload a dbt manifest
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="mt-4 flex flex-col gap-2 duration-300 animate-in fade-in slide-in-from-top-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
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
      </details>
      ) : null}

    </div>
  );
}
