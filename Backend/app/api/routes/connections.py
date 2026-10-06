from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import OrganizationAccess
from app.permissions import require_capability
from app.db import get_db
from app.models.snowflake_connections import SnowflakeConnection
from app.models.query_usage import QueryUsage
from app.models.sync_runs import SyncRun
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
    lock_connection,
    validate_connection,
)

router = APIRouter(
    prefix="/api/v1/organizations/{organization_id}/snowflake-connections",
    tags=["snowflake-connections"],
)


def _find_connection(db: Session, organization_id: UUID, connection_id: UUID, *, lock=False):
    if lock:
        lock_connection(db, organization_id, connection_id)
    query = db.query(SnowflakeConnection).filter(
        SnowflakeConnection.id == connection_id,
        SnowflakeConnection.organization_id == organization_id,
    )
    connection = (query.with_for_update() if lock else query).one_or_none()
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    return connection


def _sync_is_active(db: Session, connection_id: UUID) -> bool:
    return db.query(SyncRun.id).filter(
        SyncRun.connection_id == connection_id,
        SyncRun.run_type == "snowflake_query_usage_ingestion",
        SyncRun.status.in_(["queued", "running"]),
    ).first() is not None


def _read_connection(connection: SnowflakeConnection) -> SnowflakeConnectionRead:
    setup_sql = None
    if connection.public_key and connection.key_pair_name and connection.user_name:
        setup_sql = registration_sql(connection)
    return SnowflakeConnectionRead.model_validate(connection).model_copy(
        update={"registration_sql": setup_sql}
    )


@router.get("", response_model=list[SnowflakeConnectionRead])
def list_connections(
    access: OrganizationAccess = Depends(require_capability("view_data")), db: Session = Depends(get_db)
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
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
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
        db.flush()
        response = _read_connection(connection)
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
    return response


@router.patch("/{connection_id}", response_model=SnowflakeConnectionRead)
def update_connection(
    connection_id: UUID,
    payload: SnowflakeConnectionUpdate,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    connection = _find_connection(db, access.organization_id, connection_id, lock=True)
    changes = payload.model_dump(exclude_unset=True)
    if changes:
        scope_changed = any(
            field != "name" and (
                value.casefold() != connection.account_identifier.casefold()
                if field == "account_identifier" else value != getattr(connection, field)
            )
            for field, value in changes.items()
        )
        account_changed = changes.get("account_identifier", connection.account_identifier).casefold() != connection.account_identifier.casefold()
        warehouse_changed = (
            "warehouse_name" in changes and changes["warehouse_name"] != connection.warehouse_name
        )
        if account_changed or warehouse_changed:
            usage_exists = db.query(QueryUsage.id).filter(
                QueryUsage.organization_id == access.organization_id,
                QueryUsage.connection_id == connection.id,
            ).first()
            has_watermark = warehouse_changed and (connection.watermarks or {}).get("query_attribution_history")
            if usage_exists or has_watermark:
                source = "warehouse" if warehouse_changed else "account"
                raise HTTPException(
                    status_code=409,
                    detail=f"Create a new connection to use a different Snowflake {source}",
                )
        if scope_changed and _sync_is_active(db, connection.id):
            raise HTTPException(status_code=409, detail="Wait for the active Snowflake sync before changing connection scope")
        for field, value in changes.items():
            setattr(connection, field, value)
        if scope_changed:
            connection.status = "pending"
            connection.lifecycle_state = "configured"
            connection.enabled = False
            connection.capabilities = {}
            connection.validation_error = None
            connection.last_validated_at = None
            connection.key_expires_at = None
    try:
        # Flush defaults and serialize while transaction-local authorization is valid.
        db.flush()
        response = _read_connection(connection)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Snowflake connection conflicts with an existing connection",
        ) from exc
    return response


@router.post("/{connection_id}/validate", response_model=SnowflakeConnectionRead)
def validate_snowflake_connection(
    connection_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
    db: Session = Depends(get_db),
) -> SnowflakeConnectionRead:
    connection = _find_connection(db, access.organization_id, connection_id, lock=True)
    if _sync_is_active(db, connection.id):
        raise HTTPException(status_code=409, detail="Wait for the active Snowflake sync before validating")
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
        # Flush defaults and serialize while transaction-local authorization is valid.
        db.flush()
        response = _read_connection(connection)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Another Snowflake connection is already enabled",
        ) from exc
    return response


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_connection(
    connection_id: UUID,
    access: OrganizationAccess = Depends(require_capability("manage_connection")),
    db: Session = Depends(get_db),
) -> None:
    connection = _find_connection(db, access.organization_id, connection_id, lock=True)
    if _sync_is_active(db, connection.id):
        raise HTTPException(status_code=409, detail="Wait for the active Snowflake sync before disabling the connection")
    connection.enabled = False
    connection.status = "disabled"
    connection.lifecycle_state = "disabled"
    db.commit()
