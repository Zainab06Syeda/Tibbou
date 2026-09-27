"""Live, non-persisted Snowflake connectivity check for the onboarding wizard.

Unlike app.services.ingestion, which resolves a *saved* connection's secret
from an environment variable keyed by secret_reference, this module takes
credentials directly from the request and uses them for exactly one connect
attempt. Nothing here is written to disk or the database -- only the
resulting success/failure and a human-readable detail string are returned.
"""

from app.schemas.connections import SnowflakeConnectionTestRequest


def _connection_kwargs(payload: SnowflakeConnectionTestRequest) -> dict:
    kwargs: dict = {
        "account": payload.account_identifier,
        "user": payload.user_name,
        "role": payload.role_name,
        "warehouse": payload.warehouse_name,
        "database": payload.database_name,
        "client_session_keep_alive": False,
        "login_timeout": 15,
        "network_timeout": 30,
    }

    if payload.auth_method == "key_pair":
        from cryptography.hazmat.primitives import serialization

        private_key = serialization.load_pem_private_key(
            payload.private_key_pem.encode(),
            password=payload.private_key_passphrase.encode()
            if payload.private_key_passphrase
            else None,
        )
        kwargs["private_key"] = private_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    else:
        kwargs.update(authenticator="oauth", token=payload.oauth_token)

    return {key: value for key, value in kwargs.items() if value is not None}


def test_connection(payload: SnowflakeConnectionTestRequest) -> tuple[bool, str]:
    import snowflake.connector

    try:
        kwargs = _connection_kwargs(payload)
    except ValueError as exc:
        return False, f"Could not read the private key: {exc}"

    try:
        connection = snowflake.connector.connect(**kwargs)
    except Exception as exc:  # snowflake.connector raises its own broad error hierarchy
        return False, str(exc)

    try:
        cursor = connection.cursor()
        try:
            cursor.execute("select current_version(), current_role(), current_warehouse()")
            version, role, warehouse = cursor.fetchone()
            return (
                True,
                f"Connected — Snowflake {version}, role {role}, warehouse {warehouse}",
            )
        finally:
            cursor.close()
    except Exception as exc:
        return False, str(exc)
    finally:
        connection.close()
