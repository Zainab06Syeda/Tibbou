# AGENTS.md

## Project

Tibbou is a full-stack prototype for data lineage and Snowflake usage and cost visibility. It uses:

- React and Vite for the frontend
- FastAPI, SQLAlchemy, Alembic, and Pydantic for the backend
- Supabase Auth and PostgreSQL
- dbt `manifest.json` and Snowflake-derived metadata

Verify this summary against the repository. Preserve working MVP behavior and avoid overengineering.

## Working rules

Inspect the repository, Git status, relevant code, and migrations before editing.

Follow the current task's scope. Make the smallest coherent change; defer adjacent work.

Preserve unrelated worktree changes. Do not refactor, upgrade dependencies, commit, push, deploy, or change external systems unless authorized.

Verify assumptions from code or connected services. Clearly label inference and anything unverified.

If instructions conflict, stop and explain; do not bypass them without explicit user direction.

Never expose secrets from files, history, logs, environment variables, or services.

## Database and external-system safety

The live Supabase database contains valuable test data generated from a former Snowflake trial. It is not disposable.

Never drop, truncate, reset, reseed, overwrite, bulk-delete, or transform live data without explicit authorization.

Do not apply, stamp, downgrade, rewrite, or edit applied migrations without explicit authorization.

Before an authorized live migration, review generated SQL and verify a usable backup/export of affected schema and valuable data. Stop if preservation cannot be verified.

Prefer additive, reversible migrations. State affected objects, locking/data effects, and rollback limitations.

Verify row counts and representative Snowflake-derived records before and after authorized data/schema changes.

Read-only access does not authorize mutation. State any proposed Supabase, Snowflake, identity-provider, or hosting change before performing it.

Never place database passwords, service-role/secret keys, Snowflake private keys, OAuth secrets, or credentials in frontend code, tracked files, logs, or reports.

## Authentication and data access

Do not assume Entra, Azure, Okta, OAuth/OIDC, or SAML is configured because code or UI mentions it.

Keep authentication separate from authorization. Resolve organization access from authoritative memberships, never email domain, frontend state, or user-editable metadata.

Unless the code or task says otherwise, the browser uses Supabase for Auth and FastAPI for business data.

Validate Supabase JWT signature, issuer, audience, expiration, and allowed algorithm. Never weaken validation to make tests pass.

Backend database access must use least privilege and must not silently bypass RLS.

Request user/organization database context must come from validated identity and membership, be transaction-local, fail closed, and not leak through connection pooling.

Feature flags control presentation only. Missing provider flags must default to disabled, and disabled controls must make no requests.

## Code and verification

Preserve existing frameworks and project patterns unless the task explicitly changes architecture.

Keep models, schemas, migrations, and the live schema aligned.

Do not add placeholder runtime failures, unnecessary abstractions, infrastructure, tables, or files.

Return consistent, safe API and UI errors. Do not swallow exceptions or expose internal details.

Use existing commands. Do not install or upgrade dependencies unless authorized.

Review the final diff for scope and secret exposure.

Run relevant frontend lint/type-check/tests/build and backend import/startup/OpenAPI checks.

For auth, test session creation/restoration, logout, protected access, and invalid tokens.

For tenancy, test two users/two organizations and explicit cross-tenant read/write attempts.

For migrations, verify revision, schema, grants, policies, preserved records, and rollback expectations.

Report exact files changed, commands/tests and results, assumptions, manual steps, deferred work, and whether any database or external state changed.

Never claim end-to-end success when real-service or external configuration testing was not completed.

## Output style

Be concise and practical.
Prefer short summaries over long explanations.
Show exactly what changed and how it was verified.
