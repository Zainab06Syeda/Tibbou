import { useState } from "react";
import { MailPlus } from "lucide-react";

import { useOrganization } from "@/contexts/OrganizationContext";

// Invitations to other workspaces, for people who already belong to one.
// (People with no workspace yet see their invitations in onboarding.)
export default function PendingInvitations() {
  const { invitations, acceptInvitation } = useOrganization();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  if (!invitations.length) return null;

  async function join(invitation) {
    setBusyId(invitation.id);
    setError("");
    try {
      await acceptInvitation(invitation.id);
    } catch (requestError) {
      setError(requestError.message || "Could not join that workspace.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-6 w-full rounded-2xl border border-primary/30 bg-primary/10 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MailPlus className="h-4 w-4 text-primary" />
        {invitations.length === 1 ? "You've been invited to a workspace" : "You've been invited to workspaces"}
      </div>
      <ul className="mt-3 space-y-2">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="text-sm">
              <span className="font-medium text-foreground">{invitation.organization_name}</span>
              <span className="ml-2 text-xs capitalize text-muted-foreground">as {invitation.role}</span>
            </div>
            <button
              type="button"
              disabled={busyId === invitation.id}
              onClick={() => join(invitation)}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-slate-950 disabled:opacity-60"
            >
              {busyId === invitation.id ? "Joining…" : "Join"}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-sm text-red-300">{error}</p> : null}
    </section>
  );
}
