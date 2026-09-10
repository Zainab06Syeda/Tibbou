import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { readOAuthCallback } from "@/lib/authConfig";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    async function finish() {
      const { code, providerError } = readOAuthCallback(window.location.search);
      if (!supabase || providerError || !code) {
        setError("Unable to complete sign-in. Return to the login page and try again.");
        return;
      }
      try {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          setError(getAuthErrorMessage(exchangeError, "complete sign-in"));
          return;
        }
        navigate("/", { replace: true });
      } catch (requestError) {
        setError(getAuthErrorMessage(requestError, "complete sign-in"));
      }
    }
    finish();
  }, [navigate]);

  return <div className="grid min-h-screen place-items-center">{error || "Completing sign-in…"}</div>;
}
