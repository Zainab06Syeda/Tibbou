from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class LineageEdgeCreate(BaseModel):
    upstream_dataset_id: UUID
    downstream_dataset_id: UUID
    relationship_type: str | None = None
    provenance: str = "manual"


class LineageEdgeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    upstream_dataset_id: UUID
    downstream_dataset_id: UUID
    relationship_type: str | None
    provenance: str
    is_active: bool
    created_at: datetime
