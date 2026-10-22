import { useEffect, useState } from "react";
import { Check, UploadCloud } from "lucide-react";

import {
  createInvitation,
  createOrganization,
  getDomainMatch,
  ingestDbtManifest,
  joinOrganizationByDomain,
  requestToJoinByDomain,
} from "@/api/tibbou";
import ConnectionForm from "@/components/ConnectionForm";
import TibbouLockup from "@/components/auth/TibbouLockup";
import TibbouMark from "@/components/auth/TibbouMark";
import "@/components/auth/login.css";
import "./onboarding.css";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
  countDbtResources,
  emailDomain,
  isFreeEmailDomain,
  setupInProgressKey,
  slugPreview,
} from "@/lib/organizations";

const STEPS = ["organization", "connection", "manifest", "invite", "done"];

// Copy for the animated right-hand panel, keyed by wizard step -- this is
// the "interactive, explain what this does" half of the page: plain-language
// context for what's about to happen and why, aimed at non-technical users
// rather than at the person who already knows what a dbt manifest is.
const PANEL_CONTENT = {
  entry: {
    eyebrow: "GETTING STARTED",
    headline: "One workspace for your whole team's data.",
    body: "Tibbou connects to Snowflake and dbt so everyone can see what's running, what it costs, and how it's all connected — without writing SQL.",
  },
  organization: {
    eyebrow: "STEP 1 OF 5 — ORGANIZATION",
    headline: "This is your team's shared workspace.",
    body: "Everything you connect next — Snowflake, dbt, teammates — lives inside this organization. Rename it or manage who's in it any time from Settings.",
  },
  connection: {
    eyebrow: "STEP 2 OF 5 — CONNECTION",
    headline: "We only read metadata, never your rows.",
    body: "Tibbou connects to Snowflake to see which queries ran, how long they took, and what they cost — never the data inside your tables. You run two short scripts in Snowflake; Tibbou handles the login key for you.",
  },
  manifest: {
    eyebrow: "STEP 3 OF 5 — DBT MANIFEST",
    headline: "This is how Tibbou learns your data's shape.",
    body: "Your dbt manifest lists every model and how they depend on each other. Uploading it lets Tibbou draw the map, so you can trace any number on a dashboard back to the model that produced it.",
  },
  invite: {
    eyebrow: "STEP 4 OF 5 — TEAM",
    headline: "Everyone sees the same source of truth.",
    body: "Invite your team so they don't have to ask where a number came from — they can just look. Admins manage the connection; viewers can explore lineage and cost freely.",
  },
  done: {
    eyebrow: "YOU'RE ALL SET",
    headline: "Tibbou is now watching your warehouse.",
    body: "As syncs run, datasets, lineage, and cost data will populate automatically. Come back to the dashboard any time to see what's changed.",
  },
};

