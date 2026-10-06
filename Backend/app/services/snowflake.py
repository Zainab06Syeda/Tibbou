import base64
import hashlib
import json
import os
import re
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.snowflake_connections import SnowflakeConnection
from app.schemas.connections import BLOCKED_ROLES, SNOWFLAKE_IDENTIFIER_PATTERN, normalize_account_identifier


class SnowflakeValidationError(RuntimeError):
    pass


@dataclass(frozen=True)
class GeneratedKeyPair:
    private_key_pem: str
    public_key: str
    fingerprint: str


@dataclass(frozen=True)
class ValidationResult:
    capabilities: dict[str, Any]
    key_expires_at: datetime | None


def generate_key_pair() -> GeneratedKeyPair:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    fingerprint = base64.b64encode(hashlib.sha256(public_der).digest()).decode("ascii")
    return GeneratedKeyPair(
        private_key_pem=private_pem.decode("ascii"),
        public_key=base64.b64encode(public_der).decode("ascii"),
        fingerprint=f"SHA256:{fingerprint}",
    )


def create_vault_secret(db: Session, connection_id: UUID, private_key_pem: str) -> str:
    secret_id = db.execute(
        text("select private.create_snowflake_connection_secret(:connection_id, :private_key)"),
        {"connection_id": str(connection_id), "private_key": private_key_pem},
    ).scalar_one()
    return str(secret_id)


def _read_vault_secret(db: Session, connection_id: UUID) -> bytes:
    private_key_pem = db.execute(
        text("select private.read_snowflake_connection_secret(:connection_id)"),
        {"connection_id": str(connection_id)},
    ).scalar_one()
    if not private_key_pem:
        raise RuntimeError("Snowflake credential is unavailable")
    return private_key_pem.encode("ascii")


def _secret_env_prefix(secret_reference: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]", "_", secret_reference).upper()
    return f"SNOWFLAKE_SECRET_{normalized}_"


def _private_key_bytes(db: Session | None, connection: SnowflakeConnection) -> bytes:
    password = None
    if connection.credential_provider == "supabase_vault":
        if db is None:
            raise RuntimeError("Database session is required for Vault credentials")
        pem = _read_vault_secret(db, connection.id)
    else:
        if os.getenv("APP_ENV", "development").lower() == "production":
            raise RuntimeError("A managed Snowflake credential is required in production")
        prefix = _secret_env_prefix(connection.secret_reference or "")
        path_value = os.getenv(f"{prefix}PRIVATE_KEY_PATH")
        if not path_value:
            raise RuntimeError("Snowflake key-pair credential is unavailable")
        pem = Path(path_value).read_bytes()
        password_value = os.getenv(f"{prefix}PRIVATE_KEY_PASSPHRASE")
        password = password_value.encode() if password_value else None

    private_key = serialization.load_pem_private_key(pem, password=password)
    return private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def lock_connection(db: Session, organization_id: UUID, connection_id: UUID) -> None:
    # Operators may read/queue but cannot UPDATE connections under RLS.
    # Share this transaction lock with setup changes without expanding grants.
    db.execute(text("select pg_advisory_xact_lock(hashtextextended(:scope, 0))"),
               {"scope": f"tibbou:snowflake:{organization_id}:{connection_id}"})


def _validate_identifiers(connection: SnowflakeConnection) -> None:
    try:
        normalize_account_identifier(connection.account_identifier)
    except (ValueError, TypeError, AttributeError) as exc:
        raise SnowflakeValidationError("Invalid Snowflake account identifier") from exc
    for field in ("user_name", "role_name", "warehouse_name", "key_pair_name"):
        value = getattr(connection, field, None)
        if not isinstance(value, str) or not re.fullmatch(SNOWFLAKE_IDENTIFIER_PATTERN, value):
            raise SnowflakeValidationError("Invalid Snowflake setup identifier")
    if connection.role_name.upper() in BLOCKED_ROLES:
        raise SnowflakeValidationError("Use a dedicated least-privilege Snowflake role")
    if connection.key_pair_name.upper() in {"PUBLIC_KEY_1", "PUBLIC_KEY_2"}:
        raise SnowflakeValidationError("Use the generated named Snowflake key")


