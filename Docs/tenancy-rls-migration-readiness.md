# Tenancy/RLS migration readiness

Assessment date: 2026-08-23. This is a Phase 2B assessment and Phase 3 execution
record. The only persistent hosted mutation was the separately approved Gate 5
revocation of `anon` and `authenticated` business-table privileges. One
approved Alembic upgrade was attempted, failed inside transactional DDL, and
was verified to have rolled back completely. No hosted schema, row data, Auth,
ownership, migration revision, or project setting remains changed by that
attempt.

## Outcome

**Not ready for another live rollout attempt yet.** Revision 20260818_120000 is
an unapplied local expand/security migration. The failed attempt exposed one
hosted baseline drift that is corrected locally and must receive a fresh SQL
review and separate execution approval. Rollout also requires independently
approved hosted least-privilege database login roles, explicit selection of the
controlled Auth user and legacy organization, and completion of real Phase 1
Auth/API testing. Disposable local PostgreSQL/Supabase policy validation and a
read-only hosted application/Auth backup-and-restore proof are complete.

## Verified hosted baseline before Gate 5 containment

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
  Before Gate 5, anon, authenticated, and service_role had all table privileges
  through permissive default ACLs. Gate 5 later revoked the anon and
  authenticated grants while leaving service_role unchanged.
- postgres owns the tables and has BYPASSRLS; service_role also has BYPASSRLS.
  anon and authenticated do not.
- The live schema matches the columns, relations, owners, primary/foreign-key
  constraints, and non-lineage indexes produced by revision 20260408_203100 and
  has no organization, tenant, owner, or application-user columns. It lacks the
  baseline lineage uniqueness constraint and its backing index; that isolated
  drift is recorded below.
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
| raw_ingestions | 16 | 10 Snowflake query-history, 6 dbt manifest; 14 match sync-run detail, 2 do not | Link 14; keep 2 legacy links null; reject new null links and clearing established links with a trigger | 16 |
| sync_runs | 16 | 10 Snowflake and 6 dbt; 14 success, 2 failed | Add queue columns; keep legacy requester null | 16 |
| retired users | 0 | Not Supabase Auth | Revoke access; FORCE RLS; no policies | 0 |
| organizations / memberships | 0 | Not present | Create empty; no invented owner/workspace | 0 |
| connection/query tables | 0 | Not present | Create empty | 0 |
| auth.users | 1 | Confirmed email identity | Unchanged | 1 |

All existing foreign-key relationships are valid. There are no duplicate
lineage keys, invalid cost checks, or unsupported existing statuses.

## Phase 3 failed attempt and hosted schema-drift diagnosis

After the refreshed backup and final read-only preflight passed, the single
approved `20260408_203100 -> 20260818_120000` Alembic attempt used the
administrative migration connection with a 5-second lock timeout, 5-minute
statement timeout, and 60-second idle-in-transaction timeout. PostgreSQL
reported transactional DDL and stopped at:

```sql
ALTER TABLE lineage_edges
DROP CONSTRAINT uq_lineage_edges_upstream_downstream_relationship;
```

The named constraint did not exist. No retry or stamp was performed. The
post-error read-only verification proved complete rollback: Alembic remained at
`20260408_203100`; all 61 business rows, full ID digests, representative IDs,
and relationships matched the preflight; the candidate tables, roles, private
schema, policies, triggers, and RLS changes were absent; grants returned to the
documented Gate 5 baseline; and no application session or public-table lock
remained.

A complete read-only catalog comparison against a clean PostgreSQL 17.6
application of `20260408_203100` covered every public relation and column,
owners, constraints, indexes, triggers, public/private functions, table and
schema grants, default ACLs, policies, and RLS/FORCE RLS state. The only
application-schema differences were both sides of the same drift:

- hosted lacks constraint
  `uq_lineage_edges_upstream_downstream_relationship` on
  `(upstream_dataset_id, downstream_dataset_id, relationship_type)`;
- hosted consequently lacks that constraint's backing unique index.

