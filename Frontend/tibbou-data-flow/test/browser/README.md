# Authentication browser regressions

Run from `Frontend/tibbou-data-flow`:

```sh
node --test test/browser/auth.test.cjs
```

This is separate from `npm test`. It uses Node's existing test runner and the same Playwright browser approach used for the SSO implementation. No application dependency, lockfile or package script is changed.

## Prerequisites

- Node.js 22 or later and the frontend dependencies already installed using the repository's normal setup.
- An existing Playwright runtime with `page.clock` support, plus its Chromium browser or an installed Chrome/Edge channel. The suite does not install packages or download browsers.
- By default, normal Node module resolution finds `playwright`, and Playwright selects its installed Chromium. If your test tooling supplies Playwright elsewhere, set `TIBBOU_PLAYWRIGHT_MODULE` to that existing package directory. Do not copy a developer-specific path into the tests.

For example, PowerShell can use an existing external runtime and Edge:

```powershell
$env:TIBBOU_PLAYWRIGHT_MODULE = 'C:\path\to\existing\node_modules\playwright'
$env:TIBBOU_BROWSER_CHANNEL = 'msedge'
node --test test/browser/auth.test.cjs
```

`TIBBOU_BROWSER_CHANNEL=chrome` selects installed Chrome. Leave it unset for Playwright's Chromium. These are test-process settings, not application configuration.

Run only recovery checks:

```sh
node --test --test-name-pattern="workspace|retry|sign out|sign-out|connection" test/browser/auth.test.cjs
```

Set `TIBBOU_BROWSER_ARTIFACTS` to an output directory to capture representative desktop and mobile recovery screenshots. No screenshots, session exports or request logs are written by default.

## Isolation and coverage

The suite starts and stops two loopback Vite servers from this checkout on dynamically selected ports. It overrides Auth URLs, public-key placeholders, API routing and feature flags in those child processes only. It does not reuse running servers or require `.env` changes. The production entry point is unchanged; `strict-entry.jsx` mounts the actual `App` under React Strict Mode for the relevant tests.

Every Auth and business API response is intercepted. Session values, account IDs and passwords are synthetic browser fixtures, generated or held in memory; no real credentials or tokens are needed. No hosted Auth, Okta, Entra, database, email or Snowflake operation occurs. Unexpected API/external requests and browser errors fail the test. Public font requests are blocked.

Coverage includes password login/signup, Azure routing, enabled/disabled Okta, organization disclosure and provider selection, discovery failure/deadline/cancellation/retry/unmount, late SDK redirects, callback errors and Strict Mode exchange, session restoration/logout, invitation-only SAML onboarding, 403/503 recovery, continuing denials, duplicate submissions, rejected promises, failed server sign-out, connection failures and stale organization refresh responses.

The installed SDK may clear the browser session even when server sign-out fails. Tests require an honest warning on the login screen in that case; they do not assert remote session revocation. A local storage failure instead leaves the error recovery screen available. Neither failure changes backend access rules.

These are real browser/component executions with simulated services. They do not establish hosted authentication, email delivery, PostgreSQL/RLS, two-provider tenant isolation or production capacity. Those remain separate acceptance gates.
