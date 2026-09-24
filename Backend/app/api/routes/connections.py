from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess, require_admin, require_viewer
from app.db import get_db
from app.models.snowflake_connections import SnowflakeConnection
from app.schemas.connections import (
    SnowflakeConnectionCreate,
    SnowflakeConnectionRead,
    SnowflakeConnectionUpdate,
)
from app.services.ingestion import utcnow
from app.services.snowflake import (
    SnowflakeValidationError,
    create_vault_secret,
    generate_key_pair,
    registration_sql,
    validate_connection,
)

router = APIRouter(
    prefix="/api/v1/organizations/{organization_id}/snowflake-connections",
    tags=["snowflake-connections"],
)


def _find_connection(db: Session, organization_id: UUID, connection_id: UUID):
    connection = (
        db.query(SnowflakeConnection)
        .filter(
            SnowflakeConnection.id == connection_id,
            SnowflakeConnection.organization_id == organization_id,
        )
        .one_or_none()
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    return connection


def _read_connection(connection: SnowflakeConnection) -> SnowflakeConnectionRead:
    setup_sql = None
    if connection.public_key and connection.key_pair_name and connection.user_name:
        setup_sql = registration_sql(connection)
    return SnowflakeConnectionRead.model_validate(connection).model_copy(
        update={"registration_sql": setup_sql}
    )


@router.get("", response_model=list[SnowflakeConnectionRead])
def list_connections(
    access: OrganizationAccess = Depends(require_viewer), db: Session = Depends(get_db)
) -> list[SnowflakeConnectionRead]:
    connections = (
        db.query(SnowflakeConnection)
        .filter(SnowflakeConnection.organization_id == access.organization_id)
        .order_by(SnowflakeConnection.name, SnowflakeConnection.id)
        .all()
    )
    return [_read_connection(connection) for connection in connections]


@router.post("", response_model=SnowflakeConnectionRead, status_code=status.HTTP_201_CREATED)
def create_connection(
    payload: SnowflakeConnectionCreate,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    key_pair = generate_key_pair()
    connection_id = uuid4()
    connection = SnowflakeConnection(
        id=connection_id,
        organization_id=access.organization_id,
        **payload.model_dump(),
        auth_method="key_pair",
        credential_provider="supabase_vault",
        lifecycle_state="configured",
        public_key=key_pair.public_key,
        public_key_fingerprint=key_pair.fingerprint,
        key_pair_name=f"TIBBOU_{connection_id.hex.upper()}",
        status="pending",
        enabled=False,
    )
    db.add(connection)
    try:
        db.flush()
        connection.secret_reference = create_vault_secret(
            db, connection.id, key_pair.private_key_pem
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Snowflake connection conflicts with an existing connection",
        ) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Snowflake credential storage is unavailable",
        ) from exc
    db.refresh(connection)
    return _read_connection(connection)


@router.patch("/{connection_id}", response_model=SnowflakeConnectionRead)
def update_connection(
    connection_id: UUID,
    payload: SnowflakeConnectionUpdate,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    connection = _find_connection(db, access.organization_id, connection_id)
    changes = payload.model_dump(exclude_unset=True)
    if changes:
        for field, value in changes.items():
            setattr(connection, field, value)
        connection.status = "pending"
        connection.lifecycle_state = "configured"
        connection.enabled = False
        connection.capabilities = {}
        connection.validation_error = None
        connection.last_validated_at = None
        connection.key_expires_at = None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Snowflake connection conflicts with an existing connection",
        ) from exc
    db.refresh(connection)
    return _read_connection(connection)


@router.post("/{connection_id}/validate", response_model=SnowflakeConnectionRead)
def validate_snowflake_connection(
    connection_id: UUID,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    connection = _find_connection(db, access.organization_id, connection_id)
    try:
        result = validate_connection(db, connection)
    except SnowflakeValidationError as exc:
        connection.status = "invalid"
        connection.lifecycle_state = "invalid"
        connection.enabled = False
        connection.validation_error = str(exc)
        connection.capabilities = {}
        connection.key_expires_at = None
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    connection.status = "valid"
    connection.lifecycle_state = "validated"
    connection.enabled = True
    connection.validation_error = None
    connection.capabilities = result.capabilities
    connection.last_validated_at = utcnow()
    connection.key_expires_at = result.key_expires_at
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Another Snowflake connection is already enabled",
        ) from exc
    db.refresh(connection)
    return _read_connection(connection)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_connection(
    connection_id: UUID,
    access: OrganizationAccess = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    connection = _find_connection(db, access.organization_id, connection_id)
    connection.enabled = False
    connection.status = "disabled"
    connection.lifecycle_state = "disabled"
    db.commit()
