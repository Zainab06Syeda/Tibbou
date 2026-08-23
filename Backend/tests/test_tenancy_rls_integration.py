import os
import secrets
import subprocess
import sys
import unittest
from pathlib import Path
from urllib.parse import urlparse

import psycopg2
from psycopg2 import sql
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL


LOCAL_MARKER = "TIBBOU_PHASE2B_LOCAL_TEST"
DATABASE_ENV = "TIBBOU_PHASE2B_DATABASE_URL"
LOGIN_ROLE = "tibbou_phase2b_api_test"
USER_ONE = "11000000-0000-0000-0000-000000000001"
USER_TWO = "11000000-0000-0000-0000-000000000002"
STALE_USER = "11000000-0000-0000-0000-000000000099"
ORG_ONE = "21000000-0000-0000-0000-000000000001"
ORG_TWO = "21000000-0000-0000-0000-000000000002"
BACKEND = Path(__file__).resolve().parents[1]
MIGRATION_TIMEOUTS = (
    ("lock_timeout", "5s"),
    ("statement_timeout", "2min"),
    ("idle_in_transaction_session_timeout", "1min"),
)


def local_database_config() -> dict[str, object]:
    if os.getenv(LOCAL_MARKER) != "enabled":
        raise unittest.SkipTest("explicit Phase 2B local-test marker is absent")

    raw_url = os.getenv(DATABASE_ENV, "")
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"postgresql", "postgresql+psycopg2"}:
        raise unittest.SkipTest("Phase 2B database URL is not PostgreSQL")
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise unittest.SkipTest("Phase 2B integration tests require a loopback database")
    if parsed.port is None or not 54000 <= parsed.port <= 54999:
        raise unittest.SkipTest("Phase 2B integration tests require a local CLI port")
    if parsed.path.lstrip("/") != "postgres":
        raise unittest.SkipTest("Phase 2B integration tests require local Supabase postgres")

    return {
        "host": parsed.hostname,
        "port": parsed.port,
        "dbname": parsed.path.lstrip("/"),
        "user": parsed.username,
        "password": parsed.password,
        "sslmode": "disable",
    }


def local_database_url(config: dict[str, object], database: str) -> str:
    return URL.create(
        "postgresql+psycopg2",
        username=str(config["user"]),
        password=str(config["password"]),
        host=str(config["host"]),
        port=int(config["port"]),
        database=database,
        query={"sslmode": "disable"},
    ).render_as_string(hide_password=False)


def timeout_values(cursor) -> dict[str, str]:
    values = {}
    for setting, _ in MIGRATION_TIMEOUTS:
        cursor.execute(sql.SQL("show {}").format(sql.Identifier(setting)))
        values[setting] = cursor.fetchone()[0]
    return values


