import { useEffect, useState } from "react";
import {
  Building2,
  Check,
  FileJson,
  GitBranch,
  Plug,
  Sparkles,
  UserPlus,
  UploadCloud,
} from "lucide-react";

import {
  createInvitation,
  createOrganization,
  getDomainMatch,
  ingestDbtManifest,
  joinOrganizationByDomain,
  requestToJoinByDomain,
} from "@/api/tibbou";
import ConnectionForm from "@/components/ConnectionForm";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { cn } from "@/lib/utils";
import { countDbtResources, emailDomain, isFreeEmailDomain, slugPreview } from "@/lib/organizations";

const STEPS = [
  { key: "organization", label: "Organization", icon: Building2 },
  { key: "connection", label: "Connection", icon: Plug },
  { key: "manifest", label: "dbt manifest", icon: FileJson },
  { key: "invite", label: "Invite team", icon: UserPlus },
  { key: "done", label: "Done", icon: Sparkles },
];

function Brandmark() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/20">
        <GitBranch className="h-4 w-4 text-primary" />
      </div>
      <div>
        <span className="text-lg font-semibold tracking-tight text-foreground">Tibbou</span>
        <p className="text-[11px] text-muted-foreground">Data lineage and cost visibility</p>
      </div>
    </div>
  );
}

function StepShell({ eyebrow, title, description, step, children }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_top,_rgba(6,182,212,0.16),_transparent_55%)]"
      />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-2xl flex-col justify-center">
        <Brandmark />

        {step ? <StepProgress step={step} /> : null}

        <section className="mt-6 rounded-[28px] border border-border bg-card p-8 shadow-xl shadow-black/20">
          {eyebrow ? (
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/80">{eyebrow}</p>
          ) : null}
          <h1 className={cn("text-2xl font-semibold tracking-tight text-foreground", eyebrow && "mt-2")}>
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          ) : null}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

