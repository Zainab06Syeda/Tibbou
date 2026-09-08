from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CostSnapshotCreate(BaseModel):
    dataset_id: UUID
    period_start: datetime
    period_end: datetime
    cost_amount: Decimal
    currency: str | None = None
    usage_unit: str | None = None
    usage_amount: Decimal | None = None
    collected_at: datetime


class CostSnapshotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    dataset_id: UUID
    period_start: datetime
    period_end: datetime
    cost_amount: Decimal
    currency: str
    usage_unit: str | None
    usage_amount: Decimal | None
    collected_at: datetime
