import base64
import hashlib
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")

from cryptography.hazmat.primitives import serialization
from pydantic import ValidationError
from snowflake.connector.errors import ProgrammingError

from fastapi import HTTPException

from app.api.routes.connections import (
    _find_connection,
    create_connection,
    validate_snowflake_connection,
)
from app.schemas.connections import SnowflakeConnectionCreate, SnowflakeConnectionUpdate
from app.services.snowflake import (
    GeneratedKeyPair,
    SnowflakeValidationError,
    ValidationResult,
    connection_kwargs,
    generate_key_pair,
    validate_connection,
)


class _FakeCursor:
    def __init__(self, fingerprint, access_history=True, current_user="TIBBOU_USER"):
        self.fingerprint = fingerprint
        self.access_history = access_history
        self.current_user = current_user
        self.description = []
        self.rows = []
        self.closed = False

    def execute(self, statement):
        lowered = statement.lower()
        if "current_account" in lowered:
            self.rows = [("TEST_ACCOUNT", self.current_user, "TIBBOU_ROLE", "TIBBOU_WH")]
        elif lowered.startswith("show user key pairs"):
            self.description = [
                ("FINGERPRINT",),
                ("ROLE_SCOPE",),
                ("STATUS",),
                ("EXPIRES_AT",),
            ]
            self.rows = [
                (
                    self.fingerprint,
                    "TIBBOU_ROLE",
                    "ACTIVE",
                    datetime(2026, 12, 1, tzinfo=timezone.utc),
                )
            ]
        elif "access_history" in lowered and not self.access_history:
            raise ProgrammingError(msg="not authorized")
        return self

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows

    def close(self):
        self.closed = True


def _connection(fingerprint="SHA256:test"):
    return SimpleNamespace(
        id="connection-id",
        account_identifier="test-account",
        user_name="TIBBOU_USER",
        role_name="TIBBOU_ROLE",
        warehouse_name="TIBBOU_WH",
        public_key_fingerprint=fingerprint,
    )


