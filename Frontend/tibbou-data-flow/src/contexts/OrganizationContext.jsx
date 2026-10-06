import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

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
  const refreshVersion = useRef(0);

  async function refresh(preferredId = null) {
    if (!session) return;
    const version = ++refreshVersion.current;
    setLoading(true);
    try {
      const rows = await getOrganizations();
      const storedId = localStorage.getItem(STORAGE_KEY);
      const selected =
        rows.find((row) => row.id === preferredId) ||
        rows.find((row) => row.id === storedId) ||
        rows[0] ||
        null;
      const pending = selected ? [] : await getInvitations();
      if (version !== refreshVersion.current) return;
      setOrganizations(rows);
      setOrganization(selected);
      if (selected) localStorage.setItem(STORAGE_KEY, selected.id);
      else localStorage.removeItem(STORAGE_KEY);
      setInvitations(pending);
      setError("");
    } catch (requestError) {
      if (version === refreshVersion.current) setError(requestError.message);
      throw requestError;
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (session) refresh().catch(() => {});
    else {
      refreshVersion.current += 1;
      localStorage.removeItem(STORAGE_KEY);
      setError("");
      setOrganizations([]);
      setOrganization(null);
      setInvitations([]);
      setLoading(false);
    }
    return () => { refreshVersion.current += 1; };
  }, [session]);

  function selectOrganization(id) {
    const selected = organizations.find((item) => item.id === id);
    if (selected) {
      refreshVersion.current += 1;
      setLoading(false);
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
    () => ({ organizations, organization, invitations, loading, error, refresh, selectOrganization, acceptInvitation }),
    [organizations, organization, invitations, loading, error],
  );
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization must be used inside OrganizationProvider");
  return value;
}
