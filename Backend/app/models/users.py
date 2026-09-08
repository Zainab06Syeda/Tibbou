import uuid

from sqlalchemy import Boolean, Column, DateTime, Text, func, text
from sqlalchemy.dialects.postgresql import UUID

from app.db import Base


class User(Base):
    """Deprecated MVP credential table; retained only for migration compatibility.

    New identities come from Supabase auth.users. No application route reads or writes
    this model, and it should be archived only after legacy-row ownership is reviewed.
    """
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(Text, unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Boolean, nullable=False, server_default=text("true"))
