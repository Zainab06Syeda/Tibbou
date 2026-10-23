import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  DollarSign,
  FolderTree,
  GitBranch,
  Layers3,
  Search,
  X,
} from "lucide-react";

import { getCostSnapshots, getDatasets, getLineageEdges } from "@/api/tibbou";
import { ChartCard, RankedBars, TrendArea } from "@/components/charts";
import CountUp from "@/components/CountUp";
import { datasetsByGroup, datasetsOverTime, projectLabel } from "@/lib/chartData";
import {
  DEFAULT_FILTERS,
  ROLE_LABELS,
  SORT_KEYS,
  buildDatasetRows,
  filterRows,
  paginate,
  sortRows,
} from "@/lib/datasetTable";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const ROLE_STYLES = {
  source: "border-primary/40 bg-primary/10 text-primary",
  transformation: "border-[hsl(var(--chart-4))]/40 bg-[hsl(var(--chart-4))]/10 text-[hsl(var(--chart-4))]",
  destination: "border-accent/40 bg-accent/10 text-accent",
  none: "border-border bg-secondary/20 text-muted-foreground",
};

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatDay(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function RoleBadge({ role }) {
  return (
    <span className={cn("inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", ROLE_STYLES[role])}>
      {ROLE_LABELS[role]}
    </span>
  );
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <select
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[110px,minmax(0,1fr)] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words text-foreground">{children}</dd>
    </div>
  );
}

