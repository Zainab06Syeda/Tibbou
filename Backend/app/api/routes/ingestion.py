import hashlib
import json
import os
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from psycopg2.errors import UniqueViolation
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import CurrentUser, OrganizationAccess, set_request_user_context
from app.permissions import require_capability
from app.db import get_db
from app.models.raw_ingestions import RawIngestion
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.schemas.ingestion import (
    DbtManifestIngestionRequest,
    LatestDbtManifestIngestionSummaryResponse,
    LatestSnowflakeDatasetCreditSummariesResponse,
    QueuedSyncRunResponse,
    SnowflakeSyncRequest,
    SyncRunRead,
)
from app.services.ingestion import build_legacy_credit_summary, utcnow, usage_window
from app.services.snowflake import lock_connection

router = APIRouter(
    prefix="/api/v1/organizations/{organization_id}/ingestion", tags=["ingestion"]
)


def max_dbt_manifest_bytes() -> int:
    return min(
        max(int(os.getenv("MAX_DBT_MANIFEST_BYTES", "10485760")), 1024),
        25 * 1024 * 1024,
    )


def _validated_idempotency_key(value: str | None, fallback: str) -> str:
    key = (value or fallback).strip()
    if not key or len(key) > 200:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Idempotency-Key must contain 1 to 200 characters",
        )
    return key


def _existing_run(db: Session, organization_id: UUID, key: str) -> SyncRun | None:
    return (
        db.query(SyncRun)
        .filter(
            SyncRun.organization_id == organization_id,
            SyncRun.idempotency_key == key,
        )
        .one_or_none()
    )


def _existing_run_after_idempotency_conflict(
    db: Session, organization_id: UUID, key: str, exc: IntegrityError, user: CurrentUser
) -> SyncRun:
    db.rollback()
    constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    if not isinstance(exc.orig, UniqueViolation) or constraint_name != "uq_sync_runs_org_idempotency":
        raise exc

    set_request_user_context(db, user.id, user.email)
    db.execute(text("select set_config('app.current_organization_id', :organization_id, true)"),
               {"organization_id": str(organization_id)})
    existing = _existing_run(db, organization_id, key)
    if existing is None:
        raise exc
    return existing


@router.post(
    "/dbt/manifest",
    response_model=QueuedSyncRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def enqueue_dbt_manifest(
    payload: DbtManifestIngestionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    access: OrganizationAccess = Depends(require_capability("upload_dbt_manifest")),
    db: Session = Depends(get_db),
) -> QueuedSyncRunResponse:
    encoded = json.dumps(payload.model_dump(mode="json"), separators=(",", ":"), sort_keys=True).encode()
    max_bytes = max_dbt_manifest_bytes()
    max_nodes = min(max(int(os.getenv("MAX_DBT_MANIFEST_NODES", "50000")), 1), 100000)
    resource_count = len(payload.nodes) + len(payload.sources)
    if len(encoded) > max_bytes or resource_count > max_nodes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="dbt manifest exceeds configured ingestion limits",
        )

    artifact_hash = hashlib.sha256(encoded).hexdigest()
    key = _validated_idempotency_key(idempotency_key, f"dbt:{artifact_hash}")
    existing = _existing_run(db, access.organization_id, key)
    if existing is not None:
        if existing.run_type != "dbt_manifest_ingestion":
            raise HTTPException(status_code=409, detail="Idempotency key is already in use")
        raw = db.query(RawIngestion).filter(RawIngestion.sync_run_id == existing.id).one_or_none()
        return QueuedSyncRunResponse(
            sync_run_id=existing.id,
            raw_ingestion_id=raw.id if raw else None,
            status=existing.status,
        )

    sync_run = SyncRun(
        organization_id=access.organization_id,
        requested_by=access.user.id,
        run_type="dbt_manifest_ingestion",
        status="queued",
        idempotency_key=key,
        details={"artifact_hash": artifact_hash, "resource_count": resource_count},
    )
    try:
        db.add(sync_run)
        db.flush()
        raw = RawIngestion(
            organization_id=access.organization_id,
            sync_run_id=sync_run.id,
            source_system="dbt",
            ingestion_type="manifest",
            status="queued",
            ingested_at=utcnow(),
            raw_payload=payload.model_dump(mode="json"),
            artifact_hash=artifact_hash,
        )
        db.add(raw)
        db.flush()
        response = QueuedSyncRunResponse(
            sync_run_id=sync_run.id, raw_ingestion_id=raw.id, status="queued"
        )
        db.commit()
    except IntegrityError as exc:
        existing = _existing_run_after_idempotency_conflict(
            db, access.organization_id, key, exc, access.user
        )
        if existing.run_type != "dbt_manifest_ingestion":
            raise HTTPException(status_code=409, detail="Idempotency key is already in use") from exc
        raw = (
            db.query(RawIngestion)
            .filter(RawIngestion.sync_run_id == existing.id)
            .one_or_none()
        )
        return QueuedSyncRunResponse(
            sync_run_id=existing.id,
            raw_ingestion_id=raw.id if raw else None,
            status=existing.status,
        )
    return response


