export function featureEnabled(value) {
  return value === "true";
}

export const entraSsoEnabled = featureEnabled(import.meta.env?.VITE_ENABLE_ENTRA_SSO);
export const oktaSsoEnabled = featureEnabled(import.meta.env?.VITE_ENABLE_OKTA_SSO);

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

export const SSO_DISCOVERY_TIMEOUT_MS = 10_000;

export async function startOrganizationSso({ enabled, slug, origin, auth, lookup, signal = undefined }) {
  if (!enabled) return;
  const organization = slug.trim();
  if (!organization || !auth) throw new Error("Organization sign-in is unavailable");
  signal?.throwIfAborted();
  const request = new AbortController();
  const cancel = () => request.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => rejectCancellation(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => request.abort(new DOMException("Discovery timed out", "TimeoutError")), SSO_DISCOVERY_TIMEOUT_MS);
  try {
    // Race cancellation too: a late response must never start authentication.
    const connection = await Promise.race([lookup(organization, { signal: request.signal }), cancelled]);
    clearTimeout(deadline);
    request.signal.throwIfAborted();
    if (connection?.idp !== "okta" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connection?.provider_id)) {
      throw new Error("Organization sign-in is unavailable");
    }
    const { data, error } = await Promise.race([auth.signInWithSSO({
      providerId: connection.provider_id,
      options: { redirectTo: `${origin}/auth/callback`, skipBrowserRedirect: true },
    }), cancelled]);
    request.signal.throwIfAborted();
    if (error) throw error;
    if (!data?.url) throw new Error("Organization sign-in is unavailable");
    return data.url;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", onAbort);
  }
}

// Presentation only: FastAPI resolves the authoritative identity and membership.
export function isOrganizationSsoUser(user) {
  return user?.identities?.some((identity) => identity.provider?.startsWith("sso:")) || false;
}

export function readOAuthCallback(search, hash = "") {
  const params = new URLSearchParams(search);
  return {
    code: params.getAll("code").length === 1 ? params.get("code") : null,
    providerError: params.has("error") || new URLSearchParams(hash.replace(/^#/, "")).has("error"),
  };
}

export async function completeOAuthSignIn(auth, search, hash = "") {
  const { code, providerError } = readOAuthCallback(search, hash);
  if (!auth || providerError || !code) throw new Error("Unable to complete sign-in");
  const { data, error } = await auth.exchangeCodeForSession(code);
  if (error) throw error;
  if (!data?.session) throw new Error("Unable to complete sign-in");
}
