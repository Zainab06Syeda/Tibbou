import assert from "node:assert/strict";
import test from "node:test";

import { entraOAuthOptions, featureEnabled, readOAuthCallback } from "../src/lib/authConfig.js";

test("Entra stays disabled unless explicitly enabled", () => {
  assert.equal(featureEnabled(undefined), false);
  assert.equal(featureEnabled("false"), false);
  assert.equal(featureEnabled("true"), true);
});

test("Entra uses Azure, email scope, and the PKCE callback", () => {
  assert.deepEqual(entraOAuthOptions("http://localhost:5173"), {
    provider: "azure",
    options: {
      scopes: "email",
      redirectTo: "http://localhost:5173/auth/callback",
    },
  });
});

test("OAuth callback input distinguishes codes from provider errors", () => {
  assert.deepEqual(readOAuthCallback("?code=one-time-code"), {
    code: "one-time-code",
    providerError: false,
  });
  assert.deepEqual(readOAuthCallback("?error=access_denied"), {
    code: null,
    providerError: true,
  });
});
