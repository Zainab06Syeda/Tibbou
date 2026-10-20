import { useEffect, useMemo, useState } from "react";

import {
  createConnection,
  listConnections,
  syncSnowflake,
  updateConnection,
  validateConnection,
} from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";
import { leastPrivilegeSql } from "@/lib/organizations";

function CopyBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  async function copy() {
    try {
      setCopyError("");
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyError("Clipboard unavailable. Select and copy the SQL above.");
    }
  }

  return (
    <div>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-secondary/30 p-3 text-xs">
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary/40"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      {copyError ? <p role="status">{copyError}</p> : null}
    </div>
  );
}

const inputClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

// Shared by the onboarding wizard's "Connect Snowflake" step and
// /settings/connection. Tibbou generates the key pair server-side and keeps
// the private half in Supabase Vault -- the user never handles a key. They
// run two SQL snippets in Snowflake and click Validate.
export default function ConnectionForm({ onSaved, defaultName = "Primary Snowflake connection" }) {
  const { organization } = useOrganization();
  const [form, setForm] = useState({
    account_identifier: "",
    user_name: "TIBBOU_SVC",
    role_name: "TIBBOU_READER",
    warehouse_name: "",
  });
  const [connection, setConnection] = useState(null);
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Resume a connection whose key was generated but never validated, so
  // reloading midway doesn't strand it (or trip the unique-name rule).
  useEffect(() => {
    let active = true;
    listConnections()
      .then((rows) => {
        const pending = rows.find((row) => row.status !== "disabled" && !row.enabled && row.registration_sql);
        if (!active || !pending) return;
        setConnection(pending);
        setForm({
          account_identifier: pending.account_identifier,
          user_name: pending.user_name,
          role_name: pending.role_name,
          warehouse_name: pending.warehouse_name,
        });
        setEditing(false);
      })
      .catch((requestError) => active && setError(requestError.message || "Could not recover a pending connection."));
    return () => {
      active = false;
    };
  }, [organization?.id]);

  const setupSql = useMemo(
    () =>
      leastPrivilegeSql({
        roleName: form.role_name,
        warehouseName: form.warehouse_name,
        userName: form.user_name,
      }),
    [form.role_name, form.warehouse_name, form.user_name]
  );

  function update(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  async function saveDetails(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = connection
        ? await updateConnection(connection.id, form)
        : await createConnection({
            name: `${defaultName} (${form.account_identifier.trim()})`.slice(0, 120),
            ...form,
          });
      setConnection(saved);
      setEditing(false);
    } catch (requestError) {
      setError(requestError.message || "Could not save the connection.");
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    setBusy(true);
    setError("");
    try {
      const validated = await validateConnection(connection.id);
      let notice = "Connection validated. Usage sync queued.";
      try { await syncSnowflake(validated.id); }
      catch (syncError) { notice = `Connection validated, but usage sync was not queued: ${syncError.message}. Retry from Connection settings.`; }
      onSaved(validated, notice);
    } catch (requestError) {
      setError(requestError.message || "Validation failed.");
    } finally {
      setBusy(false);
    }
  }

  const canSave = form.account_identifier.trim() && form.user_name && form.role_name && form.warehouse_name;

  return (
    <div className="space-y-4">
      <details className="rounded-lg border border-border bg-background p-4 text-sm" open={!connection}>
        <summary className="cursor-pointer font-medium">1. Prepare Snowflake</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Run this in a Snowflake worksheet as <span className="font-mono">ACCOUNTADMIN</span>. It creates
          a dedicated role for usage metadata and a
          user for Tibbou to sign in as. Fill in your warehouse below first so it's included.
        </p>
        <CopyBlock code={setupSql} />
      </details>

      <div className="rounded-lg border border-border bg-background p-4 text-sm">
        <p className="font-medium">2. Tell Tibbou where to connect</p>
        {editing ? (
          <form noValidate className="mt-3 space-y-3" onSubmit={saveDetails}>
            <div>
              <input
                aria-label="Snowflake account identifier"
                required
                value={form.account_identifier}
                onChange={update("account_identifier")}
                placeholder="Account identifier (e.g. ORGNAME-ACCOUNTNAME)"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                In Snowflake: click your name (bottom left) → Account → View account details → Account
                identifier.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input aria-label="Snowflake service user" required value={form.user_name} onChange={update("user_name")} placeholder="User" className={inputClass} />
              <input aria-label="Snowflake role" required value={form.role_name} onChange={update("role_name")} placeholder="Role" className={inputClass} />
              <input
                required
                aria-label="Snowflake warehouse"
                value={form.warehouse_name}
                onChange={update("warehouse_name")}
                placeholder="Warehouse (e.g. COMPUTE_WH)"
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={!canSave || busy}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Saving…" : connection ? "Save changes" : "Generate connection key"}
            </button>
          </form>
        ) : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs text-muted-foreground">
              {form.user_name} @ {form.account_identifier} · role {form.role_name} · warehouse {form.warehouse_name}
            </p>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Edit details
            </button>
          </div>
        )}
      </div>

      {connection && !editing ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm">
          <p className="font-medium">3. Give Snowflake Tibbou's key</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Tibbou generated a key for this connection and stored the private half securely — you never
            need to handle it. Run this line in the same Snowflake worksheet to register the public half,
            then validate.
          </p>
          <CopyBlock code={connection.registration_sql} />
          <button
            type="button"
            onClick={validate}
            disabled={busy}
            className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Validating…" : "Validate connection"}
          </button>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    </div>
  );
}
