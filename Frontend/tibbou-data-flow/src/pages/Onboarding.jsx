import { useEffect, useMemo, useState } from "react";

import {
  createConnection,
  createInvitation,
  createOrganization,
  getDomainMatch,
  ingestDbtManifest,
  joinOrganizationByDomain,
  requestToJoinByDomain,
  testConnection,
} from "@/api/tibbou";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
  countDbtResources,
  emailDomain,
  isFreeEmailDomain,
  leastPrivilegeSql,
  slugPreview,
} from "@/lib/organizations";

const STEPS = ["organization", "connection", "manifest", "invite", "done"];

function StepShell({ title, description, children }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="w-full max-w-2xl rounded-2xl border border-border bg-card p-8">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
        <div className="mt-6">{children}</div>
      </section>
    </main>
  );
}

function StepProgress({ step }) {
  const index = STEPS.indexOf(step);
  const labels = ["Organization", "Connection", "dbt manifest", "Invite team", "Done"];
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
      {labels.map((label, position) => (
        <span key={label} className={position <= index ? "font-medium text-foreground" : ""}>
          {label}
          {position < labels.length - 1 ? <span className="mx-2">→</span> : null}
        </span>
      ))}
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
    return <StepShell title="Loading…">{null}</StepShell>;
  }

  const alreadyRequested = requested || domainMatch?.already_requested;

  return (
    <StepShell title="Welcome to Tibbou" description="Let's get you into a workspace.">
      {domainMatch?.organization ? (
        <article className="rounded-lg border border-border bg-background p-4">
          <h2 className="font-medium">{domainMatch.organization.name} already uses Tibbou</h2>
          <p className="mt-1 text-xs text-muted-foreground">{domainMatch.organization.slug}</p>
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
              className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Requesting…" : "Request to join"}
            </button>
          )}
        </article>
      ) : null}

      {invitations.length ? (
        <div className="mt-4 space-y-3">
          {invitations.map((invitation) => (
            <article key={invitation.id} className="rounded-lg border border-border bg-background p-4">
              <h2 className="font-medium">{invitation.organization_name}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {invitation.organization_slug} · {invitation.role}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
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
    <StepShell title="Create your organization" description="This becomes the workspace your team's data lives in.">
      <StepProgress step="organization" />
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="text-sm font-medium" htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Inc."
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          {name ? (
            <p className="mt-1 text-xs text-muted-foreground">URL slug: {slugPreview(name)}</p>
          ) : null}
        </div>
        {canClaimDomain ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowDomainJoin}
              onChange={(event) => setAllowDomainJoin(event.target.checked)}
              className="mt-1"
            />
            <span>
              Let anyone with an <span className="font-mono">@{domain}</span> email join automatically,
              without needing an invite.
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
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
  const [form, setForm] = useState({
    name: "Primary Snowflake connection",
    account_identifier: "",
    user_name: "TIBBOU_SVC",
    role_name: "TIBBOU_READER",
    warehouse_name: "",
    database_name: "",
    auth_method: "key_pair",
    oauth_token: "",
    private_key_pem: "",
    private_key_passphrase: "",
  });
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [sqlCopied, setSqlCopied] = useState(false);

  function update(field) {
    return (event) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
      setTestResult(null);
    };
  }

  const sql = useMemo(
    () =>
      leastPrivilegeSql({
        roleName: form.role_name,
        warehouseName: form.warehouse_name,
        databaseName: form.database_name,
      }),
    [form.role_name, form.warehouse_name, form.database_name]
  );

  async function copySql() {
    try {
      await navigator.clipboard.writeText(sql);
      setSqlCopied(true);
      setTimeout(() => setSqlCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context); the SQL is
      // still selectable/readable in the <pre> block below.
    }
  }

  async function handleTest(event) {
    event.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({
        account_identifier: form.account_identifier,
        user_name: form.user_name || null,
        role_name: form.role_name,
        warehouse_name: form.warehouse_name,
        database_name: form.database_name || null,
        auth_method: form.auth_method,
        oauth_token: form.auth_method === "external_oauth" ? form.oauth_token : null,
        private_key_pem: form.auth_method === "key_pair" ? form.private_key_pem : null,
        private_key_passphrase:
          form.auth_method === "key_pair" ? form.private_key_passphrase || null : null,
      });
      setTestResult(result);
    } catch (requestError) {
      setTestResult({ success: false, detail: requestError.message || "Test failed." });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    try {
      const secretReference = `${slugPreview(form.name)}-${Date.now().toString(36)}`;
      const connection = await createConnection({
        name: form.name,
        account_identifier: form.account_identifier,
        user_name: form.user_name || null,
        role_name: form.role_name,
        warehouse_name: form.warehouse_name,
        database_name: form.database_name || null,
        auth_method: form.auth_method,
        secret_reference: secretReference,
      });
      onConnected(connection);
    } catch (requestError) {
      setSaveError(requestError.message || "Failed to save connection.");
    } finally {
      setSaving(false);
    }
  }

  const canTest =
    form.account_identifier &&
    form.role_name &&
    form.warehouse_name &&
    (form.auth_method === "key_pair" ? form.private_key_pem : form.oauth_token);

  return (
    <StepShell
      title="Connect Snowflake"
      description="Required — Tibbou reads query and lineage metadata from this connection. Nothing you type here is stored; only a reference label is saved."
    >
      <StepProgress step="connection" />

      <details className="mb-4 rounded-lg border border-border bg-background p-4 text-sm" open>
        <summary className="cursor-pointer font-medium">
          1. Give your data engineer this least-privilege setup SQL
        </summary>
        <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-secondary/30 p-3 text-xs">{sql}</pre>
        <button
          type="button"
          onClick={copySql}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary/40"
        >
          {sqlCopied ? "Copied!" : "Copy SQL"}
        </button>
      </details>

      <form className="space-y-4" onSubmit={handleTest}>
        <p className="text-sm font-medium">2. Enter the credentials your data engineer hands back</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            required
            value={form.account_identifier}
            onChange={update("account_identifier")}
            placeholder="Account identifier (e.g. xy12345.us-east-1)"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
          />
          <input
            value={form.user_name}
            onChange={update("user_name")}
            placeholder="User name"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            required
            value={form.role_name}
            onChange={update("role_name")}
            placeholder="Role"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            required
            value={form.warehouse_name}
            onChange={update("warehouse_name")}
            placeholder="Warehouse"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={form.database_name}
            onChange={update("database_name")}
            placeholder="Database (optional)"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={form.auth_method === "key_pair"}
              onChange={() => setForm((current) => ({ ...current, auth_method: "key_pair" }))}
            />
            Key pair (recommended)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={form.auth_method === "external_oauth"}
              onChange={() => setForm((current) => ({ ...current, auth_method: "external_oauth" }))}
            />
            External OAuth
          </label>
        </div>

        {form.auth_method === "key_pair" ? (
          <>
            <textarea
              required
              value={form.private_key_pem}
              onChange={update("private_key_pem")}
              placeholder="-----BEGIN PRIVATE KEY-----"
              rows={5}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            />
            <input
              type="password"
              value={form.private_key_passphrase}
              onChange={update("private_key_passphrase")}
              placeholder="Private key passphrase (if any)"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </>
        ) : (
          <input
            required
            type="password"
            value={form.oauth_token}
            onChange={update("oauth_token")}
            placeholder="OAuth token"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        )}

        <button
          type="submit"
          disabled={!canTest || testing}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
      </form>

      {testResult ? (
        <p className={`mt-4 text-sm ${testResult.success ? "text-emerald-400" : "text-red-300"}`}>
          {testResult.detail}
        </p>
      ) : null}

      {saveError ? <p className="mt-2 text-sm text-red-300">{saveError}</p> : null}

      <button
        type="button"
        disabled={!testResult?.success || saving}
        onClick={handleSave}
        className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save and continue"}
      </button>
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
    <StepShell title="Upload your dbt manifest" description="target/manifest.json from your dbt project.">
      <StepProgress step="manifest" />
      <input type="file" accept="application/json,.json" onChange={handleFile} className="text-sm" />
      {fileName ? <p className="mt-2 text-xs text-muted-foreground">{fileName}</p> : null}
      {parseError ? <p className="mt-2 text-sm text-red-300">{parseError}</p> : null}
      {resourceCount !== null ? (
        <p className="mt-2 text-sm text-emerald-400">Valid manifest — {resourceCount} models found.</p>
      ) : null}
      {submitError ? <p className="mt-2 text-sm text-red-300">{submitError}</p> : null}
      {queued ? (
        <p className="mt-2 text-sm text-muted-foreground">
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
    <StepShell title="Invite your team" description="Optional — you can always invite people later from Admin.">
      <StepProgress step="invite" />
      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleInvite}>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="teammate@company.com"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Inviting…" : "Invite"}
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {invited.length ? (
        <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
          {invited.map((invitation) => (
            <li key={invitation.id}>{invitation.email} — {invitation.role}</li>
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
    <StepShell title="You're all set" description="Your workspace is ready.">
      <StepProgress step="done" />
      <button
        type="button"
        onClick={onFinish}
        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950"
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
