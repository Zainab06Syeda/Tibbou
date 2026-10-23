import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Database,
  DollarSign,
  GitBranch,
  Info,
  Layers3,
  RefreshCw,
  Trophy,
} from "lucide-react";

import { getDashboardData, getLatestDbtManifestIngestionSummary, listConnections } from "@/api/tibbou";
import { ChartCard, Donut, RankedBars, TrendArea } from "@/components/charts";
import CountUp from "@/components/CountUp";
import SetupChecklist from "@/components/SetupChecklist";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { costOverTime, datasetsByGroup, projectLabel } from "@/lib/chartData";
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
} from "@/lib/dashboardInsights";
import { ROLE_INFO, relativeTime } from "@/lib/members";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatCompactCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function monthName(key) {
  if (!key) return "";
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

const ACTIVITY_ICONS = {
  dataset: { icon: Database, style: "bg-primary/15 text-primary" },
  cost: { icon: DollarSign, style: "bg-accent/15 text-accent" },
  manifest: { icon: GitBranch, style: "bg-[hsl(var(--chart-4))]/15 text-[hsl(var(--chart-4))]" },
  sync: { icon: RefreshCw, style: "bg-sky-400/15 text-sky-300" },
};

const INSIGHT_STYLES = {
  warning: { icon: AlertTriangle, style: "text-amber-300" },
  info: { icon: Info, style: "text-sky-300" },
  success: { icon: CheckCircle2, style: "text-emerald-400" },
};

function StatusChip({ to, tone = "neutral", live = false, children }) {
  const className = cn(
    "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors",
    tone === "good" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
    tone === "neutral" && "border-border bg-secondary/30 text-muted-foreground",
    to && "hover:brightness-125"
  );
  const content = (
    <>
      {live ? <span className="live-dot" aria-hidden="true" /> : null}
      {children}
    </>
  );
  return to ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { organization } = useOrganization();
  const [dashboard, setDashboard] = useState(null);
  const [connections, setConnections] = useState(null);
  const [latestManifest, setLatestManifest] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canManageConnection = hasPermission(organization?.role, "manage_connection");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await getDashboardData();
        if (active) setDashboard(data);
      } catch (requestError) {
        if (active) setError(requestError.message || "Failed to load dashboard data.");
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    // Status extras; the dashboard works without them.
    listConnections()
      .then((rows) => active && setConnections(rows))
      .catch(() => active && setConnections([]));
    getLatestDbtManifestIngestionSummary()
      .then((summary) => active && setLatestManifest(summary))
      .catch(() => active && setLatestManifest(null));

    return () => {
      active = false;
    };
  }, []);

  const derived = useMemo(() => {
    if (!dashboard) return null;
    const { datasets, lineage, costs } = dashboard;
    const datasetsById = Object.fromEntries(datasets.map((dataset) => [dataset.id, dataset]));
    const radius = blastRadius(lineage, datasetsById);
    const nameCounts = radius.reduce((counts, row) => ({ ...counts, [row.name]: (counts[row.name] || 0) + 1 }), {});
    return {
      datasetsById,
      totalCost: costs.reduce((sum, snapshot) => sum + Number(snapshot.cost_amount || 0), 0),
      newDatasets: addedSince(datasets, 30),
      coverage: lineageCoverage(datasets, lineage),
      change: costChange(costs),
      driver: topCostDriver(costs, datasetsById),
      // Several projects reuse names like stg_orders, so add the project when needed.
      radius: radius.map((row) => ({ ...row, label: nameCounts[row.name] > 1 && row.project ? `${row.name} (${row.project})` : row.name })),
      byProject: datasetsByGroup(datasets, projectLabel),
      trend: costOverTime(costs, datasetsById, 0),
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

  const { datasets, lineage, costs } = dashboard;
  const connected = connections === null ? null : connections.some((row) => row.enabled);
  const name = firstName(user);
  const notes = insights({ datasets, edges: lineage, costs, connected, canManageConnection, latestManifest });
  const activity = recentActivity({ datasets, costs, latestManifest, connections, datasetsById: derived.datasetsById });
  const { change, driver, coverage } = derived;
  const costRising = change.change !== null && change.change > 0;

  const cards = [
    {
      label: "Datasets",
      icon: Layers3,
      to: "/datasets",
      value: <CountUp value={datasets.length} format={formatCount} />,
      note: derived.newDatasets ? `+${derived.newDatasets} in the last 30 days` : "None added in the last 30 days",
    },
    {
      label: "Lineage coverage",
      icon: GitBranch,
      to: "/lineage",
      value: <CountUp value={coverage.share * 100} format={formatPercent} />,
      note: `${coverage.connected} of ${datasets.length} datasets connected · ${lineage.length} relationships`,
      meter: coverage.share,
    },
    {
      label: "Recorded cost",
      icon: DollarSign,
      to: "/costs",
      value: <CountUp value={derived.totalCost} format={formatCurrency} />,
      note:
        change.change === null ? (
          `${costs.length} cost ${costs.length === 1 ? "record" : "records"}`
        ) : (
          <span className={cn("inline-flex items-center gap-1", costRising ? "text-amber-300" : "text-emerald-400")}>
            {costRising ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {Math.abs(Math.round(change.change * 100))}% in {monthName(change.month)} vs the month before
          </span>
        ),
    },
    {
      label: "Top cost driver",
      icon: Trophy,
      to: "/costs",
      value: driver ? <span className="block truncate text-2xl" title={driver.datasetName}>{driver.datasetName}</span> : "—",
      note: driver ? `${Math.round(driver.share * 100)}% of recorded cost · ${formatCurrency(driver.total)}` : "No costs recorded yet",
    },
  ];

  return (
    <div className="w-full space-y-6">
      <section className="relative overflow-hidden rounded-[28px] border border-border bg-[radial-gradient(circle_at_top_left,_rgba(6,182,212,0.18),_transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.95),rgba(15,23,42,0.82))] p-6 lg:p-8">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/80">{organization?.name || "Tibbou overview"}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
          {greeting()}
          {name ? `, ${name}` : ""}.
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Here&apos;s how your data moves and what it costs.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {connected === null ? null : connected ? (
            <StatusChip to="/settings/connection" tone="good" live>
              Snowflake connected
            </StatusChip>
          ) : (
            <StatusChip to={canManageConnection ? "/settings/connection" : null} tone="warn">
              Snowflake not connected{canManageConnection ? " · Connect" : ""}
            </StatusChip>
          )}
          {latestManifest === undefined ? null : latestManifest?.finished_at ? (
            <StatusChip to="/lineage" tone={latestManifest.status === "failed" ? "warn" : "neutral"}>
              {latestManifest.status === "failed" ? "Last dbt upload failed" : `dbt refreshed ${relativeTime(latestManifest.finished_at)}`}
            </StatusChip>
          ) : latestManifest ? (
            <StatusChip to="/lineage">dbt refresh in progress</StatusChip>
          ) : (
            <StatusChip to="/lineage" tone="warn">
              No dbt manifest yet
            </StatusChip>
          )}
          {organization?.role ? <StatusChip>You&apos;re {organization.role === "admin" || organization.role === "owner" || organization.role === "operator" ? "an" : "a"} {ROLE_INFO[organization.role]?.label}</StatusChip> : null}
        </div>
      </section>

      <SetupChecklist />

      <section className="motion-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="motion-lift group block min-w-0 rounded-2xl border border-border bg-card/90 p-5 shadow-lg shadow-black/10 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">{card.label}</p>
              <card.icon className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{card.value}</div>
            {card.meter !== undefined ? (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary/40">
                <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${card.meter * 100}%` }} />
              </div>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{card.note}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </Link>
        ))}
      </section>

      <section className="motion-stagger grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr),minmax(0,1fr)]">
        <ChartCard
          title="Cost trend"
          description={`Total recorded cost per ${derived.trend.granularity}.`}
          isEmpty={derived.trend.rows.length === 0}
          emptyText="No costs recorded yet."
          height={260}
        >
          <TrendArea data={derived.trend.rows} dataKey="total" name="Cost" valueFormatter={formatCompactCurrency} />
        </ChartCard>

        <ChartCard
          title="Datasets by dbt project"
          description="Where the tracked datasets come from."
          isEmpty={derived.byProject.length === 0}
          emptyText="No datasets yet. Upload a dbt manifest on the Lineage page to add some."
          responsive={false}
        >
          <Donut data={derived.byProject} valueFormatter={formatCount} centerLabel="datasets" />
        </ChartCard>
      </section>

      <section className="motion-stagger grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr),minmax(0,1fr)]">
        <ChartCard
          title="Biggest impact if they break"
          description="Datasets with the most others downstream of them. Click one to see its lineage."
          isEmpty={derived.radius.length === 0}
          emptyText="Upload a dbt manifest to see which datasets others depend on."
          height={Math.max(200, derived.radius.length * 40)}
        >
          <RankedBars
            data={derived.radius}
            labelKey="label"
            bars={[{ key: "downstream", label: "Datasets downstream" }]}
            valueFormatter={formatCount}
            onBarClick={(row) => navigate(`/lineage?focus=${encodeURIComponent(row.name)}`)}
          />
        </ChartCard>

        <article className="min-w-0 rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Needs attention</h2>
          <p className="mt-1 text-xs text-muted-foreground">Things worth a look in this workspace.</p>
          <ul className="motion-stagger mt-4 space-y-2">
            {notes.map((note) => {
              const { icon: Icon, style } = INSIGHT_STYLES[note.tone];
              return (
                <li key={note.text} className="flex items-start gap-3 rounded-xl border border-border bg-secondary/20 p-3">
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style)} />
                  <p className="min-w-0 flex-1 text-sm text-foreground">{note.text}</p>
                  {note.to ? (
                    <Link to={note.to} className="shrink-0 text-xs font-medium text-primary hover:underline">
                      {note.action || "View"}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </article>
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
          <p className="text-xs text-muted-foreground">New datasets, cost records, dbt refreshes and Snowflake syncs.</p>
        </div>
        {activity.length ? (
          <ol className="motion-stagger relative px-5 py-4">
            {activity.map((event, index) => {
              const { icon: Icon, style } = ACTIVITY_ICONS[event.kind];
              return (
                <li key={event.id} className="relative flex gap-4 pb-5 last:pb-0">
                  {index < activity.length - 1 ? (
                    <span className="absolute left-4 top-9 h-[calc(100%-2.25rem)] w-px bg-border" aria-hidden="true" />
                  ) : null}
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", style)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm text-foreground">
                      {event.title}
                      {event.amount !== undefined ? <span className="ml-2 font-medium text-accent">{formatCurrency(event.amount)}</span> : null}
                    </p>
                    {event.detail ? <p className="truncate text-xs text-muted-foreground">{event.detail}</p> : null}
                  </div>
                  <time className="shrink-0 pt-1 text-xs text-muted-foreground" dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                    {relativeTime(event.at)}
                  </time>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Nothing has happened in this workspace yet.</p>
        )}
      </section>
    </div>
  );
}
