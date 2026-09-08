import { useEffect, useState } from "react";
import { Activity, CheckCircle2, LogOut, ServerCrash } from "lucide-react";

import { getHealth } from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";

export default function TopBar() {
  const { signOut } = useAuth();
  const { organization, organizations, selectOrganization } = useOrganization();
  const [status, setStatus] = useState({ state: "loading", message: "Checking connection" });

  useEffect(() => {
    let active = true;

    async function loadHealth() {
      try {
        const health = await getHealth();
        if (!active) {
          return;
        }

        setStatus({
          state: health.status === "ok" ? "healthy" : "degraded",
          message: health.status === "ok" ? "Live data connected" : "Service warning",
        });
      } catch (error) {
        if (!active) {
          return;
        }

        setStatus({
          state: "error",
          message: error.message || "Connection unavailable",
        });
      }
    }

    loadHealth();

    return () => {
      active = false;
    };
  }, []);

  const tone =
    status.state === "healthy"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : status.state === "error"
        ? "border-red-500/20 bg-red-500/10 text-red-300"
        : "border-amber-500/20 bg-amber-500/10 text-amber-300";

  return (
    <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b border-border bg-card/70 px-6 backdrop-blur">
      <div>
        <p className="text-sm font-semibold text-foreground">Tibbou</p>
        <p className="text-xs text-muted-foreground">
          Datasets, lineage, and cost activity in one workspace.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <select className="rounded-md border border-border bg-background px-2 py-1.5 text-xs" value={organization?.id || ""} onChange={(event) => selectOrganization(event.target.value)} aria-label="Organization">
          {organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${tone}`}>
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