@router.post(
    "/snowflake/query-usage",
    response_model=QueuedSyncRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def enqueue_snowflake_sync(
    payload: SnowflakeSyncRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    access: OrganizationAccess = Depends(require_capability("trigger_sync")),
    db: Session = Depends(get_db),
) -> QueuedSyncRunResponse:
    connection = (
        db.query(SnowflakeConnection)
        .filter(
            SnowflakeConnection.id == payload.connection_id,
            SnowflakeConnection.organization_id == access.organization_id,
        )
        .one_or_none()
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Snowflake connection not found")
    fallback = f"snowflake:{connection.id}:{utcnow().isoformat()}"
    key = _validated_idempotency_key(idempotency_key, fallback)
    existing = _existing_run(db, access.organization_id, key)
    if existing is not None:
        if existing.connection_id != connection.id or existing.run_type != "snowflake_query_usage_ingestion":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key is already in use")
        return QueuedSyncRunResponse(sync_run_id=existing.id, status=existing.status)

    # Share a transaction lock with scope edits, then reread after a waiter commits.
    lock_connection(db, access.organization_id, connection.id)
    db.refresh(connection)
    existing = _existing_run(db, access.organization_id, key)
    if existing is not None:
        if existing.connection_id != connection.id or existing.run_type != "snowflake_query_usage_ingestion":
            raise HTTPException(status_code=409, detail="Idempotency key is already in use")
        return QueuedSyncRunResponse(sync_run_id=existing.id, status=existing.status)
    if not connection.enabled or connection.status != "valid":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Validate and enable the Snowflake connection first")
    if not (connection.capabilities or {}).get("query_attribution_history"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Snowflake query attribution access is required")
    active = db.query(SyncRun).filter(
        SyncRun.organization_id == access.organization_id,
        SyncRun.connection_id == connection.id,
        SyncRun.run_type == "snowflake_query_usage_ingestion",
        SyncRun.status.in_(["queued", "running"]),
    ).first()
    if active is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Snowflake synchronization is already queued or running")
    period_end = utcnow()
    period_start, period_end = usage_window(connection.watermarks or {}, period_end)

    run = SyncRun(
        organization_id=access.organization_id,
        connection_id=connection.id,
        requested_by=access.user.id,
        run_type="snowflake_query_usage_ingestion",
        status="queued",
        idempotency_key=key,
        details={"connection_id": str(connection.id), "period_start": period_start.isoformat(),
                 "period_end": period_end.isoformat(), "source_latency_hours": 8},
    )
    try:
        db.add(run)
        db.flush()
        response = QueuedSyncRunResponse(sync_run_id=run.id, status=run.status)
        db.commit()
    except IntegrityError as exc:
        run = _existing_run_after_idempotency_conflict(
            db, access.organization_id, key, exc, access.user
        )
        if run.connection_id != connection.id or run.run_type != "snowflake_query_usage_ingestion":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key is already in use") from exc
        return QueuedSyncRunResponse(sync_run_id=run.id, status=run.status)
    return response


@router.get("/sync-runs/{sync_run_id}", response_model=SyncRunRead)
def get_sync_run(
    sync_run_id: UUID,
    access: OrganizationAccess = Depends(require_capability("view_data")),
    db: Session = Depends(get_db),
) -> SyncRunRead:
    run = (
        db.query(SyncRun)
        .filter(SyncRun.id == sync_run_id, SyncRun.organization_id == access.organization_id)
        .one_or_none()
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sync run not found")
    return run


@router.get(
    "/dbt/manifest/latest", response_model=LatestDbtManifestIngestionSummaryResponse
)
def latest_dbt_manifest(
    access: OrganizationAccess = Depends(require_capability("view_data")), db: Session = Depends(get_db)
) -> LatestDbtManifestIngestionSummaryResponse:
    run = (
        db.query(SyncRun)
        .filter(
            SyncRun.organization_id == access.organization_id,
            SyncRun.run_type == "dbt_manifest_ingestion",
        )
        .order_by(SyncRun.queued_at.desc(), SyncRun.id.desc())
        .first()
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dbt sync run not found")
    raw = db.query(RawIngestion).filter(RawIngestion.sync_run_id == run.id).one_or_none()
    if raw is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dbt artifact record not found")
    details = run.details or {}
    return LatestDbtManifestIngestionSummaryResponse(
        sync_run_id=run.id,
        raw_ingestion_id=raw.id,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        datasets_processed=details.get("datasets_processed", 0),
        datasets_created=details.get("datasets_created", 0),
        datasets_deactivated=details.get("datasets_deactivated", 0),
        lineage_edges_processed=details.get("lineage_edges_processed", 0),
        lineage_edges_created=details.get("lineage_edges_created", 0),
        lineage_edges_deactivated=details.get("lineage_edges_deactivated", 0),
    )


@router.get(
    "/snowflake/dataset-credit-summaries/latest",
    response_model=LatestSnowflakeDatasetCreditSummariesResponse,
)
def latest_snowflake_summaries(
    access: OrganizationAccess = Depends(require_capability("view_data")), db: Session = Depends(get_db)
) -> LatestSnowflakeDatasetCreditSummariesResponse:
    run = (
        db.query(SyncRun)
        .filter(
            SyncRun.organization_id == access.organization_id,
            SyncRun.run_type == "snowflake_query_usage_ingestion",
            SyncRun.status.in_(["success", "partial"]),
        )
        .order_by(SyncRun.finished_at.desc(), SyncRun.id.desc())
        .first()
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Snowflake summaries not found")

    legacy_summary = None
    if not isinstance((run.details or {}).get("published_summary"), dict):
        legacy_summary = build_legacy_credit_summary(db, access.organization_id, run.id)
        # A page may capture the report between the run lookup and aggregate.
        # Recheck afterward so READ COMMITTED readers never return moved rows.
        db.refresh(run, attribute_names=["details"])

    if isinstance((run.details or {}).get("published_summary"), dict):
        latest_attempt = db.query(SyncRun.status).filter(
            SyncRun.organization_id == access.organization_id,
            SyncRun.connection_id == run.connection_id,
            SyncRun.run_type == "snowflake_query_usage_ingestion",
        ).order_by(SyncRun.queued_at.desc(), SyncRun.id.desc()).first()
        return LatestSnowflakeDatasetCreditSummariesResponse.model_validate({
            **run.details["published_summary"],
            "sync_run_id": run.id,
            "organization_id": access.organization_id,
            "connection_id": run.connection_id,
            "report_state": run.details["published_summary"].get("report_state", "frozen"),
            "status": run.status,
            "last_success_at": run.finished_at,
            "latest_attempt_status": latest_attempt[0] if latest_attempt else run.status,
        })

    return LatestSnowflakeDatasetCreditSummariesResponse.model_validate({
        **legacy_summary,
        "sync_run_id": run.id,
        "organization_id": access.organization_id,
        "connection_id": run.connection_id,
        "last_success_at": run.finished_at,
        "latest_attempt_status": run.status,
        "status": run.status,
    })
