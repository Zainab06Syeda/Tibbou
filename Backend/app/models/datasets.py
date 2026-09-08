import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db import Base


class Dataset(Base):
    __tablename__ = "datasets"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "system", "source_unique_id", name="uq_datasets_org_source_id"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name = Column(Text, nullable=False)
    system = Column(Text, nullable=False)
    namespace = Column(Text, nullable=True)
    source_unique_id = Column(Text, nullable=True)
    account_name = Column(Text, nullable=True)
    database_name = Column(Text, nullable=True)
    schema_name = Column(Text, nullable=True)
    object_name = Column(Text, nullable=True)
    object_domain = Column(Text, nullable=True)
    relation_name = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, server_default="true")
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    upstream_edges = relationship(
        "LineageEdge",
        foreign_keys="LineageEdge.upstream_dataset_id",
        back_populates="upstream_dataset",
    )
    downstream_edges = relationship(
        "LineageEdge",
        foreign_keys="LineageEdge.downstream_dataset_id",
        back_populates="downstream_dataset",
    )
    cost_snapshots = relationship("CostSnapshot", back_populates="dataset")
