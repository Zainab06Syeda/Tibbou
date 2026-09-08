import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.db import Base


class QueryUsage(Base):
    __tablename__ = "query_usage"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "connection_id", "snowflake_query_id", name="uq_query_usage_org_query"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    sync_run_id = Column(
        UUID(as_uuid=True), ForeignKey("sync_runs.id", ondelete="CASCADE"), nullable=False
    )
    connection_id = Column(
        UUID(as_uuid=True), ForeignKey("snowflake_connections.id", ondelete="CASCADE"), nullable=False
    )
    snowflake_query_id = Column(Text, nullable=False)
    query_hash = Column(Text, nullable=False)
    warehouse_name = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    compute_credits = Column(Numeric, nullable=True)
    acceleration_credits = Column(Numeric, nullable=True)


class QueryDatasetAllocation(Base):
    __tablename__ = "query_dataset_allocations"
    __table_args__ = (
        UniqueConstraint("query_usage_id", "dataset_id", name="uq_query_dataset_allocation"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    query_usage_id = Column(
        UUID(as_uuid=True), ForeignKey("query_usage.id", ondelete="CASCADE"), nullable=False
    )
    dataset_id = Column(
        UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False
    )
    allocation_weight = Column(Numeric, nullable=False)
    evidence_source = Column(Text, nullable=False)