function StepDots({ current }) {
  const index = STEPS.indexOf(current);
  return (
    <div className="tb-steps" aria-hidden="true">
      {STEPS.map((key, position) => (
        <div key={key} style={{ display: "contents" }}>
          <div
            className={`tb-step ${
              position < index ? "tb-step--done" : position === index ? "tb-step--active" : ""
            }`}
          >
            {position < index ? <Check className="h-3 w-3" /> : position + 1}
          </div>
          {position < STEPS.length - 1 ? (
            <div className={`tb-step-line ${position < index ? "tb-step-line--done" : ""}`} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// Shares its brand tokens and animated panel with the (in-progress) sign-in
// page, but not its side-by-side layout: the panel fills the whole viewport
// as a background, and the form sits in one centered, frosted-glass card on
// top of it. `step` drives both the dot tracker and the panel's copy below.
function Shell({ step, title, lede, children }) {
  const { user, signOut } = useAuth();
  const panel = PANEL_CONTENT[step] || PANEL_CONTENT.entry;
  return (
    <div className="tb-login tb-login--onboard" data-theme="dark">
      <aside className="tb-panel">
        <div className="tb-panel__glow" aria-hidden="true" />
        <div className="tb-panel__glow tb-panel__glow--2" aria-hidden="true" />
        <div className="tb-ghost tb-ghost--1" aria-hidden="true" />
        <div className="tb-ghost tb-ghost--3" aria-hidden="true" />

        <div className="tb-chip tb-chip--1" aria-hidden="true">
          models traced <strong>128</strong>
        </div>
        <div className="tb-chip tb-chip--3" aria-hidden="true">
          last sync <strong>2m ago</strong>
        </div>
        <div className="tb-chip tb-chip--4" aria-hidden="true">
          rows scanned <strong>12,482</strong>
        </div>
        <div className="tb-scrap tb-scrap--2" aria-hidden="true">warehouse: analytics_wh</div>

        <div className="tb-panel__eyebrow">{panel.eyebrow}</div>

        <div className="tb-panel__visual" aria-hidden="true">
          <TibbouMark size={80} theme="dark" className="tb-panel__mark" />
          <div className="tb-rows">
            <div className="tb-row">
              <span className="tb-row__name">stg_orders</span>
              <div className="tb-row__track"><div className="tb-row__fill tb-row__fill--a" /></div>
            </div>
            <div className="tb-row">
              <span className="tb-row__name">fct_revenue</span>
              <div className="tb-row__track"><div className="tb-row__fill tb-row__fill--b" /></div>
            </div>
            <div className="tb-row">
              <span className="tb-row__name">dim_customers</span>
              <div className="tb-row__track"><div className="tb-row__fill tb-row__fill--c" /></div>
            </div>
            <div className="tb-row">
              <span className="tb-row__name">mart_orders_daily</span>
              <div className="tb-row__track"><div className="tb-row__fill tb-row__fill--d" /></div>
            </div>
          </div>
        </div>

        <div className="tb-panel__copy">
          <p className="tb-panel__headline">{panel.headline}</p>
          <p className="tb-panel__body">{panel.body}</p>
        </div>
      </aside>

      <div className="tb-onboard-center">
        <main className="tb-onboard-card">
          <div className="tb-onboard-card__top">
            <TibbouLockup size={13} theme="dark" />
            <button type="button" onClick={signOut} className="tb-signout" title={user?.email}>
              Sign out
            </button>
          </div>

          {STEPS.includes(step) ? <StepDots current={step} /> : null}
          <h1 className="tb-login__title">{title}</h1>
          {lede ? <p className="tb-login__lede">{lede}</p> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry: shown when the user has no organization yet -- either an existing
// domain match (join / request to join) or pending invitations to accept, or
// a clean path to create a new one.
// ---------------------------------------------------------------------------
function EntryStep({ onOrganizationReady, onCreateNew }) {
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
      <Shell step="entry" title="Loading your workspace…">
        <div className="tb-row-actions" style={{ justifyContent: "center", padding: "24px 0" }}>
          <div className="tb-spinner" />
        </div>
      </Shell>
    );
  }

  const alreadyRequested = requested || domainMatch?.already_requested;

  return (
    <Shell step="entry" title="Welcome to Tibbou" lede="Let's get you into a workspace.">
      <div className="tb-stack">
        {domainMatch?.organization ? (
          <div className="tb-card">
            <div className="tb-card__row">
              <TibbouMark size={28} theme="dark" />
              <div>
                <p className="tb-card__title">{domainMatch.organization.name} already uses Tibbou</p>
                <p className="tb-card__meta">{domainMatch.organization.slug}</p>
              </div>
            </div>
            {domainMatch.allow_domain_join ? (
              <button type="button" disabled={busy} onClick={handleJoin} className="tb-btn tb-btn--primary" style={{ marginTop: 16 }}>
                {busy ? "Joining…" : "Join this organization"}
              </button>
            ) : alreadyRequested ? (
              <p className="tb-text-muted" style={{ marginTop: 16 }}>
                Your request to join is pending. An admin will need to approve it.
              </p>
            ) : (
              <button type="button" disabled={busy} onClick={handleRequestToJoin} className="tb-btn tb-btn--secondary" style={{ marginTop: 16 }}>
                {busy ? "Requesting…" : "Request to join"}
              </button>
            )}
          </div>
        ) : null}

        {invitations.map((invitation) => (
          <div key={invitation.id} className="tb-card">
            <div className="tb-card__row">
              <TibbouMark size={28} theme="dark" />
              <div>
                <p className="tb-card__title">{invitation.organization_name}</p>
                <p className="tb-card__meta">{invitation.organization_slug} · {invitation.role}</p>
              </div>
            </div>
            <p className="tb-card__meta" style={{ marginTop: 12 }}>
              Expires {new Date(invitation.expires_at).toLocaleString()}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleAcceptInvitation(invitation.id)}
              className="tb-btn tb-btn--primary"
              style={{ marginTop: 16 }}
            >
              {busy ? "Joining…" : "Join organization"}
            </button>
          </div>
        ))}

        {actionError ? <p className="tb-login__error" role="alert">{actionError}</p> : null}
      </div>

      <div className="tb-section-divider">
        <p className="tb-text-muted">
          {domainMatch?.organization
            ? "Starting something separate from your team's workspace?"
            : "No invitations or matching workspace found."}
        </p>
        <button type="button" onClick={onCreateNew} className="tb-btn tb-btn--secondary" style={{ marginTop: 12 }}>
          Create a new organization
        </button>
      </div>
    </Shell>
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
    <Shell step="organization" title="Create your organization" lede="This becomes the workspace your team's data lives in.">
      <form className="tb-login__form" onSubmit={handleSubmit} noValidate>
        <div className="tb-field">
          <label className="tb-field__label" htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Inc."
            className="tb-field__input"
          />
          {name ? <p className="tb-text-muted">URL slug: {slugPreview(name)}</p> : null}
        </div>

        {canClaimDomain ? (
          <label className="tb-check" style={{ alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={allowDomainJoin}
              onChange={(event) => setAllowDomainJoin(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Let anyone with an <strong>@{domain}</strong> email join automatically, without needing
              an invite.
            </span>
          </label>
        ) : (
          <p className="tb-hint">
            Your email domain is a personal provider, so this organization won't claim a domain — invite
            teammates by email instead.
          </p>
        )}

        {error ? <p className="tb-login__error" role="alert">{error}</p> : null}

        <button type="submit" disabled={submitting || !name.trim()} className="tb-btn tb-btn--primary">
          {submitting ? "Creating…" : "Create organization"}
        </button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Step 2: connect Snowflake -- recommended, but skippable. Skipping drops the
// user straight onto the dashboard; SetupChecklist there surfaces "Connect
// Snowflake" (linking to /settings/connection) until one is actually enabled.
// ---------------------------------------------------------------------------
function ConnectionStep({ onConnected, onSkip }) {
  return (
    <Shell
      step="connection"
      title="Connect Snowflake"
      lede="Tibbou reads query history and cost metadata from this connection — never the data in your tables."
    >
      <ConnectionForm onSaved={onConnected} />
      <button type="button" onClick={onSkip} className="tb-btn tb-btn--secondary" style={{ marginTop: 16 }}>
        Skip for now — connect Snowflake later from Settings
      </button>
    </Shell>
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
    <Shell step="manifest" title="Upload your dbt manifest" lede="target/manifest.json from your dbt project.">
      <div className="tb-stack">
        <label htmlFor="dbt-manifest" className="tb-dropzone">
          <UploadCloud className="h-6 w-6" />
          <span className="tb-dropzone__title">{fileName || "Click to choose manifest.json"}</span>
          <span className="tb-dropzone__hint">JSON file, generated by `dbt compile` or `dbt run`</span>
          <input id="dbt-manifest" type="file" accept="application/json,.json" onChange={handleFile} className="sr-only" />
        </label>

        {parseError ? <p className="tb-login__error" role="alert">{parseError}</p> : null}
        {resourceCount !== null ? (
          <p className="tb-text-success"><Check className="h-4 w-4" /> Valid manifest — {resourceCount} models found.</p>
        ) : null}
        {submitError ? <p className="tb-login__error" role="alert">{submitError}</p> : null}
        {queued ? <p className="tb-text-muted">Queued for processing — lineage and datasets will appear shortly.</p> : null}

        <div className="tb-row-actions">
          <button type="button" disabled={!manifest || submitting || queued} onClick={handleSubmit} className="tb-btn tb-btn--primary">
            {submitting ? "Uploading…" : queued ? "Uploaded" : "Upload manifest"}
          </button>
          <button type="button" onClick={onDone} className="tb-btn tb-btn--secondary">
            {queued ? "Continue" : "Skip for now"}
          </button>
        </div>
      </div>
    </Shell>
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
    <Shell step="invite" title="Invite your team" lede="Optional — you can always invite people later from Members.">
      <div className="tb-stack">
        <form className="tb-row-actions" onSubmit={handleInvite} style={{ flexWrap: "nowrap" }}>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@company.com"
            className="tb-field__input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <select value={role} onChange={(event) => setRole(event.target.value)} className="tb-field__input" style={{ width: "auto" }}>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="submit" disabled={submitting} className="tb-btn tb-btn--secondary">
            {submitting ? "Inviting…" : "Invite"}
          </button>
        </form>

        {error ? <p className="tb-login__error" role="alert">{error}</p> : null}

        {invited.length ? (
          <ul className="tb-invited-list">
            {invited.map((invitation) => (
              <li key={invitation.id} className="tb-invited-item">
                <span>{invitation.email} — {invitation.role}</span>
                {invitation.email_sent ? (
                  <span className="tb-text-success"><Check className="h-3.5 w-3.5" /> Sent</span>
                ) : (
                  <span className="tb-text-warn">Share sign-in link manually</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <button type="button" onClick={onDone} className="tb-btn tb-btn--primary">
          {invited.length ? "Continue" : "Skip for now"}
        </button>
      </div>
    </Shell>
  );
}

function DoneStep({ onFinish }) {
  return (
    <Shell step="done" title="You're all set" lede="Your workspace is ready.">
      <div className="tb-stack">
        <div className="tb-card tb-card__row">
          <TibbouMark size={28} theme="dark" />
          <p className="tb-text-muted">
            Tibbou is tracking your connection. Datasets, lineage, and cost data will populate as sync
            runs complete.
          </p>
        </div>
        <button type="button" onClick={onFinish} className="tb-btn tb-btn--primary">
          Go to dashboard
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

export default function Onboarding({ hasOrganization, onFinish, onSkip }) {
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
        onCreated={async (created) => {
          sessionStorage.setItem(setupInProgressKey(created.id), "1");
          await refresh(created.id);
          setStep("connection");
        }}
      />
    );
  }
  if (step === "connection") {
    return <ConnectionStep onConnected={() => setStep("manifest")} onSkip={onSkip} />;
  }
  if (step === "manifest") {
    return <ManifestStep onDone={() => setStep("invite")} />;
  }
  if (step === "invite") {
    return <InviteStep onDone={() => setStep("done")} />;
  }
  return <DoneStep onFinish={onFinish} organization={organization} />;
}
