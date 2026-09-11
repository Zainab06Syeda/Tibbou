# Tibbou

## Purpose

Tibbou is a tenant-aware service for viewing data lineage and attributing Snowflake query usage to datasets. It includes a browser interface, an API, PostgreSQL storage, and a database-backed ingestion worker.

## Technologies

- Frontend: React, Vite, Tailwind CSS, and Supabase JS
- Backend: FastAPI, SQLAlchemy, Alembic, and Pydantic
- Database and authentication: PostgreSQL and Supabase Auth
- Data integration: dbt `manifest.json` artifacts and the Snowflake Python connector

## Installation and setup

### Backend

```powershell
cd Backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

Set the values in `Backend/.env` for the PostgreSQL database and Supabase project used for local development.

### Supabase

Enable email and password authentication with **Confirm Email enabled**. Confirmed email is a required rollout prerequisite because organization invitations match the signed-in user's exact email. Set the Site URL to `http://localhost:5173` and allow `http://localhost:5173/auth/callback` as a redirect URL.

Microsoft Entra sign-in is implemented but defaults off. After configuring and verifying the Azure provider in Supabase, set `VITE_ENABLE_ENTRA_SSO=true` in the frontend environment. Keep the Entra client secret only in Entra and Supabase; never place it in frontend variables or Git. Okta and SAML remain deferred.

Use the same Supabase project in the backend and frontend environment files. Keep database credentials and other private values out of Git.

### Organization provisioning

Self-service organization creation is disabled. A trusted platform operator provisions a new customer organization and its initial owner directly in PostgreSQL using one transaction:

1. Verify the owner's existing Supabase `auth.users.id`.
2. Insert the organization with that user as `created_by`.
3. Insert the matching `organization_memberships` row with role `owner`.
4. Verify the organization and exactly one initial owner before committing.

Do not perform this against a hosted database without an approved backup, reviewed SQL, and explicit authorization. After bootstrap, owners and administrators onboard members only through exact-email invitations in the application. Microsoft and email/password users accept invitations through the same flow; organization membership, not provider or domain metadata, grants access.

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
npm test
npm run typecheck
npm run lint
npm run build
npm audit
```
