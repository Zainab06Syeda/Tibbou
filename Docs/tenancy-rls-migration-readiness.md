# Tenancy/RLS migration readiness

Assessment date: 2026-08-19. This is a read-only Phase 2 assessment. No hosted
database, Auth, project setting, or other external state was changed.

## Outcome

**Not ready for live rollout yet.** Revision 20260818_120000 is now a safer
local expand/security migration, but rollout still requires an independently
verified backup, least-privilege database login roles, explicit selection of
the controlled Auth user and legacy organization, a local PostgreSQL/Supabase
policy test, and completion of real Phase 1 Auth/API testing.

## Verified hosted baseline

- Project dulvpwykcbctfiffxbsn is healthy in us-east-1 on PostgreSQL
  17.6.1.063. Its organization reports the Free plan.
- public.alembic_version contains exactly 20260408_203100. Supabase's separate
  migration list is empty. Local Alembic is linear:
  20260408_203100 -> 20260818_120000.
- The only public relations are alembic_version, datasets, lineage_edges,
  cost_snapshots, raw_ingestions, sync_runs, and the retired users table. All
  are owned by postgres; there are no public views, functions, triggers, or
  sequences.
- RLS and FORCE RLS are disabled on every public table and no policies exist.
  anon, authenticated, and service_role currently have all table privileges
  through permissive default ACLs. This is a critical pre-rollout exposure.
- postgres owns the tables and has BYPASSRLS; service_role also has BYPASSRLS.
  anon and authenticated do not.
- The live schema matches revision 20260408_203100 and has no organization,
  tenant, owner, or application-user columns.
- Auth has one confirmed, non-anonymous email user and one email identity.
  There are no SSO/SAML providers and no SSO users. No personal identifier was
  recorded here.

The Supabase table-list estimate incorrectly reported zero rows. Direct
count(*) queries are authoritative and confirmed valuable data:

| Table | Current | Evidence/relationships | Migration treatment | Expected after expand |
|---|---:|---|---|---:|
| datasets | 18 | 15 dbt, 2 lineage-test, 1 cost-test; sample UUID 0326dbfd-1588-49e1-8fb7-51f22c4a703b | Add nullable ownership and metadata; preserve IDs/values | 18 |
| lineage_edges | 10 | All depends_on; no missing endpoints or self edges | Add nullable ownership/defaulted metadata and indexes | 10 |
| cost_snapshots | 1 | References one dataset; no invalid period/negative amount | Add nullable ownership/checks/indexes | 1 |
| raw_ingestions | 16 | 10 Snowflake query-history, 6 dbt manifest; 14 match sync-run detail, 2 do not | Link 14; keep 2 legacy links null; create no synthetic rows | 16 |
| sync_runs | 16 | 10 Snowflake and 6 dbt; 14 success, 2 failed | Add queue columns; keep legacy requester null | 16 |
| retired users | 0 | Not Supabase Auth | Revoke access; FORCE RLS; no policies | 0 |
| organizations / memberships | 0 | Not present | Create empty; no invented owner/workspace | 0 |
| connection/query tables | 0 | Not present | Create empty | 0 |
| auth.users | 1 | Confirmed email identity | Unchanged | 1 |

All existing foreign-key relationships are valid. There are no duplicate
lineage keys, invalid cost checks, or unsupported existing statuses.

## Data flow and roles

Verified application flow:

Browser -> Supabase Auth -> access token -> FastAPI -> PostgreSQL

The frontend uses supabase-js only for Auth/session operations. Business calls
go through Frontend/tibbou-data-flow/src/api/tibbou.js to FastAPI. FastAPI
validates asymmetric JWT signature, issuer, audience, expiration, required
claims, allowed algorithm, and authenticated role before resolving an
authoritative membership.

The current backend URL uses the Supavisor session endpoint on port 5432 as
postgres.<project-ref>. It therefore runs as the table owner/BYPASSRLS role and
would evade policies even with FORCE RLS. Before rollout, the API and worker
must use separate login roles that inherit only tibbou_runtime and
tibbou_worker; migrations must retain a separate administrative connection.

FastAPI sets app.current_user_id and app.current_organization_id with
set_config(..., true), so context is transaction-local. Missing user,
organization, membership, role, or organization context makes helpers return
false. SQLAlchemy close/commit/rollback ends the transaction and prevents pool
leakage. Code that queries after a commit must re-establish validated context;
organization creation now does so before refresh.

## Authorization matrix

| Object | Viewer | Operator | Admin | Owner | Worker | Data API roles |
|---|---|---|---|---|---|---|
| Business SELECT | own organization | own organization | own organization | own organization | requested user's organization | none |
| Business INSERT/UPDATE/DELETE | deny | own organization | own organization | own organization | requested user's organization | none |
| Organizations SELECT | memberships | memberships | memberships | memberships | deny | none |
| Organizations INSERT | self as creator | same | same | same | deny | none |
| Memberships SELECT | organization members | same | same | same | deny | none |
| Non-owner membership changes | deny | deny | own organization | own organization | deny | none |
| Owner membership changes | deny | deny | deny | own organization; last owner protected | deny | none |
| retired users / alembic_version | deny | deny | deny | deny | deny | none |

