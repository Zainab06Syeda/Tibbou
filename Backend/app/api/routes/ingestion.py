import hashlib
import json
import os
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from psycopg2.errors import UniqueViolation
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess, require_operator, require_viewer
from app.db import get_db
from app.models.datasets import Dataset
from app.models.query_usage import QueryDatasetAllocation, QueryUsage
from app.models.raw_ingestions import RawIngestion
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.schemas.ingestion import (
    DbtManifestIngestionRequest,
    LatestDbtManifestIngestionSummaryResponse,
    LatestSnowflakeDatasetCreditSummariesResponse,
    QueuedSyncRunResponse,
    SnowflakeDatasetCreditSummaryItem,
    SnowflakeSyncRequest,
    SyncRunRead,
)
from app.services.ingestion import utcnow

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
    db: Session, organization_id: UUID, key: str, exc: IntegrityError
) -> SyncRun:
    db.rollback()
    constraint_name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    if not isinstance(exc.orig, UniqueViolation) or constraint_name != "uq_sync_runs_org_idempotency":
        raise exc

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
    access: OrganizationAccess = Depends(require_operator),
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
        db.commit()
    except IntegrityError as exc:
        existing = _existing_run_after_idempotency_conflict(
            db, access.organization_id, key, exc
        )
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
    return QueuedSyncRunResponse(sync_run_id=sync_run.id, raw_ingestion_id=raw.id, status="queued")


@router.post(
    "/snowflake/query-usage",
    response_model=QueuedSyncRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def enqueue_snowflake_sync(
    payload: SnowflakeSyncRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    access: OrganizationAccess = Depends(require_operator),
    db: Session = Depends(get_db),
) -> QueuedSyncRunResponse:
    connection = (
        db.query(SnowflakeConnection)
        .filter(
            SnowflakeConnection.id == payload.connection_id,
            SnowflakeConnection.organization_id == access.organization_id,
            SnowflakeConnection.status != "disabled",
        )
        .one_or_none()
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Snowflake connection not found")

    fallback = f"snowflake:{connection.id}:{utcnow().strftime('%Y-%m-%dT%H')}"
    key = _validated_idempotency_key(idempotency_key, fallback)
    existing = _existing_run(db, access.organization_id, key)
    if existing is not None:
        return QueuedSyncRunResponse(sync_run_id=existing.id, status=existing.status)

    run = SyncRun(
        organization_id=access.organization_id,
        connection_id=connection.id,
        requested_by=access.user.id,
        run_type="snowflake_query_usage_ingestion",
        status="queued",
        idempotency_key=key,
        details={"connection_id": str(connection.id)},
    )
    try:
        db.add(run)
        db.commit()
    except IntegrityError as exc:
        run = _existing_run_after_idempotency_conflict(
            db, access.organization_id, key, exc
        )
    return QueuedSyncRunResponse(sync_run_id=run.id, status=run.status)


@router.get("/sync-runs/{sync_run_id}", response_model=SyncRunRead)
def get_sync_run(
    sync_run_id: UUID,
    access: OrganizationAccess = Depends(require_viewer),
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
    access: OrganizationAccess = Depends(require_viewer), db: Session = Depends(get_db)
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
    access: OrganizationAccess = Depends(require_viewer), db: Session = Depends(get_db)
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

    rows = (
        db.query(
            Dataset.id,
            Dataset.name,
            func.sum(QueryUsage.compute_credits * QueryDatasetAllocation.allocation_weight),
            func.sum(QueryUsage.acceleration_credits * QueryDatasetAllocation.allocation_weight),
            func.count(QueryUsage.id.distinct()),
            func.min(QueryUsage.started_at),
            func.max(QueryUsage.ended_at),
        )
        .join(QueryDatasetAllocation, QueryDatasetAllocation.dataset_id == Dataset.id)
        .join(QueryUsage, QueryUsage.id == QueryDatasetAllocation.query_usage_id)
        .filter(
            Dataset.organization_id == access.organization_id,
            QueryUsage.sync_run_id == run.id,
        )
        .group_by(Dataset.id, Dataset.name)
        .order_by(Dataset.name, Dataset.id)
        .all()
    )
    summaries = [
        SnowflakeDatasetCreditSummaryItem(
            dataset_id=row[0],
            dataset_name=row[1],
            total_credits_attributed_compute=float(row[2]) if row[2] is not None else None,
            total_credits_used_query_acceleration=float(row[3]) if row[3] is not None else None,
            attributed_query_count=row[4],
            period_start=row[5],
            period_end=row[6],
        )
        for row in rows
    ]
    period_start = min((item.period_start for item in summaries if item.period_start), default=None)
    period_end = max((item.period_end for item in summaries if item.period_end), default=None)
    return LatestSnowflakeDatasetCreditSummariesResponse(
        sync_run_id=run.id,
        status=run.status,
        period_start=period_start,
        period_end=period_end,
        dataset_credit_summaries=summaries,
        dataset_credit_summary_count=len(summaries),
    )
