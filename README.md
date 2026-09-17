# Tibbou

## What Tibbou does

Tibbou helps teams view data lineage and understand Snowflake usage and cost by dataset. It has a web interface, a FastAPI backend, PostgreSQL storage, Supabase authentication, and an ingestion worker for dbt and Snowflake data.

## Repository structure

- `Frontend/` contains the React application.
- `Backend/` contains the API, worker, and backend tests.
- `Database/` contains Alembic migrations and the RLS SQL test scenario.
- `Documentation/` contains the [database schema](<Documentation/Diagrams (Cap 2)/database-schema.md>).
- `Testing/` contains the [test index and detailed evidence](Testing/README.md).
- `README.md` and `CONTRIBUTIONS.md` at the root.

## Tech Stack

- Frontend: React, Vite, Tailwind CSS, and Supabase JS
- Backend: FastAPI, SQLAlchemy, Alembic, and Pydantic
- Database and authentication: PostgreSQL and Supabase Auth
- Data integration: dbt `manifest.json` files and the Snowflake Python connector

## Installation

### Backend

```powershell
cd Backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

Set the local PostgreSQL and Supabase values in `Backend/.env`.

### Database

With the backend virtual environment active, run Alembic from the repository root:

```powershell
python -m alembic -c Database\alembic.ini upgrade head
```

Only run migrations against the database you intend to update. The database design is shown in [Documentation/Diagrams (Cap 2)/database-schema.md](<Documentation/Diagrams (Cap 2)/database-schema.md>).

### Frontend

```powershell
cd Frontend\tibbou-data-flow
npm install
Copy-Item .env.example .env
```

Set the API and Supabase values in `Frontend/tibbou-data-flow/.env`.

### Supabase authentication

Use the same Supabase project in both environment files. Email confirmation must be enabled because invitations match the signed-in user's email.

Microsoft Entra sign-in is available but disabled by default. After the Azure provider is configured in Supabase, set `VITE_ENABLE_ENTRA_SSO=true` in the frontend environment. Keep the Entra client secret in Entra and Supabase, not in the frontend or Git.

Self-service organization creation is disabled. A trusted operator creates the first organization and owner. Owners and administrators can then invite members by exact email address. Organization membership controls access.

## Run the application

Start the API from `Backend`:

```powershell
.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

Start the ingestion worker in a second terminal from `Backend`:

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

The automated results were verified on September 13, 2026. Previous manual and integration results are labeled separately. See [Testing/README.md](Testing/README.md) for the full test index and evidence.

| Area | What and why | Command used | Actual result | Evidence |
| --- | --- | --- | --- | --- |
| Authentication | Accepted ES256 tokens, rejected shared-secret tokens, and handled JWKS failure safely. This protects API sessions. | `cd Backend; python -m unittest discover -s tests -v` | 3 authentication tests passed. | [`test_auth.py`](Backend/tests/test_auth.py) |
| Microsoft SSO and frontend tests | Checked the disabled default, Azure settings, PKCE callback, and provider errors. Manual sign-in checked the real flow. | `npm test` and manual browser sign-in | 3 automated tests passed. In previous manual testing, an existing Microsoft user signed in, and a new Entra user reached the expected no-membership state. | [`authConfig.test.js`](Frontend/tibbou-data-flow/test/authConfig.test.js) and [detailed evidence](Testing/README.md) |
| Organization invitations | Checked role limits, email matching, private visibility, atomic acceptance, and rollback. | `cd Backend; python -m unittest discover -s tests -v` | 10 tests passed. | [`test_organization_invitations.py`](Backend/tests/test_organization_invitations.py) |
| Admin access | Checked owner and admin access, blocked lower roles, and hid other organizations. | `cd Backend; python -m unittest discover -s tests -v` | 3 tests passed. | [`test_admin_dashboard.py`](Backend/tests/test_admin_dashboard.py) |
| API security | Checked bearer-token requirements, private database health, upload limits, and tenant-scoped routes. | `cd Backend; python -m unittest discover -s tests -v` | 5 tests passed. | [`test_api_security.py`](Backend/tests/test_api_security.py) |
| Migration contracts | Checked revision order, safe constraints, RLS rules, grants, and rollback behavior. | `cd Backend; python -m unittest discover -s tests -v` | 21 tests passed. Alembic reported `20260910_120000` as the head. | [`test_tenancy_migration_contract.py`](Backend/tests/test_tenancy_migration_contract.py) |
| RLS and organization isolation | Checked migration RLS contracts. Runtime tests require an isolated local Supabase database. | Backend test command | Contract tests passed. The current runtime rerun was skipped because the required local test settings were absent. A prior isolated run passed 10/10. | [`test_tenancy_rls_integration.py`](Backend/tests/test_tenancy_rls_integration.py) and [RLS SQL scenario](Database/tests/tenancy_rls_scenarios.sql) |
| Lint | Checked frontend source for configured ESLint errors. | `npm run lint` | Passed. | [`eslint.config.js`](Frontend/tibbou-data-flow/eslint.config.js) |
| Type checking | Checked JavaScript and JSX types without writing files. | `npm run typecheck` | Passed. | [`jsconfig.json`](Frontend/tibbou-data-flow/jsconfig.json) |
| Build | Checked that Vite creates a production build. | `npm run build` | Passed. | [`package.json`](Frontend/tibbou-data-flow/package.json) |
| Dependency audit | Checked installed frontend packages for known npm vulnerabilities. | `npm audit` | 0 vulnerabilities found. | [`package-lock.json`](Frontend/tibbou-data-flow/package-lock.json) |
