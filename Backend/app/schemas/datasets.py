from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    system: str = Field(min_length=1, max_length=64)
    namespace: str | None = None
    source_unique_id: str | None = None
    account_name: str | None = None
    database_name: str | None = None
    schema_name: str | None = None
    object_name: str | None = None
    object_domain: str | None = None
    relation_name: str | None = None


class DatasetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    system: str
    namespace: str | None
    source_unique_id: str | None
    account_name: str | None
    database_name: str | None
    schema_name: str | None
    object_name: str | None
    object_domain: str | None
    relation_name: str | None
    is_active: bool
    created_at: datetime
