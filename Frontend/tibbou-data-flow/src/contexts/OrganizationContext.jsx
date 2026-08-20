import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { createOrganization, getOrganizations } from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";

const OrganizationContext = createContext(null);
const STORAGE_KEY = "tibbou.organizationId";

export function OrganizationProvider({ children }) {
  const { session } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [organization, setOrganization] = useState(null);
  const [loading, setLoading] = useState(Boolean(session));
  const [error, setError] = useState("");

  async function refresh() {
    if (!session) return;
    setLoading(true);
    try {
      const rows = await getOrganizations();
      const storedId = localStorage.getItem(STORAGE_KEY);
      const selected = rows.find((row) => row.id === storedId) || rows[0] || null;
      setOrganizations(rows);
      setOrganization(selected);
      if (selected) localStorage.setItem(STORAGE_KEY, selected.id);
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

  async function createWorkspace(payload) {
    const created = await createOrganization(payload);
    await refresh();
    selectOrganization(created.id);
    return created;
  }

  const value = useMemo(
    () => ({ organizations, organization, loading, error, selectOrganization, createWorkspace }),
    [organizations, organization, loading, error],
  );
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization must be used inside OrganizationProvider");
  return value;
}
