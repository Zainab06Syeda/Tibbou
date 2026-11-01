# Customer-specific Enterprise SSO: local implementation

Implementation and verification record, October 22, 2026; selective login presentation reconciled October 25, 2026 (record below). Local source is ready for review; hosted SSO and production rollout are not verified or authorized.

## Isolation and baseline

- Verified remote `main`, fetched `origin/main`, and confirmed both matched the approved baseline `4539047cde65afe7ccaa835c07ca3fbcc1605146`; no intervening main changes required review.
- Created a clean, isolated worktree and an SSO feature branch at that commit.
- The existing `feature/snowflake-dbt-data-path` checkout and its unrelated tracked/untracked files were preserved. No Snowflake feature commits were copied into this branch.
- No dependencies were added or upgraded. Existing installed frontend dependencies matching the lockfile were copied into the new worktree's ignored `node_modules` for verification.
- No database, RLS policy, migration, external provider, secret, or hosted configuration was changed. Nothing was committed, pushed, merged, or deployed.

## Identity checkpoint and supported evidence

The API first retains existing JWT signature, algorithm (`ES256`/`RS256`), issuer, audience, authenticated-role, expiry and bounded clock-skew validation. JWT/JWKS work runs in the worker thread pool, preserving the former synchronous dependency's isolation from the event loop.

