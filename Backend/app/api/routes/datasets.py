from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess, require_operator, require_viewer
from app.db import get_db
from app.models.datasets import Dataset
from app.schemas.datasets import DatasetCreate, DatasetRead

router = APIRouter(prefix="/api/v1/organizations/{organization_id}/datasets", tags=["datasets"])


@router.get("", response_model=list[DatasetRead])
def list_datasets(
    limit: int = Query(100, ge=1, le=500),
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> list[DatasetRead]:
    datasets = (
        db.query(Dataset)
        .filter(Dataset.organization_id == access.organization_id)
        .order_by(Dataset.created_at.desc(), Dataset.id.desc())
        .limit(limit)
        .all()
    )
    return datasets


@router.post("", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def create_dataset(
    payload: DatasetCreate,
    access: OrganizationAccess = Depends(require_operator),
    db: Session = Depends(get_db),
) -> DatasetRead:
    dataset = Dataset(
        organization_id=access.organization_id,
        **payload.model_dump(),
    )
    db.add(dataset)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Dataset already exists") from exc
    db.refresh(dataset)
    return dataset


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(
    dataset_id: UUID,
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> DatasetRead:
    dataset = (
        db.query(Dataset)
        .filter(Dataset.id == dataset_id, Dataset.organization_id == access.organization_id)
        .first()
    )
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    return dataset
