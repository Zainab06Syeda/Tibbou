from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess
from app.db import get_db
from app.models.snowflake_connections import SnowflakeConnection
from app.permissions import require_capability
from app.schemas.connections import (
    SnowflakeConnectionCreate,
    SnowflakeConnectionRead,
    SnowflakeConnectionTestRequest,
    SnowflakeConnectionTestResult,
)
from app.services.snowflake_test import test_connection as run_snowflake_connection_test

router = APIRouter(
    prefix="/api/v1/organizations/{organization_id}/snowflake-connections",
    tags=["snowflake-connections"],
)


@router.get("", response_model=list[SnowflakeConnectionRead])
def list_connections(
    access: OrganizationAccess = Depends(require_capability("view_data")),
    db: Session = Depends(get_db),
) -> list[SnowflakeConnectionRead]:
    return (
        db.query(SnowflakeConnection)
        .filter(SnowflakeConnection.organization_id == access.organization_id)
        .order_by(SnowflakeConnection.name, SnowflakeConnection.id)
        .all()
    )


@router.post("", response_model=SnowflakeConnectionRead, status_code=status.HTTP_201_CREATED)
def create_connection(
    payload: SnowflakeConnectionCreate,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    connection = SnowflakeConnection(
        organization_id=access.organization_id,
        **payload.model_dump(),
        status="pending",
        enabled=False,
    )
    db.add(connection)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connection name exists") from exc
    db.refresh(connection)
    return connection


@router.post("/test", response_model=SnowflakeConnectionTestResult)
def test_connection(
    payload: SnowflakeConnectionTestRequest,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
) -> SnowflakeConnectionTestResult:
    success, detail = run_snowflake_connection_test(payload)
    return SnowflakeConnectionTestResult(success=success, detail=detail)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_connection(
    connection_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
    db: Session = Depends(get_db),
) -> None:
    connection = (
        db.query(SnowflakeConnection)
        .filter(
            SnowflakeConnection.id == connection_id,
            SnowflakeConnection.organization_id == access.organization_id,
        )
        .one_or_none()
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    connection.enabled = False
    connection.status = "disabled"
    db.commit()
