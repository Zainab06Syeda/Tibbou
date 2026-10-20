import { useCallback, useEffect, useRef, useState } from "react";

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
  const { organization } = useOrganization();
  if (!hasPermission(organization?.role, "manage_members")) return <p role="alert">You do not have permission to manage this workspace's settings.</p>;
  return <MembersWorkspace key={organization.id} />;
}

function MembersWorkspace() {
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
  const [confirmation, setConfirmation] = useState(null);
  const loadVersion = useRef(0);
  const loginUrl = `${window.location.origin}/login`;
  const canManageMembers = hasPermission(organization?.role, "manage_members");
  const isOwner = organization?.role === "owner";

  const load = useCallback(() => {
    const version = ++loadVersion.current;
    setData(null);
    setError("");
    Promise.all([getAdminDashboard(), listJoinRequests()])
      .then(([dashboard, requests]) => {
        if (version !== loadVersion.current) return;
        setData(dashboard);
        setJoinRequests(requests);
      })
      .catch((requestError) => version === loadVersion.current && setError(requestError.message || "Could not load member settings."));
  }, []);

  useEffect(() => {
    setActionError("");
    setEmail("");
    setRole("viewer");
    setInviteNotice(null);
    load();
    return () => { loadVersion.current += 1; };
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
          item.user_id === membership.user_id ? updated : item
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
      if (membership.user_id === user?.id) await refreshOrganizations();
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
          item.user_id === membership.user_id ? updated : item
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

      {confirmation ? <MemberConfirmation action={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); confirmation.run(); }} /> : null}

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
          <form noValidate className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={invite}>
            <input
              aria-label="Invitation email"
              type="email"
              required
              maxLength={320}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="member@example.com"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <select aria-label="Invitation role" value={role} onChange={(event) => setRole(event.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              {isOwner ? <option value="admin">Admin</option> : null}
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
            <button disabled={submitting} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? "Inviting…" : "Create invitation"}
            </button>
          </form>
          {actionError ? <p role="alert" className="mt-3 text-sm text-red-300">{actionError}</p> : null}
          {inviteNotice ? (
            inviteNotice.sent ? (
              <p className="mt-3 text-sm text-emerald-400">Invitation emailed to {inviteNotice.email}.</p>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                The invitation was saved, but no email was delivered to {inviteNotice.email} —
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
                          onClick={() => setConfirmation({ label: "Approve request", description: `Grant viewer access to ${request.email}?`, run: () => resolveJoinRequest(request, true) })}
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
                        {canRevoke ? <button type="button" onClick={() => setConfirmation({ label: "Revoke invitation", description: `Revoke the invitation for ${invitation.email}?`, run: () => revoke(invitation) })} className="text-sm text-red-300 hover:text-red-200">Revoke</button> : null}
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
            {canManageMembers ? "Change a member's role, transfer ownership, or remove them." : "Read-only membership records for this organization."}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-border bg-secondary/20"><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">User ID</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Role</th><th className="px-5 py-3 text-left text-xs uppercase text-muted-foreground">Added</th>{canManageMembers ? <th className="px-5 py-3 text-right text-xs uppercase text-muted-foreground">Action</th> : null}</tr></thead>
            <tbody>
              {data.memberships.map((membership) => {
                const canModify = canManageMembers && (membership.role !== "owner" || isOwner);
                const busy = busyId === membership.user_id;
                return (
                  <tr key={membership.user_id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3 font-mono text-xs">{membership.user_id}</td>
                    <td className="px-5 py-3 text-sm capitalize">
                      {canModify && membership.role !== "owner" ? (
                        <select
                          aria-label={`Role for ${membership.user_id}`}
                          value={membership.role}
                          disabled={busy}
                          onChange={(event) => { const newRole = event.target.value; setConfirmation({ label: "Change role", description: `Change ${membership.user_id} to ${newRole}?`, run: () => changeRole(membership, newRole) }); }}
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
                          {canModify && hasPermission(organization?.role, "transfer_ownership") && membership.role !== "owner" ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmation({ label: "Make owner", description: `Grant owner access to ${membership.user_id}? Existing owners keep their role.`, run: () => makeOwner(membership) })}
                              className="text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Make owner
                            </button>
                          ) : null}
                          {canModify ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmation({ label: "Remove member", description: `Remove ${membership.user_id} from this workspace?`, run: () => remove(membership) })}
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

function MemberConfirmation({ action, onCancel, onConfirm }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} onCancel={onCancel} aria-labelledby="member-action-title"
    className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-foreground backdrop:bg-black/60">
    <h2 id="member-action-title" className="text-lg font-semibold">{action.label}</h2>
    <p className="mt-3 text-sm">{action.description}</p>
    <div className="mt-5 flex justify-end gap-3">
      <button type="button" autoFocus onClick={onCancel} className="rounded-md border border-border px-4 py-2">Cancel</button>
      <button type="button" onClick={onConfirm} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">{action.label}</button>
    </div>
  </dialog>;
}
