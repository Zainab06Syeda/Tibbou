import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { listConnections } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import Onboarding from "@/pages/Onboarding";

export default function WorkspaceGate() {
  const { organization, loading, error } = useOrganization();
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);

  const organizationId = organization?.id;

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
    listConnections()
      .then((rows) => active && setHasConnection(rows.some((row) => row.enabled)))
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
  if (organization && hasConnection) return <Outlet />;

  return (
    <Onboarding
      hasOrganization={Boolean(organization)}
      onFinish={() => setHasConnection(true)}
    />
  );
}
