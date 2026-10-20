from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_serializer


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

    @computed_field
    @property
    def is_complete(self) -> bool:
        return self.status in {"success", "partial"}


class SnowflakeDatasetCreditSummaryItem(BaseModel):
    dataset_id: UUID
    dataset_name: str
    total_credits_attributed_compute: Decimal | None
    total_credits_used_query_acceleration: Decimal | None
    attributed_query_count: int
    period_start: datetime | None
    period_end: datetime | None
    unit: str = "credits"
    source: str = "Tibbou allocation from Snowflake query and access history"
    allocation_method: str = "equal split across matched dbt datasets; modified, direct, then base objects"


    @field_serializer("total_credits_attributed_compute", "total_credits_used_query_acceleration", when_used="json")
    def serialize_credits(self, value: Decimal | None) -> float | None:
        # Keep the existing JSON number contract; all stored arithmetic stays Decimal.
        return float(value) if value is not None else None


class LatestSnowflakeDatasetCreditSummariesResponse(BaseModel):
    sync_run_id: UUID
    organization_id: UUID | None = None
    connection_id: UUID | None = None
    status: str
    period_start: datetime | None
    period_end: datetime | None
    unit: str = "credits"
    source: str = "SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY"
    source_latency_hours: int = 8
    credit_precision: Decimal = Decimal("0.000000001")
    billing_scope: str = "Query compute and acceleration credits; excludes idle warehouse time and other charges"
    last_success_at: datetime | None = None
    latest_attempt_status: str | None = None
    observed_start: datetime | None = None
    observed_end: datetime | None = None
    capabilities: dict[str, Any] = Field(default_factory=dict)
    query_count: int | None = None
    attribution_status: str = "unknown"
    report_state: Literal["frozen", "legacy"] = "legacy"
    attributed_query_count: int | None = None
    attribution_coverage: Decimal | None = None
    total_compute_credits: Decimal | None = None
    total_acceleration_credits: Decimal | None = None
    total_credits: Decimal | None = None
    allocated_credits: Decimal | None = None
    unattributed_credits: Decimal | None = None
    unavailable_attribution_credits: Decimal | None = None
    dataset_credit_summaries: list[SnowflakeDatasetCreditSummaryItem]
    dataset_credit_summary_count: int


    @field_serializer("credit_precision", "attribution_coverage", "total_compute_credits", "total_acceleration_credits", "total_credits", "allocated_credits", "unattributed_credits", "unavailable_attribution_credits", when_used="json")
    def serialize_credits(self, value: Decimal | None) -> float | None:
        return float(value) if value is not None else None


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
