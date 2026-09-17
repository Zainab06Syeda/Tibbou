import { createContext, useContext, useEffect, useMemo, useState } from "react";

import {
  acceptInvitation as acceptInvitationRequest,
  getInvitations,
  getOrganizations,
} from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";

const OrganizationContext = createContext(null);
const STORAGE_KEY = "tibbou.organizationId";

export function OrganizationProvider({ children }) {
  const { session } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [organization, setOrganization] = useState(null);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(Boolean(session));
  const [error, setError] = useState("");

  async function refresh(preferredId = null) {
    if (!session) return;
    setLoading(true);
    try {
      const rows = await getOrganizations();
      const storedId = localStorage.getItem(STORAGE_KEY);
      const selected =
        rows.find((row) => row.id === preferredId) ||
        rows.find((row) => row.id === storedId) ||
        rows[0] ||
        null;
      setOrganizations(rows);
      setOrganization(selected);
      if (selected) localStorage.setItem(STORAGE_KEY, selected.id);
      setInvitations(selected ? [] : await getInvitations());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session) refresh();
    else {
      setOrganizations([]);
      setOrganization(null);
      setInvitations([]);
      setLoading(false);
    }
  }, [session]);

  function selectOrganization(id) {
    const selected = organizations.find((item) => item.id === id);
    if (selected) {
      setOrganization(selected);
      localStorage.setItem(STORAGE_KEY, selected.id);
    }
  }

  async function acceptInvitation(id) {
    const joined = await acceptInvitationRequest(id);
    await refresh(joined.id);
    return joined;
  }

  const value = useMemo(
    () => ({ organizations, organization, invitations, loading, error, selectOrganization, acceptInvitation }),
    [organizations, organization, invitations, loading, error],
  );
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization must be used inside OrganizationProvider");
  return value;
}
