import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { listConnections } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import { hasPermission } from "@/lib/permissions";
import Onboarding from "@/pages/Onboarding";

// Connecting Snowflake is skippable from the wizard -- once skipped for an
// organization, that choice is remembered here so the user isn't dropped
// back into onboarding on every visit. They can still set up a connection
// any time from /settings/connection; SetupChecklist nudges them there.
function skippedKey(organizationId) {
  return `tibbou.onboardingSkipped.${organizationId}`;
}

export default function WorkspaceGate() {
  const { organization, loading, error } = useOrganization();
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const organizationId = organization?.id;

  useEffect(() => {
    setSkipped(Boolean(organizationId) && localStorage.getItem(skippedKey(organizationId)) === "true");
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId) {
      setHasConnection(false);
      setConnectionChecked(true);
      return () => {
        active = false;
      };
    }
    setConnectionChecked(false);
    // Any non-disabled connection counts: it passed a live test before it
    // could be saved. `enabled` only flips after a first successful sync, so
    // gating on it kept every other member of the org stuck in onboarding.
    listConnections()
      .then((rows) => active && setHasConnection(rows.some((row) => row.status !== "disabled")))
      .catch(() => active && setHasConnection(false))
      .finally(() => active && setConnectionChecked(true));
    return () => {
      active = false;
    };
  }, [organizationId]);

  if (loading || !connectionChecked) {
    return <div className="grid min-h-screen place-items-center">Loading workspace…</div>;
  }
  if (error) {
    return <div className="grid min-h-screen place-items-center text-red-300">{error}</div>;
  }
  // Only people who can set up a connection are asked to; everyone else in
  // an org without one goes straight in (SetupChecklist nudges the admins).
  const canSetUpConnection = hasPermission(organization?.role, "manage_connection");
  if (organization && (hasConnection || skipped || !canSetUpConnection)) return <Outlet />;

  return (
    <Onboarding
      hasOrganization={Boolean(organization)}
      onFinish={() => setHasConnection(true)}
      onSkip={() => {
        if (organizationId) localStorage.setItem(skippedKey(organizationId), "true");
        setSkipped(true);
      }}
    />
  );
}
