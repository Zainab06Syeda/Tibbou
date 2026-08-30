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

Enable email and password authentication in the Supabase project. 
Configure http://localhost:5173 as an allowed local URL and add http://localhost:5173/auth/callback as an allowed redirect URL.
Use the same Supabase project for the backend and frontend environment settings. Keep database credentials and other private values out of Git.


See the [ERD](Docs/erd.md) for the database schema and relationships.