def connection_kwargs(db: Session | None, connection: SnowflakeConnection) -> dict[str, Any]:
    _validate_identifiers(connection)
    if connection.auth_method != "key_pair":
        raise RuntimeError("Only Snowflake key-pair authentication is supported")
    return {
        "account": connection.account_identifier,
        "user": connection.user_name,
        "role": connection.role_name,
        "warehouse": connection.warehouse_name,
        "private_key": _private_key_bytes(db, connection),
        "client_session_keep_alive": False,
        "login_timeout": 15,
        "network_timeout": 30,
    }


USAGE_PAGE_SIZE = 1000


def _access_objects(value: Any) -> set[str]:
    if isinstance(value, str):
        value = json.loads(value)
    return {
        item["objectName"]
        for item in (value or [])
        if isinstance(item, dict) and isinstance(item.get("objectName"), str)
    }


def iter_usage_pages(
    connection: SnowflakeConnection,
    snowflake_kwargs: dict[str, Any],
    window_start: datetime,
    window_end: datetime,
):
    """Yield bounded query pages and Access History tiers for one half-open window."""
    import snowflake.connector

    with (
        closing(snowflake.connector.connect(**snowflake_kwargs)) as snowflake_connection,
        closing(snowflake_connection.cursor()) as cursor,
    ):
        timeout = min(
            max(int(os.getenv("SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS", "30")), 5), 120
        )
        cursor.execute(f"alter session set statement_timeout_in_seconds = {timeout}")
        after: tuple[datetime, str] | None = None
        access_history_available = bool((connection.capabilities or {}).get("access_history"))
        while True:
            try:
                cursor.execute(
                    f"""
            select query_id, warehouse_name, start_time, end_time,
                   credits_attributed_compute, credits_used_query_acceleration
            from snowflake.account_usage.query_attribution_history
            where start_time >= %s and start_time < %s
              and warehouse_name = %s
              and (%s is null or start_time > %s
                   or (start_time = %s and query_id > %s))
            order by start_time, query_id
            limit {USAGE_PAGE_SIZE}
            """,
                    (window_start, window_end,
                     (connection.capabilities or {}).get("current_warehouse", connection.warehouse_name),
                     after[0] if after else None, after[0] if after else None,
                     after[0] if after else None, after[1] if after else None),
                )
            except snowflake.connector.errors.ProgrammingError as exc:
                if getattr(exc, "sqlstate", None) in {"42501", "42S02"}:
                    raise SnowflakeValidationError(
                        "Snowflake role needs access to QUERY_ATTRIBUTION_HISTORY"
                    ) from exc
                raise
            columns = [item[0].lower() for item in cursor.description]
            usage = [dict(zip(columns, row)) for row in cursor.fetchall()]
            if not usage:
                break

            objects_by_query: dict[str, dict[str, set[str]]] = {}
            query_ids = [str(row["query_id"]) for row in usage if row.get("query_id")]
            if query_ids and access_history_available:
                try:
                    cursor.execute(
                        """
                        with relevant_query_ids as (
                            select value::string as query_id
                            from table(flatten(input => parse_json(%s)))
                        )
                        select history.query_id, to_json(history.objects_modified),
                               to_json(history.direct_objects_accessed),
                               to_json(history.base_objects_accessed)
                        from snowflake.account_usage.access_history as history
                        join relevant_query_ids as relevant
                          on relevant.query_id = history.query_id
                        where history.query_start_time >= %s
                          and history.query_start_time < %s
                        """,
                        (json.dumps(query_ids), window_start, window_end),
                    )
                    for query_id, modified, direct, base in cursor.fetchall():
                        if query_id:
                            objects_by_query[str(query_id)] = {
                                "objects_modified": _access_objects(modified),
                                "direct_objects_accessed": _access_objects(direct),
                                "base_objects_accessed": _access_objects(base),
                            }
                except snowflake.connector.errors.ProgrammingError as exc:
                    if getattr(exc, "sqlstate", None) not in {"42501", "42S02"}:
                        raise
                    access_history_available = False

            yield usage, objects_by_query, access_history_available
            last = usage[-1]
            after = (last["start_time"], str(last["query_id"]))
            if len(usage) < USAGE_PAGE_SIZE:
                break


