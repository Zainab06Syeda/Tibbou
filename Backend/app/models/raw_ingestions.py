import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db import Base


class RawIngestion(Base):
    __tablename__ = "raw_ingestions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    sync_run_id = Column(
        UUID(as_uuid=True), ForeignKey("sync_runs.id", ondelete="CASCADE"), nullable=False
    )
    source_system = Column(Text, nullable=False)
    ingestion_type = Column(Text, nullable=False)
    status = Column(Text, nullable=False)
    ingested_at = Column(DateTime(timezone=True), nullable=False)
    raw_payload = Column(JSONB, nullable=False)
    artifact_hash = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