Hosted has no extra application objects, triggers, functions, or policies.
Gate 5 grants, Supabase default ACLs, owners, and disabled RLS/FORCE RLS state
match the expected pre-migration state. Grouping all ten hosted lineage rows by
the legacy relationship key returned zero duplicate groups, so creation of the
final provenance-aware uniqueness constraint is not blocked by existing data.

Because `20260818_120000` remains unapplied, its legacy drop is corrected
locally to use `DROP CONSTRAINT IF EXISTS`. This accepts both reconstructed
baseline variants—the declared constraint present and the hosted-drift state
where it is absent—while leaving the later final constraint creation unchanged:

```sql
UNIQUE (
  upstream_dataset_id,
  downstream_dataset_id,
  relationship_type,
  provenance
)
```

Contract coverage requires the guarded drop to appear exactly once and the
final constraint to be recreated afterward. Local integration coverage creates
two isolated databases, upgrades one with the legacy constraint present and one
with it removed, and requires both to reach `20260818_120000` with the same
preserved lineage row and final uniqueness columns. Both variants pass. The
transaction-rolled-back SQL RLS scenario passes, all six local integration tests
pass, and the complete 24-test backend suite passes. Backend import/OpenAPI and
Alembic head/current checks pass; frontend type-check, lint, and production
build pass; whitespace and changed-file secret scans pass.

The corrected full offline Alembic SQL remains 627 lines and has SHA-256
`1890a80611664f565e3b94e663f2345817dba79d11f0fa4405469e2556d07b4d`.
Compared byte-for-byte with the previously approved SQL, the only changed SQL
statement is:

```diff
-ALTER TABLE lineage_edges DROP CONSTRAINT uq_lineage_edges_upstream_downstream_relationship;
+alter table public.lineage_edges drop constraint if exists uq_lineage_edges_upstream_downstream_relationship;
```

No other DDL, DML, role, grant, policy, trigger, function, RLS, or migration
history statement changed.

## Phase 2B disposable local validation

An unlinked Supabase CLI project was created under the nonsynced Windows temp
directory. No login, link, remote database command, or hosted credential was
used. The validated stack used Supabase CLI 2.115.0, Docker 29.7.2, PostgreSQL
17.6 (Supabase image 17.6.1.159), GoTrue 2.195.0, PostgREST 16.1, Realtime
2.129.0, Storage API 1.69.11, and Studio 2026.08.17-sha-0c1da8f.

The base revision was reconstructed and seeded with synthetic-only data: two
Auth users, 18 datasets, 10 valid lineage edges, one cost snapshot, 16 raw
ingestions, and 16 sync runs. Fourteen raw records matched sync-run detail and
two deliberately did not. After the candidate migration:

| Behavior | Local evidence | Result |
|---|---|---|
| Upgrade and preservation | Revision advanced to 20260818_120000; every seeded ID/count and existing FK relationship remained; no cascade FK exists | Pass |
| Nullable expansion/backfill | Legacy ownership remained null after expand; new null ownership was rejected; all five tenant checks validated after synthetic ownership backfill | Pass |
| Raw exceptions | Both unmatched rows survived and accepted ownership; new null links and clearing an established link were rejected | Pass after local correction |
| RLS authorization | Same-organization reads and owner/operator-style writes succeeded; viewer and cross-organization writes failed | Pass |
| Bootstrap and recursion | Creator/first-owner and subsequent membership paths completed without recursive-policy errors | Pass |
| Context safety | Missing and stale context returned no rows; malformed UUID context raised before data access; transaction-local context did not survive commit, rollback, or reuse of the same pooled connection | Pass |
| Least privilege | A real LOGIN role inheriting tibbou_runtime had NOBYPASSRLS; a local ES256 Auth token reached FastAPI, returned 200 for the member organization and 404 cross-organization | Pass locally; hosted role still absent |
| Data API boundary | Local REST returned 401 for anon and 403 for authenticated on datasets; protected business grants were zero | Pass |
| Upgrade failure | A forced late duplicate-function failure left Alembic at 20260408_203100, all seeded counts intact, and no partial tenant DDL | Pass |

