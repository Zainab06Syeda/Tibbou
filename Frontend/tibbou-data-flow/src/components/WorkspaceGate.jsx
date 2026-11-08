import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { listConnections } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import { setupInProgressKey } from "@/lib/organizations";
import { hasPermission } from "@/lib/permissions";
import Onboarding from "@/pages/Onboarding";

export default function WorkspaceGate() {
  const { organization, loading, error } = useOrganization();
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);
  const [, setSetupEnded] = useState(0);
  const [connectionError, setConnectionError] = useState("");
  const [retry, setRetry] = useState(0);

  const organizationId = organization?.id;
  // Read during render (not from an effect) so the step is already decided
  // on the first render after the new workspace is selected.
  const settingUp = Boolean(organizationId) && sessionStorage.getItem(setupInProgressKey(organizationId)) === "1";

  function endSetup() {
    if (organizationId) sessionStorage.removeItem(setupInProgressKey(organizationId));
    setSetupEnded((count) => count + 1);
  }

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
    setConnectionError("");
    // `enabled` is set by the validate step, org-wide, so every member of
    // the org sees the same answer regardless of browser.
    listConnections()
      .then((rows) => active && setHasConnection(rows.some((row) => row.enabled)))
      .catch((requestError) => active && setConnectionError(requestError.message || "Could not check the connection."))
      .finally(() => active && setConnectionChecked(true));
    return () => {
      active = false;
    };
  }, [organizationId, retry]);

  if (loading || !connectionChecked) {
    return <div className="grid min-h-screen place-items-center">Loading workspace…</div>;
  }
  if (connectionError) {
    return <div className="grid min-h-screen place-items-center"><div><p role="alert">{connectionError}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div></div>;
  }
  if (error) {
    return <div className="grid min-h-screen place-items-center text-red-300">{error}</div>;
  }
  // The Snowflake step is only shown up front to the person creating the
  // workspace, in that tab. Everyone else (other members, other devices,
  // later visits) goes straight in; SetupChecklist offers the connection.
  const canSetUpConnection = hasPermission(organization?.role, "manage_connection");
  if (organization && (hasConnection || !settingUp || !canSetUpConnection)) return <Outlet />;

  return (
    <Onboarding
      key={organizationId || "new-organization"}
      hasOrganization={Boolean(organization)}
      onFinish={() => {
        endSetup();
        setHasConnection(true);
      }}
      onSkip={endSetup}
    />
  );
}
