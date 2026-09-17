import uuid

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID

from app.db import Base


class OrganizationInvitation(Base):
    __tablename__ = "organization_invitations"
    __table_args__ = (
        CheckConstraint(
            "email = lower(btrim(email)) and length(email) between 3 and 320 "
            "and email not like '% %' and email like '%_@_%._%'",
            name="ck_organization_invitations_email",
        ),
        CheckConstraint(
            "role in ('admin', 'operator', 'viewer')",
            name="ck_organization_invitations_role",
        ),
        CheckConstraint(
            "expires_at > created_at",
            name="ck_organization_invitations_expiry",
        ),
        UniqueConstraint(
            "organization_id", "email", name="uq_organization_invitations_org_email"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
    )
    email = Column(Text, nullable=False)
    role = Column(Text, nullable=False, server_default="viewer")
    # Supabase Auth manages auth.users; the migration creates this foreign key.
    invited_by = Column(UUID(as_uuid=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now() + interval '7 days'"),
    )
