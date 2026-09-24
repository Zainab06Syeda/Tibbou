import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")

from app import worker


BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent


def run_python(code, **variables):
    env = os.environ.copy()
    env.update(variables)
    return subprocess.run(
        [sys.executable, "-B", "-c", code],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )


class DeploymentReadinessTests(unittest.TestCase):
    def test_api_rejects_other_roles_and_migration_credentials(self):
        wrong_role = run_python(
            "import app.main",
            DATABASE_URL="postgresql://postgres@localhost/test",
            MIGRATION_DATABASE_URL="",
        )
        self.assertNotEqual(wrong_role.returncode, 0)
        self.assertIn("tibbou_api_login", wrong_role.stderr)

        migration_credential = run_python(
            "import app.main",
            DATABASE_URL="postgresql://tibbou_api_login@localhost/test",
            MIGRATION_DATABASE_URL="postgresql://postgres@localhost/test",
        )
        self.assertNotEqual(migration_credential.returncode, 0)
        self.assertIn("Worker and migration credentials must not be available", migration_credential.stderr)

        oversized_pool = run_python(
            "import app.main",
            DATABASE_URL="postgresql://tibbou_api_login@localhost/test",
            MIGRATION_DATABASE_URL="",
            DATABASE_POOL_SIZE="5",
        )
        self.assertNotEqual(oversized_pool.returncode, 0)
        self.assertIn("at most 3 connections", oversized_pool.stderr)

    def test_worker_rejects_api_fallback(self):
        env = os.environ.copy()
        env.update(
            DATABASE_URL="postgresql://tibbou_api_login@localhost/test",
            WORKER_DATABASE_URL="",
            MIGRATION_DATABASE_URL="",
        )
        result = subprocess.run(
            [sys.executable, "-B", "-m", "app.worker", "--once"],
            cwd=BACKEND,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("API and migration credentials must not be available", result.stderr)

    def test_production_database_requires_ca_and_verify_full(self):
        url = "postgresql://tibbou_api_login@pooler.example.test/test"
        missing = run_python(
            "import app.db",
            DATABASE_URL=url,
            DATABASE_SSL_ROOT_CERT="",
            APP_ENV="production",
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("DATABASE_SSL_ROOT_CERT", missing.stderr)

        with tempfile.TemporaryDirectory() as directory:
            certificate = Path(directory) / "root.crt"
            certificate.write_text("test certificate path", encoding="ascii")
            checked = run_python(
                "from unittest.mock import patch\n"
                "with patch('sqlalchemy.create_engine') as create:\n"
                " import app.db\n"
                " assert create.call_args.kwargs['connect_args'] == "
                "{'sslmode': 'verify-full', 'sslrootcert': __import__('os').environ['DATABASE_SSL_ROOT_CERT']}\n",
                DATABASE_URL=url,
                DATABASE_SSL_ROOT_CERT=str(certificate),
                APP_ENV="production",
            )
        self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_worker_recovers_then_drains_on_sigterm(self):
        handlers = {}
        lock = MagicMock()
        lock.execute.return_value.one.return_value = (True, 1234)
        engine = MagicMock()
        engine.url.username = "tibbou_worker_login"
        engine.connect.return_value.__enter__.return_value = lock
        session = MagicMock()
        session.execute.return_value.scalar_one.return_value = 1
        session_factory = MagicMock()
        session_factory.return_value.__enter__.return_value = session

        def process_once(connection, backend_pid):
            self.assertIs(connection, lock)
            self.assertEqual(backend_pid, 1234)
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            return True

        with (
            patch.object(worker, "engine", engine),
            patch.object(worker, "SessionLocal", session_factory),
            patch.object(worker, "_assert_worker_ownership"),
            patch.object(worker, "process_next_run", side_effect=process_once) as process,
            patch.object(worker.logging, "basicConfig"),
            patch.object(worker.signal, "signal", side_effect=lambda sig, handler: handlers.setdefault(sig, handler)),
            patch.dict(os.environ, {"MIGRATION_DATABASE_URL": ""}),
            patch.object(sys, "argv", ["worker"]),
        ):
            worker.main()
        process.assert_called_once_with(lock, 1234)
        session_factory.assert_called_once_with(bind=lock)
        self.assertIn("recover_interrupted_sync_runs", str(session.execute.call_args.args[0]))
        lock.invalidate.assert_called_once_with()

    def test_lost_lock_rolls_back_results_instead_of_publishing(self):
        connection = MagicMock()
        run = SimpleNamespace(id="run-1", run_type="dbt_manifest_ingestion", status="running")
        raw = SimpleNamespace(id="raw-1", status="queued", raw_payload={"nodes": {}}, artifact_hash="hash")
        session = MagicMock()
        session.get.return_value = run
        session.query.return_value.filter.return_value.one_or_none.return_value = raw
        session.execute.return_value.one_or_none.return_value = SimpleNamespace(status="running", attempt_count=1)
        factory = MagicMock()
        factory.return_value.__enter__.return_value = session

        def stage_result(db, *_):
            db.add("staged result")
            return {"datasets_created": 1}

        with (
            patch.object(worker, "_claim_next_run", return_value=(run.id, "org", "user", 1)),
            patch.object(worker, "SessionLocal", factory),
            patch.object(worker, "_set_context"),
            patch.object(worker, "process_dbt_manifest", side_effect=stage_result),
            patch.object(worker, "_assert_worker_ownership", side_effect=[None, worker.LostOwnership("lock lost")]),
        ):
            with self.assertRaises(worker.LostOwnership):
                worker.process_next_run(connection, 1234)

        factory.assert_called_once_with(bind=connection)
        session.add.assert_called_once_with("staged result")
        session.rollback.assert_called_once_with()
        self.assertEqual(session.commit.call_count, 1)  # raw running, no result commit
        self.assertEqual(run.status, "running")
        self.assertEqual(raw.raw_payload, {"nodes": {}})

    def test_connection_loss_discards_staged_results_before_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = create_engine("sqlite:///" + str(Path(directory) / "results.db"))
            try:
                with engine.begin() as connection:
                    connection.execute(text("create table results (value text)"))
                locked_connection = engine.connect()
                try:
                    with Session(bind=locked_connection) as db:
                        db.execute(text("insert into results values ('stale')"))
                        locked_connection.invalidate()  # database session dies mid-job
                        db.rollback()
                finally:
                    locked_connection.close()
                with engine.begin() as replacement:
                    replacement.execute(text("insert into results values ('replacement')"))
                with engine.connect() as verify:
                    self.assertEqual(
                        verify.execute(text("select value from results")).all(),
                        [("replacement",)],
                    )
            finally:
                engine.dispose()

    def test_failed_job_cannot_requeue_after_lock_loss(self):
        run = SimpleNamespace(id="run-1", run_type="dbt_manifest_ingestion", status="running")
        raw = SimpleNamespace(id="raw-1", status="queued")
        session = MagicMock()
        session.get.return_value = run
        session.query.return_value.filter.return_value.one_or_none.return_value = raw
        session.execute.return_value.one_or_none.return_value = SimpleNamespace(status="running", attempt_count=1)
        factory = MagicMock()
        factory.return_value.__enter__.return_value = session
        with (
            patch.object(worker, "_claim_next_run", return_value=(run.id, "org", "user", 1)),
            patch.object(worker, "SessionLocal", factory),
            patch.object(worker, "_set_context"),
            patch.object(worker, "process_dbt_manifest", side_effect=ValueError("secret must not be logged")),
            patch.object(worker, "_assert_worker_ownership", side_effect=[None, worker.LostOwnership("lock lost")]),
            self.assertLogs("app.worker", level="ERROR") as logged,
        ):
            with self.assertRaises(worker.LostOwnership):
                worker.process_next_run(MagicMock(), 1234)
        self.assertEqual(run.status, "running")
        self.assertEqual(session.commit.call_count, 1)
        self.assertNotIn("secret must not be logged", " ".join(logged.output))

    def test_third_failed_attempt_is_not_requeued(self):
        run = SimpleNamespace(
            id="run-1", run_type="dbt_manifest_ingestion", status="running",
            attempt_count=3, finished_at=None, error=None,
        )
        raw = SimpleNamespace(id="raw-1", status="queued", artifact_hash="hash", raw_payload={"nodes": {}})
        session = MagicMock()
        session.get.side_effect = lambda model, _id: run if model is worker.SyncRun else raw
        session.query.return_value.filter.return_value.one_or_none.return_value = raw
        factory = MagicMock()
        factory.return_value.__enter__.return_value = session
        with (
            patch.object(worker, "_claim_next_run", return_value=(run.id, "org", "user", 3)),
            patch.object(worker, "SessionLocal", factory),
            patch.object(worker, "_set_context"),
            patch.object(worker, "_assert_run_ownership"),
            patch.object(worker, "process_dbt_manifest", side_effect=ValueError("failure")),
        ):
            self.assertTrue(worker.process_next_run(MagicMock(), 1234))
        self.assertEqual(run.status, "failed")
        self.assertEqual(raw.status, "failed")
        self.assertEqual(session.commit.call_count, 2)

    def test_lock_session_and_claim_attempt_are_fenced(self):
        db = MagicMock()
        db.execute.return_value.scalar_one.return_value = False
        with self.assertRaises(worker.LostOwnership):
            worker._assert_worker_ownership(db, 1234)
        self.assertIn("pg_catalog.pg_locks", str(db.execute.call_args.args[0]))
        self.assertEqual(db.execute.call_args.args[1], {"backend_pid": 1234})

        lock_result = MagicMock()
        lock_result.scalar_one.return_value = True
        run_result = MagicMock()
        run_result.one_or_none.return_value = SimpleNamespace(status="running", attempt_count=2)
        db.execute.side_effect = [lock_result, run_result]
        with self.assertRaises(worker.LostOwnership):
            worker._assert_run_ownership(db, 1234, "run-1", 1)
        self.assertIn("for update", str(db.execute.call_args.args[0]).lower())

    def test_replacement_recovers_after_worker_termination(self):
        first, replacement = MagicMock(), MagicMock()
        first.execute.return_value.one.return_value = (True, 1234)
        replacement.execute.return_value.one.return_value = (True, 5678)
        contexts = []
        for connection in (first, replacement):
            context = MagicMock()
            context.__enter__.return_value = connection
            contexts.append(context)
        engine = MagicMock()
        engine.url.username = "tibbou_worker_login"
        engine.connect.side_effect = contexts
        session = MagicMock()
        session.execute.return_value.scalar_one.return_value = 1
        factory = MagicMock()
        factory.return_value.__enter__.return_value = session
        with (
            patch.object(worker, "engine", engine),
            patch.object(worker, "SessionLocal", factory),
            patch.object(worker, "_assert_worker_ownership"),
            patch.object(worker, "process_next_run", side_effect=[SystemExit(9), False]) as process,
            patch.object(worker.logging, "basicConfig"),
            patch.object(worker.signal, "signal"),
            patch.dict(os.environ, {"MIGRATION_DATABASE_URL": ""}),
            patch.object(sys, "argv", ["worker", "--once"]),
        ):
            with self.assertRaises(SystemExit):
                worker.main()
            worker.main()
        self.assertEqual(process.call_count, 2)
        self.assertEqual(factory.call_count, 2)  # recovery on both starts
        first.invalidate.assert_called_once_with()
        replacement.invalidate.assert_called_once_with()

    def test_second_worker_does_not_recover_while_lock_is_held(self):
        lock = MagicMock()
        lock.execute.return_value.one.return_value = (False, 5678)
        engine = MagicMock()
        engine.url.username = "tibbou_worker_login"
        engine.connect.return_value.__enter__.return_value = lock
        with (
            patch.object(worker, "engine", engine),
            patch.object(worker, "SessionLocal") as sessions,
            patch.object(worker.logging, "basicConfig"),
            patch.object(worker.signal, "signal"),
            patch.dict(os.environ, {"MIGRATION_DATABASE_URL": ""}),
            patch.object(sys, "argv", ["worker", "--once"]),
        ):
            with self.assertRaises(SystemExit):
                worker.main()
        sessions.assert_not_called()

    def test_recovery_migration_is_worker_only(self):
        env = os.environ.copy()
        env["DATABASE_URL"] = "postgresql://localhost/tibbou_offline"
        env["MIGRATION_DATABASE_URL"] = ""
        result = subprocess.run(
            [
                sys.executable, "-B", "-m", "alembic", "-c",
                str(ROOT / "Database" / "alembic.ini"), "upgrade",
                "20260921_120000:20260922_120000", "--sql",
            ],
            cwd=BACKEND,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("candidate.attempt_count < 3", result.stdout.lower())
        self.assertIn("grant execute on function private.recover_interrupted_sync_runs() to tibbou_worker", result.stdout.lower())
        self.assertIn("where run.status = 'running'", result.stdout.lower())
        self.assertIn("finished_artifact.status in ('success', 'partial')", result.stdout.lower())
        self.assertIn("raw.organization_id = recovered.organization_id", result.stdout.lower())
        self.assertIn("raw.status = 'running'", result.stdout.lower())

        downgrade = subprocess.run(
            [
                sys.executable, "-B", "-m", "alembic", "-c",
                str(ROOT / "Database" / "alembic.ini"), "downgrade",
                "20260922_120000:20260921_120000", "--sql",
            ],
            cwd=BACKEND,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(downgrade.returncode, 0, downgrade.stderr)
        self.assertIn("drop function private.recover_interrupted_sync_runs()", downgrade.stdout.lower())
        self.assertIn("create or replace function private.claim_sync_run()", downgrade.stdout.lower())
        self.assertNotIn("candidate.attempt_count < 3", downgrade.stdout.lower())

    def test_bundle_uses_allowlist(self):
        result = subprocess.run(
            [sys.executable, "-B", "package_deployment.py"],
            cwd=BACKEND,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with ZipFile(BACKEND / "dist" / "tibbou-api.zip") as bundle:
            names = set(bundle.namelist())
        self.assertIn("Procfile", names)
        self.assertIn("app/main.py", names)
        self.assertIn(".platform/nginx/conf.d/elasticbeanstalk/uploads.conf", names)
        self.assertIn("certs/supabase-ca.crt", names)
        self.assertFalse(any(".env" in name or name.endswith(".key") for name in names))
        self.assertNotIn("snowflake_test.py", names)


if __name__ == "__main__":
    unittest.main()