The first local run exposed a PostgreSQL staging defect: a NOT VALID
`sync_run_id is not null` check also rejects later updates to the two preserved
legacy exceptions, which blocked ownership backfill. Because the candidate is
unapplied, it was corrected locally to use a trigger that rejects new null
links and non-null-to-null changes while allowing unrelated updates to the two
pre-existing null-link rows. The clean rebuild, prepared rollback-only SQL
scenario, and 21-test backend suite then passed.

The local direct PostgreSQL port does not provide SSL. `app.db` was narrowed to
disable SSL only for loopback hosts while continuing to require SSL for every
non-loopback database; this enabled the real local FastAPI/login-role proof
without weakening the hosted default.

## Data flow and roles

Verified application flow:

Browser -> Supabase Auth -> access token -> FastAPI -> PostgreSQL

The frontend uses supabase-js only for Auth/session operations. Business calls
go through Frontend/tibbou-data-flow/src/api/tibbou.js to FastAPI. FastAPI
validates asymmetric JWT signature, issuer, audience, expiration, required
claims, allowed algorithm, and authenticated role before resolving an
authoritative membership.

## Phase 2B manual Auth gate

Local email/password sign-in with the existing confirmed account succeeded on
2026-08-23. The following `GET /api/v1/organizations` returned 500 because the
connected database remains at 20260408_203100 and has no `organizations` table;
this is the expected schema/code mismatch. A later Vite connection refusal
occurred only after the local backend stopped and is separate from that error.

The controlled hosted-browser check remains manual because credentials must
not be entered into chat or automation. Using the existing confirmed test
account, the operator must sign in with email/password, reload the protected
page to prove session restoration, confirm that a FastAPI protected request
carries the bearer token, sign out, and confirm the protected route returns to
login. A malformed token and an expired token must each receive a sanitized
401 response from FastAPI. A deliberately incorrect password must display the
sanitized UI message rather than hosted/internal details. Sign-up should be
tested only if creating another controlled account is approved. Microsoft
Entra ID and Okta controls remain disabled and make no provider requests.

The organization dashboard cannot pass hosted end-to-end testing until the
tenancy migration and an approved organization/membership are present.

## Phase 2B emergency containment result

Static inspection found no frontend Supabase business-table query: the client
uses `supabase.auth.getSession()` to obtain a token and sends every business
request to FastAPI. After explicit approval, the following table-scoped
transaction was executed. It changed no data/RLS/ownership/Auth setting and
left `service_role` and the current FastAPI database role unchanged:

```sql
BEGIN;
REVOKE ALL PRIVILEGES ON TABLE
  public.datasets,
  public.lineage_edges,
  public.cost_snapshots,
  public.raw_ingestions,
  public.sync_runs,
  public.users
FROM anon, authenticated;
COMMIT;
```

Verify that effective privileges are absent (including any inherited grant):

```sql
SELECT r.role_name,
       t.table_name,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'SELECT') AS can_select,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'INSERT') AS can_insert,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'UPDATE') AS can_update,
       has_table_privilege(r.role_name, format('public.%I', t.table_name), 'DELETE') AS can_delete
FROM (VALUES ('anon'), ('authenticated')) AS r(role_name)
CROSS JOIN (VALUES
  ('datasets'),
  ('lineage_edges'),
  ('cost_snapshots'),
  ('raw_ingestions'),
  ('sync_runs'),
  ('users')
) AS t(table_name)
ORDER BY r.role_name, t.table_name;
```

All 84 effective privilege results were false. The remaining explicit grant
count was zero for `anon` and `authenticated` and 42 for `service_role`, exactly
matching its six-table baseline. An anonymous hosted REST datasets read
returned 401. The configured FastAPI database login continued to read the
unchanged counts, but no non-local absolute FastAPI URL or controlled user
credential was available for the real authenticated HTTP check; that remains
in the manual Auth gate. Alembic remained at 20260408_203100 and counts remained
18/10/1/16/16 with zero broken lineage/cost relationships and the same 14
matched raw/sync details.

