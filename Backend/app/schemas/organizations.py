from datetime import datetime
import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class OrganizationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str
    role: str
    created_at: datetime


class OrganizationSummaryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    allow_domain_join: bool = False

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Organization name is required")
        return normalized


class DomainMatchRead(BaseModel):
    organization: OrganizationSummaryRead | None
    allow_domain_join: bool
    already_requested: bool


class OrganizationJoinRequestRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    email: str
    status: str
    created_at: datetime
    resolved_at: datetime | None


class OrganizationJoinRequestSummaryRead(BaseModel):
    id: UUID
    user_id: UUID
    email: str
    status: str
    created_at: datetime


class OrganizationMembershipRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    role: str
    created_at: datetime


class OrganizationInvitationCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Literal["admin", "operator", "viewer"] = "viewer"

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
            raise ValueError("Enter a valid email address")
        return normalized


class OrganizationInvitationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    email: str
    role: str
    invited_by: UUID
    created_at: datetime
    expires_at: datetime


class OrganizationInvitationSummaryRead(BaseModel):
    id: UUID
    organization_id: UUID
    organization_name: str
    organization_slug: str
    role: str
    expires_at: datetime


class OrganizationAdminCurrentUserRead(BaseModel):
    id: UUID
    email: str | None
    role: str


class OrganizationAdminRead(BaseModel):
    organization: OrganizationRead
    memberships: list[OrganizationMembershipRead]
    invitations: list[OrganizationInvitationRead]
    current_user: OrganizationAdminCurrentUserRead
