import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import TibbouLockup from "@/components/auth/TibbouLockup";
import "@/components/auth/login.css";
import "./login-page.css";
import { readOAuthCallback } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

const MIN_LENGTH = 8;

// Opened from the "reset your password" email. The link carries a one-time
// code that has to be exchanged in the same browser that asked for it.
export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;
    const { code, providerError } = readOAuthCallback(window.location.search);
    if (!supabase || providerError || !code) {
      setLinkError("This reset link is missing or has already been used. Request a new one from the sign-in page.");
      return;
    }
    supabase.auth
      .exchangeCodeForSession(code)
      .then(({ error: exchangeError }) => {
        if (exchangeError) {
          setLinkError(
            "This reset link has expired, was already used, or was opened in a different browser from the one that requested it. Request a new one from the sign-in page."
          );
        } else {
          window.history.replaceState(null, "", "/auth/reset");
          setReady(true);
        }
      })
      .catch(() => setLinkError("Could not open this reset link. Request a new one from the sign-in page."));
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setError("");
    setPending(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) setError(getAuthErrorMessage(updateError, "set your new password"));
      else navigate("/", { replace: true });
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "set your new password"));
    } finally {
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
          <h1 className="tb-login__title">Choose a new password</h1>
          {linkError ? (
            <>
              <p className="tb-login__error" role="alert">{linkError}</p>
              <p className="tb-login__lede" style={{ marginTop: 20 }}>
                <Link to="/login" className="tb-link">Back to sign in</Link>
              </p>
            </>
          ) : !ready ? (
            <p className="tb-login__lede">Checking your reset link…</p>
          ) : (
            <form className="tb-login__form" onSubmit={submit} noValidate>
              <div className="tb-field">
                <label htmlFor="tb-new-password" className="tb-field__label">New password</label>
                <input
                  id="tb-new-password"
                  className="tb-field__input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                />
              </div>
              <div className="tb-field">
                <label htmlFor="tb-confirm-password" className="tb-field__label">Confirm new password</label>
                <input
                  id="tb-confirm-password"
                  className="tb-field__input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  disabled={pending}
                />
              </div>
              {error ? <p className="tb-login__error" role="alert">{error}</p> : null}
              <button type="submit" className="tb-btn tb-btn--primary" disabled={pending}>
                {pending ? "Saving…" : "Save new password"}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
