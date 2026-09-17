import { useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { entraOAuthOptions, entraSsoEnabled } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

export default function Login() {
  const { configured, loading, session } = useAuth();
  const [mode, setMode] = useState("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRequest = useRef(false);
  if (loading) return <div className="grid min-h-screen place-items-center">Loading…</div>;
  if (session) return <Navigate to="/" replace />;

  function selectMode(nextMode) {
    if (pending) return;
    setMode(nextMode);
    setError("");
    setNotice("");
  }

  async function submit(event) {
    event.preventDefault();
    if (pendingRequest.current) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError("Enter both your email address and password.");
      return;
    }

    setError("");
    setNotice("");
    pendingRequest.current = true;
    setPending(true);

    const action = mode === "signIn" ? "sign in" : "create your account";
    try {
      const result = mode === "signIn"
        ? await supabase.auth.signInWithPassword({ email: normalizedEmail, password })
        : await supabase.auth.signUp({ email: normalizedEmail, password });

      if (result.error) {
        setError(getAuthErrorMessage(result.error, action));
      } else if (mode === "signUp" && !result.data.session) {
        setNotice("Account created. Check your email to confirm it before signing in.");
      }
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, action));
    } finally {
      pendingRequest.current = false;
      setPending(false);
    }
  }

  async function signInWithEntra() {
    if (!entraSsoEnabled || pendingRequest.current) return;

    setError("");
    setNotice("");
    pendingRequest.current = true;
    setPending(true);
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth(
        entraOAuthOptions(window.location.origin),
      );
      if (oauthError) setError(getAuthErrorMessage(oauthError, "sign in with Microsoft"));
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "sign in with Microsoft"));
    } finally {
      pendingRequest.current = false;
      setPending(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-6 text-foreground">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div
          className="absolute rounded-full"
          style={{
            top: "-60px",
            right: "-80px",
            width: "420px",
            height: "420px",
            background: "rgba(6,182,212,0.08)",
            filter: "blur(90px)",
            animation: "floatOrb 16s ease-in-out infinite",
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            top: "40%",
            left: "-60px",
            width: "320px",
            height: "320px",
            background: "rgba(16,185,129,0.06)",
            filter: "blur(80px)",
            animation: "floatOrb 20s ease-in-out infinite",
            animationDelay: "-7s",
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            bottom: "80px",
            right: "30%",
            width: "260px",
            height: "260px",
            background: "rgba(245,158,11,0.05)",
            filter: "blur(70px)",
            animation: "floatOrb 14s ease-in-out infinite",
            animationDelay: "-3s",
          }}
        />
      </div>
      <section className="relative w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-xl">
        <p className="text-sm font-semibold text-emerald-400">Tibbou</p>
        <h1 className="mt-2 text-2xl font-semibold">
          {mode === "signIn" ? "Sign in to your workspace" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with Microsoft when available, or use email and password.
        </p>
        {!configured ? (
          <p className="mt-6 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            Supabase Auth is not configured. Set the Vite publishable-key environment variables.
          </p>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 rounded-md border border-border bg-background p-1">
              <button
                className={`rounded px-3 py-2 text-sm font-medium ${mode === "signIn" ? "bg-card text-foreground" : "text-muted-foreground"}`}
                type="button"
                disabled={pending}
                onClick={() => selectMode("signIn")}
              >
                Sign in
              </button>
              <button
                className={`rounded px-3 py-2 text-sm font-medium ${mode === "signUp" ? "bg-card text-foreground" : "text-muted-foreground"}`}
                type="button"
                disabled={pending}
                onClick={() => selectMode("signUp")}
              >
                Create account
              </button>
            </div>

            <form className="mt-4 space-y-4" onSubmit={submit}>
              <label className="block text-sm font-medium" htmlFor="email">
                Email
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-emerald-500"
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={pending}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="block text-sm font-medium" htmlFor="password">
                Password
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-emerald-500"
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                  required
                  disabled={pending}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="w-full rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={pending}
              >
                {pending ? "Please wait…" : mode === "signIn" ? "Sign in" : "Create account"}
              </button>
            </form>

            <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              Or continue with
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-2">
              <button
                className="w-full rounded-md border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-70"
                type="button"
                disabled={!entraSsoEnabled || pending}
                onClick={entraSsoEnabled ? signInWithEntra : undefined}
              >
                {entraSsoEnabled ? "Continue with Microsoft" : "Microsoft Entra ID — Not enabled"}
              </button>
              <button className="w-full cursor-not-allowed rounded-md border border-border px-4 py-2 text-sm text-muted-foreground opacity-70" type="button" disabled>
                Okta — Coming soon
              </button>
            </div>
          </>
        )}
        {error ? <p className="mt-3 text-sm text-red-300" role="alert">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-emerald-300" role="status">{notice}</p> : null}
      </section>
    </main>
  );
}
