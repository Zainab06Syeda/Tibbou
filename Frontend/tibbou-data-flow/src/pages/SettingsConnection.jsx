import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { disableConnection, listConnections, syncSnowflake } from "@/api/tibbou";
import ConnectionForm from "@/components/ConnectionForm";
import { useOrganization } from "@/contexts/OrganizationContext";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

const STATUS_STYLES = {
  pending: "text-muted-foreground",
  disabled: "text-muted-foreground",
  failing: "text-red-300",
  invalid: "text-red-300",
};

// Saved but never validated (or validation failed): the form below picks
// it up again, with its key, instead of starting over.
function needsSetup(connection) {
  return !connection.enabled && connection.status !== "disabled";
}

export default function SettingsConnection() {
  const { organization } = useOrganization();
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);

  function refresh() {
    listConnections()
      .then(setConnections)
      .catch((requestError) => setError(requestError.message || "Failed to load connections."));
  }

  async function act(connection, action) {
    setBusyId(connection.id);
    setError("");
    setNotice("");
    try {
      if (action === "sync") {
        await syncSnowflake(connection.id);
        setNotice("Sync queued. New query and cost data usually appears within a few minutes (Snowflake's own usage views can lag by up to ~3 hours).");
      } else {
        await disableConnection(connection.id);
        refresh();
      }
    } catch (requestError) {
      setError(requestError.message || "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    setConnections(null);
    setError("");
    refresh();
  }, [organization?.id]);

  return (
    <div className="w-full space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold">Snowflake connection</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tibbou signs in with a key it generated for this connection; the private half is stored
          encrypted and never shown. It can read query history and costs, not the data in your tables.
        </p>
      </div>

      {error ? <p key={error} className="text-sm text-red-300 duration-300 animate-in fade-in slide-in-from-top-1">{error}</p> : null}
      {notice ? <p key={notice} className="text-sm text-emerald-300 duration-300 animate-in fade-in slide-in-from-top-1">{notice}</p> : null}

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Connections</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Name</th>
                <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Status</th>
                <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Last verified</th>
                <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Last successful sync</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="motion-stagger">
              {connections === null ? (
                <tr><td colSpan={5} className="px-5 py-4 text-sm text-muted-foreground">Loading…</td></tr>
              ) : connections.length ? (
                connections.map((connection) => (
                  <tr
                    key={connection.id}
                    className="border-b border-border/60 transition-colors duration-200 last:border-0 hover:bg-secondary/10"
                  >
                    <td className="px-5 py-3 text-sm">
                      {connection.name}
                      {connection.status === "disabled" ? <span className="ml-2 text-xs text-muted-foreground">(disabled)</span> : null}
                    </td>
                    <td className={`px-5 py-3 text-sm ${STATUS_STYLES[connection.status] || "text-emerald-400"}`}>
                      <span className="inline-flex items-center gap-2">
                        {connection.enabled ? <span className="live-dot" aria-hidden="true" /> : null}
                        {connection.status === "pending" ? "Setup not finished" : <span className="capitalize">{connection.status}</span>}
                      </span>
                      {connection.status === "invalid" && connection.validation_error ? (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{connection.validation_error}</p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(connection.last_validated_at)}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(connection.last_success_at)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right text-sm">
                      {connection.enabled ? (
                        <button
                          type="button"
                          disabled={busyId === connection.id}
                          onClick={() => act(connection, "sync")}
                          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition-transform active:scale-95 disabled:opacity-60"
                        >
                          <RefreshCw className={`h-3 w-3 ${busyId === connection.id ? "motion-safe:animate-spin" : ""}`} />
                          {busyId === connection.id ? "Queuing…" : "Sync now"}
                        </button>
                      ) : null}
                      {needsSetup(connection) && !showAddForm ? (
                        <button
                          type="button"
                          onClick={() => setShowAddForm(true)}
                          className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition-transform active:scale-95"
                        >
                          Finish setup
                        </button>
                      ) : null}
                      {connection.status !== "disabled" ? (
                        <button
                          type="button"
                          disabled={busyId === connection.id}
                          onClick={() => act(connection, "disable")}
                          className="ml-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary/40 disabled:opacity-60"
                        >
                          Disable
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5} className="px-5 py-4 text-sm text-muted-foreground">No connections yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        {showAddForm ? (
          <div className="duration-300 animate-in fade-in slide-in-from-top-2">
            <h2 className="font-semibold">
              {connections?.some(needsSetup) ? "Finish setting up your connection" : "Add a connection"}
            </h2>
            <div className="mt-4">
              <ConnectionForm
                defaultName={`Snowflake connection ${(connections?.length || 0) + 1}`}
                onSaved={() => {
                  setShowAddForm(false);
                  refresh();
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="mt-4 text-sm text-muted-foreground underline hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40"
          >
            Add a new connection
          </button>
        )}
      </section>
    </div>
  );
}
