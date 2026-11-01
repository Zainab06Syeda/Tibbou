import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { completeOAuthSignIn } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const exchange = useRef(null);

  useEffect(() => {
    let active = true;
    // React Strict Mode must not exchange the same one-time PKCE code twice.
    exchange.current ||= completeOAuthSignIn(supabase?.auth, window.location.search, window.location.hash);
    exchange.current.then(() => {
      if (active) navigate("/", { replace: true });
    }).catch((requestError) => {
      if (active) setError(getAuthErrorMessage(requestError, "complete sign-in"));
    });
    return () => { active = false; };
  }, [navigate]);

  return <main className="grid min-h-screen place-items-center p-6"><div>{error ? <><p role="alert">{error}</p><Link className="mt-3 inline-block underline" to="/login">Return to sign in</Link></> : <p role="status">Completing sign-in…</p>}</div></main>;
}
