import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getAuthErrorMessage } from "@/lib/authErrors";
import { supabase } from "@/lib/supabase";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    async function finish() {
      const code = new URLSearchParams(window.location.search).get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          setError(getAuthErrorMessage(exchangeError, "complete sign-in"));
          return;
        }
      }
      navigate("/", { replace: true });
    }
    finish();
  }, [navigate]);

  return <div className="grid min-h-screen place-items-center">{error || "Completing sign-in…"}</div>;
}