If emergency rollback is explicitly approved, restore the former hosted
baseline table privileges with:

```sql
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.datasets,
  public.lineage_edges,
  public.cost_snapshots,
  public.raw_ingestions,
  public.sync_runs,
  public.users
TO anon, authenticated;
COMMIT;
```

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

## Phase 2B hosted backup and restore proof

After separate approval, a read-only logical export was created in the approved
nonsynced local backup directory outside the repository and OneDrive. The
directory has inherited permissions disabled and grants access only to the
current Windows user and SYSTEM. No credential file remains. The export used
PostgreSQL 17.6 client tools from the already-cached Supabase PostgreSQL image
and contains:

- roles-only globals SQL with role passwords excluded;
- schema/ACL SQL;
- a full custom-format archive;
- independent custom-format `public` and `auth` data archives;
- an archive catalog, hosted count report, SHA-256 manifest, and restore
  verification record.

The approved archive was restored only into a second unlinked disposable local
Supabase PostgreSQL 17.6 target. A direct all-managed-schema restore stopped on
Supabase-provisioned Realtime state and was not treated as a success. After the
disposable database was reset, the required application recovery scopes
(`public` and `auth`) restored successfully with `--exit-on-error`,
`--no-owner`, and `--no-privileges`; an empty managed `auth` schema was created
first as required by the archive catalog. The restored Alembic revision was
20260408_203100. Exact restored counts were 18 datasets, 10 lineage edges, one
cost snapshot, 16 raw ingestions, 16 sync runs, and one Auth user. All five
representative non-sensitive IDs matched the hosted report, all three public
foreign keys were validated, no lineage/cost relationship was broken, and 14
raw records retained matching sync-run detail. The two known unmatched raw
records remained the only integrity exceptions.

This proves recovery of Tibbou's application schema/data and Auth database
records, not a complete self-hosted reconstruction of every Supabase-managed
service schema. Full managed-service disaster recovery still depends on
Supabase provisioning/support. The disposable restored database and copied
archive were destroyed with `supabase stop --no-backup`; the approved source
backup remains protected for rollout recovery.

## Backup procedure for Phase 3

The verified organization is on the Free plan; do not treat platform
availability as a usable pre-rollout backup. Before the live migration, refresh
the approved logical backup after the write freeze and repeat the verified
application/Auth restore procedure.

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
   nullable until provenance is explicitly resolved; the staging trigger lets
   those rows receive ownership but rejects new null links and prevents an
   established link from being cleared.
10. Switch API/worker secrets to least-privilege logins, deploy, and test two
    users/two organizations, cross-tenant reads/writes, roles, first-owner
    bootstrap, worker context, pool reuse, and direct role denial.
11. Re-run Supabase advisors and the preservation matrix, then resume traffic
    only after review.

## Rollback limitations and blockers

- The failed hosted attempt was transactionally rolled back. The corrected
  unapplied migration and its newly generated SQL require a fresh checkpoint
  review and separate approval before any hosted retry.
- Downgrade drops tenant-era tables/columns and can fail if queued rows have
  null started_at; it is unsafe after new writes. It deliberately does not
  restore insecure Data API/default grants. Prefer forward repair or restore.
- Disposable local PostgreSQL/Supabase validation is complete. The prepared
  tenancy scenario remains transaction-rolled-back and now requires an
  explicit externally supplied local-test marker plus the candidate revision.
- Two legacy raw ingestions lack a matching sync-run detail and need an explicit
  provenance decision before that relationship can be fully validated.
- The application/Auth backup restore is verified, but complete reconstruction
  of every Supabase-managed schema was not demonstrated; use the documented
  scoped recovery path and retain Supabase-managed-service recovery support.
- Real hosted Auth/API testing and least-privilege role provisioning remain
  manual prerequisites.
