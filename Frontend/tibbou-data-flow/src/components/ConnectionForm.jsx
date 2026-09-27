import { useMemo, useState } from "react";

import { createConnection, testConnection } from "@/api/tibbou";
import { leastPrivilegeSql, slugPreview } from "@/lib/organizations";

const MAC_LINUX_KEYGEN = `openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
cat rsa_key.p8
cat rsa_key.pub`;

// Deliberately not piped: Windows PowerShell 5.1 can mangle text piped
// between two native (non-PowerShell) processes, which corrupts the PEM
// framing. Writing each step to a file and reading it back sidesteps that.
const WINDOWS_KEYGEN = `$openssl = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
& $openssl genrsa -out rsa_key_raw.pem 2048
& $openssl pkcs8 -topk8 -inform PEM -in rsa_key_raw.pem -out rsa_key.p8 -nocrypt
& $openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
Get-Content rsa_key.p8
Get-Content rsa_key.pub`;

// A copyable shell snippet -- used for both the keygen commands here and
// (via the same pattern) the setup SQL above.
function CopyBlock({ code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context); the code is
      // still selectable/readable in the <pre> block below.
    }
  }

  return (
    <div>
      <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-secondary/30 p-3 text-xs">{code}</pre>
      <button
        type="button"
        onClick={copy}
        className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary/40"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

// Shared by the onboarding wizard's "Connect Snowflake" step and
// /settings/connection: test-before-save, credentials never persisted --
// only a chosen secret_reference label is saved via createConnection.
export default function ConnectionForm({ onSaved, defaultName = "Primary Snowflake connection" }) {
  const [form, setForm] = useState({
    name: defaultName,
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
      onSaved(connection);
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
    <div>
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
        <input
          value={form.name}
          onChange={update("name")}
          placeholder="Connection name"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
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
            <details className="rounded-lg border border-border bg-background p-4 text-sm">
              <summary className="cursor-pointer font-medium">
                Don't have a private key yet? Generate one
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                Snowflake doesn't hand you a private key — you generate one yourself, keep it, and
                give Snowflake only the public half (paste it into the <span className="font-mono">rsa_public_key</span>{" "}
                line in the setup SQL above). Run one of these in a terminal on your own computer.
              </p>

              <p className="mt-3 text-xs font-medium">macOS / Linux</p>
              <CopyBlock code={MAC_LINUX_KEYGEN} />

              <p className="mt-3 text-xs font-medium">Windows (PowerShell)</p>
              <CopyBlock code={WINDOWS_KEYGEN} />
              <p className="mt-1 text-xs text-muted-foreground">
                Uses the OpenSSL bundled with Git for Windows. If that path doesn't exist, install{" "}
                <span className="font-mono">Git for Windows</span> first, or ask someone who manages
                your computer for a key generated with <span className="font-mono">openssl genrsa</span>.
              </p>

              <p className="mt-3 text-xs text-muted-foreground">
                Paste the <strong>entire</strong> output of the first file (including the BEGIN/END
                lines) into the field below. From the second file, copy only the base64 lines
                <em> between</em> BEGIN/END — no header or footer — into the SQL above.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Getting a "could not read the private key" / "MalformedFraming" error? The paste is
                missing or has extra lines — re-copy directly from your terminal's output rather than
                retyping it, and make sure nothing was added before the first line or after the last.
              </p>
            </details>

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
        {saving ? "Saving…" : "Save connection"}
      </button>
    </div>
  );
}
