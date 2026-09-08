import argparse
import time
from datetime import timedelta

from sqlalchemy import text

from app.auth import set_request_user_context
from app.db import SessionLocal
from app.models.raw_ingestions import RawIngestion
from app.models.sync_runs import SyncRun
from app.services.ingestion import process_dbt_manifest, process_snowflake_sync, utcnow

MAX_ATTEMPTS = 3


def _set_context(db, user_id, organization_id) -> None:
    set_request_user_context(db, user_id)
    db.execute(
        text("select set_config('app.current_organization_id', :organization_id, true)"),
        {"organization_id": str(organization_id)},
    )


def _claim_next_run() -> tuple[object, object, object] | None:
    with SessionLocal() as db:
        claim = db.execute(text("select * from private.claim_sync_run()"))
        row = claim.one_or_none()
        if row is None:
            return None
        db.commit()
        return row.id, row.organization_id, row.requested_by


def _safe_failure_message(run_type: str) -> str:
    if run_type == "snowflake_query_usage_ingestion":
        return "Snowflake synchronization failed; review restricted worker logs"
    return "Artifact processing failed; review restricted worker logs"


def process_next_run() -> bool:
    claimed = _claim_next_run()
    if claimed is None:
        return False
    run_id, organization_id, requested_by = claimed

    with SessionLocal() as db:
        _set_context(db, requested_by, organization_id)
        run = db.get(SyncRun, run_id)
        if run is None:
            return True
        raw = (
            db.query(RawIngestion).filter(RawIngestion.sync_run_id == run.id).one_or_none()
        )
        if raw is not None:
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
        except Exception:
            db.rollback()
            _set_context(db, requested_by, organization_id)
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
    parser = argparse.ArgumentParser(description="Process Tibbou ingestion jobs")
    parser.add_argument("--once", action="store_true", help="Process at most one queued job")
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    args = parser.parse_args()

    while True:
        processed = process_next_run()
        if args.once:
            return
        if not processed:
            time.sleep(min(max(args.poll_seconds, 0.5), 30.0))


if __name__ == "__main__":
    main()
