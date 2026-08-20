from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess, require_operator, require_viewer
from app.db import get_db
from app.models.datasets import Dataset
from app.models.lineage_edges import LineageEdge
from app.schemas.lineage import LineageEdgeCreate, LineageEdgeRead

router = APIRouter(prefix="/api/v1/organizations/{organization_id}/lineage", tags=["lineage"])


@router.get("", response_model=list[LineageEdgeRead])
def list_lineage_edges(
    limit: int = Query(500, ge=1, le=2000),
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> list[LineageEdgeRead]:
    edges = (
        db.query(LineageEdge)
        .filter(LineageEdge.organization_id == access.organization_id, LineageEdge.is_active.is_(True))
        .order_by(LineageEdge.created_at.desc(), LineageEdge.id.desc())
        .limit(limit)
        .all()
    )
    return edges


@router.post("", response_model=LineageEdgeRead, status_code=status.HTTP_201_CREATED)
def create_lineage_edge(
    payload: LineageEdgeCreate,
    access: OrganizationAccess = Depends(require_operator),
    db: Session = Depends(get_db),
) -> LineageEdgeRead:
    if payload.upstream_dataset_id == payload.downstream_dataset_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Self edges are not allowed")
    dataset_count = (
        db.query(Dataset)
        .filter(
            Dataset.organization_id == access.organization_id,
            Dataset.id.in_([payload.upstream_dataset_id, payload.downstream_dataset_id]),
        )
        .count()
    )
    if dataset_count != 2:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    edge = LineageEdge(
        organization_id=access.organization_id,
        upstream_dataset_id=payload.upstream_dataset_id,
        downstream_dataset_id=payload.downstream_dataset_id,
        relationship_type=payload.relationship_type,
        provenance=payload.provenance,
    )
    db.add(edge)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Lineage edge already exists") from exc
    db.refresh(edge)
    return edge


@router.get("/{edge_id}", response_model=LineageEdgeRead)
def get_lineage_edge(
    edge_id: UUID,
    access: OrganizationAccess = Depends(require_viewer),
    db: Session = Depends(get_db),
) -> LineageEdgeRead:
    edge = (
        db.query(LineageEdge)
        .filter(LineageEdge.id == edge_id, LineageEdge.organization_id == access.organization_id)
        .first()
    )
    if edge is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Lineage edge not found"
        )
    return edge