def registration_sql(connection: SnowflakeConnection) -> str:
    _validate_identifiers(connection)
    def identifier(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    role = connection.role_name.replace("'", "''")
    return (
        f"ALTER USER {identifier(connection.user_name)} ADD KEY PAIR "
        f"{identifier(connection.key_pair_name)} PUBLIC_KEY = '{connection.public_key}' "
        f"ROLE_RESTRICTION = '{role}' DAYS_TO_EXPIRY = 90 "
        "COMMENT = 'Tibbou Snowflake connection';"
    )


def _normalized_fingerprint(value: Any) -> str:
    return str(value or "").removeprefix("SHA256:").strip()


def _account_matches(configured: str, locator: str, organization: str, account_name: str) -> bool:
    expected = configured.casefold().replace("_", "-")
    named = f"{organization}-{account_name}".casefold().replace("_", "-")
    return expected == named or configured.split(".", 1)[0].casefold() == locator.casefold()


def validate_connection(db: Session, connection: SnowflakeConnection) -> ValidationResult:
    import snowflake.connector

    _validate_identifiers(connection)
    try:
        snowflake_connection = snowflake.connector.connect(**connection_kwargs(db, connection))
        cursor = snowflake_connection.cursor()
    except Exception as exc:
        raise SnowflakeValidationError("Snowflake authentication failed") from exc

    try:
        cursor.execute(
            "select current_account(), current_organization_name(), current_account_name(), "
            "current_user(), current_role(), current_warehouse()"
        )
        current_account, current_organization, current_account_name, current_user, current_role, current_warehouse = cursor.fetchone()
        if not _account_matches(
            connection.account_identifier, str(current_account),
            str(current_organization), str(current_account_name),
        ):
            raise SnowflakeValidationError("Snowflake account does not match the connection")
        expected = {
            "user": connection.user_name,
            "role": connection.role_name,
            "warehouse": connection.warehouse_name,
        }
        actual = {
            "user": current_user,
            "role": current_role,
            "warehouse": current_warehouse,
        }
        for key, expected_value in expected.items():
            if str(actual[key] or "").upper() != str(expected_value or "").upper():
                raise SnowflakeValidationError(f"Snowflake {key} does not match the connection")

        cursor.execute("show user key pairs")
        columns = [column[0].lower() for column in cursor.description]
        key_pairs = [dict(zip(columns, row)) for row in cursor.fetchall()]
        matching_key = next(
            (
                key
                for key in key_pairs
                if str(key.get("name") or "") == connection.key_pair_name
                and _normalized_fingerprint(key.get("fingerprint"))
                == _normalized_fingerprint(connection.public_key_fingerprint)
            ),
            None,
        )
        if matching_key is None:
            raise SnowflakeValidationError("The generated public key is not registered")
        if (
            str(matching_key.get("role_scope") or "").upper()
            != connection.role_name.upper()
        ):
            raise SnowflakeValidationError(
                "The Snowflake key is not restricted to the configured role"
            )
        if str(matching_key.get("status") or "").upper() != "ACTIVE":
            raise SnowflakeValidationError("The Snowflake key is not active")

        try:
            cursor.execute(
                "select query_id from snowflake.account_usage.query_attribution_history "
                "where start_time >= dateadd(day, -1, current_timestamp()) limit 1"
            )
        except snowflake.connector.errors.ProgrammingError as exc:
            raise SnowflakeValidationError(
                "The configured role cannot read Snowflake query attribution history"
            ) from exc

        access_history = True
        try:
            cursor.execute(
                "select query_id from snowflake.account_usage.access_history "
                "where query_start_time >= dateadd(day, -1, current_timestamp()) limit 1"
            )
        except snowflake.connector.errors.ProgrammingError as exc:
            if getattr(exc, "sqlstate", None) not in {"42501", "42S02"}:
                raise
            access_history = False

        expires_at = matching_key.get("expires_at")
        if isinstance(expires_at, datetime) and expires_at.replace(tzinfo=expires_at.tzinfo or timezone.utc) <= datetime.now(timezone.utc):
            raise SnowflakeValidationError("The Snowflake key has expired")
        return ValidationResult(
            capabilities={
                "authenticated": True,
                "query_attribution_history": True,
                "access_history": access_history,
                "mode": "full" if access_history else "partial",
                "current_account": str(current_account),
                "current_user": str(current_user),
                "current_role": str(current_role),
                "current_warehouse": str(current_warehouse),
                "named_key_pair": True,
            },
            key_expires_at=expires_at if isinstance(expires_at, datetime) else None,
        )
    except SnowflakeValidationError:
        raise
    except Exception as exc:
        raise SnowflakeValidationError("Snowflake capability validation failed") from exc
    finally:
        cursor.close()
        snowflake_connection.close()
