from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SnowflakeConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    account_identifier: str = Field(min_length=1, max_length=255)
    user_name: str | None = Field(default=None, max_length=255)
    role_name: str = Field(min_length=1, max_length=255)
    warehouse_name: str = Field(min_length=1, max_length=255)
    auth_method: Literal["external_oauth", "workload_identity", "key_pair"]
    secret_reference: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$")


class SnowflakeConnectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    account_identifier: str
    user_name: str | None
    role_name: str
    warehouse_name: str
    auth_method: str
    status: str
    capabilities: dict[str, Any]
    enabled: bool
    last_validated_at: datetime | None
    last_success_at: datetime | None
    created_at: datetime
    updated_at: datetime
