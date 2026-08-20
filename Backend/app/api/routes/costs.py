from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess, require_operator, require_viewer
from app.db import get_db
from app.models.cost_snapshots import CostSnapshot
from app.models.datasets import Dataset
from app.schemas.costs import CostSnapshotCreate, CostSnapshotRead

router = APIRouter(prefix="/api/v1/organizations/{organization_id}/costs", tags=["costs"])


@router.get("", response_model=list[CostSnapshotRead])
def list_cost_snapshots(
    limit: int = Query(500, ge=1, le=2000),
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> list[CostSnapshotRead]:
    snapshots = (
        db.query(CostSnapshot)
        .filter(CostSnapshot.organization_id == access.organization_id)
        .order_by(CostSnapshot.collected_at.desc(), CostSnapshot.id.desc())
        .limit(limit)
        .all()
    )
    return snapshots


@router.post("", response_model=CostSnapshotRead, status_code=status.HTTP_201_CREATED)
def create_cost_snapshot(
    payload: CostSnapshotCreate,
    access: OrganizationAccess = Depends(require_operator),
    db: Session = Depends(get_db),
) -> CostSnapshotRead:
    if payload.period_end <= payload.period_start or payload.cost_amount < 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid cost period or amount")
    dataset_exists = (
        db.query(Dataset.id)
        .filter(Dataset.id == payload.dataset_id, Dataset.organization_id == access.organization_id)
        .first()
    )
    if dataset_exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    snapshot = CostSnapshot(
        organization_id=access.organization_id,
        **payload.model_dump(exclude_none=True),
    )
    db.add(snapshot)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cost snapshot conflicts") from exc
    db.refresh(snapshot)
    return snapshot


@router.get("/{cost_id}", response_model=CostSnapshotRead)
def get_cost_snapshot(
    cost_id: UUID,
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> CostSnapshotRead:
    snapshot = (
        db.query(CostSnapshot)
        .filter(CostSnapshot.id == cost_id, CostSnapshot.organization_id == access.organization_id)
        .first()
    )
    if snapshot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cost snapshot not found",
        )
    return snapshot
