# Tibbou

Tibbou is a tenant-aware data lineage and Snowflake usage service. The application uses a React/Vite browser client, Supabase Auth, FastAPI, SQLAlchemy/Alembic, PostgreSQL, and a lightweight database-backed ingestion worker.

## Architecture

```text
React/Vite ── Supabase Auth (email/password) ──► FastAPI
                                                     │
                                                     ├──► Supabase Postgres
                                                     │      tenant-scoped rows + RLS
                                                     │
                                                     └──► queued sync_runs
                                                               │
Worker ◄────────────────────────────────────────────────────────┘
  ├── dbt artifact reconciliation
  └── customer-owned Snowflake account
```

Interactive API requests never execute Snowflake SQL. They enqueue a run and return `202 Accepted`; `python -m app.worker` processes queued work separately.

## Security model

- Supabase `auth.users` is the identity source. The old local password table is deprecated and unused.
- FastAPI verifies asymmetric Supabase access tokens through the project JWKS endpoint and rejects HS256 tokens.
- Every business route is versioned and organization-scoped under `/api/v1/organizations/{organization_id}`.
- Organization roles are `owner`, `admin`, `operator`, and `viewer`. Authentication and membership authorization are checked separately.
- PostgreSQL RLS mirrors the application boundary. The migration enables and forces RLS on tenant tables.
- The browser receives only a Supabase publishable key. Never use a secret or service-role key in Vite variables.
- Snowflake connection rows contain only non-secret metadata and a secret-manager reference. Query text and private keys are not stored in PostgreSQL.

## Backend development

```powershell
cd Backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
alembic upgrade head
uvicorn app.main:app --reload
```

Run the worker in another process with `python -m app.worker`. Run local checks with `python -m unittest discover -s tests -v`. Database migration commands are intentionally deferred during Phase 1 authentication recovery.

## Frontend development

```powershell
cd Frontend\tibbou-data-flow
npm install
Copy-Item .env.example .env
npm run dev
```

Verification commands are `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit`.

## Required Supabase setup

1. Rotate the previously exposed database credential before using the project.
2. The connected project is active; do not restore, pause, branch, reset, or otherwise change its project state during Phase 1.
3. Do not apply, stamp, downgrade, or edit database migrations during Phase 1. Schema and RLS work is deferred to a separately authorized phase.
4. The connected project currently publishes an ES256 signing key, which matches the API's allowed asymmetric algorithms. The API intentionally rejects shared-secret JWTs.
5. For Phase 1, enable Supabase email/password Auth and configure `http://localhost:5173` plus `/auth/callback` in the allowed local URLs. Entra and Okta remain disabled roadmap items.
6. Use a constrained non-owner runtime database login. Keep migration credentials separate.
7. Test RLS with two users in different organizations before deployment.

The frontend SSO flags control presentation only and do not configure or validate an identity provider. Entra, Okta, SAML connections, and provider-to-organization routing are deferred and are not created by Phase 1 code.

## Snowflake onboarding

Each Tibbou organization connects its own Snowflake account. Prefer External OAuth or workload identity; use a dedicated `TYPE=SERVICE` key-pair user only as a fallback. Grant a dedicated role only the required `SNOWFLAKE` database roles (`USAGE_VIEWER`, `OBJECT_VIEWER`, and optionally `GOVERNANCE_VIEWER`) plus `USAGE` on an approved warehouse.

The worker reads `QUERY_ATTRIBUTION_HISTORY` and, when the customer edition permits, `ACCESS_HISTORY`. Exact physical relation matches produce equal-weight allocations whose total is one. Accounts without `ACCESS_HISTORY` complete with `partial` status and retain unallocated query credits rather than inventing lineage.

Local development can resolve a connection's secret reference through `SNOWFLAKE_SECRET_<REFERENCE>_*` environment variables. `APP_ENV=production` disables that resolver: a deployment-specific managed secret provider must be supplied before production Snowflake runs.

See [production readiness](Docs/production-readiness.md) for rollout gates and the [ERD](Docs/erd.md) for the schema.
