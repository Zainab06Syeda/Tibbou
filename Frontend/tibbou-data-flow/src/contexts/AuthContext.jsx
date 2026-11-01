import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { authConfigured, supabase } from "@/lib/supabase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(authConfigured);
  const [signOutError, setSignOutError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setLoading(false);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
      if (nextSession) setSignOutError("");
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      configured: authConfigured,
      loading,
      session,
      user: session?.user || null,
      signOutError,
      signOut: async () => {
        setSignOutError("");
        try {
          const result = await supabase?.auth.signOut();
          // The SDK can clear the browser session before returning a server error.
          if (result?.error) setSignOutError("Sign-out could not be confirmed on the server. Other sessions may still be active.");
          return result;
        } catch {
          const message = "Unable to sign out. Try again.";
          setSignOutError(message);
          return { error: new Error(message) };
        }
      },
    }),
    [loading, session, signOutError],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