class TenancyMigrationBaselineVariantsIntegrationTests(unittest.TestCase):
    def test_upgrade_accepts_present_and_absent_legacy_lineage_constraint(self):
        owner_config = local_database_config()

        for legacy_constraint_present in (True, False):
            variant = "present" if legacy_constraint_present else "absent"
            database = f"tibbou_lineage_{variant}_{secrets.token_hex(4)}"

            with self.subTest(legacy_constraint=variant):
                admin = psycopg2.connect(**owner_config)
                try:
                    admin.autocommit = True
                    with admin.cursor() as cursor:
                        cursor.execute(
                            sql.SQL("create database {} template template0").format(
                                sql.Identifier(database)
                            )
                        )
                finally:
                    admin.close()

                try:
                    variant_config = {**owner_config, "dbname": database}
                    with psycopg2.connect(**variant_config) as connection:
                        with connection.cursor() as cursor:
                            cursor.execute("create schema auth")
                            cursor.execute(
                                "create table auth.users (id uuid primary key)"
                            )

                    env = os.environ.copy()
                    env["DATABASE_URL"] = local_database_url(owner_config, database)
                    subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "alembic",
                            "upgrade",
                            "20260408_203100",
                        ],
                        cwd=BACKEND,
                        env=env,
                        check=True,
                        capture_output=True,
                        text=True,
                    )

                    with psycopg2.connect(**variant_config) as connection:
                        with connection.cursor() as cursor:
                            cursor.execute(
                                "insert into public.datasets (id, name, system) values "
                                "('61000000-0000-0000-0000-000000000001', 'upstream', 'test'), "
                                "('61000000-0000-0000-0000-000000000002', 'downstream', 'test')"
                            )
                            cursor.execute(
                                "insert into public.lineage_edges "
                                "(id, upstream_dataset_id, downstream_dataset_id, relationship_type) "
                                "values ('62000000-0000-0000-0000-000000000001', "
                                "'61000000-0000-0000-0000-000000000001', "
                                "'61000000-0000-0000-0000-000000000002', 'depends_on')"
                            )
                            if not legacy_constraint_present:
                                cursor.execute(
                                    "alter table public.lineage_edges drop constraint "
                                    "uq_lineage_edges_upstream_downstream_relationship"
                                )
                            baseline_timeouts = timeout_values(cursor)

                    subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "alembic",
                            "upgrade",
                            "20260818_120000",
                        ],
                        cwd=BACKEND,
                        env=env,
                        check=True,
                        capture_output=True,
                        text=True,
                    )

                    with psycopg2.connect(**variant_config) as connection:
                        with connection.cursor() as cursor:
                            self.assertEqual(timeout_values(cursor), baseline_timeouts)
                            cursor.execute(
                                "select version_num from public.alembic_version"
                            )
                            self.assertEqual(cursor.fetchone()[0], "20260818_120000")
                            cursor.execute(
                                "select array_agg(attribute.attname order by key.ordinality) "
                                "from pg_constraint constraint_definition "
                                "cross join lateral unnest(constraint_definition.conkey) "
                                "with ordinality as key(attnum, ordinality) "
                                "join pg_attribute attribute "
                                "on attribute.attrelid = constraint_definition.conrelid "
                                "and attribute.attnum = key.attnum "
                                "where constraint_definition.conrelid = "
                                "'public.lineage_edges'::regclass "
                                "and constraint_definition.conname = "
                                "'uq_lineage_edges_upstream_downstream_relationship'"
                            )
                            self.assertEqual(
                                cursor.fetchone()[0],
                                [
                                    "upstream_dataset_id",
                                    "downstream_dataset_id",
                                    "relationship_type",
                                    "provenance",
                                ],
                            )
                            cursor.execute("select count(*) from public.lineage_edges")
                            self.assertEqual(cursor.fetchone()[0], 1)
                finally:
                    admin = psycopg2.connect(**owner_config)
                    try:
                        admin.autocommit = True
                        with admin.cursor() as cursor:
                            cursor.execute(
                                "select pg_terminate_backend(pid) from pg_stat_activity "
                                "where datname = %s and pid <> pg_backend_pid()",
                                (database,),
                            )
                            cursor.execute(
                                sql.SQL("drop database if exists {}").format(
                                    sql.Identifier(database)
                                )
                            )
                    finally:
                        admin.close()

    def test_timeout_settings_are_transaction_local(self):
        owner_config = local_database_config()

        with psycopg2.connect(**owner_config) as connection:
            with connection.cursor() as cursor:
                before = timeout_values(cursor)
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                cursor.execute("SET LOCAL statement_timeout = '2min'")
                cursor.execute(
                    "SET LOCAL idle_in_transaction_session_timeout = '60s'"
                )
                self.assertEqual(
                    timeout_values(cursor),
                    dict(MIGRATION_TIMEOUTS),
                )
                connection.rollback()
                self.assertEqual(timeout_values(cursor), before)
                connection.rollback()

    def test_failed_late_upgrade_rolls_back_every_migration_change(self):
        owner_config = local_database_config()
        database = f"tibbou_timeout_rollback_{secrets.token_hex(4)}"
        admin = psycopg2.connect(**owner_config)
        try:
            admin.autocommit = True
            with admin.cursor() as cursor:
                cursor.execute(
                    sql.SQL("create database {} template template0").format(
                        sql.Identifier(database)
                    )
                )
        finally:
            admin.close()

        try:
            variant_config = {**owner_config, "dbname": database}
            with psycopg2.connect(**variant_config) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("create schema auth")
                    cursor.execute("create table auth.users (id uuid primary key)")

            env = os.environ.copy()
            env["DATABASE_URL"] = local_database_url(owner_config, database)
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "alembic",
                    "upgrade",
                    "20260408_203100",
                ],
                cwd=BACKEND,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            with psycopg2.connect(**variant_config) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "insert into public.datasets (id, name, system) values "
                        "('63000000-0000-0000-0000-000000000001', 'upstream', 'test'), "
                        "('63000000-0000-0000-0000-000000000002', 'downstream', 'test')"
                    )
                    cursor.execute(
                        "insert into public.lineage_edges "
                        "(id, upstream_dataset_id, downstream_dataset_id, relationship_type) "
                        "values ('64000000-0000-0000-0000-000000000001', "
                        "'63000000-0000-0000-0000-000000000001', "
                        "'63000000-0000-0000-0000-000000000002', 'depends_on')"
                    )
                    cursor.execute("create schema private")
                    cursor.execute(
                        "create function private.claim_sync_run() returns integer "
                        "language sql as $$ select 1 $$"
                    )
                    baseline_timeouts = timeout_values(cursor)
                    cursor.execute(
                        "select table_name from information_schema.tables "
                        "where table_schema = 'public' order by table_name"
                    )
                    baseline_tables = cursor.fetchall()
                    cursor.execute(
                        "select rolname, rolcanlogin, rolbypassrls from pg_roles "
                        "where rolname like 'tibbou_%' order by rolname"
                    )
                    baseline_roles = cursor.fetchall()
                    cursor.execute(
                        "select grantee, table_name, privilege_type "
                        "from information_schema.role_table_grants "
                        "where table_schema = 'public' "
                        "and grantee in ('anon', 'authenticated', 'service_role') "
                        "order by grantee, table_name, privilege_type"
                    )
                    baseline_grants = cursor.fetchall()

            failed_upgrade = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "alembic",
                    "upgrade",
                    "20260818_120000",
                ],
                cwd=BACKEND,
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(failed_upgrade.returncode, 0)

            with psycopg2.connect(**variant_config) as connection:
                with connection.cursor() as cursor:
                    self.assertEqual(timeout_values(cursor), baseline_timeouts)
                    cursor.execute("select version_num from public.alembic_version")
                    self.assertEqual(cursor.fetchone()[0], "20260408_203100")
                    cursor.execute(
                        "select table_name from information_schema.tables "
                        "where table_schema = 'public' order by table_name"
                    )
                    self.assertEqual(cursor.fetchall(), baseline_tables)
                    cursor.execute(
                        "select rolname, rolcanlogin, rolbypassrls from pg_roles "
                        "where rolname like 'tibbou_%' order by rolname"
                    )
                    self.assertEqual(cursor.fetchall(), baseline_roles)
                    cursor.execute(
                        "select grantee, table_name, privilege_type "
                        "from information_schema.role_table_grants "
                        "where table_schema = 'public' "
                        "and grantee in ('anon', 'authenticated', 'service_role') "
                        "order by grantee, table_name, privilege_type"
                    )
                    self.assertEqual(cursor.fetchall(), baseline_grants)
                    cursor.execute(
                        "select count(*) from information_schema.columns "
                        "where table_schema = 'public' and column_name = 'organization_id'"
                    )
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute(
                        "select count(*) from pg_policies where schemaname = 'public'"
                    )
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute(
                        "select count(*) from pg_class relation "
                        "join pg_namespace namespace on namespace.oid = relation.relnamespace "
                        "where namespace.nspname = 'public' and relation.relrowsecurity"
                    )
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute(
                        "select count(*) from pg_trigger trigger_definition "
                        "join pg_class relation on relation.oid = trigger_definition.tgrelid "
                        "join pg_namespace namespace on namespace.oid = relation.relnamespace "
                        "where namespace.nspname = 'public' "
                        "and not trigger_definition.tgisinternal"
                    )
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute(
                        "select proname from pg_proc function_definition "
                        "join pg_namespace namespace "
                        "on namespace.oid = function_definition.pronamespace "
                        "where namespace.nspname = 'private' order by proname"
                    )
                    self.assertEqual(cursor.fetchall(), [("claim_sync_run",)])
                    cursor.execute("select count(*) from public.datasets")
                    self.assertEqual(cursor.fetchone()[0], 2)
                    cursor.execute("select count(*) from public.lineage_edges")
                    self.assertEqual(cursor.fetchone()[0], 1)
                    cursor.execute(
                        "select array_agg(attribute.attname order by key.ordinality) "
                        "from pg_constraint constraint_definition "
                        "cross join lateral unnest(constraint_definition.conkey) "
                        "with ordinality as key(attnum, ordinality) "
                        "join pg_attribute attribute "
                        "on attribute.attrelid = constraint_definition.conrelid "
                        "and attribute.attnum = key.attnum "
                        "where constraint_definition.conrelid = "
                        "'public.lineage_edges'::regclass "
                        "and constraint_definition.conname = "
                        "'uq_lineage_edges_upstream_downstream_relationship'"
                    )
                    self.assertEqual(
                        cursor.fetchone()[0],
                        [
                            "upstream_dataset_id",
                            "downstream_dataset_id",
                            "relationship_type",
                        ],
                    )
        finally:
            admin = psycopg2.connect(**owner_config)
            try:
                admin.autocommit = True
                with admin.cursor() as cursor:
                    cursor.execute(
                        "select pg_terminate_backend(pid) from pg_stat_activity "
                        "where datname = %s and pid <> pg_backend_pid()",
                        (database,),
                    )
                    cursor.execute(
                        sql.SQL("drop database if exists {}").format(
                            sql.Identifier(database)
                        )
                    )
            finally:
                admin.close()


class TenancyRlsIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.owner_config = local_database_config()
        cls.login_password = secrets.token_urlsafe(24)

        with psycopg2.connect(**cls.owner_config) as connection:
            connection.autocommit = True
            with connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("drop role if exists {}").format(sql.Identifier(LOGIN_ROLE))
                )
                cursor.execute(
                    sql.SQL(
                        "create role {} login password {} "
                        "nosuperuser nocreatedb nocreaterole nobypassrls "
                        "in role tibbou_runtime"
                    ).format(
                        sql.Identifier(LOGIN_ROLE),
                        sql.Literal(cls.login_password),
                    )
                )

    @classmethod
    def tearDownClass(cls):
        with psycopg2.connect(**cls.owner_config) as connection:
            connection.autocommit = True
            with connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("drop role if exists {}").format(sql.Identifier(LOGIN_ROLE))
                )

    @classmethod
    def connect_login(cls):
        return psycopg2.connect(
            host=cls.owner_config["host"],
            port=cls.owner_config["port"],
            dbname=cls.owner_config["dbname"],
            user=LOGIN_ROLE,
            password=cls.login_password,
            sslmode="disable",
        )

    @staticmethod
    def set_context(cursor, user_id: str, organization_id: str) -> None:
        cursor.execute(
            "select set_config('app.current_user_id', %s, true)", (user_id,)
        )
        cursor.execute(
            "select set_config('app.current_organization_id', %s, true)",
            (organization_id,),
        )

    def test_real_login_uses_forced_rls_and_authorized_writes(self):
        with self.connect_login() as connection, connection.cursor() as cursor:
            cursor.execute(
                "select rolbypassrls from pg_roles where rolname = session_user"
            )
            self.assertFalse(cursor.fetchone()[0])

            self.set_context(cursor, USER_ONE, ORG_ONE)
            cursor.execute("select count(*) from public.datasets")
            self.assertEqual(cursor.fetchone()[0], 11)

            cursor.execute(
                "insert into public.datasets (id, organization_id, name, system) "
                "values ('59000000-0000-0000-0000-000000000010', %s, 'RLS write', 'test')",
                (ORG_ONE,),
            )
            cursor.execute(
                "update public.datasets set name = 'RLS update' "
                "where id = '59000000-0000-0000-0000-000000000010'"
            )
            self.assertEqual(cursor.rowcount, 1)
            cursor.execute(
                "delete from public.datasets "
                "where id = '59000000-0000-0000-0000-000000000010'"
            )
            self.assertEqual(cursor.rowcount, 1)

    def test_cross_organization_and_viewer_writes_fail(self):
        with self.connect_login() as connection, connection.cursor() as cursor:
            self.set_context(cursor, USER_ONE, ORG_TWO)
            cursor.execute("select count(*) from public.datasets")
            self.assertEqual(cursor.fetchone()[0], 0)
            cursor.execute(
                "update public.datasets set name = 'forbidden' "
                "where organization_id = %s",
                (ORG_TWO,),
            )
            self.assertEqual(cursor.rowcount, 0)
            cursor.execute(
                "delete from public.datasets where organization_id = %s", (ORG_TWO,)
            )
            self.assertEqual(cursor.rowcount, 0)

        connection = self.connect_login()
        try:
            with connection.cursor() as cursor:
                self.set_context(cursor, USER_ONE, ORG_TWO)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    cursor.execute(
                        "insert into public.datasets "
                        "(id, organization_id, name, system) "
                        "values ('59000000-0000-0000-0000-000000000020', %s, 'forbidden', 'test')",
                        (ORG_TWO,),
                    )
        finally:
            connection.rollback()
            connection.close()

        connection = self.connect_login()
        try:
            with connection.cursor() as cursor:
                self.set_context(cursor, USER_TWO, ORG_ONE)
                cursor.execute("select count(*) from public.datasets")
                self.assertEqual(cursor.fetchone()[0], 11)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    cursor.execute(
                        "insert into public.datasets "
                        "(id, organization_id, name, system) "
                        "values ('59000000-0000-0000-0000-000000000021', %s, 'viewer write', 'test')",
                        (ORG_ONE,),
                    )
        finally:
            connection.rollback()
            connection.close()

    def test_missing_stale_and_invalid_context_fail_closed(self):
        with self.connect_login() as connection, connection.cursor() as cursor:
            cursor.execute("select count(*) from public.datasets")
            self.assertEqual(cursor.fetchone()[0], 0)

        with self.connect_login() as connection, connection.cursor() as cursor:
            self.set_context(cursor, STALE_USER, ORG_ONE)
            cursor.execute("select count(*) from public.datasets")
            self.assertEqual(cursor.fetchone()[0], 0)

        connection = self.connect_login()
        try:
            with connection.cursor() as cursor:
                self.set_context(cursor, "not-a-uuid", ORG_ONE)
                with self.assertRaises(psycopg2.errors.InvalidTextRepresentation):
                    cursor.execute("select count(*) from public.datasets")
        finally:
            connection.rollback()
            connection.close()

    def test_transaction_local_context_does_not_leak_through_pool(self):
        engine = create_engine(
            "postgresql+psycopg2://",
            creator=self.connect_login,
            pool_size=1,
            max_overflow=0,
            pool_reset_on_return="rollback",
        )
        try:
            with engine.begin() as connection:
                first_pid = connection.execute(text("select pg_backend_pid()") ).scalar_one()
                connection.execute(
                    text("select set_config('app.current_user_id', :value, true)"),
                    {"value": USER_ONE},
                )
                connection.execute(
                    text(
                        "select set_config('app.current_organization_id', :value, true)"
                    ),
                    {"value": ORG_ONE},
                )
                self.assertEqual(
                    connection.execute(text("select count(*) from public.datasets")).scalar_one(),
                    11,
                )

            with engine.begin() as connection:
                self.assertEqual(
                    connection.execute(text("select pg_backend_pid()")).scalar_one(),
                    first_pid,
                )
                self.assertEqual(
                    connection.execute(text("select count(*) from public.datasets")).scalar_one(),
                    0,
                )

            try:
                with engine.begin() as connection:
                    connection.execute(
                        text("select set_config('app.current_user_id', :value, true)"),
                        {"value": USER_ONE},
                    )
                    connection.execute(
                        text(
                            "select set_config('app.current_organization_id', :value, true)"
                        ),
                        {"value": ORG_ONE},
                    )
                    raise RuntimeError("force rollback")
            except RuntimeError:
                pass

            with engine.begin() as connection:
                self.assertEqual(
                    connection.execute(text("select pg_backend_pid()")).scalar_one(),
                    first_pid,
                )
                self.assertEqual(
                    connection.execute(text("select count(*) from public.datasets")).scalar_one(),
                    0,
                )
        finally:
            engine.dispose()

    def test_raw_sync_guard_and_non_cascading_delete(self):
        connection = self.connect_login()
        try:
            with connection.cursor() as cursor:
                self.set_context(cursor, USER_ONE, ORG_ONE)
                with self.assertRaises(psycopg2.errors.CheckViolation):
                    cursor.execute(
                        "insert into public.raw_ingestions "
                        "(id, organization_id, source_system, ingestion_type, status, ingested_at, raw_payload) "
                        "values ('79000000-0000-0000-0000-000000000001', %s, "
                        "'snowflake', 'metadata', 'success', now(), '{}'::jsonb)",
                        (ORG_ONE,),
                    )
        finally:
            connection.rollback()
            connection.close()

        with psycopg2.connect(**self.owner_config) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "select count(*) from public.raw_ingestions where sync_run_id is null"
                )
                self.assertEqual(cursor.fetchone()[0], 2)

                with self.assertRaises(psycopg2.errors.CheckViolation):
                    cursor.execute(
                        "update public.raw_ingestions set sync_run_id = null "
                        "where id = '70000000-0000-0000-0000-000000000001'"
                    )
            connection.rollback()

        with psycopg2.connect(**self.owner_config) as connection:
            with connection.cursor() as cursor:
                with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
                    cursor.execute(
                        "delete from public.organizations where id = %s", (ORG_ONE,)
                    )
            connection.rollback()

        with psycopg2.connect(**self.owner_config) as connection:
            with connection.cursor() as cursor:
                cursor.execute("select count(*) from public.datasets")
                self.assertEqual(cursor.fetchone()[0], 18)
                cursor.execute("select count(*) from public.raw_ingestions")
                self.assertEqual(cursor.fetchone()[0], 16)


if __name__ == "__main__":
    unittest.main()
