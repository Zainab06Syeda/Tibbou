import { useState } from "react";
import { Outlet } from "react-router-dom";

import { useOrganization } from "@/contexts/OrganizationContext";
import { useAuth } from "@/contexts/AuthContext";

export default function WorkspaceGate() {
  const { user, signOut } = useAuth();
  const { organization, invitations, loading, error, acceptInvitation } = useOrganization();
  const [joiningId, setJoiningId] = useState(null);
  const [joinError, setJoinError] = useState("");
  if (loading) return <div className="grid min-h-screen place-items-center">Loading workspace…</div>;
  if (error) return <div className="grid min-h-screen place-items-center text-red-300">{error}</div>;
  if (organization) return <Outlet />;

  async function join(id) {
    setJoinError("");
    setJoiningId(id);
    try {
      await acceptInvitation(id);
    } catch (requestError) {
      setJoinError(requestError.message || "Failed to join organization.");
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8">
        <h1 className="text-xl font-semibold">No organization membership found</h1>
        {invitations.length ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">Accept an approved invitation to join an organization.</p>
            <div className="mt-6 space-y-3">
              {invitations.map((invitation) => (
                <article key={invitation.id} className="rounded-lg border border-border bg-background p-4">
                  <h2 className="font-medium">{invitation.organization_name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{invitation.organization_slug} · {invitation.role}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Expires {new Date(invitation.expires_at).toLocaleString()}</p>
                  <button
                    type="button"
                    disabled={joiningId !== null}
                    onClick={() => join(invitation.id)}
                    className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {joiningId === invitation.id ? "Joining…" : "Join organization"}
                  </button>
                </article>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No organization access has been approved. Ask an owner or administrator to invite {user?.email || "your signed-in email"}.
          </p>
        )}
        {joinError ? <p className="mt-4 text-sm text-red-300">{joinError}</p> : null}
        <button type="button" onClick={signOut} className="mt-6 text-sm text-muted-foreground underline hover:text-foreground">
          Sign out
        </button>
      </section>
    </main>
  );
}
