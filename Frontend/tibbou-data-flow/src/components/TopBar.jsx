import { useEffect, useState } from "react";
import { Activity, CheckCircle2, LogOut, Menu, ServerCrash } from "lucide-react";

import { getHealth, listConnections } from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";

export default function TopBar({ onMenu }) {
  const { signOut } = useAuth();
  const { organization, organizations, selectOrganization } = useOrganization();
  const [status, setStatus] = useState({ state: "loading", message: "Checking connection" });

  // The pill describes the Snowflake connection, not just whether our own
  // server answers: "connected" only when this workspace has one enabled.
  useEffect(() => {
    let active = true;
    async function loadStatus() {
      try {
        await getHealth();
        const connections = organization?.id ? await listConnections() : [];
        if (!active) return;
        setStatus(
          connections.some((row) => row.enabled)
            ? { state: "healthy", message: "Snowflake connected" }
            : { state: "degraded", message: "Snowflake not connected" }
        );
      } catch {
        if (active) setStatus({ state: "error", message: "Service unavailable" });
      }
    }
    loadStatus();
    return () => {
      active = false;
    };
  }, [organization?.id]);

  const tone =
    status.state === "healthy"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : status.state === "error"
        ? "border-red-500/20 bg-red-500/10 text-red-300"
        : "border-amber-500/20 bg-amber-500/10 text-amber-300";

  return (
    <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b border-border bg-card/70 px-4 backdrop-blur sm:px-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open menu"
          className="rounded-md border border-border p-2 text-muted-foreground hover:text-foreground md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div>
          <p className="text-sm font-semibold text-foreground">Tibbou</p>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Datasets, lineage, and cost activity in one workspace.
          </p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <select className="min-w-0 max-w-[9rem] truncate rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:max-w-none" value={organization?.id || ""} onChange={(event) => selectOrganization(event.target.value)} aria-label="Organization">
          {organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs sm:flex ${tone}`}>
          {status.state === "healthy" ? <CheckCircle2 className="h-3.5 w-3.5" /> : status.state === "error" ? <ServerCrash className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
          <span>{status.message}</span>
        </div>
        <button className="rounded-md border border-border p-2 text-muted-foreground hover:text-foreground" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
