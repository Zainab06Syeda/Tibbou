import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db import Base


class SyncRun(Base):
    __tablename__ = "sync_runs"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "idempotency_key", name="uq_sync_runs_org_idempotency"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    connection_id = Column(
        UUID(as_uuid=True),
        ForeignKey("snowflake_connections.id", ondelete="SET NULL"),
        nullable=True,
    )
    requested_by = Column(UUID(as_uuid=True), nullable=False)
    run_type = Column(Text, nullable=False)
    status = Column(Text, nullable=False)
    queued_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    attempt_count = Column(Integer, nullable=False, server_default="0")
    idempotency_key = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    error = Column(Text, nullable=True)
