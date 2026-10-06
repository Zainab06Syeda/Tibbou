import base64
import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.snowflake_connections import SnowflakeConnection


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


def connection_kwargs(db: Session | None, connection: SnowflakeConnection) -> dict[str, Any]:
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


def fetch_usage(
    connection: SnowflakeConnection, snowflake_kwargs: dict[str, Any]
) -> tuple[list[dict], dict[str, set[str]], bool]:
    import snowflake.connector

    snowflake_connection = snowflake.connector.connect(**snowflake_kwargs)
    cursor = snowflake_connection.cursor()
    try:
        timeout = min(
            max(int(os.getenv("SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS", "30")), 5), 120
        )
        cursor.execute(f"alter session set statement_timeout_in_seconds = {timeout}")
        cursor.execute(
            """
            select query_id, warehouse_name, start_time, end_time,
                   credits_attributed_compute, credits_used_query_acceleration
            from snowflake.account_usage.query_attribution_history
            where start_time >= dateadd(hour, -48, current_timestamp())
              and warehouse_name = %s
            order by start_time
            limit 10000
            """,
            (connection.warehouse_name,),
        )
        columns = [item[0].lower() for item in cursor.description]
        usage = [dict(zip(columns, row)) for row in cursor.fetchall()]

        object_names: dict[str, set[str]] = {}
        access_history_available = True
        try:
            query_ids = [str(row["query_id"]) for row in usage if row.get("query_id")]
            if query_ids:
                cursor.execute(
                    """
                    with relevant_query_ids as (
                        select value::string as query_id
                        from table(flatten(input => parse_json(%s)))
                    )
                    select history.query_id, accessed.value:objectName::string as object_name
                    from snowflake.account_usage.access_history as history
                    join relevant_query_ids as relevant
                      on relevant.query_id = history.query_id,
                         lateral flatten(input => history.base_objects_accessed) as accessed
                    where history.query_start_time >= dateadd(hour, -48, current_timestamp())
                    limit 10000
                    """,
                    (json.dumps(query_ids),),
                )
                for query_id, object_name in cursor.fetchall():
                    if query_id and object_name:
                        object_names.setdefault(str(query_id), set()).add(
                            str(object_name).upper()
                        )
        except snowflake.connector.errors.ProgrammingError:
            access_history_available = False
        return usage, object_names, access_history_available
    finally:
        cursor.close()
        snowflake_connection.close()


def registration_sql(connection: SnowflakeConnection) -> str:
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


def validate_connection(db: Session, connection: SnowflakeConnection) -> ValidationResult:
    import snowflake.connector

    try:
        snowflake_connection = snowflake.connector.connect(**connection_kwargs(db, connection))
        cursor = snowflake_connection.cursor()
    except Exception as exc:
        raise SnowflakeValidationError("Snowflake authentication failed") from exc

    try:
        cursor.execute(
            "select current_account(), current_user(), current_role(), current_warehouse()"
        )
        current_account, current_user, current_role, current_warehouse = cursor.fetchone()
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
                if _normalized_fingerprint(key.get("fingerprint"))
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
        except snowflake.connector.errors.ProgrammingError:
            access_history = False

        expires_at = matching_key.get("expires_at")
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
