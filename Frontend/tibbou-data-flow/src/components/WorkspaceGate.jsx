import { useState } from "react";
import { Outlet } from "react-router-dom";

import { useOrganization } from "@/contexts/OrganizationContext";

export default function WorkspaceGate() {
  const { organization, loading, error, createWorkspace } = useOrganization();
  const [name, setName] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  if (loading) return <div className="grid min-h-screen place-items-center">Loading workspace…</div>;
  if (error) return <div className="grid min-h-screen place-items-center text-red-300">{error}</div>;
  if (organization) return <Outlet />;

  async function submit(event) {
    event.preventDefault();
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) {
      setSubmitError("Enter a workspace name containing letters or numbers.");
      return;
    }

    setSubmitError("");
    setSubmitting(true);
    try {
      await createWorkspace({ name, slug });
    } catch (requestError) {
      setSubmitError(requestError.message || "Failed to create workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <form className="w-full max-w-md rounded-xl border border-border bg-card p-8" onSubmit={submit}>
        <h1 className="text-xl font-semibold">Create your first workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">Workspaces isolate datasets, lineage, costs, and integrations.</p>
        <input className="mt-6 w-full rounded-md border border-border bg-background px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} required placeholder="Organization name" />
        {submitError ? <p className="mt-3 text-sm text-red-300">{submitError}</p> : null}
        <button disabled={submitting} className="mt-4 w-full rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60">
          {submitting ? "Creating workspace..." : "Create workspace"}
        </button>
      </form>
    </main>
  );
}
