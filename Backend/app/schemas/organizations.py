from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", min_length=2, max_length=63)


class OrganizationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str
    role: str
    created_at: datetime


class OrganizationMembershipRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    role: str
    created_at: datetime


class OrganizationAdminCurrentUserRead(BaseModel):
    id: UUID
    email: str | None
    role: str


class OrganizationAdminRead(BaseModel):
    organization: OrganizationRead
    memberships: list[OrganizationMembershipRead]
    current_user: OrganizationAdminCurrentUserRead
