import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import TibbouLockup from "@/components/auth/TibbouLockup";
import TibbouMark from "@/components/auth/TibbouMark";
import "@/components/auth/login.css";
import "./login-page.css";

import { useAuth } from "@/contexts/AuthContext";
import { getOrganizationSso } from "@/api/tibbou";
import { entraOAuthOptions, entraSsoEnabled, oktaSsoEnabled, startOrganizationSso } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

export default function Login() {
  const { configured, loading, session, signOutError } = useAuth();
  const [mode, setMode] = useState("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [organizationExpanded, setOrganizationExpanded] = useState(false);
  const [invalidField, setInvalidField] = useState("");
  const emailInput = useRef(null);
  const passwordInput = useRef(null);
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [organizationError, setOrganizationError] = useState("");
  const organizationInput = useRef(null);
  const pendingRequest = useRef(false);
  const ssoAttempt = useRef(null);
  useEffect(() => () => {
    ssoAttempt.current?.abort();
    ssoAttempt.current = null;
  }, []);
  useEffect(() => {
    if (organizationExpanded) organizationInput.current?.focus();
  }, [organizationExpanded]);
  if (loading) return <div className="grid min-h-screen place-items-center">Loading…</div>;
  if (session) return <Navigate to="/" replace />;

  function selectMode(nextMode) {
    if (pending) return;
    setMode(nextMode);
    setInvalidField("");
    setError("");
    setNotice("");
  }

  async function submit(event) {
    event.preventDefault();
    if (pendingRequest.current) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError("Enter both your email address and password.");
      setInvalidField(normalizedEmail ? "password" : "email");
      (normalizedEmail ? passwordInput : emailInput).current?.focus();
      return;
    }

    if (emailInput.current?.validity.typeMismatch) {
      setError("Enter a valid email address.");
      setInvalidField("email");
      emailInput.current?.focus();
      return;
    }
    setInvalidField("");
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

    setInvalidField("");
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

  async function signInWithOkta(event) {
    event.preventDefault();
    if (!oktaSsoEnabled || pendingRequest.current) return;
    if (!organizationSlug.trim()) {
      setOrganizationError("Enter your organization slug.");
      organizationInput.current?.focus();
      return;
    }
    setOrganizationError("");
    setError("");
    setNotice("");
    const attempt = new AbortController();
    ssoAttempt.current = attempt;
    pendingRequest.current = true;
    setPending(true);
    try {
      const url = await startOrganizationSso({
        enabled: oktaSsoEnabled, slug: organizationSlug, origin: window.location.origin,
        auth: supabase?.auth, lookup: getOrganizationSso, signal: attempt.signal,
      });
      if (!attempt.signal.aborted) window.location.assign(url);
    } catch (requestError) {
      if (ssoAttempt.current === attempt) setError(getAuthErrorMessage(requestError, "sign in with your organization's Okta connection"));
    } finally {
      if (ssoAttempt.current === attempt) {
        ssoAttempt.current = null;
        pendingRequest.current = false;
        setPending(false);
      }
    }
  }

  return (
    <div className="tb-login" data-theme="dark">
      <main className="tb-login__form-col">
        <div className="tb-login__mark">
          <TibbouLockup size={13} theme="dark" />
        </div>
        <div className="tb-login__form-wrap">
          <h1 className="tb-login__title">{mode === "signIn" ? "Welcome back" : "Create your account"}</h1>
          <p className="tb-login__lede">
            {mode === "signIn"
              ? "Sign in to see where your warehouse spend went this week."
              : "Set up your account, then create or join a workspace."}
          </p>
          {!configured ? (
            <p className="tb-login__error" role="alert">
              Supabase Auth is not configured. Set the Vite publishable-key environment variables.
            </p>
          ) : (
            <>
              <div className="tb-mode-switch" role="group" aria-label="Account access">
                <button type="button" className={`tb-mode-switch__btn ${mode === "signIn" ? "tb-mode-switch__btn--active" : ""}`}
                  disabled={pending} aria-pressed={mode === "signIn"} onClick={() => selectMode("signIn")}>Sign in</button>
                <button type="button" className={`tb-mode-switch__btn ${mode === "signUp" ? "tb-mode-switch__btn--active" : ""}`}
                  disabled={pending} aria-pressed={mode === "signUp"} onClick={() => selectMode("signUp")}>Create account</button>
              </div>

              <form className="tb-login__form" onSubmit={submit} noValidate aria-label={mode === "signIn" ? "Sign in" : "Create account"} aria-busy={pending}>
                <div className="tb-field">
                  <label htmlFor="email" className="tb-field__label">Work email</label>
                  <input id="email" ref={emailInput} className="tb-field__input" name="email" type="email" autoComplete="email"
                    placeholder="you@company.com" required disabled={pending} value={email}
                    aria-invalid={invalidField === "email"} aria-describedby={error ? "login-error" : undefined}
                    onChange={(event) => { setEmail(event.target.value); setInvalidField(""); }} />
                </div>
                <div className="tb-field">
                  <label htmlFor="password" className="tb-field__label">Password</label>
                  <input id="password" ref={passwordInput} className="tb-field__input" name="password" type="password"
                    autoComplete={mode === "signIn" ? "current-password" : "new-password"} placeholder="••••••••••"
                    required disabled={pending} value={password} aria-invalid={invalidField === "password"}
                    aria-describedby={error ? "login-error" : undefined}
                    onChange={(event) => { setPassword(event.target.value); setInvalidField(""); }} />
                </div>
                <button type="submit" className="tb-btn tb-btn--primary" disabled={pending}>
                  {pending ? "Please wait…" : mode === "signIn" ? "Sign in" : "Create account"}
                </button>
              </form>

              <div className="tb-divider" aria-hidden="true"><span /><em>OR</em><span /></div>
              <div className="tb-login__providers">
                <button type="button" className="tb-btn tb-btn--secondary" disabled={!entraSsoEnabled || pending}
                  onClick={entraSsoEnabled ? signInWithEntra : undefined}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  {entraSsoEnabled ? "Continue with Microsoft" : "Microsoft Entra ID — Not enabled"}
                </button>
                {oktaSsoEnabled ? (
                  <>
                    <button type="button" className="tb-btn tb-btn--secondary" disabled={pending}
                      aria-expanded={organizationExpanded} aria-controls="organization-sso"
                      onClick={() => { setOrganizationExpanded((value) => !value); setOrganizationError(""); setInvalidField(""); setError(""); setNotice(""); }}>
                      {organizationExpanded ? "Hide organization sign-in" : "Continue with Okta"}
                    </button>
                    <div id="organization-sso" hidden={!organizationExpanded}>
                      <form className="tb-login__form" onSubmit={signInWithOkta} noValidate aria-label="Organization sign-in" aria-busy={pending}>
                        <div className="tb-field">
                          <label htmlFor="organization-slug" className="tb-field__label">Organization slug</label>
                          <input id="organization-slug" ref={organizationInput} className="tb-field__input" name="organization"
                            required maxLength={200} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={pending}
                            value={organizationSlug} aria-describedby={organizationError ? "organization-help organization-error" : "organization-help"}
                            aria-invalid={Boolean(organizationError)}
                            onChange={(event) => { setOrganizationSlug(event.target.value); setOrganizationError(""); }} />
                          <p id="organization-help" className="tb-login__help">Use the slug provided by your organization administrator.</p>
                          {organizationError ? <p id="organization-error" className="tb-login__error" role="alert">{organizationError}</p> : null}
                        </div>
                        <button type="submit" className="tb-btn tb-btn--primary" disabled={pending || !organizationSlug.trim()}>
                          {pending ? "Please wait…" : "Sign in with Okta"}
                        </button>
                        {pending && ssoAttempt.current ? (
                          <button type="button" className="tb-btn tb-btn--secondary" onClick={() => ssoAttempt.current?.abort()}>Cancel organization sign-in</button>
                        ) : null}
                      </form>
                    </div>
                  </>
                ) : <button type="button" className="tb-btn tb-btn--secondary" disabled>Okta — Coming soon</button>}
              </div>
              {error || signOutError ? <p id="login-error" className="tb-login__error" role="alert">{error || signOutError}</p> : null}
              {notice ? <p className="tb-login__notice" role="status">{notice}</p> : null}
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
