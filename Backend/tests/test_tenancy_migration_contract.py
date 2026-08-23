import os
import subprocess
import sys
import unittest
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = (
    BACKEND
    / "alembic"
    / "versions"
    / "20260818_120000_add_tenancy_auth_and_ingestion.py"
)


def offline_sql() -> str:
    env = os.environ.copy()
    env["DATABASE_URL"] = "postgresql+psycopg2://localhost/tibbou_offline"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "upgrade",
            "20260408_203100:20260818_120000",
            "--sql",
        ],
        cwd=BACKEND,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.lower()


class TenancyMigrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = MIGRATION.read_text(encoding="utf-8").lower()
        cls.sql = offline_sql()

    def test_revision_extends_the_confirmed_live_revision(self):
        self.assertIn('revision = "20260818_120000"', self.source)
        self.assertIn('down_revision = "20260408_203100"', self.source)

    def test_upgrade_starts_with_transaction_local_timeouts(self):
        settings = (
            "set local lock_timeout = '5s'",
            "set local statement_timeout = '2min'",
            "set local idle_in_transaction_session_timeout = '60s'",
        )
        organization_table = self.sql.index("create table organizations")

        for setting in settings:
            self.assertEqual(self.sql.count(setting), 1)
            self.assertLess(self.sql.index(setting), organization_table)

        self.assertNotIn("alter database", self.sql)
        self.assertNotIn("alter role", self.sql)

    def test_legacy_ownership_is_not_invented(self):
        self.assertNotIn("legacy tibbou workspace", self.sql)
        self.assertNotIn("00000000-0000-0000-0000-000000000000", self.sql)
        self.assertNotIn("insert into organizations", self.sql)
        self.assertNotIn("update datasets set organization_id", self.sql)
        self.assertIn("organization_id is not null) not valid", self.sql)

    def test_staging_checks_follow_migration_owned_updates(self):
        sync_update = self.sql.index(
            "update sync_runs set queued_at = coalesce(started_at, now())"
        )
        raw_update = self.sql.index("update raw_ingestions r set sync_run_id")
        sync_check = self.sql.index("ck_sync_runs_organization_required")
        raw_check = self.sql.index("ck_raw_ingestions_organization_required")
        self.assertGreater(sync_check, sync_update)
        self.assertGreater(raw_check, raw_update)

    def test_legacy_lineage_constraint_drop_accepts_both_baselines(self):
        legacy_drop = (
            "alter table public.lineage_edges drop constraint if exists "
            "uq_lineage_edges_upstream_downstream_relationship"
        )
        self.assertEqual(self.sql.count(legacy_drop), 1)

    def test_final_lineage_uniqueness_is_recreated(self):
        legacy_drop = self.sql.index(
            "alter table public.lineage_edges drop constraint if exists "
            "uq_lineage_edges_upstream_downstream_relationship"
        )
        final_constraint = self.sql.index(
            "add constraint uq_lineage_edges_upstream_downstream_relationship "
            "unique (upstream_dataset_id, downstream_dataset_id, "
            "relationship_type, provenance)"
        )
        self.assertGreater(final_constraint, legacy_drop)

    def test_legacy_raw_sync_exceptions_can_be_tenant_backfilled(self):
        self.assertNotIn("ck_raw_ingestions_sync_run_required", self.sql)
        self.assertIn("create trigger raw_ingestions_require_sync_run", self.sql)
        self.assertIn("before insert or update of sync_run_id", self.sql)
        self.assertIn("tg_op = 'insert' or old.sync_run_id is not null", self.sql)

    def test_delete_actions_do_not_cascade_business_data(self):
        self.assertNotIn("on delete cascade", self.sql)
        self.assertIn("on delete restrict", self.sql)
        self.assertIn("on delete set null", self.sql)

    def test_rls_is_forced_and_context_fails_closed(self):
        self.assertGreaterEqual(self.sql.count("force row level security"), 12)
        self.assertIn("current_setting('app.current_user_id', true)", self.sql)
        self.assertIn("current_setting('app.current_organization_id', true)", self.sql)
        self.assertIn("request_user is not null", self.sql)
        self.assertIn("request_organization is not null", self.sql)
        self.assertIn("with check", self.sql)

    def test_privileged_helpers_are_private_and_narrowly_granted(self):
        self.assertIn("security definer set search_path = ''", self.sql)
        self.assertIn(
            "revoke all on schema private from public, anon, authenticated, service_role",
            self.sql,
        )
        self.assertIn(
            "grant execute on function private.claim_sync_run() to tibbou_worker",
            self.sql,
        )
        self.assertNotIn(
            "grant execute on function private.claim_sync_run() to authenticated",
            self.sql,
        )

    def test_data_api_roles_have_no_business_table_grants(self):
        self.assertIn(
            "revoke all on all tables in schema public from anon, authenticated, service_role",
            self.sql,
        )
        self.assertNotIn("grant select on datasets to authenticated", self.sql)
        self.assertNotIn("grant select on datasets to anon", self.sql)


if __name__ == "__main__":
    unittest.main()
