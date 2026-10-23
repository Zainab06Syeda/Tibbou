import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, Mail, Search, ShieldCheck, UserPlus, Users, X } from "lucide-react";

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
import CountUp from "@/components/CountUp";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { entraSsoEnabled } from "@/lib/authConfig";
import {
  CAPABILITY_LABELS,
  ROLES,
  ROLE_INFO,
  avatarIndex,
  filterMembers,
  initials,
  parseEmails,
  relativeTime,
  sortMembers,
} from "@/lib/members";
import { allowedRolesFor, hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const ROLE_STYLES = {
  owner: "border-accent/40 bg-accent/10 text-accent",
  admin: "border-primary/40 bg-primary/10 text-primary",
  operator: "border-[hsl(var(--chart-4))]/40 bg-[hsl(var(--chart-4))]/10 text-[hsl(var(--chart-4))]",
  viewer: "border-border bg-secondary/30 text-muted-foreground",
};

const AVATAR_STYLES = [
  "bg-primary/20 text-primary",
  "bg-[hsl(var(--chart-4))]/20 text-[hsl(var(--chart-4))]",
  "bg-accent/20 text-accent",
  "bg-[hsl(var(--chart-5))]/20 text-[hsl(var(--chart-5))]",
  "bg-sky-400/20 text-sky-300",
];

const PROVIDER_LABELS = { email: "Email & password", azure: "Microsoft", okta: "Okta" };

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function RoleBadge({ role }) {
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium", ROLE_STYLES[role] || ROLE_STYLES.viewer)}>
      {ROLE_INFO[role]?.label || role}
    </span>
  );
}

function Avatar({ id, name, email, icon: Icon }) {
  return (
    <span
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold",
        Icon ? "bg-secondary/40 text-muted-foreground" : AVATAR_STYLES[avatarIndex(id || email)]
      )}
      aria-hidden="true"
    >
      {Icon ? <Icon className="h-4 w-4" /> : initials(name, email)}
    </span>
  );
}

function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard can be unavailable; the text is still selectable.
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

// Inline "Are you sure?" shown in place of a row's buttons.
function Confirm({ message, confirmLabel, tone = "danger", busy, onConfirm, onCancel }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs duration-200 animate-in fade-in slide-in-from-right-2">
      <span className="text-muted-foreground">{message}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className={cn(
          "rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-60",
          tone === "danger" ? "bg-red-500/90 text-white hover:bg-red-500" : "bg-primary text-primary-foreground hover:opacity-90"
        )}
      >
        {busy ? "Working…" : confirmLabel}
      </button>
      <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground">
        Cancel
      </button>
    </div>
  );
}