class SnowflakeConnectionTests(unittest.TestCase):
    def test_generated_private_key_matches_public_key_and_fingerprint(self):
        generated = generate_key_pair()
        private_key = serialization.load_pem_private_key(
            generated.private_key_pem.encode("ascii"), password=None
        )
        public_der = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )

        self.assertEqual(base64.b64decode(generated.public_key), public_der)
        self.assertEqual(
            generated.fingerprint,
            "SHA256:" + base64.b64encode(hashlib.sha256(public_der).digest()).decode("ascii"),
        )

    def test_vault_private_key_is_loaded_for_the_connector(self):
        generated = generate_key_pair()
        connection = _connection(generated.fingerprint)
        connection.auth_method = "key_pair"
        connection.credential_provider = "supabase_vault"
        connection.secret_reference = "vault-id"
        db = MagicMock()
        db.execute.return_value.scalar_one.return_value = generated.private_key_pem

        kwargs = connection_kwargs(db, connection)

        loaded = serialization.load_der_private_key(kwargs["private_key"], password=None)
        self.assertEqual(loaded.key_size, 2048)

    def test_client_cannot_supply_auth_method_or_secret_reference(self):
        payload = {
            "name": "Primary",
            "account_identifier": "org-account",
            "user_name": "tibbou_user",
            "role_name": "tibbou_role",
            "warehouse_name": "tibbou_wh",
            "auth_method": "key_pair",
            "secret_reference": "browser-secret",
        }
        with self.assertRaises(ValidationError):
            SnowflakeConnectionCreate.model_validate(payload)

    def test_identifiers_are_normalized_and_privileged_roles_are_rejected(self):
        connection = SnowflakeConnectionCreate(
            name=" Primary ",
            account_identifier=" org-account ",
            user_name="tibbou_user",
            role_name="tibbou_role",
            warehouse_name="tibbou_wh",
        )
        self.assertEqual(connection.name, "Primary")
        self.assertEqual(connection.role_name, "TIBBOU_ROLE")

        with self.assertRaises(ValidationError):
            SnowflakeConnectionCreate(
                name="Primary",
                account_identifier="org-account",
                user_name="tibbou_user",
                role_name="accountadmin",
                warehouse_name="tibbou_wh",
            )
        with self.assertRaises(ValidationError):
            SnowflakeConnectionUpdate(role_name=None)

    def test_validation_reports_full_and_partial_capabilities(self):
        for access_history, expected_mode in ((True, "full"), (False, "partial")):
            with self.subTest(mode=expected_mode):
                cursor = _FakeCursor("SHA256:test", access_history=access_history)
                snowflake_connection = MagicMock()
                snowflake_connection.cursor.return_value = cursor
                with (
                    patch(
                        "app.services.snowflake.connection_kwargs", return_value={}
                    ),
                    patch(
                        "snowflake.connector.connect",
                        return_value=snowflake_connection,
                    ),
                ):
                    result = validate_connection(SimpleNamespace(), _connection())

                self.assertEqual(result.capabilities["mode"], expected_mode)
                self.assertEqual(
                    result.capabilities["access_history"], access_history
                )
                self.assertTrue(cursor.closed)
                snowflake_connection.close.assert_called_once_with()

    def test_validation_rejects_identity_mismatch_without_leaking_details(self):
        cursor = _FakeCursor("SHA256:test", current_user="OTHER_USER")
        snowflake_connection = MagicMock()
        snowflake_connection.cursor.return_value = cursor
        with (
            patch("app.services.snowflake.connection_kwargs", return_value={}),
            patch(
                "snowflake.connector.connect",
                return_value=snowflake_connection,
            ),
            self.assertRaisesRegex(SnowflakeValidationError, "user does not match"),
        ):
            validate_connection(SimpleNamespace(), _connection())

    def test_create_generates_and_stores_server_side_credential(self):
        payload = SnowflakeConnectionCreate(
            name="Primary",
            account_identifier="org-account",
            user_name="tibbou_user",
            role_name="tibbou_role",
            warehouse_name="tibbou_wh",
        )
        generated = GeneratedKeyPair("private-pem", "public-key", "SHA256:fingerprint")
        db = MagicMock()
        with (
            patch("app.api.routes.connections.generate_key_pair", return_value=generated),
            patch(
                "app.api.routes.connections.create_vault_secret",
                return_value="vault-id",
            ) as store_secret,
            patch(
                "app.api.routes.connections._read_connection",
                side_effect=lambda connection: connection,
            ),
        ):
            created = create_connection(
                payload,
                SimpleNamespace(organization_id="organization-id"),
                db,
            )

        self.assertIs(created, db.add.call_args.args[0])
        self.assertEqual(created.credential_provider, "supabase_vault")
        self.assertEqual(created.lifecycle_state, "configured")
        self.assertFalse(created.enabled)
        self.assertEqual(created.secret_reference, "vault-id")
        store_secret.assert_called_once_with(db, created.id, "private-pem")

    def test_validation_marks_connection_validated_but_not_active(self):
        connection = SimpleNamespace()
        result = ValidationResult(
            capabilities={"mode": "partial"},
            key_expires_at=datetime(2026, 12, 1, tzinfo=timezone.utc),
        )
        db = MagicMock()
        with (
            patch(
                "app.api.routes.connections._find_connection",
                return_value=connection,
            ),
            patch("app.api.routes.connections.validate_connection", return_value=result),
            patch(
                "app.api.routes.connections._read_connection",
                side_effect=lambda value: value,
            ),
        ):
            validated = validate_snowflake_connection(
                "connection-id",
                SimpleNamespace(organization_id="organization-id"),
                db,
            )

        self.assertIs(validated, connection)
        self.assertEqual(connection.lifecycle_state, "validated")
        self.assertNotEqual(connection.lifecycle_state, "active")
        self.assertTrue(connection.enabled)

    def test_cross_organization_connection_is_hidden(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        with self.assertRaises(HTTPException) as raised:
            _find_connection(
                db,
                UUID("20000000-0000-0000-0000-000000000001"),
                UUID("30000000-0000-0000-0000-000000000001"),
            )

        self.assertEqual(raised.exception.status_code, 404)
        filters = db.query.return_value.filter.call_args.args
        self.assertEqual(len(filters), 2)
        self.assertIn("organization_id", str(filters[1]))


if __name__ == "__main__":
    unittest.main()
