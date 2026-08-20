# Production readiness gates

This repository contains the application-side foundation. The following external operations were intentionally not performed during implementation.

## Must complete before deployment

- Rotate the exposed Supabase database credential and historical Snowflake key. Scan remote history, shared archives, CI variables, and deployments.
- Reconcile and commit the current dirty/divergent repository as one reviewed baseline.
- Restore the inactive Supabase project only under an approved change, inspect live drift, back it up, and then apply the migration.
- Configure asymmetric Supabase Auth signing, Azure/Entra, allowed callbacks, and production URLs.
- Create separate migration, API-runtime, and worker database logins. Runtime roles must not be owners, superusers, or `BYPASSRLS`.
- Implement the deployment's managed-secret adapter. Production deliberately rejects the development environment resolver.
- Configure a worker service and scheduler. Start with hourly query usage, six-hourly lineage/attribution reconciliation, and daily billing reconciliation.
- Add deployment-specific throttling, structured restricted logs, metrics, alerting, backups, and retention jobs.

## Verify against live infrastructure

- Apply and downgrade the migration in a disposable PostgreSQL/Supabase environment.
- Test API authorization and PostgreSQL RLS independently with two organizations and all roles.
- Verify Entra login, callback, logout, disabled-user behavior, tenant restriction, and email claim handling.
- Validate a least-privilege Snowflake service identity without `ACCOUNTADMIN` or broad `MONITOR USAGE`.
- Exercise accounts with and without Enterprise `ACCESS_HISTORY` and confirm `partial` capability reporting.
- Assert that every query's allocation weights sum to exactly one and totals reconcile to stored credits.
- Load-test representative manifests at configured limits and verify retry/idempotency behavior.

## External or tier-dependent

- Supabase SAML connections, IdP assignment, and provider-to-organization routing.
- Entra registration, tenant consent, credential rotation, and Conditional Access.
- Customer Snowflake users, roles, grants, OAuth integrations, workload identity, key rotation, and revocation.
- Object storage/KMS policies, retention, compliance controls, SLAs, and disaster recovery.

## Known implementation boundary

The worker normalizes dbt current-state lineage and Snowflake per-query attribution. It does not yet ingest warehouse idle credits, currency billing, columns, or declared `OBJECT_DEPENDENCIES`; add those as independently checkpointed sync types after target editions and allocation rules are agreed. SAML provisioning, invitations, SCIM, quotas, and self-service Snowflake setup-script generation also remain later product work.
