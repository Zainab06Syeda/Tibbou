import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import TibbouMark from "@/components/auth/TibbouMark";
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

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center rounded-xl border border-border bg-card p-8 text-center shadow-2xl shadow-black/20">
        <TibbouMark size={20} theme="dark" forceDot animated={!error} />
        {error ? (
          <p className="mt-5 text-sm text-red-300" role="alert">{error}</p>
        ) : (
          <p className="mt-5 text-sm text-muted-foreground" role="status">Completing sign-in…</p>
        )}
      </div>
    </div>
  );
}
