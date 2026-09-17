import { useEffect, useState } from "react";

import { createInvitation, deleteInvitation, getAdminDashboard } from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { entraSsoEnabled } from "@/lib/authConfig";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const { organization } = useOrganization();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setActionError("");
    setEmail("");
    setRole("viewer");
    getAdminDashboard()
      .then((result) => active && setData(result))
      .catch((requestError) => active && setError(requestError.message || "Failed to load admin data."));
    return () => {
      active = false;
    };
  }, [organization?.id]);

  if (error) {
    return (
      <div className="w-full rounded-2xl border border-red-500/20 bg-red-500/10 p-6">
        <h1 className="text-xl font-semibold">Admin dashboard unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="w-full text-sm text-muted-foreground">Loading admin dashboard…</div>;

  async function invite(event) {
    event.preventDefault();
    setSubmitting(true);
    setActionError("");
    try {
      const invitation = await createInvitation({ email, role });
      setData((current) => ({ ...current, invitations: [...current.invitations, invitation] }));
      setEmail("");
      setRole("viewer");
    } catch (requestError) {
      setActionError(requestError.message || "Failed to create invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(invitation) {
    setActionError("");
    try {
      await deleteInvitation(invitation.id);
      setData((current) => ({
        ...current,
        invitations: current.invitations.filter((item) => item.id !== invitation.id),
      }));
    } catch (requestError) {
      setActionError(requestError.message || "Failed to revoke invitation.");
    }
  }

  const linkedProviders = Array.isArray(user?.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];
  return (
    <div className="w-full space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">Organization administration</p>
        <h1 className="mt-2 text-3xl font-semibold">{data.organization.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Slug: {data.organization.slug}</p>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="font-semibold">Current user</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-muted-foreground">Email</dt><dd>{data.current_user.email || "Not provided"}</dd></div>
            <div><dt className="text-muted-foreground">User ID</dt><dd className="break-all font-mono text-xs">{data.current_user.id}</dd></div>
            <div><dt className="text-muted-foreground">Role</dt><dd className="capitalize">{data.current_user.role}</dd></div>
          </dl>
        </article>
        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="font-semibold">Authentication providers</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4"><dt>Email/password</dt><dd className="text-emerald-300">Available fallback</dd></div>
            <div className="flex justify-between gap-4"><dt>Microsoft Entra</dt><dd>{entraSsoEnabled ? "Enabled" : "Disabled"}</dd></div>
            <div className="flex justify-between gap-4"><dt>Okta</dt><dd>Deferred</dd></div>
            <div className="flex justify-between gap-4"><dt>SAML</dt><dd>Deferred</dd></div>
            <div><dt className="text-muted-foreground">Linked methods</dt><dd>{linkedProviders.length ? linkedProviders.join(", ") : "Unavailable"}</dd></div>
          </dl>
        </article>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="font-semibold">Invite a member</h2>
        <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={invite}>
          <input
            type="email"
            required
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="member@example.com"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
            {data.current_user.role === "owner" ? <option value="admin">Admin</option> : null}
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
          <button disabled={submitting} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60">
            {submitting ? "Inviting…" : "Create invitation"}
          </button>
        </form>
        {actionError ? <p className="mt-3 text-sm text-red-300">{actionError}</p> : null}
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Pending invitations</h2>
          <p className="mt-1 text-xs text-muted-foreground">Invitations authorize membership only after the user accepts.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-border bg-secondary/20"><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Email</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Role</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Expires</th><th className="px-5 py-3 text-right text-xs uppercase text-muted-foreground">Action</th></tr></thead>
            <tbody>
              {data.invitations.length ? data.invitations.map((invitation) => {
                const expired = new Date(invitation.expires_at) <= new Date();
                const canRevoke = data.current_user.role === "owner" || invitation.role !== "admin";
                return (
                  <tr key={invitation.id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 text-sm">{invitation.email}</td>
                    <td className="px-5 py-3 text-sm capitalize">{invitation.role}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{expired ? "Expired" : formatDate(invitation.expires_at)}</td>
                    <td className="px-5 py-3 text-right">
                      {canRevoke ? <button type="button" onClick={() => revoke(invitation)} className="text-sm text-red-300 hover:text-red-200">Revoke</button> : "—"}
                    </td>
                  </tr>
                );
              }) : <tr><td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">No pending invitations.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Organization memberships</h2>
          <p className="mt-1 text-xs text-muted-foreground">Read-only membership records for this organization.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-border bg-secondary/20"><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">User ID</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Role</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Added</th></tr></thead>
            <tbody>
              {data.memberships.map((membership) => (
                <tr key={membership.user_id} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-3 font-mono text-xs">{membership.user_id}</td>
                  <td className="px-5 py-3 text-sm capitalize">{membership.role}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(membership.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