function Section({ title, description, actions, children, className = "" }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export default function SettingsMembers() {
  const { user } = useAuth();
  const { organization, refresh: refreshOrganizations } = useOrganization();
  const [data, setData] = useState(null);
  const [joinRequests, setJoinRequests] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [emailText, setEmailText] = useState("");
  const [role, setRole] = useState("viewer");
  const [submitting, setSubmitting] = useState(false);
  const [shareLink, setShareLink] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const loginUrl = `${window.location.origin}/login`;
  const canManageMembers = hasPermission(organization?.role, "manage_members");
  const isOwner = organization?.role === "owner";

  const load = useCallback(() => {
    setData(null);
    setError("");
    // The server only lets owners and admins read this page's data.
    if (!canManageMembers) return;
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
    setNotice(null);
    setEmailText("");
    setRole("viewer");
    setShareLink(null);
    setConfirming(null);
    load();
  }, [organization?.id, load]);

  // Success messages clear themselves; errors stay until the next action.
  useEffect(() => {
    if (notice?.tone !== "success") return undefined;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const members = useMemo(() => sortMembers(data?.memberships || []), [data]);
  const visibleMembers = useMemo(() => filterMembers(members, { search, role: roleFilter }), [members, search, roleFilter]);
  const roleCounts = useMemo(
    () => Object.fromEntries(ROLES.map((item) => [item, members.filter((member) => member.role === item).length])),
    [members]
  );

  if (organization && !canManageMembers) {
    return (
      <div className="mx-auto mt-10 w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-primary" />
        <h1 className="mt-4 text-xl font-semibold">Members are managed by owners and admins</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;re a {ROLE_INFO[organization.role]?.label || organization.role} in {organization.name}.{" "}
          {ROLE_INFO[organization.role]?.description} Ask an owner or admin if someone needs to be added or their role changed.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full rounded-2xl border border-red-500/20 bg-red-500/10 p-6">
        <h1 className="text-xl font-semibold">Members unavailable</h1>
        <p className="mt-2 text-sm text-red-200">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
      </div>
    );
  }

  function fail(requestError, fallback) {
    setNotice({ tone: "error", text: requestError.message || fallback });
  }

  async function invite(event) {
    event.preventDefault();
    const { valid, invalid } = parseEmails(emailText);
    if (!valid.length) {
      setNotice({ tone: "error", text: "Enter at least one valid email address." });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    setShareLink(null);
    const invited = [];
    const failed = invalid.map((value) => `${value} (not a valid email)`);
    let anyNotEmailed = false;
    for (const email of valid) {
      try {
        const invitation = await createInvitation({ email, role });
        invited.push(invitation);
        if (!invitation.email_sent) anyNotEmailed = true;
      } catch (requestError) {
        failed.push(`${email} (${requestError.message || "couldn't be invited"})`);
      }
    }
    if (invited.length) {
      setData((current) => ({ ...current, invitations: [...current.invitations, ...invited] }));
    }
    setEmailText(failed.length ? failed.map((item) => item.split(" (")[0]).join(", ") : "");
    if (anyNotEmailed) setShareLink(invited.filter((item) => !item.email_sent).map((item) => item.email));
    const parts = [];
    if (invited.length) parts.push(`Invited ${invited.length === 1 ? invited[0].email : `${invited.length} people`} as ${ROLE_INFO[role].label}.`);
    if (failed.length) parts.push(`Not invited: ${failed.join("; ")}.`);
    setNotice({ tone: failed.length ? "error" : "success", text: parts.join(" ") });
    setSubmitting(false);
  }

  async function run(id, action) {
    setBusyId(id);
    setNotice(null);
    try {
      await action();
      setConfirming(null);
    } finally {
      setBusyId(null);
    }
  }

  const revoke = (invitation) =>
    run(invitation.id, async () => {
      try {
        await deleteInvitation(invitation.id);
        setData((current) => ({ ...current, invitations: current.invitations.filter((item) => item.id !== invitation.id) }));
        setNotice({ tone: "success", text: `Revoked the invitation for ${invitation.email}.` });
      } catch (requestError) {
        fail(requestError, "Failed to revoke invitation.");
      }
    });

  const resend = (invitation) =>
    run(invitation.id, async () => {
      try {
        const updated = await resendInvitation(invitation.id);
        if (updated.email_sent) setNotice({ tone: "success", text: `Invitation emailed to ${updated.email} again.` });
        else setShareLink([updated.email]);
      } catch (requestError) {
        fail(requestError, "Failed to resend invitation.");
      }
    });

  const changeRole = (membership, newRole) =>
    run(membership.user_id, async () => {
      try {
        const updated = await updateMemberRole(membership.user_id, newRole);
        setData((current) => ({
          ...current,
          memberships: current.memberships.map((item) =>
            item.user_id === membership.user_id ? { ...item, role: updated.role } : item
          ),
        }));
        setNotice({ tone: "success", text: `${membership.display_name || membership.email} is now ${ROLE_INFO[updated.role]?.label || updated.role}.` });
        if (membership.user_id === user?.id) await refreshOrganizations();
      } catch (requestError) {
        fail(requestError, "Failed to change role.");
      }
    });

  const remove = (membership) =>
    run(membership.user_id, async () => {
      try {
        await removeMember(membership.user_id);
        setData((current) => ({
          ...current,
          memberships: current.memberships.filter((item) => item.user_id !== membership.user_id),
        }));
        setNotice({ tone: "success", text: `Removed ${membership.display_name || membership.email} from the workspace.` });
      } catch (requestError) {
        fail(requestError, "Failed to remove member.");
      }
    });

  const makeOwner = (membership) =>
    run(membership.user_id, async () => {
      try {
        const updated = await transferOwnership(membership.user_id);
        setData((current) => ({
          ...current,
          memberships: current.memberships.map((item) =>
            item.user_id === membership.user_id ? { ...item, role: updated.role } : item
          ),
        }));
        setNotice({ tone: "success", text: `${membership.display_name || membership.email} is now an owner.` });
      } catch (requestError) {
        fail(requestError, "Failed to add owner.");
      }
    });

  const resolveJoinRequest = (request, approve) =>
    run(request.id, async () => {
      try {
        if (approve) await approveJoinRequest(request.id);
        else await denyJoinRequest(request.id);
        setJoinRequests((current) => current.filter((item) => item.id !== request.id));
        setNotice({ tone: "success", text: approve ? `${request.email} joined the workspace.` : `Denied ${request.email}'s request.` });
        if (approve) load();
      } catch (requestError) {
        fail(requestError, "Failed to resolve join request.");
      }
    });

  const linkedProviders = Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers : [];
  const me = members.find((member) => member.user_id === user?.id);
  const pendingCount = data.invitations.filter((item) => new Date(item.expires_at) > new Date()).length;
  const parsed = parseEmails(emailText);
  const inviteRoles = isOwner ? ["admin", "operator", "viewer"] : ["operator", "viewer"];

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/80">Settings · Members</p>
          <h1 className="mt-2 text-3xl font-semibold">{data.organization.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage who can see this workspace and what they can do.
          </p>
        </div>
        <div className="motion-stagger flex gap-3">
          {[
            { label: "Members", value: members.length },
            { label: "Pending invites", value: pendingCount },
            ...(canManageMembers ? [{ label: "Join requests", value: joinRequests.length }] : []),
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl border border-border bg-card px-4 py-2.5 text-center">
              <p className="text-xl font-semibold">
                <CountUp value={stat.value} />
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {notice ? (
        <div
          key={notice.text}
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm duration-300 animate-in fade-in slide-in-from-top-2",
            notice.tone === "error" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          )}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <section className={cn("grid grid-cols-1 gap-4", canManageMembers && "lg:grid-cols-[minmax(0,1fr),minmax(0,1.5fr)]")}>
        <article className="min-w-0 rounded-2xl border border-border bg-card p-5">
          <h2 className="font-semibold">Your account</h2>
          <div className="mt-4 flex items-center gap-3">
            <Avatar id={user?.id} name={me?.display_name} email={data.current_user.email} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{me?.display_name || data.current_user.email || "You"}</p>
              {me?.display_name ? <p className="truncate text-xs text-muted-foreground">{data.current_user.email}</p> : null}
            </div>
            <span className="ml-auto shrink-0">
              <RoleBadge role={organization?.role} />
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{ROLE_INFO[organization?.role]?.description}</p>
          <dl className="mt-4 space-y-3 border-t border-border/60 pt-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground">You sign in with</dt>
              <dd className="flex flex-wrap gap-1.5">
                {linkedProviders.length ? (
                  linkedProviders.map((provider) => (
                    <span key={provider} className="rounded-full border border-border bg-secondary/30 px-2 py-0.5 text-xs">
                      {PROVIDER_LABELS[provider] || provider}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">Unknown</span>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground">Sign-in options here</dt>
              <dd className="text-xs">
                Email & password{entraSsoEnabled ? " · Microsoft" : ""}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground">User ID</dt>
              <dd className="flex items-center gap-2">
                <span className="max-w-[160px] truncate font-mono text-[11px] text-muted-foreground" title={data.current_user.id}>
                  {data.current_user.id}
                </span>
                <CopyButton text={data.current_user.id} />
              </dd>
            </div>
          </dl>
        </article>

        {canManageMembers ? (
          <article className="min-w-0 rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-primary" />
              <h2 className="font-semibold">Invite people</h2>
            </div>
            <form className="mt-4 space-y-3" onSubmit={invite}>
              <textarea
                rows={2}
                maxLength={4000}
                value={emailText}
                onChange={(event) => setEmailText(event.target.value)}
                placeholder="name@company.com, another@company.com"
                aria-label="Email addresses to invite"
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
              />
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr),auto]">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Role for new members">
                  {inviteRoles.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={role === option}
                      onClick={() => setRole(option)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        role === option ? ROLE_STYLES[option] : "border-border text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {ROLE_INFO[option].label}
                    </button>
                  ))}
                </div>
                <button
                  disabled={submitting || !parsed.valid.length}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Mail className="h-4 w-4" />
                  {submitting
                    ? "Inviting…"
                    : parsed.valid.length > 1
                      ? `Send ${parsed.valid.length} invitations`
                      : "Send invitation"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground">{ROLE_INFO[role].label}:</span> {ROLE_INFO[role].description} Separate
                several emails with commas.
              </p>
            </form>
            {shareLink ? (
              <div className="mt-4 rounded-lg border border-border bg-secondary/20 p-3 text-xs duration-300 animate-in fade-in">
                <p className="text-muted-foreground">
                  Email delivery isn&apos;t set up yet, so {shareLink.join(", ")} {shareLink.length > 1 ? "weren't" : "wasn't"} emailed.
                  Send them this sign-in link; the invitation will be waiting when they sign in with that address.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="truncate font-mono text-foreground">{loginUrl}</span>
                  <CopyButton text={loginUrl} label="Copy link" />
                </div>
              </div>
            ) : null}
          </article>
        ) : null}
      </section>

      {joinRequests.length ? (
        <Section title="Requests to join" description="These people share your organization's email domain and asked to join.">
          <ul className="motion-stagger divide-y divide-border/60">
            {joinRequests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar id={request.id} email={request.email} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{request.email}</p>
                  <p className="text-xs text-muted-foreground" title={formatDate(request.created_at)}>
                    Asked {relativeTime(request.created_at)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === request.id}
                    onClick={() => resolveJoinRequest(request, true)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === request.id}
                    onClick={() => resolveJoinRequest(request, false)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Members"
        description={canManageMembers ? "Change a member's role, add another owner, or remove them." : "Everyone with access to this workspace."}
        actions={
          <label className="relative block w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or email"
              className="w-full rounded-lg border border-border bg-background py-1.5 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary/40"
            />
          </label>
        }
      >
        <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-5 py-3" role="tablist" aria-label="Filter by role">
          {["all", ...ROLES].map((option) => {
            const count = option === "all" ? members.length : roleCounts[option];
            if (option !== "all" && !count) return null;
            return (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={roleFilter === option}
                onClick={() => setRoleFilter(option)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  roleFilter === option ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option === "all" ? "Everyone" : ROLE_INFO[option].label}
                <span className="ml-1.5 text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
        <ul key={`${roleFilter}-${search}`} className="motion-stagger divide-y divide-border/60">
          {visibleMembers.length ? (
            visibleMembers.map((membership) => {
              const isMe = membership.user_id === user?.id;
              const canModify = canManageMembers && !isMe && (membership.role !== "owner" || isOwner);
              const busy = busyId === membership.user_id;
              const name = membership.display_name || membership.email || "Unknown member";
              const confirmingThis = confirming?.id === membership.user_id;
              return (
                <li key={membership.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-secondary/10">
                  <Avatar id={membership.user_id} name={membership.display_name} email={membership.email} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      <span className="truncate">{name}</span>
                      {isMe ? <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">You</span> : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {membership.display_name && membership.email ? `${membership.email} · ` : ""}
                      <span title={formatDate(membership.created_at)}>Joined {relativeTime(membership.created_at)}</span>
                    </p>
                  </div>
                  {confirmingThis ? (
                    <Confirm
                      message={
                        confirming.type === "remove"
                          ? `Remove ${name}? They lose access straight away.`
                          : `Make ${name} an owner? They get full control; you stay an owner too.`
                      }
                      confirmLabel={confirming.type === "remove" ? "Remove" : "Make owner"}
                      tone={confirming.type === "remove" ? "danger" : "primary"}
                      busy={busy}
                      onConfirm={() => (confirming.type === "remove" ? remove(membership) : makeOwner(membership))}
                      onCancel={() => setConfirming(null)}
                    />
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {canModify && membership.role !== "owner" ? (
                        <select
                          value={membership.role}
                          disabled={busy}
                          onChange={(event) => changeRole(membership, event.target.value)}
                          aria-label={`Role for ${name}`}
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                        >
                          {isOwner ? <option value="admin">Admin</option> : null}
                          {!isOwner && membership.role === "admin" ? <option value="admin">Admin</option> : null}
                          <option value="operator">Operator</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      ) : (
                        <RoleBadge role={membership.role} />
                      )}
                      {canModify && membership.role !== "owner" && isOwner ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirming({ id: membership.user_id, type: "owner" })}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground disabled:opacity-60"
                        >
                          Make owner
                        </button>
                      ) : null}
                      {canModify ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirming({ id: membership.user_id, type: "remove" })}
                          className="rounded-md px-2 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-60"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })
          ) : (
            <li className="px-5 py-8 text-center text-sm text-muted-foreground">No members match.</li>
          )}
        </ul>
      </Section>

      <Section
        title="Pending invitations"
        description="People become members once they sign in with the invited email and accept."
      >
        <ul className="motion-stagger divide-y divide-border/60">
          {data.invitations.length ? (
            data.invitations.map((invitation) => {
              const expired = new Date(invitation.expires_at) <= new Date();
              const canRevoke = canManageMembers && (isOwner || invitation.role !== "admin");
              const busy = busyId === invitation.id;
              return (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Avatar icon={Mail} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{invitation.email}</p>
                    <p className={cn("text-xs", expired ? "text-red-300" : "text-muted-foreground")} title={formatDate(invitation.expires_at)}>
                      {expired ? "Expired" : `Expires ${relativeTime(invitation.expires_at)}`}
                    </p>
                  </div>
                  {confirming?.id === invitation.id ? (
                    <Confirm
                      message={`Revoke the invitation for ${invitation.email}?`}
                      confirmLabel="Revoke"
                      busy={busy}
                      onConfirm={() => revoke(invitation)}
                      onCancel={() => setConfirming(null)}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <RoleBadge role={invitation.role} />
                      {!expired && canManageMembers ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => resend(invitation)}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground disabled:opacity-60"
                        >
                          {busy ? "Resending…" : "Resend"}
                        </button>
                      ) : null}
                      {canRevoke ? (
                        <button
                          type="button"
                          onClick={() => setConfirming({ id: invitation.id, type: "revoke" })}
                          className="rounded-md px-2 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })
          ) : (
            <li className="flex items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
              <Users className="h-4 w-4" /> No pending invitations.
            </li>
          )}
        </ul>
      </Section>

      <details className="group rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
          <span className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            What each role can do
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="overflow-x-auto border-t border-border duration-300 animate-in fade-in">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-muted-foreground">Can…</th>
                {ROLES.map((item) => (
                  <th key={item} className="px-3 py-3 text-center">
                    <RoleBadge role={item} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(CAPABILITY_LABELS).map(([capability, label]) => {
                const allowed = allowedRolesFor(capability);
                return (
                  <tr key={capability} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-2.5 text-muted-foreground">{label}</td>
                    {ROLES.map((item) => (
                      <td key={item} className="px-3 py-2.5 text-center">
                        {allowed.includes(item) ? (
                          <Check className="mx-auto h-4 w-4 text-emerald-400" aria-label="Yes" />
                        ) : (
                          <span className="text-muted-foreground/40" aria-label="No">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-5 py-3 text-xs text-muted-foreground">
            Only owners can invite or manage admins. A workspace always keeps at least one owner.
          </p>
        </div>
      </details>
    </div>
  );
}
