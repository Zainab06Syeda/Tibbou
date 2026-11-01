import assert from "node:assert/strict";
import test from "node:test";

import { completeOAuthSignIn, entraOAuthOptions, featureEnabled, isOrganizationSsoUser, readOAuthCallback, SSO_DISCOVERY_TIMEOUT_MS, startOrganizationSso } from "../src/lib/authConfig.js";
import { getAuthErrorMessage } from "../src/lib/authErrors.js";

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

const providerId = "30000000-0000-0000-0000-000000000001";
function ssoOptions(changes = {}) {
  return {
    enabled: true, slug: " acme ", origin: "https://tibbou.example",
    lookup: async () => ({ provider_id: providerId, idp: "okta" }),
    auth: { signInWithSSO: async () => ({ data: { url: "https://auth.example/saml" }, error: null }) },
    ...changes,
  };
}

test("disabled Okta performs no lookup or SDK request", async () => {
  const forbidden = () => { assert.fail("disabled SSO made a request"); };
  await startOrganizationSso(ssoOptions({ enabled: false, lookup: forbidden, auth: { signInWithSSO: forbidden } }));
  for (const value of [undefined, null, true, "TRUE", "1", "false"]) assert.equal(featureEnabled(value), false);
});

test("Okta routes the exact organization provider through the shared PKCE callback", async () => {
  let calls = 0;
  await startOrganizationSso(ssoOptions({
    lookup: async (slug) => { assert.equal(slug, "acme"); return { provider_id: providerId, idp: "okta" }; },
    auth: { signInWithSSO: async (options) => {
      calls++;
      assert.deepEqual(options, { providerId, options: { redirectTo: "https://tibbou.example/auth/callback", skipBrowserRedirect: true } });
      return { data: { url: "https://auth.example/saml" }, error: null };
    } },
  }));
  assert.equal(calls, 1);
});

test("never-resolving discovery times out, aborts the request, and permits retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  let sdkCalls = 0;
  const pending = startOrganizationSso(ssoOptions({
    lookup: (_slug, { signal }) => { requestSignal = signal; return new Promise(() => {}); },
    auth: { signInWithSSO: () => { sdkCalls++; assert.fail("timed-out discovery started SSO"); } },
  }));
  const failed = assert.rejects(pending, { name: "TimeoutError" });
  t.mock.timers.tick(SSO_DISCOVERY_TIMEOUT_MS);
  await failed;
  assert.equal(requestSignal.aborted, true);
  assert.equal(sdkCalls, 0);
  assert.match(getAuthErrorMessage(requestSignal.reason), /Try again or choose another sign-in method/);
  assert.equal(await startOrganizationSso(ssoOptions()), "https://auth.example/saml");
});

test("late discovery after its deadline cannot call SSO", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishDiscovery;
  let sdkCalls = 0;
  const pending = startOrganizationSso(ssoOptions({
    lookup: () => new Promise(resolve => { finishDiscovery = resolve; }),
    auth: { signInWithSSO: () => { sdkCalls++; } },
  }));
  const failed = assert.rejects(pending, { name: "TimeoutError" });
  t.mock.timers.tick(SSO_DISCOVERY_TIMEOUT_MS);
  await failed;
  finishDiscovery({ provider_id: providerId, idp: "okta" });
  await Promise.resolve();
  assert.equal(sdkCalls, 0);
});

test("cancellation/unmount aborts discovery even if its transport ignores abort", async () => {
  const controller = new AbortController();
  let finishDiscovery;
  let requestSignal;
  let sdkCalls = 0;
  const pending = startOrganizationSso(ssoOptions({ signal: controller.signal,
    lookup: (_slug, { signal }) => { requestSignal = signal; return new Promise(resolve => { finishDiscovery = resolve; }); },
    auth: { signInWithSSO: () => { sdkCalls++; } },
  }));
  const failed = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await failed;
  finishDiscovery({ provider_id: providerId, idp: "okta" });
  await Promise.resolve();
  assert.equal(requestSignal.aborted, true);
  assert.equal(sdkCalls, 0);
});

test("already cancelled attempts perform no discovery", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startOrganizationSso(ssoOptions({ signal: controller.signal,
    lookup: () => assert.fail("cancelled attempt performed discovery"),
  })), { name: "AbortError" });
});

test("cancellation during SDK request ignores its late redirect", async () => {
  const controller = new AbortController();
  let finishSso;
  let started;
  const sdkStarted = new Promise(resolve => { started = resolve; });
  const pending = startOrganizationSso(ssoOptions({ signal: controller.signal,
    auth: { signInWithSSO: ({ options }) => {
      assert.equal(options.skipBrowserRedirect, true);
      started();
      return new Promise(resolve => { finishSso = resolve; });
    } },
  }));
  const failed = assert.rejects(pending, { name: "AbortError" });
  await sdkStarted;
  controller.abort();
  await failed;
  finishSso({ data: { url: "https://auth.example/late" }, error: null });
  await Promise.resolve();
});

test("blank organization and unavailable auth stop before discovery", async () => {
  for (const changes of [{ slug: "  " }, { auth: null }]) {
    await assert.rejects(startOrganizationSso(ssoOptions({ ...changes, lookup: () => assert.fail("unexpected discovery") })));
  }
});

test("missing, disabled, malformed or incorrect provider lookup cannot start SSO", async () => {
  for (const connection of [null, {}, { provider_id: "bad", idp: "okta" }, { provider_id: providerId, idp: "entra" }]) {
    await assert.rejects(startOrganizationSso(ssoOptions({
      lookup: async () => connection, auth: { signInWithSSO: () => assert.fail("unexpected SSO request") },
    })));
  }
  await assert.rejects(startOrganizationSso(ssoOptions({ lookup: async () => { throw new Error("404"); } })));
});

test("SDK errors and missing redirect are failures", async () => {
  for (const result of [{ error: new Error("SSO unavailable") }, { data: null, error: null }]) {
    await assert.rejects(startOrganizationSso(ssoOptions({ auth: { signInWithSSO: async () => result } })));
  }
});

test("SAML presentation uses identities, never email or user metadata", () => {
  assert.equal(isOrganizationSsoUser(null), false);
  for (const provider of ["email", "azure"]) assert.equal(isOrganizationSsoUser({ identities: [{ provider }], user_metadata: { provider: `sso:${providerId}` } }), false);
  assert.equal(isOrganizationSsoUser({ identities: [{ provider: `sso:${providerId}` }] }), true);
});

test("callback rejects provider errors, missing or duplicate code before exchange", async () => {
  const auth = { exchangeCodeForSession: () => assert.fail("unexpected exchange") };
  for (const [search, hash] of [["", ""], ["?code=a&code=b", ""], ["?code=a&error=denied", ""], ["?code=a", "#error=access_denied"]]) {
    await assert.rejects(completeOAuthSignIn(auth, search, hash));
  }
});

test("shared callback requires an exchanged session for Entra and SAML", async () => {
  let calls = 0;
  await completeOAuthSignIn({ exchangeCodeForSession: async (code) => {
    assert.equal(code, "one-time-code"); calls++;
    return { data: { session: { access_token: "local-fixture" } }, error: null };
  } }, "?code=one-time-code");
  assert.equal(calls, 1);
  for (const result of [{ data: { session: null } }, { error: new Error("expired code") }]) {
    await assert.rejects(completeOAuthSignIn({ exchangeCodeForSession: async () => result }, "?code=one-time-code"));
  }
});
