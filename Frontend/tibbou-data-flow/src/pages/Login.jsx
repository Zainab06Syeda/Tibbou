import { useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import TibbouLockup from "@/components/auth/TibbouLockup";
import TibbouMark from "@/components/auth/TibbouMark";
import "@/components/auth/login.css";
import "./login-page.css";
import { useAuth } from "@/contexts/AuthContext";
import { entraOAuthOptions, entraSsoEnabled } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    if (!normalizedEmail || (mode !== "reset" && !password)) {
      setError(mode === "reset" ? "Enter your email address." : "Enter both your email address and password.");
      return;
    }
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setError("Enter a valid email address.");
      return;
    }

    setError("");
    setNotice("");
    pendingRequest.current = true;
    setPending(true);

    if (mode === "reset") {
      try {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
          redirectTo: `${window.location.origin}/auth/reset`,
        });
        if (resetError) setError(getAuthErrorMessage(resetError, "send a reset link"));
        else
          setNotice(
            `If an account exists for ${normalizedEmail}, a link to choose a new password is on its way. Open it in this same browser.`
          );
      } catch (requestError) {
        setError(getAuthErrorMessage(requestError, "send a reset link"));
      } finally {
        pendingRequest.current = false;
        setPending(false);
      }
      return;
    }

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
    <div className="tb-login" data-theme="dark">
      <main className="tb-login__form-col">
        <div className="tb-login__mark">
          <TibbouLockup size={13} theme="dark" />
        </div>

        <div className="tb-login__form-wrap">
          <h1 className="tb-login__title">
            {mode === "signIn" ? "Welcome back" : mode === "reset" ? "Reset your password" : "Create your account"}
          </h1>
          <p className="tb-login__lede">
            {mode === "signIn"
              ? "Sign in to see where your warehouse spend went this week."
              : mode === "reset"
                ? "Enter your email and we'll send you a link to choose a new password."
                : "Set up your account, then create or join a workspace."}
          </p>

          {!configured ? (
            <p className="tb-login__error" role="alert">
              Supabase Auth is not configured. Set the Vite publishable-key environment variables.
            </p>
          ) : (
            <>
              {mode === "reset" ? null : (
              <div className="tb-mode-switch">
                <button
                  type="button"
                  className={`tb-mode-switch__btn ${mode === "signIn" ? "tb-mode-switch__btn--active" : ""}`}
                  disabled={pending}
                  onClick={() => selectMode("signIn")}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={`tb-mode-switch__btn ${mode === "signUp" ? "tb-mode-switch__btn--active" : ""}`}
                  disabled={pending}
                  onClick={() => selectMode("signUp")}
                >
                  Create account
                </button>
              </div>
              )}

              <form className="tb-login__form" onSubmit={submit} noValidate>
                <div className="tb-field">
                  <label htmlFor="tb-email" className="tb-field__label">Work email</label>
                  <input
                    id="tb-email"
                    className="tb-field__input"
                    type="email"
                    name="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    disabled={pending}
                  />
                </div>

                {mode === "reset" ? null : (
                <div className="tb-field">
                  <div className="tb-field__row">
                    <label htmlFor="tb-password" className="tb-field__label">Password</label>
                    {mode === "signIn" ? (
                      <button type="button" className="tb-link tb-link--small tb-link-button" onClick={() => selectMode("reset")}>
                        Forgot password?
                      </button>
                    ) : null}
                  </div>
                  <input
                    id="tb-password"
                    className="tb-field__input"
                    type="password"
                    name="password"
                    autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                    placeholder="••••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    disabled={pending}
                  />
                </div>
                )}

                {error ? <p className="tb-login__error" role="alert">{error}</p> : null}
                {notice ? <p className="tb-login__notice" role="status">{notice}</p> : null}

                <button type="submit" className="tb-btn tb-btn--primary" disabled={pending}>
                  {pending ? "Please wait…" : mode === "signIn" ? "Sign in" : mode === "reset" ? "Send reset link" : "Create account"}
                </button>

                {mode === "reset" ? (
                  <button type="button" className="tb-link tb-link--small tb-link-button" onClick={() => selectMode("signIn")}>
                    Back to sign in
                  </button>
                ) : (
                <>

                <div className="tb-divider" aria-hidden="true">
                  <span />
                  <em>OR</em>
                  <span />
                </div>

                <button
                  type="button"
                  className="tb-btn tb-btn--secondary"
                  onClick={entraSsoEnabled ? signInWithEntra : undefined}
                  disabled={pending || !entraSsoEnabled}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  {entraSsoEnabled ? "Continue with Microsoft" : "Microsoft Entra ID — Not enabled"}
                </button>
                <button type="button" className="tb-btn tb-btn--secondary" disabled>
                  Okta — Coming soon
                </button>
                </>
                )}
              </form>
            </>
          )}
        </div>
      </main>

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

        <div className="tb-panel__eyebrow">COST &amp; LINEAGE ATTRIBUTION</div>

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
          <p className="tb-panel__headline">Every query traced back to the model that ran it.</p>
          <p className="tb-panel__body">
            Tibbou reads your dbt manifest and Snowflake query history, then puts a number next to
            every node in the graph.
          </p>
        </div>
      </aside>
    </div>
  );
}
