import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Numeric, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db import Base


class CostSnapshot(Base):
    __tablename__ = "cost_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    dataset_id = Column(UUID(as_uuid=True), ForeignKey("datasets.id"), nullable=False)
    period_start = Column(DateTime(timezone=True), nullable=False)
    period_end = Column(DateTime(timezone=True), nullable=False)
    cost_amount = Column(Numeric, nullable=False)
    currency = Column(Text, nullable=False, server_default=text("'USD'"))
    usage_unit = Column(Text, nullable=True)
    usage_amount = Column(Numeric, nullable=True)
    collected_at = Column(DateTime(timezone=True), nullable=False)
    dataset = relationship("Dataset", back_populates="cost_snapshots")