Membership lookups use narrowly granted SECURITY DEFINER helpers in the
unexposed private schema to avoid recursive policies. Every helper has an empty
fixed search_path, checks session role and transaction-local identity/context,
and has PUBLIC/anon/authenticated/service_role execution revoked. Future views
must use security_invoker=true or remain unexposed with client grants revoked.

## Backup procedure required before Phase 3

No backup was created. The verified organization is on the Free plan; current
Supabase guidance does not promise automatic daily backups for Free projects
and recommends regular exports. Do not treat platform availability as a usable
pre-rollout backup.

On a secured workstation with approved PostgreSQL client tools, supply
credentials through a protected prompt/environment, never command history:

1. Set PGHOST, PGPORT, PGDATABASE, and PGUSER placeholders and supply
   PGPASSWORD through the approved secret mechanism.
2. Run pg_dumpall --roles-only --no-role-passwords to a timestamped globals SQL
   file.
3. Run pg_dump --schema-only to a timestamped schema/ACL SQL file.
4. Run pg_dump --format=custom for a full database dump.
5. Run two additional custom data-only dumps for public and auth so application,
   Snowflake-derived, and Auth recovery data can be verified independently.

The globals file covers custom roles/memberships; schema output covers grants,
functions, triggers, policies, migration history, and ownership declarations;
the custom dumps cover data. Custom-role passwords are not backed up and must
be re-established securely after restore.

Then:

1. Record tool/server versions, file sizes, SHA-256 hashes, restrictive file
   permissions, encryption, offsite copy, access list, and retention.
2. Inspect pg_restore --list and the schema file without printing data/secrets.
3. Restore to an isolated compatible PostgreSQL 17/Supabase environment, not
   live. Reconcile managed roles/schemas rather than overwriting them blindly.
4. Verify Alembic revision, objects, grants, RLS/policies, Auth count, the
   preservation matrix, sample UUIDs, foreign keys, and application login.
5. Record restore duration and obtain explicit approval that the restore is
   usable before any live migration.

## Proposed Phase 3 operations (not executed)

1. Complete live email/password session creation/restoration, logout,
   invalid-token, and protected-API tests. Keep Entra and Okta disabled.
2. Explicitly select the controlled confirmed Auth user and approve a real
   organization name, slug, and UUID. Never infer ownership from domain or
   metadata.
3. Create/approve separate API and worker login roles, grant only membership in
   tibbou_runtime/tibbou_worker, and prepare secret rotation. Keep the migration
   connection separate.
4. Execute and restore-verify the backup procedure above.
5. Freeze writes and workers. Re-query revision, counts, sample IDs,
   relationships, roles, grants, and blocking locks.
6. Regenerate/review offline SQL and apply only
   20260408_203100 -> 20260818_120000 with the migration connection.
7. Verify counts/IDs/relationships are unchanged, RLS is forced, helpers/grants
   match the matrix, legacy ownership is null, and Data API roles are denied.
8. In one reviewed transaction, insert the approved organization and first
   owner membership, assign that organization UUID to the five legacy business
   tables, and verify all 61 rows/relationships. Do not fabricate historical
   requested_by values.
9. Validate the five organization foreign keys/checks, then set their
   organization_id columns NOT NULL in a separately reviewed contract
   revision. Keep the two unmatched legacy raw_ingestions.sync_run_id values
   nullable until provenance is explicitly resolved.
10. Switch API/worker secrets to least-privilege logins, deploy, and test two
    users/two organizations, cross-tenant reads/writes, roles, first-owner
    bootstrap, worker context, pool reuse, and direct role denial.
11. Re-run Supabase advisors and the preservation matrix, then resume traffic
    only after review.

## Rollback limitations and blockers

- Downgrade drops tenant-era tables/columns and can fail if queued rows have
  null started_at; it is unsafe after new writes. It deliberately does not
  restore insecure Data API/default grants. Prefer forward repair or restore.
- No suitable local/ephemeral PostgreSQL was available: Docker Desktop was not
  running, no PostgreSQL service was installed, and WSL access was unavailable.
  Cross-tenant RLS behavior remains unexecuted; only offline/static tests ran.
  Backend/tests/tenancy_rls_scenarios.sql is transaction-rolled-back and
  database-name-gated for the later isolated Supabase-compatible test run.
- Two legacy raw ingestions lack a matching sync-run detail and need an explicit
  provenance decision before that relationship can be fully validated.
- Free-plan backup protection is insufficient until a dump is restored and
  verified. Real Auth/API testing and least-privilege role provisioning remain
  manual prerequisites.
