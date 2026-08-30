# Tibbou

## Purpose

Tibbou is a tenant-aware service for viewing data lineage and attributing Snowflake query usage to datasets. It includes a browser interface, an API, PostgreSQL storage, and a database-backed ingestion worker.

## Technologies

- Frontend: React, Vite, Tailwind CSS, and Supabase JS
- Backend: FastAPI, SQLAlchemy, Alembic, and Pydantic
- Database and authentication: PostgreSQL and Supabase Auth
- Data integration: dbt `manifest.json` artifacts and the Snowflake Python connector

## Repository layout

```text
Backend/
  app/                  FastAPI routes, models, schemas, services, and worker
  alembic/versions/     Database migrations
  tests/                Backend tests and RLS scenarios
Frontend/
  tibbou-data-flow/     React and Vite application
Docs/
  erd.md                Database design and relationships
README.md               Project setup and operating instructions
```

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

API requests do not run Snowflake SQL directly. They queue a run and return `202 Accepted`. The `python -m app.worker` process handles queued work separately.

## Security model

- Supabase `auth.users` is the identity source. The old local password table is deprecated and unused.
- FastAPI verifies asymmetric Supabase access tokens through the project JWKS endpoint and rejects HS256 tokens.
- Every business route is versioned and organization-scoped under `/api/v1/organizations/{organization_id}`.
- Organization roles are `owner`, `admin`, `operator`, and `viewer`. Authentication and membership authorization are checked separately.
- PostgreSQL RLS mirrors the application boundary. The migration enables and forces RLS on tenant tables.
- The browser receives only a Supabase publishable key. Never use a secret or service-role key in Vite variables.
- Snowflake connection rows contain only non-secret metadata and a secret-manager reference. Query text and private keys are not stored in PostgreSQL.

## Installation

### Backend

```powershell
cd Backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

Set the values in `Backend/.env` for the PostgreSQL database and Supabase project used for local development.

### Frontend

```powershell
cd Frontend\tibbou-data-flow
npm install
Copy-Item .env.example .env
```

Set the values in `Frontend/tibbou-data-flow/.env` for the API and Supabase project used for local development.

## Run the application

Start the backend API from `Backend`:

```powershell
.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

Queued ingestion requires a second backend process:

```powershell
.venv\Scripts\Activate.ps1
python -m app.worker
```

Start the frontend from `Frontend/tibbou-data-flow`:

```powershell
npm run dev
```

Open the local URL printed by Vite.

## Testing

Run the backend test suite from `Backend`:

```powershell
.venv\Scripts\Activate.ps1
python -m unittest discover -s tests -v
```

Run the existing frontend checks from `Frontend/tibbou-data-flow`:

```powershell
npm run typecheck
npm run lint
npm run build
npm audit
```

The frontend currently has no separate unit-test script.

## Required Supabase setup

1. Rotate the previously exposed database credential before using the project.
2. The connected project is active; do not restore, pause, branch, reset, or otherwise change its project state during Phase 1.
3. Do not apply, stamp, downgrade, or edit database migrations during Phase 1. Schema and RLS work is deferred to a separately authorized phase.
4. The connected project currently publishes an ES256 signing key, which matches the API's allowed asymmetric algorithms. The API intentionally rejects shared-secret JWTs.
5. For Phase 1, enable Supabase email/password Auth and configure `http://localhost:5173` plus `/auth/callback` in the allowed local URLs. Entra and Okta remain disabled roadmap items.
6. Use a constrained non-owner runtime database login. Keep migration credentials separate.
7. Test RLS with two users in different organizations before deployment.

The frontend SSO flags only control the UI. They do not configure or validate an identity provider. Phase 1 does not create Entra, Okta, SAML connections, or provider-to-organization routing.

## Snowflake onboarding

Each Tibbou organization connects its own Snowflake account. Prefer External OAuth or workload identity; use a dedicated `TYPE=SERVICE` key-pair user only as a fallback. Grant a dedicated role only the required `SNOWFLAKE` database roles (`USAGE_VIEWER`, `OBJECT_VIEWER`, and optionally `GOVERNANCE_VIEWER`) plus `USAGE` on an approved warehouse.

The worker reads `QUERY_ATTRIBUTION_HISTORY` and, when available for the customer's edition, `ACCESS_HISTORY`. Exact physical relation matches receive equal allocation weights that add up to one. Accounts without `ACCESS_HISTORY` finish with `partial` status and keep query credits unallocated instead of inventing lineage.

Local development can resolve a connection's secret reference through `SNOWFLAKE_SECRET_<REFERENCE>_*` environment variables. `APP_ENV=production` disables that resolver: a deployment-specific managed secret provider must be supplied before production Snowflake runs.

See the [ERD](Docs/erd.md) for the database schema and relationships.
