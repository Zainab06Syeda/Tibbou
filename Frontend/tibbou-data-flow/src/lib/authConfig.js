export function featureEnabled(value) {
  return value === "true";
}

export const entraSsoEnabled = featureEnabled(import.meta.env?.VITE_ENABLE_ENTRA_SSO);

/** @returns {import("@supabase/supabase-js").SignInWithOAuthCredentials} */
export function entraOAuthOptions(origin) {
  return {
    provider: "azure",
    options: {
      scopes: "email",
      redirectTo: `${origin}/auth/callback`,
    },
  };
}

export function readOAuthCallback(search) {
  const params = new URLSearchParams(search);
  return {
    code: params.get("code"),
    providerError: Boolean(params.get("error")),
  };
}
