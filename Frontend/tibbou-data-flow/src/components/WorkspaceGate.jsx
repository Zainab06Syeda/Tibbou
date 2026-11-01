import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";

import { listConnections } from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
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
  const { organization, loading, error, refresh } = useOrganization();
  const { signOut } = useAuth();
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [retry, setRetry] = useState(0);
  const [recoveryAction, setRecoveryAction] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const recoveryPending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function recover(action) {
    if (recoveryPending.current) return;
    recoveryPending.current = true;
    setRecoveryAction(action);
    setRecoveryError("");
    try {
      if (action === "retry") {
        await refresh();
        if (mounted.current) {
          setConnectionChecked(false);
          setConnectionError("");
          setRetry((value) => value + 1);
        }
      } else {
        const result = await signOut();
        if (result?.error) throw result.error;
      }
    } catch {
      if (mounted.current) setRecoveryError(action === "retry"
        ? "Unable to reload your workspace. Try again."
        : "Unable to sign out. Try again.");
    } finally {
      recoveryPending.current = false;
      if (mounted.current) setRecoveryAction("");
    }
  }

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
    setConnectionError("");
    // `enabled` is set by the validate step, org-wide, so every member of
    // the org sees the same answer regardless of browser.
    listConnections()
      .then((rows) => active && setHasConnection(rows.some((row) => row.enabled)))
      .catch(() => active && setConnectionError("Unable to check your workspace connection. Try again or sign out."))
      .finally(() => active && setConnectionChecked(true));
    return () => {
      active = false;
    };
  }, [organizationId, retry]);

  if (loading && !recoveryAction) {
    return <div className="grid min-h-screen place-items-center" role="status">Loading workspace…</div>;
  }
  if (error || connectionError) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <section className="w-full max-w-md space-y-4" aria-labelledby="workspace-error-title" aria-busy={Boolean(recoveryAction)}>
          <h1 id="workspace-error-title" className="text-xl font-semibold">Unable to load your workspace</h1>
          <p className="text-red-300" role="alert">{error || connectionError}</p>
          <div className="flex flex-wrap gap-3" aria-label="Workspace recovery">
            <button type="button" disabled={Boolean(recoveryAction)} onClick={() => recover("retry")}
              className="min-h-11 cursor-pointer rounded-md border border-border px-4 py-2 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-60">Retry</button>
            <button type="button" disabled={Boolean(recoveryAction)} onClick={() => recover("signOut")}
              className="min-h-11 cursor-pointer rounded-md border border-border px-4 py-2 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-60">Sign out</button>
          </div>
          {recoveryAction ? <p role="status">{recoveryAction === "retry" ? "Retrying…" : "Signing out…"}</p> : null}
          {recoveryError ? <p className="text-red-300" role="alert">{recoveryError}</p> : null}
        </section>
      </main>
    );
  }
  if (!connectionChecked) {
    return <div className="grid min-h-screen place-items-center" role="status">Loading workspace…</div>;
  }
  // Only people who can set up a connection are asked to; everyone else in
  // an org without one goes straight in (SetupChecklist nudges the admins).
  const canSetUpConnection = hasPermission(organization?.role, "manage_connection");
  if (organization && (hasConnection || skipped || !canSetUpConnection)) return <Outlet />;

  return (
    <Onboarding
      key={organizationId || "new-organization"}
      hasOrganization={Boolean(organization)}
      onFinish={() => setHasConnection(true)}
      onSkip={() => {
        if (organizationId) localStorage.setItem(skippedKey(organizationId), "true");
        setSkipped(true);
      }}
    />
  );
}
