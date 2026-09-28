import argparse
import logging
import os
import signal
from datetime import timedelta
from pathlib import Path
from threading import Event

from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.engine import make_url

if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[1] / ".env.worker")
    if os.getenv("MIGRATION_DATABASE_URL") or os.getenv("DATABASE_URL"):
        raise RuntimeError("API and migration credentials must not be available to the worker")
    worker_database_url = os.getenv("WORKER_DATABASE_URL")
    worker_user = (make_url(worker_database_url).username or "") if worker_database_url else ""
    if worker_user.split(".", 1)[0] != "tibbou_worker_login":
        raise RuntimeError("Worker requires the tibbou_worker_login database role")
    os.environ.setdefault("DATABASE_POOL_SIZE", "2")
    os.environ.setdefault("DATABASE_MAX_OVERFLOW", "0")
    pool_size = int(os.environ["DATABASE_POOL_SIZE"])
    max_overflow = int(os.environ["DATABASE_MAX_OVERFLOW"])
    if pool_size < 2 or max_overflow < 0 or pool_size + max_overflow > 4:
        raise RuntimeError("Worker database pool must allow 2 to 4 connections")
    os.environ["DATABASE_URL"] = worker_database_url

from app.auth import set_request_user_context
from app.db import SessionLocal, engine
from app.models.raw_ingestions import RawIngestion
from app.models.sync_runs import SyncRun
from app.services.ingestion import process_dbt_manifest, process_snowflake_sync, utcnow

MAX_ATTEMPTS = 3
logger = logging.getLogger(__name__)


class LostOwnership(RuntimeError):
    pass


def _set_context(db, user_id, organization_id) -> None:
    set_request_user_context(db, user_id)
    db.execute(
        text("select set_config('app.current_organization_id', :organization_id, true)"),
        {"organization_id": str(organization_id)},
    )


def _assert_worker_ownership(db, backend_pid: int) -> None:
    owns_lock = db.execute(
        text(
            "select pg_backend_pid() = :backend_pid and exists ("
            "select 1 from pg_catalog.pg_locks "
            "where pid = pg_backend_pid() and locktype = 'advisory' "
            "and classid = 260922 and objid = 1 and objsubid = 2 "
            "and mode = 'ExclusiveLock' and granted)"
        ),
        {"backend_pid": backend_pid},
    ).scalar_one()
    if not owns_lock:
        raise LostOwnership("Worker lost the database lock")


def _assert_run_ownership(db, backend_pid: int, run_id, attempt_count: int) -> None:
    _assert_worker_ownership(db, backend_pid)
    row = db.execute(
        text("select status, attempt_count from public.sync_runs where id = :id for update"),
        {"id": run_id},
    ).one_or_none()
    if row is None or row.status != "running" or row.attempt_count != attempt_count:
        raise LostOwnership("Worker lost the ingestion run")


def _claim_next_run(connection, backend_pid: int) -> tuple[object, object, object, int] | None:
    with SessionLocal(bind=connection) as db:
        _assert_worker_ownership(db, backend_pid)
        claim = db.execute(text("select * from private.claim_sync_run()"))
        row = claim.one_or_none()
        if row is None:
            return None
        _set_context(db, row.requested_by, row.organization_id)
        attempt_count = db.execute(
            text("select attempt_count from public.sync_runs where id = :id"),
            {"id": row.id},
        ).scalar_one()
        db.commit()
        return row.id, row.organization_id, row.requested_by, attempt_count


def _safe_failure_message(run_type: str) -> str:
    if run_type == "snowflake_query_usage_ingestion":
        return "Snowflake synchronization failed; review restricted worker logs"
    return "Artifact processing failed; review restricted worker logs"


