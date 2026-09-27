import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Link } from "react-router-dom";

import { getAdminDashboard, getLatestDbtManifestIngestionSummary } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import { hasPermission } from "@/lib/permissions";

// Connecting Snowflake isn't a checklist item here: WorkspaceGate already
// requires an enabled connection before any authenticated route (including
// this dashboard) is reachable at all, so by the time this renders that step
// is already done. Only the wizard's two skippable steps -- dbt manifest and
// inviting the team -- are worth surfacing as recoverable here.
function dismissedKey(organizationId) {
  return `tibbou.setupChecklistDismissed.${organizationId}`;
}

export default function SetupChecklist() {
  const { organization } = useOrganization();
  const canSeeChecklist = hasPermission(organization?.role, "manage_members");
  const [dismissed, setDismissed] = useState(true);
  const [manifestUploaded, setManifestUploaded] = useState(null);
  const [teamInvited, setTeamInvited] = useState(null);

  useEffect(() => {
    if (!organization?.id) return;
    setDismissed(localStorage.getItem(dismissedKey(organization.id)) === "true");
  }, [organization?.id]);

  useEffect(() => {
    if (!canSeeChecklist || !organization?.id) return;
    getLatestDbtManifestIngestionSummary()
      .then(() => setManifestUploaded(true))
      .catch(() => setManifestUploaded(false));
    getAdminDashboard()
      .then((data) => setTeamInvited(data.invitations.length > 0 || data.memberships.length > 1))
      .catch(() => setTeamInvited(false));
  }, [canSeeChecklist, organization?.id]);

  function dismiss() {
    if (organization?.id) localStorage.setItem(dismissedKey(organization.id), "true");
    setDismissed(true);
  }

  if (!canSeeChecklist || dismissed) return null;
  if (manifestUploaded === null || teamInvited === null) return null;
  if (manifestUploaded && teamInvited) return null;

  const items = [
    {
      done: manifestUploaded,
      label: "Upload your dbt manifest",
      description: "So Tibbou can build lineage and attribute cost to datasets.",
      to: "/datasets",
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
