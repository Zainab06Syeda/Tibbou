from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DbtManifestIngestionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    metadata: dict[str, Any] = Field(default_factory=dict)
    nodes: dict[str, dict[str, Any]]
    sources: dict[str, dict[str, Any]] = Field(default_factory=dict)


class QueuedSyncRunResponse(BaseModel):
    sync_run_id: UUID
    raw_ingestion_id: UUID | None = None
    status: str


class SnowflakeSyncRequest(BaseModel):
    connection_id: UUID


class SyncRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    connection_id: UUID | None
    run_type: str
    status: str
    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    attempt_count: int
    details: dict[str, Any] | None
    error: str | None


class SnowflakeDatasetCreditSummaryItem(BaseModel):
    dataset_id: UUID
    dataset_name: str
    total_credits_attributed_compute: float | None
    total_credits_used_query_acceleration: float | None
    attributed_query_count: int
    period_start: datetime | None
    period_end: datetime | None


class LatestSnowflakeDatasetCreditSummariesResponse(BaseModel):
    sync_run_id: UUID
    status: str
    period_start: datetime | None
    period_end: datetime | None
    dataset_credit_summaries: list[SnowflakeDatasetCreditSummaryItem]
    dataset_credit_summary_count: int


class LatestDbtManifestIngestionSummaryResponse(BaseModel):
    sync_run_id: UUID
    raw_ingestion_id: UUID
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    datasets_processed: int
    datasets_created: int
    datasets_deactivated: int
    lineage_edges_processed: int
    lineage_edges_created: int
    lineage_edges_deactivated: int
