import { useCallback, useEffect, useState } from "react";

import {
  approveJoinRequest,
  createInvitation,
  deleteInvitation,
  denyJoinRequest,
  getAdminDashboard,
  listJoinRequests,
  removeMember,
  resendInvitation,
  transferOwnership,
  updateMemberRole,
} from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { entraSsoEnabled } from "@/lib/authConfig";
import { hasPermission } from "@/lib/permissions";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function SettingsMembers() {
  const { user } = useAuth();
  const { organization, refresh: refreshOrganizations } = useOrganization();
  const [data, setData] = useState(null);
  const [joinRequests, setJoinRequests] = useState([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [submitting, setSubmitting] = useState(false);
  const [inviteNotice, setInviteNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const loginUrl = `${window.location.origin}/login`;
  const canManageMembers = hasPermission(organization?.role, "manage_members");
  const isOwner = organization?.role === "owner";

  const load = useCallback(() => {
    setData(null);
    setError("");
    getAdminDashboard()
      .then(setData)
      .catch((requestError) => setError(requestError.message || "Failed to load admin data."));
    if (canManageMembers) {
      listJoinRequests()
        .then(setJoinRequests)
        .catch(() => setJoinRequests([]));
    }
  }, [canManageMembers]);

  useEffect(() => {
    setActionError("");
    setEmail("");
    setRole("viewer");
    setInviteNotice(null);
    load();
  }, [organization?.id, load]);

  if (error) {
    return (
      <div className="w-full rounded-2xl border border-red-500/20 bg-red-500/10 p-6">
        <h1 className="text-xl font-semibold">Members unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="w-full text-sm text-muted-foreground">Loading members…</div>;

  async function invite(event) {
    event.preventDefault();
    setSubmitting(true);
    setActionError("");
    setInviteNotice(null);
    try {
      const invitation = await createInvitation({ email, role });
      setData((current) => ({ ...current, invitations: [...current.invitations, invitation] }));
      setInviteNotice({ email: invitation.email, sent: invitation.email_sent });
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

  async function resend(invitation) {
    setActionError("");
    setBusyId(invitation.id);
    try {
      const updated = await resendInvitation(invitation.id);
      setInviteNotice({ email: updated.email, sent: updated.email_sent });
    } catch (requestError) {
      setActionError(requestError.message || "Failed to resend invitation.");
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(membership, newRole) {
    setActionError("");
    setBusyId(membership.user_id);
    try {
      const updated = await updateMemberRole(membership.user_id, newRole);
      setData((current) => ({
        ...current,
        memberships: current.memberships.map((item) =>
          item.user_id === membership.user_id ? { ...item, role: updated.role } : item
        ),
      }));
      if (membership.user_id === user?.id) await refreshOrganizations();
    } catch (requestError) {
      setActionError(requestError.message || "Failed to change role.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(membership) {
    setActionError("");
    setBusyId(membership.user_id);
    try {
      await removeMember(membership.user_id);
      setData((current) => ({
        ...current,
        memberships: current.memberships.filter((item) => item.user_id !== membership.user_id),
      }));
    } catch (requestError) {
      setActionError(requestError.message || "Failed to remove member.");
    } finally {
      setBusyId(null);
    }
  }

  async function makeOwner(membership) {
    setActionError("");
    setBusyId(membership.user_id);
    try {
      const updated = await transferOwnership(membership.user_id);
      setData((current) => ({
        ...current,
        memberships: current.memberships.map((item) =>
          item.user_id === membership.user_id ? { ...item, role: updated.role } : item
        ),
      }));
    } catch (requestError) {
      setActionError(requestError.message || "Failed to transfer ownership.");
    } finally {
      setBusyId(null);
    }
  }

  async function resolveJoinRequest(request, approve) {
    setActionError("");
    setBusyId(request.id);
    try {
      if (approve) await approveJoinRequest(request.id);
      else await denyJoinRequest(request.id);
      setJoinRequests((current) => current.filter((item) => item.id !== request.id));
      if (approve) load();
    } catch (requestError) {
      setActionError(requestError.message || "Failed to resolve join request.");
    } finally {
      setBusyId(null);
    }
  }

  const linkedProviders = Array.isArray(user?.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];

  return (
    <div className="w-full space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold">{data.organization.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Slug: {data.organization.slug}</p>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-border bg-card p-5">
          <h2 className="font-semibold">Current user</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-muted-foreground">Email</dt><dd>{data.current_user.email || "Not provided"}</dd></div>
            <div><dt className="text-muted-foreground">User ID</dt><dd className="break-all font-mono text-xs">{data.current_user.id}</dd></div>
            <div><dt className="text-muted-foreground">Role</dt><dd className="capitalize">{organization?.role}</dd></div>
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

      {canManageMembers ? (
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
              {isOwner ? <option value="admin">Admin</option> : null}
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
            <button disabled={submitting} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? "Inviting…" : "Create invitation"}
            </button>
          </form>
          {actionError ? <p className="mt-3 text-sm text-red-300">{actionError}</p> : null}
          {inviteNotice ? (
            inviteNotice.sent ? (
              <p className="mt-3 text-sm text-emerald-400">Invitation emailed to {inviteNotice.email}.</p>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Email delivery isn't configured yet, so {inviteNotice.email} wasn't emailed automatically —
                share this link with them instead: <span className="font-mono text-foreground">{loginUrl}</span>
              </p>
            )
          ) : null}
        </section>
      ) : null}

      {joinRequests.length ? (
        <section className="rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-semibold">Requests to join</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              These users share your organization's email domain and asked to join.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Email</th>
                  <th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Requested</th>
                  <th className="px-5 py-3 text-right text-xs uppercase text-muted-foreground">Action</th>
                </tr>
              </thead>
              <tbody>
                {joinRequests.map((request) => (
                  <tr key={request.id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 text-sm">{request.email}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(request.created_at)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          disabled={busyId === request.id}
                          onClick={() => resolveJoinRequest(request, true)}
                          className="text-sm text-emerald-400 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busyId === request.id}
                          onClick={() => resolveJoinRequest(request, false)}
                          className="text-sm text-red-300 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

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
                const canRevoke = isOwner || invitation.role !== "admin";
                return (
                  <tr key={invitation.id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 text-sm">{invitation.email}</td>
                    <td className="px-5 py-3 text-sm capitalize">{invitation.role}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{expired ? "Expired" : formatDate(invitation.expires_at)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        {!expired ? (
                          <button
                            type="button"
                            disabled={busyId === invitation.id}
                            onClick={() => resend(invitation)}
                            className="text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyId === invitation.id ? "Resending…" : "Resend"}
                          </button>
                        ) : null}
                        {canRevoke ? <button type="button" onClick={() => revoke(invitation)} className="text-sm text-red-300 hover:text-red-200">Revoke</button> : null}
                      </div>
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
          <p className="mt-1 text-xs text-muted-foreground">
            {canManageMembers ? "Change a member's role, add another owner, or remove them." : "Read-only membership records for this organization."}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-border bg-secondary/20"><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Member</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Role</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Added</th>{canManageMembers ? <th className="px-5 py-3 text-right text-xs uppercase text-muted-foreground">Action</th> : null}</tr></thead>
            <tbody>
              {data.memberships.map((membership) => {
                const canModify =
                  canManageMembers && membership.user_id !== user?.id && (membership.role !== "owner" || isOwner);
                const busy = busyId === membership.user_id;
                return (
                  <tr key={membership.user_id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 text-sm">
                      <span className="font-medium">
                        {membership.display_name || membership.email || "Unknown member"}
                      </span>
                      {membership.user_id === user?.id ? (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                      {membership.display_name && membership.email ? (
                        <span className="block text-xs text-muted-foreground">{membership.email}</span>
                      ) : null}
                      {!membership.display_name && !membership.email ? (
                        <span className="block font-mono text-xs text-muted-foreground">{membership.user_id}</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-sm capitalize">
                      {canModify && membership.role !== "owner" ? (
                        <select
                          value={membership.role}
                          disabled={busy}
                          onChange={(event) => changeRole(membership, event.target.value)}
                          className="rounded-md border border-border bg-background px-2 py-1 text-sm capitalize"
                        >
                          {isOwner ? <option value="admin">Admin</option> : null}
                          <option value="operator">Operator</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      ) : (
                        membership.role
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{formatDate(membership.created_at)}</td>
                    {canManageMembers ? (
                      <td className="px-5 py-3 text-right">
                        <div className="flex justify-end gap-3">
                          {canModify && membership.role !== "owner" ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => makeOwner(membership)}
                              className="text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Make owner
                            </button>
                          ) : null}
                          {canModify ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => remove(membership)}
                              className="text-sm text-red-300 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
