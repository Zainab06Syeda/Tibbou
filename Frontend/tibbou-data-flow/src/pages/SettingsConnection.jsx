import { useEffect, useState } from "react";

import { listConnections } from "@/api/tibbou";
import ConnectionForm from "@/components/ConnectionForm";
import { useOrganization } from "@/contexts/OrganizationContext";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

const STATUS_STYLES = {
  pending: "text-muted-foreground",
  disabled: "text-muted-foreground",
  failing: "text-red-300",
};

export default function SettingsConnection() {
  const { organization } = useOrganization();
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  function refresh() {
    listConnections()
      .then(setConnections)
      .catch((requestError) => setError(requestError.message || "Failed to load connections."));
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
          Credentials are never stored — only a reference label is saved. Rotating credentials means
          testing and saving a new connection, then disabling the old one.
        </p>
      </div>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}

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
              </tr>
            </thead>
            <tbody>
              {connections === null ? (
                <tr><td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">Loading…</td></tr>
              ) : connections.length ? (
                connections.map((connection) => (
                  <tr key={connection.id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 text-sm">
                      {connection.name}
                      {!connection.enabled ? <span className="ml-2 text-xs text-muted-foreground">(disabled)</span> : null}
                    </td>
                    <td className={`px-5 py-3 text-sm capitalize ${STATUS_STYLES[connection.status] || "text-emerald-400"}`}>
                      {connection.status}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(connection.last_validated_at)}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(connection.last_success_at)}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">No connections yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        {showAddForm ? (
          <>
            <h2 className="font-semibold">Add a connection</h2>
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
          </>
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
