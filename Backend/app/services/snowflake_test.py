"""Live, non-persisted Snowflake connectivity check for the onboarding wizard.

Unlike app.services.ingestion, which resolves a *saved* connection's secret
from an environment variable keyed by secret_reference, this module takes
credentials directly from the request and uses them for exactly one connect
attempt. Nothing here is written to disk or the database -- only the
resulting success/failure and a human-readable detail string are returned.
"""

import re

from app.schemas.connections import SnowflakeConnectionTestRequest

_PEM_BLOCK = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", re.S)


def _normalize_private_key_pem(raw: str) -> bytes:
    """Rebuild a pasted PEM into strict framing before parsing it.

    Keys copied out of a terminal routinely arrive damaged in ways that
    don't change the key itself: the legacy Windows console pads every
    copied line with trailing spaces, some paths collapse newlines into
    spaces, and people often paste the body without the BEGIN/END lines.
    cryptography's PEM parser rejects all of these as "MalformedFraming",
    so strip every whitespace character out of the base64 body and
    re-emit it with canonical headers and 64-column lines.
    """
    text = raw.strip()
    match = _PEM_BLOCK.search(text)
    label, body = (match.group(1), match.group(2)) if match else ("PRIVATE KEY", text)

    if label == "PUBLIC KEY":
        raise ValueError(
            "that's the public key (rsa_key.pub). Paste the private key "
            "(rsa_key.p8) here; the public key goes in the setup SQL."
        )

    body = "".join(body.split())
    lines = "\n".join(body[i : i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN {label}-----\n{lines}\n-----END {label}-----\n".encode()


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
            _normalize_private_key_pem(payload.private_key_pem),
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
    except (ValueError, TypeError) as exc:
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
