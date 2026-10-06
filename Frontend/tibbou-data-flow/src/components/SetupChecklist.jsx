import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Link } from "react-router-dom";

import { getAdminDashboard, getLatestDbtManifestIngestionSummary, listConnections } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import { hasPermission } from "@/lib/permissions";

// Connecting Snowflake used to be guaranteed done by the time this renders
// (WorkspaceGate required an enabled connection for any authenticated
// route), but the wizard's connection step is now skippable, so it's
// checked and surfaced here like the other two skippable steps.
function dismissedKey(organizationId) {
  return `tibbou.setupChecklistDismissed.${organizationId}`;
}

export default function SetupChecklist() {
  const { organization } = useOrganization();
  return <ChecklistWorkspace key={organization?.id || "none"} />;
}

function ChecklistWorkspace() {
  const { organization } = useOrganization();
  const canSeeChecklist = hasPermission(organization?.role, "manage_members");
  const [dismissed, setDismissed] = useState(true);
  const [connectionEnabled, setConnectionEnabled] = useState(null);
  const [manifestUploaded, setManifestUploaded] = useState(null);
  const [teamInvited, setTeamInvited] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!organization?.id) return;
    setDismissed(localStorage.getItem(dismissedKey(organization.id)) === "true");
  }, [organization?.id]);

  useEffect(() => {
    if (!canSeeChecklist || !organization?.id) return;
    let active = true;
    listConnections()
      .then((rows) => active && setConnectionEnabled(rows.some((row) => row.enabled)))
      .catch((requestError) => active && setError(requestError.message || "Could not check setup."));
    getLatestDbtManifestIngestionSummary()
      .then((run) => active && setManifestUploaded(run.status === "success"))
      .catch((requestError) => { if (active) { if (requestError.status === 404) setManifestUploaded(false); else setError(requestError.message || "Could not check dbt setup."); } });
    getAdminDashboard()
      .then((data) => active && setTeamInvited(data.invitations.length > 0 || data.memberships.length > 1))
      .catch((requestError) => active && setError(requestError.message || "Could not check invitations."));
    return () => { active = false; };
  }, [canSeeChecklist, organization?.id]);

  function dismiss() {
    if (organization?.id) localStorage.setItem(dismissedKey(organization.id), "true");
    setDismissed(true);
  }

  if (!canSeeChecklist || dismissed) return null;
  if (error) return <p role="alert" className="text-sm text-red-300">{error}</p>;
  if (connectionEnabled === null || manifestUploaded === null || teamInvited === null) return null;
  if (connectionEnabled && manifestUploaded && teamInvited) return null;

  const items = [
    {
      done: connectionEnabled,
      label: "Connect Snowflake",
      description: "So Tibbou can read query and lineage metadata.",
      to: "/settings/connection",
    },
    {
      done: manifestUploaded,
      label: "Upload your dbt manifest",
      description: "So Tibbou can build lineage and attribute cost to datasets.",
      to: "/lineage",
    },
    {
      done: teamInvited,
      label: "Invite your team",
      description: "Add colleagues so they can see lineage and cost without sharing your login.",
      to: "/settings/members",
    },
  ];

  return (
    <section className="relative rounded-2xl border border-border bg-card p-5">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss setup checklist"
        className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-sm font-semibold text-foreground">Finish setting up Tibbou</h2>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-secondary/20 p-4">
            <div>
              <p className={`text-sm font-medium ${item.done ? "text-muted-foreground line-through" : "text-foreground"}`}>
                {item.label}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
            </div>
            {!item.done ? (
              <Link to={item.to} className="whitespace-nowrap text-sm text-primary hover:underline">
                Do this
              </Link>
            ) : (
              <span className="whitespace-nowrap text-xs text-emerald-400">Done</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
