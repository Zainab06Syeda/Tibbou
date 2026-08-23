import os
import secrets
import unittest
from urllib.parse import urlparse

import psycopg2
from psycopg2 import sql
from sqlalchemy import create_engine, text


LOCAL_MARKER = "TIBBOU_PHASE2B_LOCAL_TEST"
DATABASE_ENV = "TIBBOU_PHASE2B_DATABASE_URL"
LOGIN_ROLE = "tibbou_phase2b_api_test"
USER_ONE = "11000000-0000-0000-0000-000000000001"
USER_TWO = "11000000-0000-0000-0000-000000000002"
STALE_USER = "11000000-0000-0000-0000-000000000099"
ORG_ONE = "21000000-0000-0000-0000-000000000001"
ORG_TWO = "21000000-0000-0000-0000-000000000002"


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