function DatasetDrawer({ row, rowsById, onClose, onOpen }) {
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const neighbours = (ids, empty) =>
    ids.length ? (
      <ul className="mt-2 space-y-1">
        {ids.map((id) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => onOpen(id)}
              className="flex w-full items-center justify-between gap-2 rounded-md bg-secondary/20 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary/40"
            >
              <span className="truncate">{rowsById.get(id)?.name || "Unknown dataset"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{rowsById.get(id)?.project || ""}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-2 text-sm text-muted-foreground/70">{empty}</p>
    );

  // Portalled to <body> so no page wrapper (e.g. one mid-animation) can
  // trap the fixed overlay; it always covers the sidebar and top bar.
  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/50 duration-200 animate-in fade-in" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Dataset ${row.name}`}
        className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl duration-300 animate-in slide-in-from-right"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="min-w-0">
            <RoleBadge role={row.role} />
            <h2 className="mt-2 break-words text-lg font-semibold text-foreground">{row.name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.project || "No project"} · {row.system}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
            aria-label="Close details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-secondary/20 p-3">
              <p className="text-lg font-semibold text-foreground">{row.upstreamIds.length}</p>
              <p className="text-[11px] text-muted-foreground">upstream</p>
            </div>
            <div className="rounded-lg bg-secondary/20 p-3">
              <p className="text-lg font-semibold text-foreground">{row.downstreamIds.length}</p>
              <p className="text-[11px] text-muted-foreground">downstream</p>
            </div>
            <div className="rounded-lg bg-secondary/20 p-3">
              <p className="truncate text-lg font-semibold text-foreground">
                {row.cost === null ? "—" : row.hasCost ? formatCurrency(row.cost) : "None"}
              </p>
              <p className="text-[11px] text-muted-foreground">recorded cost</p>
            </div>
          </div>

          <dl className="divide-y divide-border/60">
            <DetailRow label="Location">
              {row.location ? <span className="font-mono text-xs">{row.location}</span> : "—"}
            </DetailRow>
            <DetailRow label="dbt ID">
              {row.dataset.source_unique_id ? <span className="font-mono text-xs">{row.dataset.source_unique_id}</span> : "—"}
            </DetailRow>
            <DetailRow label="Account">{row.dataset.account_name || "—"}</DetailRow>
            <DetailRow label="Added">{formatDateTime(row.createdAt)}</DetailRow>
          </dl>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Feeds from</h3>
            {neighbours(row.upstreamIds, "Nothing feeds into this dataset.")}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Feeds into</h3>
            {neighbours(row.downstreamIds, "Nothing uses this dataset.")}
          </div>
        </div>

        {row.role !== "none" ? (
          <div className="border-t border-border p-5">
            <button
              type="button"
              onClick={() => navigate(`/lineage?focus=${encodeURIComponent(row.name)}`)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <GitBranch className="h-4 w-4" />
              Open in lineage
            </button>
          </div>
        ) : null}
      </aside>
    </>,
    document.body
  );
}

export default function Datasets() {
  const [datasets, setDatasets] = useState([]);
  const [edges, setEdges] = useState([]);
  const [costs, setCosts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [params, setParams] = useSearchParams();

  // Filters, sort, page and the open dataset live in the URL, so a filtered
  // view survives a reload and can be shared.
  const filters = Object.fromEntries(
    Object.entries(DEFAULT_FILTERS).map(([key, fallback]) => [key, params.get(key) || fallback])
  );
  const sortKey = SORT_KEYS.includes(params.get("sort")) ? params.get("sort") : "name";
  const sortDirection = params.get("dir") === "desc" ? "desc" : "asc";
  const requestedPage = Number(params.get("page")) || 1;
  const openId = params.get("dataset");

  function update(changes) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === undefined || value === "" || value === DEFAULT_FILTERS[key]) next.delete(key);
          else next.set(key, String(value));
        }
        // Any change other than paging or opening a dataset starts from page 1.
        if (!("page" in changes) && !("dataset" in changes)) next.delete("page");
        return next;
      },
      { replace: true }
    );
  }

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const rows = await getDatasets();
        if (active) setDatasets(rows);
      } catch (requestError) {
        if (active) setError(requestError.message || "Failed to load datasets.");
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    // Lineage and cost add columns but aren't required to show the list.
    getLineageEdges().then((rows) => active && setEdges(rows)).catch(() => {});
    getCostSnapshots().then((rows) => active && setCosts(rows)).catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => buildDatasetRows(datasets, edges, costs), [datasets, edges, costs]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const projects = useMemo(() => [...new Set(rows.map((row) => row.project).filter(Boolean))].sort(), [rows]);
  const systems = useMemo(() => [...new Set(rows.map((row) => row.system))].sort(), [rows]);
  const hasUnassigned = rows.some((row) => !row.project);

  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters.q, filters.project, filters.role, filters.system, filters.cost]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortRows(filtered, sortKey, sortDirection), [filtered, sortKey, sortDirection]);
  const { page, pageCount, rows: pageRows } = paginate(sorted, requestedPage, PAGE_SIZE);

  const byProject = useMemo(
    () => datasetsByGroup(datasets, projectLabel, 8).map((item) => ({ project: item.label, count: item.value })),
    [datasets]
  );
  const growth = useMemo(() => datasetsOverTime(datasets), [datasets]);

  const activeChips = [
    filters.q && { key: "q", label: `Search: “${filters.q}”` },
    filters.project !== "all" && { key: "project", label: `Project: ${filters.project === "none" ? "No project" : filters.project}` },
    filters.role !== "all" && { key: "role", label: `Role: ${ROLE_LABELS[filters.role]}` },
    filters.cost !== "all" && { key: "cost", label: filters.cost === "with" ? "Has recorded cost" : "No recorded cost" },
    filters.system !== "all" && { key: "system", label: `System: ${filters.system}` },
  ].filter(Boolean);

  function toggleSort(key) {
    if (sortKey === key) update({ sort: key, dir: sortDirection === "asc" ? "desc" : "asc" });
    else update({ sort: key, dir: ["cost", "created", "upstream", "downstream"].includes(key) ? "desc" : "asc" });
  }

  // A plain function, not a component, so headers keep focus across re-renders.
  function sortHeader(label, column, className = "") {
    const active = sortKey === column;
    const Icon = active ? (sortDirection === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
    return (
      <th className={cn("px-4 py-3 text-left", className)} aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className="h-3 w-3" />
        </button>
      </th>
    );
  }

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

  const openRow = openId ? rowsById.get(openId) : null;
  const stats = [
    { label: "Datasets", value: rows.length, icon: Layers3, note: "Tracked across all projects" },
    { label: "dbt projects", value: projects.length, icon: FolderTree, note: "Where the datasets come from" },
    { label: "In lineage", value: rows.filter((row) => row.role !== "none").length, icon: GitBranch, note: "Connected to another dataset" },
    {
      label: "With recorded cost",
      value: rows.filter((row) => row.hasCost).length,
      icon: DollarSign,
      note: costs ? "Have at least one cost record" : "Cost data unavailable",
    },
  ];

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Datasets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every dataset Tibbou tracks, with its project, place in the lineage and cost.
        </p>
      </div>

      <section className="motion-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <article key={stat.label} className="motion-lift rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
              <stat.icon className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-4 text-3xl font-semibold text-foreground">
              <CountUp value={stat.value} />
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{stat.note}</p>
          </article>
        ))}
      </section>

      <section className="motion-stagger grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Datasets by dbt project"
          description="How many datasets each project contributes. Click a bar to filter the list."
          isEmpty={byProject.length === 0}
          emptyText="No datasets yet. Upload a dbt manifest on the Lineage page to add some."
          height={Math.max(220, byProject.length * 36)}
        >
          <RankedBars
            data={byProject}
            labelKey="project"
            bars={[{ key: "count", label: "Datasets" }]}
            valueFormatter={formatCount}
            onBarClick={(item) => {
              if (projects.includes(item.project)) update({ project: item.project });
              else if (item.project === "No project") update({ project: "none" });
            }}
          />
        </ChartCard>

        <ChartCard
          title="Datasets tracked over time"
          description="Running total of datasets as they were added."
          isEmpty={growth.length === 0}
          emptyText="No datasets yet."
          height={Math.max(220, byProject.length * 36)}
        >
          <TrendArea data={growth} dataKey="total" name="Datasets" valueFormatter={formatCount} />
        </ChartCard>
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="space-y-4 border-b border-border p-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr),repeat(4,minmax(0,1fr))]">
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Search</span>
              <span className="relative block">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
                  placeholder="Name, project or warehouse location"
                  value={filters.q}
                  onChange={(event) => update({ q: event.target.value })}
                />
              </span>
            </label>
            <FilterSelect label="dbt project" value={filters.project} onChange={(value) => update({ project: value })}>
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
              {hasUnassigned ? <option value="none">No project</option> : null}
            </FilterSelect>
            <FilterSelect label="Lineage role" value={filters.role} onChange={(value) => update({ role: value })}>
              <option value="all">All roles</option>
              {Object.entries(ROLE_LABELS).map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Cost" value={filters.cost} onChange={(value) => update({ cost: value })}>
              <option value="all">Any cost</option>
              <option value="with">Has recorded cost</option>
              <option value="without">No recorded cost</option>
            </FilterSelect>
            <FilterSelect label="System" value={filters.system} onChange={(value) => update({ system: value })}>
              <option value="all">All systems</option>
              {systems.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </FilterSelect>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="mr-1 text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{sorted.length}</span> of {rows.length} datasets
            </span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => update({ [chip.key]: DEFAULT_FILTERS[chip.key] })}
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary transition-colors duration-200 animate-in fade-in zoom-in-95 hover:bg-primary/20"
                aria-label={`Remove filter ${chip.label}`}
              >
                {chip.label}
                <X className="h-3 w-3" />
              </button>
            ))}
            {activeChips.length > 1 ? (
              <button
                type="button"
                onClick={() => update(DEFAULT_FILTERS)}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear all
              </button>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                {sortHeader("Name", "name")}
                {sortHeader("Project", "project", "hidden md:table-cell")}
                {sortHeader("Role", "role")}
                {sortHeader("Upstream", "upstream", "hidden lg:table-cell")}
                {sortHeader("Downstream", "downstream", "hidden lg:table-cell")}
                {sortHeader("Cost", "cost", "hidden sm:table-cell")}
                {sortHeader("Added", "created", "hidden xl:table-cell")}
              </tr>
            </thead>
            <tbody key={`${page}-${sortKey}-${sortDirection}-${sorted.length}`} className="motion-stagger">
              {pageRows.length > 0 ? (
                pageRows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => update({ dataset: row.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") update({ dataset: row.id });
                    }}
                    className={cn(
                      "cursor-pointer border-b border-border/60 outline-none transition-colors duration-150 last:border-0 hover:bg-secondary/20 focus-visible:bg-secondary/30",
                      openId === row.id && "bg-secondary/30"
                    )}
                  >
                    <td className="max-w-[320px] px-4 py-3">
                      <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                      {row.location ? <p className="truncate font-mono text-[11px] text-muted-foreground">{row.location}</p> : null}
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-muted-foreground md:table-cell">{row.project || "—"}</td>
                    <td className="px-4 py-3">
                      <RoleBadge role={row.role} />
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-muted-foreground lg:table-cell">{row.upstreamIds.length}</td>
                    <td className="hidden px-4 py-3 text-sm text-muted-foreground lg:table-cell">{row.downstreamIds.length}</td>
                    <td className="hidden px-4 py-3 text-sm sm:table-cell">
                      {row.cost === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : row.hasCost ? (
                        <span className="font-medium text-foreground">{formatCurrency(row.cost)}</span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-muted-foreground xl:table-cell">{formatDay(row.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    {rows.length === 0 ? (
                      <>
                        No datasets yet.{" "}
                        <Link to="/lineage" className="text-primary hover:underline">
                          Upload a dbt manifest
                        </Link>{" "}
                        to add some.
                      </>
                    ) : (
                      <>
                        No datasets match these filters.{" "}
                        <button type="button" onClick={() => update(DEFAULT_FILTERS)} className="text-primary hover:underline">
                          Clear filters
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pageCount > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
            <span>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => update({ page: page - 1 })}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-secondary/40 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>
              <span className="px-2">
                Page {page} of {pageCount}
              </span>
              <button
                type="button"
                disabled={page >= pageCount}
                onClick={() => update({ page: page + 1 })}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-secondary/40 disabled:opacity-40"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {openRow ? (
        <DatasetDrawer
          key={openRow.id}
          row={openRow}
          rowsById={rowsById}
          onClose={() => update({ dataset: null })}
          onOpen={(id) => update({ dataset: id })}
        />
      ) : null}
    </div>
  );
}
