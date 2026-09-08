import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Numeric, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db import Base


class LineageEdge(Base):
    __tablename__ = "lineage_edges"
    __table_args__ = (
        UniqueConstraint(
            "upstream_dataset_id",
            "downstream_dataset_id",
            "relationship_type",
            "provenance",
            name="uq_lineage_edges_upstream_downstream_relationship",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    upstream_dataset_id = Column(
        UUID(as_uuid=True), ForeignKey("datasets.id"), nullable=False
    )
    downstream_dataset_id = Column(
        UUID(as_uuid=True), ForeignKey("datasets.id"), nullable=False
    )
    relationship_type = Column(Text, nullable=True)
    provenance = Column(Text, nullable=False, server_default="manual")
    confidence = Column(Numeric, nullable=False, server_default="1")
    is_active = Column(Boolean, nullable=False, server_default="true")
    observed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    upstream_dataset = relationship(
        "Dataset",
        foreign_keys=[upstream_dataset_id],
        back_populates="upstream_edges",
    )
    downstream_dataset = relationship(
        "Dataset",
        foreign_keys=[downstream_dataset_id],
        back_populates="downstream_edges",
    )