function StepProgress({ step }) {
  const index = STEPS.findIndex((item) => item.key === step);

  return (
    <div className="mt-8 flex items-center">
      {STEPS.map((item, position) => {
        const done = position < index;
        const active = position === index;
        return (
          <div key={item.key} className="flex flex-1 items-center last:flex-initial">
            <div className="flex flex-col items-center gap-2">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
                  done && "border-primary bg-primary/20 text-primary",
                  active && "border-primary bg-primary text-primary-foreground",
                  !done && !active && "border-border bg-secondary/20 text-muted-foreground"
                )}
              >
                {done ? <Check className="h-4 w-4" /> : <item.icon className="h-4 w-4" />}
              </div>
              <span
                className={cn(
                  "hidden text-[11px] font-medium sm:block",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {item.label}
              </span>
            </div>
            {position < STEPS.length - 1 ? (
              <span
                className={cn(
                  "mx-2 h-px flex-1 sm:-mt-5",
                  position < index ? "bg-primary" : "bg-border"
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry: shown when the user has no organization yet -- either an existing
// domain match (join / request to join) or pending invitations to accept, or
// a clean path to create a new one.
// ---------------------------------------------------------------------------
function EntryStep({ onOrganizationReady, onCreateNew }) {
  const { user, signOut } = useAuth();
  const { invitations, acceptInvitation } = useOrganization();
  const [domainMatch, setDomainMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    let active = true;
    getDomainMatch()
      .then((result) => active && setDomainMatch(result))
      .catch(() => active && setDomainMatch(null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  async function handleJoin() {
    setBusy(true);
    setActionError("");
    try {
      const organization = await joinOrganizationByDomain();
      onOrganizationReady(organization);
    } catch (requestError) {
      setActionError(requestError.message || "Failed to join organization.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestToJoin() {
    setBusy(true);
    setActionError("");
    try {
      await requestToJoinByDomain();
      setRequested(true);
    } catch (requestError) {
      setActionError(requestError.message || "Failed to request access.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptInvitation(id) {
    setBusy(true);
    setActionError("");
    try {
      const organization = await acceptInvitation(id);
      onOrganizationReady(organization);
    } catch (requestError) {
      setActionError(requestError.message || "Failed to join organization.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <StepShell eyebrow="Tibbou onboarding" title="Loading your workspace…">
        <div className="flex items-center justify-center py-6">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
        </div>
      </StepShell>
    );
  }

  const alreadyRequested = requested || domainMatch?.already_requested;

  return (
    <StepShell eyebrow="Tibbou onboarding" title="Welcome to Tibbou" description="Let's get you into a workspace.">
      {domainMatch?.organization ? (
        <article className="rounded-xl border border-border bg-secondary/20 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/20">
              <Building2 className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-foreground">
                {domainMatch.organization.name} already uses Tibbou
              </h2>
              <p className="text-xs text-muted-foreground">{domainMatch.organization.slug}</p>
            </div>
          </div>
          {domainMatch.allow_domain_join ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleJoin}
              className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Joining…" : "Join this organization"}
            </button>
          ) : alreadyRequested ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Your request to join is pending. An admin will need to approve it.
            </p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={handleRequestToJoin}
              className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40"
            >
              {busy ? "Requesting…" : "Request to join"}
            </button>
          )}
        </article>
      ) : null}

      {invitations.length ? (
        <div className="mt-4 space-y-3">
          {invitations.map((invitation) => (
            <article key={invitation.id} className="rounded-xl border border-border bg-secondary/20 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/20">
                  <UserPlus className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-medium text-foreground">{invitation.organization_name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {invitation.organization_slug} · {invitation.role}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Expires {new Date(invitation.expires_at).toLocaleString()}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleAcceptInvitation(invitation.id)}
                className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Joining…" : "Join organization"}
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {actionError ? <p className="mt-4 text-sm text-red-300">{actionError}</p> : null}

      <div className="mt-6 border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">
          {domainMatch?.organization
            ? "Starting something separate from your team's workspace?"
            : "No invitations or matching workspace found."}
        </p>
        <button
          type="button"
          onClick={onCreateNew}
          className="mt-3 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40"
        >
          Create a new organization
        </button>
      </div>

      <button type="button" onClick={signOut} className="mt-6 block text-sm text-muted-foreground underline hover:text-foreground">
        Sign out ({user?.email})
      </button>
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 1: create the organization
// ---------------------------------------------------------------------------
function OrganizationStep({ onCreated }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [allowDomainJoin, setAllowDomainJoin] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const domain = emailDomain(user?.email);
  const canClaimDomain = domain && !isFreeEmailDomain(domain);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const organization = await createOrganization({
        name,
        allow_domain_join: canClaimDomain ? allowDomainJoin : false,
      });
      onCreated(organization);
    } catch (requestError) {
      setError(requestError.message || "Failed to create organization.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      eyebrow="Step 1 of 5"
      step="organization"
      title="Create your organization"
      description="This becomes the workspace your team's data lives in."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="text-sm font-medium text-foreground" htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Inc."
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          {name ? (
            <p className="mt-1 text-xs text-muted-foreground">URL slug: {slugPreview(name)}</p>
          ) : null}
        </div>
        {canClaimDomain ? (
          <label className="flex items-start gap-2 rounded-xl border border-border bg-secondary/20 p-4 text-sm">
            <input
              type="checkbox"
              checked={allowDomainJoin}
              onChange={(event) => setAllowDomainJoin(event.target.checked)}
              className="mt-1 accent-primary"
            />
            <span className="text-foreground">
              Let anyone with an <span className="font-mono text-primary">@{domain}</span> email join
              automatically, without needing an invite.
            </span>
          </label>
        ) : (
          <p className="rounded-xl border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            Your email domain is a personal provider, so this organization won't claim a domain — invite
            teammates by email instead.
          </p>
        )}
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create organization"}
        </button>
      </form>
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 2: connect Snowflake -- test before save, required to continue
// ---------------------------------------------------------------------------
function ConnectionStep({ onConnected }) {
  return (
    <StepShell
      eyebrow="Step 2 of 5"
      step="connection"
      title="Connect Snowflake"
      description="Required — Tibbou reads query and lineage metadata from this connection. Nothing you type here is stored; only a reference label is saved."
    >
      <ConnectionForm onSaved={onConnected} />
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 3: upload the dbt manifest -- validated + counted client-side
// instantly, then queued for the backend worker to actually process.
// ---------------------------------------------------------------------------
function ManifestStep({ onDone }) {
  const [fileName, setFileName] = useState("");
  const [resourceCount, setResourceCount] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [parseError, setParseError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [queued, setQueued] = useState(false);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setManifest(null);
    setResourceCount(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.nodes || typeof parsed.nodes !== "object") {
        throw new Error("This doesn't look like a dbt manifest.json (missing 'nodes').");
      }
      setManifest(parsed);
      setResourceCount(countDbtResources(parsed));
    } catch (error) {
      setParseError(error.message || "Could not parse this file as JSON.");
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError("");
    try {
      await ingestDbtManifest(manifest);
      setQueued(true);
    } catch (requestError) {
      setSubmitError(requestError.message || "Failed to upload manifest.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      eyebrow="Step 3 of 5"
      step="manifest"
      title="Upload your dbt manifest"
      description="target/manifest.json from your dbt project."
    >
      <label
        htmlFor="dbt-manifest"
        className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 text-center transition-colors hover:border-primary/60 hover:bg-secondary/30"
      >
        <UploadCloud className="h-6 w-6 text-primary" />
        <span className="text-sm font-medium text-foreground">
          {fileName || "Click to choose manifest.json"}
        </span>
        <span className="text-xs text-muted-foreground">JSON file, generated by `dbt compile` or `dbt run`</span>
        <input
          id="dbt-manifest"
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="sr-only"
        />
      </label>
      {parseError ? <p className="mt-3 text-sm text-red-300">{parseError}</p> : null}
      {resourceCount !== null ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-400">
          <Check className="h-4 w-4" /> Valid manifest — {resourceCount} models found.
        </p>
      ) : null}
      {submitError ? <p className="mt-3 text-sm text-red-300">{submitError}</p> : null}
      {queued ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Queued for processing — lineage and datasets will appear shortly.
        </p>
      ) : null}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          disabled={!manifest || submitting || queued}
          onClick={handleSubmit}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Uploading…" : queued ? "Uploaded" : "Upload manifest"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40"
        >
          {queued ? "Continue" : "Skip for now"}
        </button>
      </div>
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 4: invite the team -- skippable
// ---------------------------------------------------------------------------
function InviteStep({ onDone }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [invited, setInvited] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleInvite(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const invitation = await createInvitation({ email, role });
      setInvited((current) => [...current, invitation]);
      setEmail("");
      setRole("viewer");
    } catch (requestError) {
      setError(requestError.message || "Failed to send invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      eyebrow="Step 4 of 5"
      step="invite"
      title="Invite your team"
      description="Optional — you can always invite people later from Members."
    >
      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleInvite}>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="teammate@company.com"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Inviting…" : "Invite"}
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {invited.length ? (
        <ul className="mt-4 space-y-2">
          {invited.map((invitation) => (
            <li
              key={invitation.id}
              className="flex items-center justify-between rounded-xl border border-border bg-secondary/20 px-4 py-3 text-sm"
            >
              <span className="text-foreground">
                {invitation.email} <span className="text-muted-foreground">— {invitation.role}</span>
              </span>
              {invitation.email_sent ? (
                <span className="text-xs text-emerald-400">Sent</span>
              ) : (
                <span className="text-xs text-amber-300">Share sign-in link manually</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={onDone}
        className="mt-6 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950"
      >
        {invited.length ? "Continue" : "Skip for now"}
      </button>
    </StepShell>
  );
}

function DoneStep({ onFinish }) {
  return (
    <StepShell
      eyebrow="Step 5 of 5"
      step="done"
      title="You're all set"
      description="Your workspace is ready."
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/20 p-4">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/20">
          <Sparkles className="h-4 w-4 text-emerald-400" />
        </div>
        <p className="text-sm text-muted-foreground">
          Tibbou is tracking your connection. Datasets, lineage, and cost data will populate as sync runs
          complete.
        </p>
      </div>
      <button
        type="button"
        onClick={onFinish}
        className="mt-6 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950"
      >
        Go to dashboard
      </button>
    </StepShell>
  );
}

// ---------------------------------------------------------------------------

export default function Onboarding({ hasOrganization, onFinish }) {
  const { organization, refresh } = useOrganization();
  const [step, setStep] = useState(hasOrganization ? "connection" : "entry");

  useEffect(() => {
    if (hasOrganization) setStep("connection");
  }, [hasOrganization]);

  if (step === "entry") {
    return (
      <EntryStep
        onOrganizationReady={() => setStep("connection")}
        onCreateNew={() => setStep("organization")}
      />
    );
  }
  if (step === "organization") {
    return (
      <OrganizationStep
        onCreated={async () => {
          await refresh();
          setStep("connection");
        }}
      />
    );
  }
  if (step === "connection") {
    return <ConnectionStep onConnected={() => setStep("manifest")} />;
  }
  if (step === "manifest") {
    return <ManifestStep onDone={() => setStep("invite")} />;
  }
  if (step === "invite") {
    return <InviteStep onDone={() => setStep("done")} />;
  }
  return <DoneStep onFinish={onFinish} organization={organization} />;
}
