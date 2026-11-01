# Tibbou testing

This page points to the real tests and records what was verified. Executable tests stay with the backend, frontend, or database code that uses them.

October 25, 2026: the [selective login reconciliation record](../Documentation/okta-enterprise-sso.md#selective-login-presentation-reconciliation--october-25-2026) covers the approved branded UI with password recovery deliberately omitted. All 20 frontend tests, type checking, lint and build passed; 10 browser authentication groups, 5 cancellation groups and 44 visual/accessibility checks passed. Backend regression: 220 passed, 0 failed/errors, 13 methods and one fixture class skipped. Browser Auth/API responses were simulated; no hosted SSO, RLS or production-capacity success is claimed. The optional whole-app UI audit retains 9 findings outside the changed login.

October 22, 2026: [Enterprise SSO local implementation evidence and rollout gates](../Documentation/okta-enterprise-sso.md) records the current backend run: 220 passed, 0 failed, 13 database test methods and one fixture class skipped (`233 tests`, `skipped=14` in unittest's summary). All 20 frontend tests, type checking, lint, build, eight browser regression groups and five cancellation groups passed. Three inverted organization-filter mutations were detected without editing production source. The ownership Auth fixture is repaired; real database concurrency/RLS, hosted two-provider SSO and production admission/performance gates remain unverified. The historical results below do not verify those gates.

| Check | Command and location | Result |
| --- | --- | --- |
| Backend tests | From `Backend`: `python -m unittest discover -s tests -v` | `Ran 53 tests` and `OK (skipped=6)`. The local database integration tests were skipped before connecting because their required marker and URL were absent. |
| Alembic path and head | From the repository root: `python -m alembic -c Database/alembic.ini heads` | Passed. The head is `20260910_120000`. |
| Backend import and OpenAPI | Imported `app.main`, built the OpenAPI schema, and checked the health and organization paths. | Passed. |
| Backend Ruff lint | From `Backend`: `python -m ruff check app tests` | Skipped. Ruff is listed in `requirements-dev.txt` but is not installed in the current Python environment. No dependencies were installed during this work. |
| Frontend tests | From `Frontend/tibbou-data-flow`: `npm test` | 3 passed and 0 failed. |
| Frontend type checking | `npm run typecheck` | Passed. |
| Frontend lint | `npm run lint` | Passed. |
| Frontend build | `npm run build` | Passed. |
| Frontend dependency audit | `npm audit` | 0 vulnerabilities found. |

## Test locations and cases

| Area | Test location | Cases verified in the current automated run |
| --- | --- | --- |
| Authentication | [`Backend/tests/test_auth.py`](../Backend/tests/test_auth.py) | 3 passed. ES256 validation, shared-secret rejection, and safe JWKS failure handling. |
| Organization invitations | [`Backend/tests/test_organization_invitations.py`](../Backend/tests/test_organization_invitations.py) | 10 passed. Role limits, email rules, visibility, acceptance, and rollback. |
| Admin access | [`Backend/tests/test_admin_dashboard.py`](../Backend/tests/test_admin_dashboard.py) | 3 passed. Owner and admin access, lower-role denial, and organization filtering. |
| API security | [`Backend/tests/test_api_security.py`](../Backend/tests/test_api_security.py) | 5 passed. Authentication, private routes, upload limits, and tenant-scoped OpenAPI routes. |
| Ingestion | [`Backend/tests/test_ingestion.py`](../Backend/tests/test_ingestion.py) | 6 passed. dbt resources, secret references, cost allocation, query limits, deactivation, and idempotency. |
| Migration contracts | [`Backend/tests/test_tenancy_migration_contract.py`](../Backend/tests/test_tenancy_migration_contract.py) | 21 passed. Revision order, migration safety, RLS, grants, and rollback contracts. |
| Local database integration | [`Backend/tests/test_tenancy_rls_integration.py`](../Backend/tests/test_tenancy_rls_integration.py) | Not rerun. The isolated local Supabase marker and database URL were not available. |
| RLS SQL scenario | [`Database/tests/tenancy_rls_scenarios.sql`](../Database/tests/tenancy_rls_scenarios.sql) | Not rerun because the isolated local Supabase environment was not available. |
| Frontend authentication settings | [`Frontend/tibbou-data-flow/test/authConfig.test.js`](../Frontend/tibbou-data-flow/test/authConfig.test.js) | 3 passed. Disabled default, Azure and PKCE options, and callback errors. |

## Previous manual and integration evidence

These checks were completed during the SSO organization onboarding review.

- An existing Microsoft user authenticated successfully.
- A new Entra test user authenticated successfully and reached the expected no-membership onboarding state.
- The isolated local PostgreSQL RLS integration suite passed 10/10.

The previous RLS result is kept as testing history. The current automated result is listed separately above so it is clear which checks were rerun.


## Final SSO review corrections

Workspace recovery and the portable browser suite are documented in [the correction record](../Documentation/okta-enterprise-sso.md#final-code-review-corrections). Run the separate browser checks using [their setup instructions](../Frontend/tibbou-data-flow/test/browser/README.md). Final results: 27 browser tests and 20 unit tests passed; type checking, lint and build passed. Backend: 220 passed, 0 failures/errors, 13 methods plus one fixture class skipped. Four intentional browser wiring mutations were detected without changing source. All service fixtures are synthetic; hosted authentication, PostgreSQL/RLS and production-capacity gates remain open.