def process_next_run(connection, backend_pid: int) -> bool:
    claimed = _claim_next_run(connection, backend_pid)
    if claimed is None:
        return False
    run_id, organization_id, requested_by, attempt_count = claimed

    with SessionLocal(bind=connection) as db:
        _set_context(db, requested_by, organization_id)
        run = db.get(SyncRun, run_id)
        if run is None:
            raise LostOwnership("Claimed ingestion run is unavailable")
        raw = (
            db.query(RawIngestion).filter(RawIngestion.sync_run_id == run.id).one_or_none()
        )
        if raw is not None:
            _assert_run_ownership(db, backend_pid, run_id, attempt_count)
            raw.status = "running"
            db.commit()
            _set_context(db, requested_by, organization_id)

        try:
            if run.run_type == "dbt_manifest_ingestion":
                if raw is None:
                    raise RuntimeError("dbt artifact record is unavailable")
                result = process_dbt_manifest(db, run, raw)
                final_status = "success"
            elif run.run_type == "snowflake_query_usage_ingestion":
                result = process_snowflake_sync(db, run)
                final_status = "success" if result["access_history_available"] else "partial"
            else:
                raise RuntimeError("Unsupported sync run type")

            # The lock and result transaction use one physical PostgreSQL session.
            # Losing that session rolls back staged results; a replacement claim
            # changes attempt_count, so stale work cannot publish after reconnect.
            _assert_run_ownership(db, backend_pid, run_id, attempt_count)
            run = db.get(SyncRun, run_id)
            run.status = final_status
            run.finished_at = utcnow()
            run.details = {**(run.details or {}), **result}
            if raw is not None:
                raw = db.get(RawIngestion, raw.id)
                raw.status = final_status
                # Retain the digest and summary, not the full manifest indefinitely.
                raw.raw_payload = {
                    "artifact_hash": raw.artifact_hash,
                    "summary": result,
                }
            db.commit()
        except LostOwnership:
            logger.error("Ingestion run %s lost worker ownership", run_id)
            db.rollback()
            raise
        except Exception as exc:
            logger.error("Ingestion run %s failed: %s", run_id, type(exc).__name__)
            db.rollback()
            _set_context(db, requested_by, organization_id)
            _assert_run_ownership(db, backend_pid, run_id, attempt_count)
            run = db.get(SyncRun, run_id)
            message = _safe_failure_message(run.run_type)
            if run.attempt_count < MAX_ATTEMPTS:
                run.status = "queued"
                run.queued_at = utcnow() + timedelta(minutes=5 * run.attempt_count)
            else:
                run.status = "failed"
                run.finished_at = utcnow()
            run.error = message
            if raw is not None:
                raw = db.get(RawIngestion, raw.id)
                raw.status = run.status
                raw.error = message
                if run.status == "failed":
                    raw.raw_payload = {"artifact_hash": raw.artifact_hash}
            db.commit()
    return True


def main() -> None:
    if os.getenv("MIGRATION_DATABASE_URL") or (engine.url.username or "").split(".", 1)[0] != "tibbou_worker_login":
        raise RuntimeError("Worker requires the tibbou_worker_login database role without migration credentials")
    parser = argparse.ArgumentParser(description="Process Tibbou ingestion jobs")
    parser.add_argument("--once", action="store_true", help="Process at most one queued job")
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    try:
        # ponytail: one worker holds this session lock; use job leases if scaling workers.
        with engine.connect() as lock_db:
            locked, backend_pid = lock_db.execute(
                text("select pg_try_advisory_lock(260922, 1), pg_backend_pid()")
            ).one()
            lock_db.commit()
            if not locked:
                raise RuntimeError("Another ingestion worker is active")
            try:
                with SessionLocal(bind=lock_db) as db:
                    _assert_worker_ownership(db, backend_pid)
                    recovered = db.execute(text("select private.recover_interrupted_sync_runs()"))
                    logger.info("Recovered %s interrupted ingestion runs", recovered.scalar_one())
                    db.commit()
                while not stop.is_set():
                    processed = process_next_run(lock_db, backend_pid)
                    if args.once:
                        return
                    if not processed:
                        stop.wait(min(max(args.poll_seconds, 0.5), 30.0))
            finally:
                # Closing the physical session also releases its advisory lock.
                lock_db.invalidate()
    except Exception as exc:
        logger.error("Ingestion worker stopped: %s", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
