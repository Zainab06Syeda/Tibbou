import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db import Base


class SnowflakeConnection(Base):
    __tablename__ = "snowflake_connections"
    __table_args__ = (
        UniqueConstraint("organization_id", "name", name="uq_snowflake_connections_org_name"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name = Column(Text, nullable=False)
    account_identifier = Column(Text, nullable=False)
    user_name = Column(Text, nullable=True)
    role_name = Column(Text, nullable=False)
    warehouse_name = Column(Text, nullable=False)
    auth_method = Column(Text, nullable=False)
    secret_reference = Column(Text, nullable=False)
    status = Column(Text, nullable=False, server_default="pending")
    capabilities = Column(JSONB, nullable=False, server_default="{}")
    watermarks = Column(JSONB, nullable=False, server_default="{}")
    enabled = Column(Boolean, nullable=False, server_default="false")
    last_validated_at = Column(DateTime(timezone=True), nullable=True)
    last_success_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