Every authenticated request then calls the Auth service using the user's bearer token and the project's publishable key. `getUser(access_token)` makes an authenticated network lookup; the JavaScript SDK wraps its result as `{data: {user}, error}`. This implementation reuses the installed HTTPX dependency to call `GET /auth/v1/user`, whose REST response is the user object itself. Identity `user_id` must match validated `sub`; client session storage is not backend evidence. See the official [getUser reference](https://supabase.com/docs/reference/javascript/auth-getuser) and [Auth UserGet implementation](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/user.go#L63).

The exact `identities[].provider = sso:<provider-uuid>` representation is supported by inspected upstream implementation: the [SAML ACS handler](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/samlacs.go#L314) constructs it and the [identity model](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/models/identity.go#L14) serializes it. The public user response does not serialize the internal `is_sso_user` field. This is source evidence, not a claim about the running hosted version. That version's actual responses must pass the hosted gate below.

One SSO identity binds the account to its configured provider. Known `email`/`azure` identities, including linked email/Azure identities, preserve existing non-SSO behavior. Unknown, missing, empty, mixed SSO/non-SSO, duplicate SSO, invalid-provider, or mismatched-user identity responses are rejected. Untrusted `user_metadata`, email domain, slug input and browser organization selection cannot confer access. Auth-owned metadata cannot contradict the identities. Separate SSO accounts are not merged by email: this follows Supabase's [SSO account and identity rules](https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml#user-accounts-and-identities).

`amr` is [optional](https://supabase.com/docs/guides/auth/jwt-fields#optional-claims). The parser scans every entry, never assumes index zero, validates objects/methods/integer timestamps and each supplied SAML provider UUID, accepts consistent duplicate methods, and rejects malformed or contradictory provenance. Missing AMR or a missing SAML provider field can only be recovered from authoritative identities; it cannot turn an SSO account into an unrestricted account. MFA/refresh entries and ordering do not remove account binding. Supabase documents that [MFA can change AMR ordering](https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml#row-level-security). Real token refresh and MFA behavior remain unverified.

Invalid credentials/provenance produce safe 401 responses. Unknown/disabled SSO mappings produce 403. An Auth outage, rate limit, redirect, timeout, missing publishable key or unusable service response fails closed with 503; no database operation or non-SSO fallback follows. The five-second total Auth lookup deadline includes HTTP connection-pool waiting and I/O. It does not bound JWT/JWKS validation, database work or the entire request. Health remains public.

### Cost of an Auth lookup on every request

One shared lifespan-managed HTTPX client pools HTTPS connections. Bearer headers are supplied per request; identity responses and authentication decisions are never cached. Redirects, retries and ambient proxy credentials are disabled. FastAPI's normal dependency caching shares identity resolution within a single request. Every new authenticated request, including existing password/Entra traffic, now depends on Auth availability and incurs a network round trip. A browser flag does not remove this dependency.

Local loopback HTTP measurements (20 serial requests, five concurrent requests) were p50 **29.3 ms**, p95 **31.3 ms**, concurrent maximum **135.5 ms**. A simulated 100 ms service delay measured **125.3 ms**; a stalled request was cancelled after **5.01 s**. These figures exclude hosted TLS, real network latency and hosted rate limits. They establish local deadline handling, not acceptable production performance.

Before deployment, benchmark authenticated read and write requests from the actual API region with password, Entra and SAML users. Record cold/warm and concurrent p50/p95/p99, Auth round trips, connection-pool saturation, 429 rates and total request latency against agreed product budgets. Inject connection refusal, slow headers/body, service 5xx and pool exhaustion in an isolated test service; confirm bounded 503 responses, cancellation, recovery, no stale identity fallback, and no business writes. Never log bearer tokens, Auth responses or PII. Do not add a cross-request cache to hide unacceptable results; review the design first.

### Mandatory production admission and performance gate — not passed

The independent review's finding 3 remains open. The current source has one API worker in `Backend/Procfile`, no explicit server request-admission limit, and an HTTPX pool that limits connections rather than incoming request/task creation. The five-second Auth lookup deadline does not limit server/proxy queues or JWT/JWKS thread-pool waiting. Passing synthetic timeout tests does not establish safe production capacity. This correction changes no server, proxy, pool or rate-limit configuration.

Before production approval, the deployment owner must define and demonstrate:

- **Server and reverse-proxy admission:** bounded concurrent requests, connections/backlog, queue length and queue-wait time; consistent proxy/server deadlines and body/header limits. Record per-instance and aggregate limits for the actual worker/replica count. Prove overload is rejected promptly with the documented 429 or 503 behavior, without unbounded tasks, memory growth or JWT/database work for rejected requests. Include public discovery traffic and preserve health access during overload.
- **Auth lookup concurrency:** measure active lookups, connection reuse, HTTPX pool wait/timeouts, saturation, thread-pool wait and database pool occupancy. Establish an admission budget that accounts for all workers and Supabase's applicable project limits. Test more concurrent requests than the pool/admission budget, client disconnects and cancellations; prove connections/tasks are released and another user's bearer header is never reused.
- **Rate limiting and 429:** define the trusted client/account keys, burst and sustained limits, where they are enforced, safe error body and retry/backoff guidance. Test both edge-generated 429 and Auth-generated 429. The current backend deliberately maps Auth 429 to a safe 503, denies business access and has no automatic retry or cached-identity fallback; measure and document that behavior. Test recovery after the rate-limit window, without retry storms or disclosing account/provider details.
- **Auth failures and recovery:** exercise refused/reset connections, slow headers/body, unavailable DNS/TLS, 5xx, 429 and exhausted pools in an authorized representative test environment. Measure time to failure and recovery, including proxy/server queue time, rather than assuming the lookup's five-second deadline bounds the whole request. Verify no business writes/external side effects on denial and that service restoration recovers without a process restart or weakened validation.
- **Representative concurrent traffic:** use password, existing Entra and SAML identities separately and in a realistic mixed workload, including two independently configured SAML providers. Exercise authenticated reads/writes, session restoration, token refresh and MFA where supported. Record the deployment size/region, client concurrency, offered/completed requests per second, burst/ramp/steady-state duration, cold/warm behavior and per-method/aggregate results.
- **Acceptance evidence:** agree numerical latency/error/queue/recovery budgets before testing. Capture end-to-end and Auth lookup p50, p95, p99, maximum/tail latency, timeout and 429/503 rates, pool/queue saturation, CPU, memory and resource recovery. Report rejected requests alongside successful requests so admission cannot hide tail latency. Keep sufficient repeated samples for meaningful p99 results, verify tenant isolation under load and attach reproducible results for human review. No production acceptance is inferred from local loopback figures.

## Configuration and routing

Backend environment additions:

```dotenv
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
ENTERPRISE_SSO_CONNECTIONS=[]
```

The key is required for **all** authenticated API requests after this source change. Use the same Supabase project as JWT validation; never use a secret/service-role key. No new configuration is needed by the ingestion worker.

Example JSON value for `ENTERPRISE_SSO_CONNECTIONS` (synthetic UUIDs, disabled deliberately):

```json
[
  {
    "organization_id": "20000000-0000-0000-0000-000000000001",
    "organization_slug": "acme",
    "provider_id": "30000000-0000-0000-0000-000000000001",
    "idp": "okta",
    "enabled": false
  },
  {
    "organization_id": "20000000-0000-0000-0000-000000000002",
    "organization_slug": "other",
    "provider_id": "30000000-0000-0000-0000-000000000002",
    "idp": "okta",
    "enabled": false
  }
]
```

Registry rules: nonzero UUIDs; exact nonempty slugs without surrounding whitespace or path separators; only `okta` or `entra`; strict boolean `enabled` defaulting false; no extra/duplicate JSON fields; each provider belongs to one organization; one provider per organization/IdP pair; consistent one-to-one organization/slug mapping. Disabled records participate in uniqueness checks. Malformed/conflicting registry data fails API startup atomically. The registry is immutable per process; restart **every** API instance to apply a change.

Existing organization slugs are non-null and unique in the SQLAlchemy model and tenancy migration. The registry cannot attest that an operator supplied the right database UUID/slug or owns an external IdP: verify those facts through authenticated organization administration and independently verified provider configuration. Do not repurpose a provider UUID for another customer. Changing a binding changes subsequent authorization after restart and still requires membership; deleting a binding does not delete identities or memberships.

`GET /api/v1/organizations/{slug}/sso?idp=okta` is the sole new public business-facing route. It reads only the registry and returns `{provider_id, idp}` for an enabled exact match; missing/disabled entries share a safe 404. Responses are `no-store`. It returns no organization details, memberships, emails or private configuration, and does not loosen other organization routes. An optional `idp=entra` supports an explicitly configured Enterprise SAML connection; the existing Microsoft button continues to use Azure OAuth. Public provider routing is discoverable; it grants no membership. Apply existing edge traffic controls before exposure.

Frontend `VITE_ENABLE_OKTA_SSO` defaults false and enables only the organization-slug form. Disabled controls make no discovery/Auth requests. Enabled login uses the returned provider UUID with `signInWithSSO` and the existing Supabase PKCE client and `/auth/callback`. The callback handles provider errors, requires an exchanged session, avoids duplicate Strict Mode exchanges and offers a login recovery link. Existing password/Entra controls and session/logout handling are preserved. Settings labels describe login presentation, not verified external provisioning.

Public discovery now has a **10-second deadline** and an AbortSignal passed through the existing API request helper. Ten seconds gives a short metadata request room for a slow connection while bounding the shared login lock; it is a usability choice, not measured production latency. Timeout, failure and explicit cancellation clear pending state and offer safe retry/other-method guidance. Unmount cancels the attempt without updating the departed page. A cancellation race also protects against transports that ignore abort. Discovery success clears the discovery timer; the SDK phase remains explicitly cancellable. `skipBrowserRedirect: true` leaves navigation to the still-active Login attempt, so a late discovery or SDK response cannot redirect after cancellation. Cancelling an already-issued SDK request ignores its result; it does not claim to cancel remote provider work. Existing password and Entra handlers are unchanged.

The UI reuses the existing Login fields, pending lock, safe error mapping, Tailwind tokens and onboarding components; no design system or visual redesign was introduced. The slug is not persisted or used as permission evidence. SSO onboarding offers invitation acceptance and admin guidance, without organization creation or domain discovery/join controls. FastAPI enforces the same rules even when browser identity data is absent or tampered with.

Disabling/removing a backend mapping denies subsequent SSO API requests after restart, including requests using existing/refreshed JWTs. It does **not** revoke Supabase tokens, sign out an Okta browser session, retroactively cancel an in-flight request, or cancel previously queued worker jobs. Disabling only the frontend flag hides login; disabling only the remote provider is not an application-session revocation guarantee. An operational disablement must include the backend registry, all instances, and a separately approved session/job response when required.

## Authorization coverage

`require_organization_role` now enforces the SSO binding before membership/context/database queries. `require_capability` already composes that dependency, so admin operations, membership/ownership changes, join-request administration, Snowflake connections/validation, dataset and lineage reads/writes, cost endpoints, ingestion/sync jobs and report endpoints inherit the check without route-by-route copies. Membership and role permissions remain required even for the correctly bound provider. Request database context remains transaction-local and the restricted API database role/RLS design is unchanged.

Exceptions to that dependency are explicitly handled: organization discovery adds the provider organization filter to the user's membership query; invitation summaries and acceptance add organization restrictions; acceptance still verifies email, expiry, membership and the existing atomic transaction; SSO organization creation/domain-join requests are forbidden; SSO domain discovery returns no match. `/db/ping` remains authenticated and exposes no organization data. `/`, `/health`, OpenAPI/docs and the narrow provider lookup carry no organization business records. A route-graph regression test requires any future business route to inherit scope enforcement or enter the explicit exception list.

Matching emails at two independent providers do not merge accounts or confer cross-customer access. Existing invitations remain email-addressed approval for the **bound** organization; accepting one grants only its approved role to that user's UUID. Password/Entra accounts are not newly required to use enterprise SSO; enforcing SSO for every identity in an organization is outside this approved scope.

## Verification and acceptance gates

1. **Local source and focused tests — completed.** Pure identity parsing, real local HTTP deadline tests, signed JWT FastAPI tests with controlled Auth transport, registry validation and frontend tests. Two users/two provider fixtures cover cross-organization read/write attempts, same email, disabled/incorrect mappings, malformed/contradictory claims, invitation acceptance and denial, membership/role checks, discovery and onboarding restrictions. Nonempty SQLite fixtures now execute actual organization and invitation predicates in both tenant directions, instead of predetermined empty results. Discovery timeout/cancellation/late-response cases pass unit and browser checks. These fixtures do not authenticate with a real IdP.
2. **Backend/database tenant isolation — partially completed.** Every current organization route was exercised in both cross-tenant directions and checked for denial before business queries/writes. The SQLite fixture preserves route predicates but substitutes PostgreSQL context, advisory locks and the invitation-summary function; it is not RLS or concurrency proof. The ownership HTTP fixture now returns an Auth identity matching its signed JWT and database user. Offline checks reach the actual role dependency's 403, reject unknown principals and reject invalid signatures before Auth. The opt-in real PostgreSQL/RLS/ownership tests and direct Supabase Data API isolation checks were not run: no authorized isolated database/fixture configuration was supplied. Hosted grants/policies have not been reverified. Do not enable this feature if direct business-table access bypasses FastAPI's binding.
3. **Real Okta/Supabase integration — blocked.** Requires separately authorized test connections and users. Before general rollout, test **two independently configured providers** against different customer organizations, including the same email at both providers, unique Supabase user IDs, exact getUser identities, login/PKCE, refresh, MFA, restoration/logout, expired/revoked sessions, invitation approval/acceptance, mapping disable/remove/reassignment and cross-organization operations. Also regress real password and existing Entra login. Inspect a failing contract securely; never remove JWT validation or tenant checks to accommodate it.
4. **Production deployment/customer enablement — not started.** Requires human approval, successful hosted/RLS/performance gates, reviewed correct provider/organization mappings, safe publishable-key configuration on every API instance, deployment/rollback preparation, and per-customer enablement. Enable the frontend flag only after those checks. No migration is required by this source change.

Commands and observed results:

| Check | Command / method | Result |
| --- | --- | --- |
| Full backend | In `Backend`, `python -B -m unittest discover -s tests -v`, with dummy loopback DB/project configuration and both database integration opt-ins disabled | 233 reported in 15.829 s; `OK (skipped=14)`. Instrumented repeat: 220 passed, 0 failures/errors, 13 test methods and one fixture class skipped (15.715 s); unittest excludes that class from its reported test count |
| Focused backend | `python -B -m unittest tests.test_sso -q`; `python -B -m unittest tests.test_ownership_concurrency_integration.OwnershipAuthFixtureTests -v` | 20 SSO tests and 3 ownership Auth fixture tests passed; 0 failed/skipped |
| Mutation probes | In-memory replacement of each production predicate `=` with `!=`, restoring each function afterward; 17 SSO API tests per probe | All 3 mutations detected: organization discovery, invitation listing and invitation acceptance. Each caused 1 assertion failure, 0 errors. Production file hashes unchanged |
| Frontend unit tests | `npm test` | 20 passed, 0 failed, 0 skipped/cancelled |
| Frontend static/build | `npm run typecheck`, `npm run lint`, `npm run build` | All passed |
| Browser smoke | Headless Edge/Playwright against loopback Vite, all Auth/API responses intercepted, no external calls | Eight scenario groups passed, zero page errors; SSO/password session restoration/logout, invitation-only onboarding, disabled flags, callback errors, Entra routing and 390px/desktop layouts |
| Browser cancellation | Headless Edge/Playwright with a controlled clock and held discovery/SDK responses, no external calls | Five groups passed, 0 failed/skipped/page errors: deadline unlock, retry, cancel then Entra, SPA unmount, and cancellation of a pending SDK redirect |
| Backend startup/OpenAPI | Lifespan-managed `TestClient(app)` with dummy configuration | 3 assertions passed: health 200; OpenAPI 200 with 32 paths; unauthenticated organization request 401; no database/Auth connection |
| Backend Ruff | Installed Python module availability checked | Not installed; no dependency installation performed |
| Optional UI convention audit | Premium skill static audit, strict mode | Exit 1: 10 existing forms/selects/scrollbar convention findings; unrelated cleanup deferred. The new SSO form's validation finding was resolved. No claim of whole-app design compliance |

No real SSO, hosted RLS or production performance success is inferred from these results.

## Files and implementation scope

Created:

- `Backend/app/auth_identity.py` — validated Auth REST lookup and identity/AMR resolution.
- `Backend/app/sso.py` — validated backend connection registry.
- `Backend/tests/test_auth_identity.py`, `Backend/tests/test_auth_identity_http.py`, `Backend/tests/test_sso.py` — identity, timeout, routing, tenant and authorization coverage.
- `Documentation/okta-enterprise-sso.md` — this configuration, evidence and acceptance record.

Modified:

- `Backend/app/auth.py`, `Backend/app/main.py` — authenticated identity dependency, central binding and pooled Auth-client lifecycle.
- `Backend/app/api/routes/organizations.py`, `invitations.py`, `onboarding.py`, `Backend/app/schemas/organizations.py` — public routing DTO and the discovery/invitation/onboarding exceptions.
- `Backend/.env.example`, `Frontend/tibbou-data-flow/.env.example` — safe defaults and required configuration names.
- `Frontend/tibbou-data-flow/src/lib/authConfig.js`, `src/api/tibbou.js`, `src/pages/Login.jsx`, `AuthCallback.jsx`, `Onboarding.jsx`, `SettingsMembers.jsx`, `AdminDashboard.jsx` — provider routing, callback and invitation-only presentation; both settings source panels describe the same flags.
- `Frontend/tibbou-data-flow/src/lib/authErrors.js` — safe discovery timeout and cancellation messages.
- `Frontend/tibbou-data-flow/test/authConfig.test.js` — routing/callback/flag regression tests.
- `Backend/tests/test_ownership_concurrency_integration.py` — controlled Auth transport matching the signed ownership fixture, with offline authentication/403 regression checks; real database tests remain opt-in.
- `README.md`, `Testing/README.md` — links to current SSO evidence; historical unrelated results retained.

No architectural deviation from the approved backend-registry design. Shared HTTPX pooling and thread-pool JWT work are necessary request-lifecycle details; no new dependency, identity store, authorization framework or migration was introduced. Remaining blockers concern real-service contracts, isolation and operational performance, not local mock success.

### Focused review corrections and readiness

Findings 1, 2 and 4 have local source/test corrections. Finding 3 remains a mandatory production gate as specified above. The correction scope is nine files: frontend `src/lib/authConfig.js`, `src/lib/authErrors.js`, `src/api/tibbou.js`, `src/pages/Login.jsx`, `test/authConfig.test.js`; backend `tests/test_sso.py`, `tests/test_ownership_concurrency_integration.py`; and this document plus `Testing/README.md`. Production authorization predicates, JWT validation, dependencies, database models/migrations and RLS were not changed by these corrections. The mutation probes did not edit source files.

The local correction is ready for review and a separately approved commit. Production readiness remains conditional on the isolated PostgreSQL/ownership/RLS tests, actual two-provider Okta/Supabase contracts and the representative admission/performance evidence. No commit, push, deployment or external state change was performed.

## Selective login presentation reconciliation — October 25, 2026

The existing isolated SSO worktree and baseline `4539047cde65afe7ccaa835c07ca3fbcc1605146` were preserved. Starting status was 20 modified tracked files, six untracked implementation files and no staged changes; all were expected. A snapshot of 168 tracked/non-ignored file hashes was captured outside the worktree before editing. The original Snowflake checkout was not modified.

The login presentation was selectively taken from `feat/org-onboarding` at pinned commit `e9bc404bc3e06fcec3fb055a3eb3be5b65fad1ff`. No merge, rebase, cherry-pick, dependency installation or Git ref update was performed. Existing `TibbouLockup`, `TibbouMark` and `components/auth/login.css` remain the canonical brand components/tokens; their implementations were reused unchanged. The new `pages/login-page.css` scopes additions beneath `.tb-login`. Only the reviewed Sora/JetBrains Mono font-loading declarations were added to `index.html`; `src/index.css` and global application styling are unchanged.

`Login.jsx` now uses the branded split-panel composition, welcome copy, sign-in/create-account controls, Microsoft button and cost/lineage illustration. At widths below 1024px the existing stylesheet turns the illustration into a compact banner. When Okta is disabled it displays `Okta — Coming soon` without a handler or request. When enabled, selecting Okta reveals and focuses a separate organization form without starting discovery; only submission invokes the existing provider lookup and SSO handler. The ten-second deadline, AbortSignal forwarding, cancellation/unmount cleanup and late-response protection are unchanged in `authConfig.js` and the API utility.

Password sign-in/sign-up and Microsoft retain their existing SDK calls and configuration. Credential validation now uses inline errors and first-invalid-field focus, including the browser's email syntax rules; validation presentation is cleared when switching methods. The hardened callback, Supabase client/session configuration, route table (including `/admin`), application tests, package scripts, backend authorization, provider binding and invitation-only SSO onboarding are unchanged from the starting snapshot.

### Deliberate differences from the reference

- **Password recovery is deferred.** The Forgot Password action is omitted. No reset component, `/auth/reset` route, recovery request, password-eligibility check, hook or database object was introduced. A separate Auth-policy review is required: recovery events and `email`/`azure` identities do not establish that a password already existed, and a frontend check cannot enforce the required OAuth-only restriction.
- An enabled Okta control opens the customer organization form; the supplied screenshot shows the disabled Coming Soon state. Microsoft presentation continues to respect its existing feature flag.
- Expanded forms and errors can increase page height. Desktop padding reserves space beneath the fixed wordmark, preventing overlap while retaining natural scrolling. No horizontal overflow was observed from 320px through 1875px.
- Placeholder, divider and eyebrow text use the existing secondary-text token for accessible contrast. Measured ratios were 6.40:1, 7.20:1 and 6.53:1 respectively; labels measured 7.20:1 and primary-button text 9.11:1. Decorative animation is retained; screenshots freeze it using the existing reduced-motion preference, so logo/bar proportions can differ from another animation frame.

### Verification executed after the final source edit

| Check | Result |
| --- | --- |
| `npm test` (unchanged command covering authentication and onboarding tests) | 20 passed; 0 failed, skipped or cancelled |
| `npm run typecheck`, `npm run lint`, `npm run build` | All passed |
| Browser authentication regression, actual installed SDK with Auth/API transport intercepted | 10 scenario groups passed; 0 failed/skipped/page errors. Includes signup confirmation, password login/restoration/logout, Azure/email-scope routing, provider discovery, callback exchange under StrictMode, callback failures and invitation-only SSO onboarding |
| Browser cancellation regression with controlled clock/held responses | 5 groups passed; 0 failed/skipped/page errors. Includes never-resolving discovery, ten-second timeout, retry, cancellation then Microsoft, SPA unmount and late SDK redirect protection |
| Browser visual/accessibility checks | 44 checks passed; 0 failed/skipped/page errors. Includes real font loading, blocked-font fallback, keyboard order, disclosure/focus/ARIA/error associations, reduced/normal motion, contrast, collapsed and expanded/error layouts, absent recovery route and protected `/admin` |
| Visual inspection | Compared supplied screenshot with rendered 1875×915 desktop, 834×1112 tablet and 390×844 mobile captures; also checked 1280px, 1024px and 320px layouts. The split-panel brand design is retained; deliberate differences are listed above |
| Full backend regression plus startup/OpenAPI | 220 methods passed; 0 failures/errors; 13 methods and one fixture class skipped. Unittest reported `Ran 233 tests in 19.805s`, `OK (skipped=14)`. Three startup/OpenAPI assertions passed; 32 paths |
| Optional whole-app UI convention audit, strict mode | Exit 1: 9 existing findings in unchanged TopBar/AdminDashboard/Datasets/Lineage/SettingsMembers/global scrollbar code; none in the changed login. Unrelated cleanup was not performed; no claim of whole-app accessibility/design compliance |

Browser evidence was captured with headless Edge using the existing local Playwright harnesses. Auth and business API responses were simulated. The visual run allowed public Google font downloads; it did not contact real Supabase Auth or an IdP. These results do not verify hosted authentication, email delivery, RLS or production performance. The database integration skips remain intentional because no authorized isolated PostgreSQL fixture was supplied. No screen-reader, physical-device or full assistive-technology audit was performed.

Incremental source scope: modified `Frontend/tibbou-data-flow/src/pages/Login.jsx`, `Frontend/tibbou-data-flow/index.html`, this document and `Testing/README.md`; created `Frontend/tibbou-data-flow/src/pages/login-page.css`. Review screenshots, browser harnesses/results and preservation hashes were stored outside the worktree with the local login reconciliation artifacts.

The combined local source is ready for independent code review. Password recovery and all existing hosted/RLS/production admission gates remain deferred. Changes remain uncommitted; no hosted configuration, provider, database, credential or external application state was changed.


## Final code review corrections

Both approved Ponytail findings have focused local corrections. The earlier CodeRabbit review reported zero issues; these new corrections have not been submitted for another CodeRabbit review. Nothing has been committed or enabled externally.

### Workspace recovery

Organization-discovery errors and connection-check errors now share a recovery interface in `WorkspaceGate.jsx`. Retry calls the existing organization `refresh()` action and repeats the connection check; Sign out uses the existing Auth action. An immediate request guard and disabled controls prevent duplicate submissions. Errors are safe, pending state is announced, rejected promises are handled, and failed refreshes keep recovery available. Organization errors take precedence over a pending connection check. Existing request-version checks and connection-effect cleanup continue to ignore stale responses.

The installed Supabase Auth SDK 2.112.1 clears the browser session even when server sign-out returns an error. A small Auth-context warning therefore survives the resulting route change and appears in the existing login error area: server sign-out could not be confirmed and other sessions may remain active. An unexpected rejected sign-out promise is also converted to a safe error result; if local cleanup fails, workspace recovery stays available. No failed sign-out is described as confirmed server revocation. Successful sign-in clears the warning. Existing SDK sign-out scope and session behavior are preserved; no replacement Auth client or token-restoration fallback was added.

Backend JWT validation, Auth identity resolution, provider binding, membership/role/invitation enforcement, database/RLS/migrations, flags, provider routing, PKCE and the hardened callback are unchanged. Login presentation is unchanged apart from the necessary safe sign-out warning. Password recovery remains deferred.

### Browser regressions retained in Git

`Frontend/tibbou-data-flow/test/browser/` now contains the portable suite, service fixtures, a test-only Strict Mode entry and running instructions. From the frontend directory:

```sh
node --test test/browser/auth.test.cjs
```

The suite uses the existing Node test runner and Playwright approach, without dependency, lockfile or package-script changes. It requires an already installed Playwright runtime/browser; see [browser test setup](../Frontend/tibbou-data-flow/test/browser/README.md) for normal resolution or an external runtime. It starts/stops its own loopback Vite servers on dynamically selected ports. Dummy settings apply only to those test processes. All Auth/business responses are intercepted, test sessions are synthetic, unexpected requests fail, and no hosted service is used.

The suite exercises actual Login/AuthCallback/Onboarding/workspace component wiring, password/signup and Microsoft routing, enabled/disabled Okta, deadline/cancellation/unmount/late responses/retry, Strict Mode single exchange, session restoration/logout, invitation-only onboarding, 403/503 recovery and continuing denials, duplicate actions, rejected promises, failed server sign-out, connection recovery and stale refreshes. Responsive checks cover 1875px, 834px and 320px expanded/error login layouts, reduced decorative motion, and a keyboard-operable 390px recovery screen.

### Verification

| Check | Result |
| --- | --- |
| Focused browser recovery selection | 13 passed; 0 failed/skipped/cancelled |
| Full portable browser suite | 27 passed; 0 failed/skipped/cancelled; no unexpected browser errors or unmocked service requests |
| Existing `npm test` | 20 passed; 0 failed/skipped/cancelled |
| Type checking, lint, production build | All passed |
| Full offline backend suite | 220 methods passed; 0 failures/errors; 13 methods and one fixture class skipped. Unittest reported 233 tests and `skipped=14` |
| Startup/import/OpenAPI | 3 assertions passed; 32 paths; no database or Auth service call |
| Browser-only wiring mutations | All four detected: broken login lookup, duplicate callback exchange, disabled SAML presentation detection, and retry disconnected from organization refresh. Each selected test failed as expected; mutation source-file hashes were unchanged |
| Optional whole-app UI convention audit | Exit 2, nine existing findings outside these corrections: five native-select ownership decisions and four form/textarea/scrollbar conventions. No changed runtime file was flagged; unrelated cleanup remains deferred |

Before correction, both reproduced organization errors showed no Retry/Sign out actions and `/login` redirected back to the error. After correction, both offer recovery, Retry succeeds once service access is restored, continuing denials remain denied, and Sign out reaches login. There is no automatic logout on Auth outages.

The first browser run exposed the SDK's failed-sign-out cleanup behavior and failed one test; the warning handoff corrected it. An added responsive test initially confused short focus transitions with ongoing decorative animation; the assertion now checks CSS animations specifically, without changing application styling. Final results above are from passing runs.

Incremental scope is four runtime files (`WorkspaceGate.jsx`, `OrganizationContext.jsx`, `AuthContext.jsx`, `Login.jsx`), four browser-test files, and this record plus `Testing/README.md`. Existing SSO work and all backend/database source are preserved. No new packages, package scripts, migrations, hosted configuration or production infrastructure were introduced.

The combined source is ready for human review and a separately approved local commit. Real two-provider SAML/Supabase behavior, real password/Entra authentication, isolated PostgreSQL/RLS/ownership concurrency and representative production admission/performance gates remain unverified and mandatory before rollout. Browser mocks do not satisfy them.
