import os
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import ValidationError

from app.schemas.connections import SnowflakeConnectionTestRequest
from app.services.snowflake_test import test_connection


def _generate_private_key_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


class _FakeCursor:
    def __init__(self, row):
        self._row = row
        self.executed = None

    def execute(self, statement):
        self.executed = statement

    def fetchone(self):
        return self._row

    def close(self):
        return None


class _FakeConnection:
    def __init__(self, row):
        self._cursor = _FakeCursor(row)

    def cursor(self):
        return self._cursor

    def close(self):
        return None


class SnowflakeConnectionTestRequestValidationTests(unittest.TestCase):
    def test_key_pair_requires_a_private_key(self):
        with self.assertRaises(ValidationError):
            SnowflakeConnectionTestRequest(
                account_identifier="acme",
                role_name="TIBBOU_READER",
                warehouse_name="TIBBOU_WH",
                auth_method="key_pair",
            )

    def test_oauth_requires_a_token(self):
        with self.assertRaises(ValidationError):
            SnowflakeConnectionTestRequest(
                account_identifier="acme",
                role_name="TIBBOU_READER",
                warehouse_name="TIBBOU_WH",
                auth_method="external_oauth",
            )


class TestConnectionTests(unittest.TestCase):
    def test_successful_key_pair_connection_reports_session_details(self):
        payload = SnowflakeConnectionTestRequest(
            account_identifier="acme",
            user_name="TIBBOU_SVC",
            role_name="TIBBOU_READER",
            warehouse_name="TIBBOU_WH",
            database_name="ANALYTICS",
            auth_method="key_pair",
            private_key_pem=_generate_private_key_pem(),
        )
        fake_connection = _FakeConnection(("8.1.0", "TIBBOU_READER", "TIBBOU_WH"))

        with patch("snowflake.connector.connect", return_value=fake_connection) as connect:
            success, detail = test_connection(payload)

        self.assertTrue(success)
        self.assertIn("TIBBOU_READER", detail)
        self.assertIn("TIBBOU_WH", detail)
        called_kwargs = connect.call_args.kwargs
        self.assertEqual(called_kwargs["account"], "acme")
        self.assertEqual(called_kwargs["database"], "ANALYTICS")
        self.assertNotIn("password", called_kwargs)
        self.assertIn("private_key", called_kwargs)
        self.assertIsInstance(called_kwargs["private_key"], bytes)

    def test_oauth_connection_uses_the_supplied_token(self):
        payload = SnowflakeConnectionTestRequest(
            account_identifier="acme",
            role_name="TIBBOU_READER",
            warehouse_name="TIBBOU_WH",
            auth_method="external_oauth",
            oauth_token="a-token",
        )
        fake_connection = _FakeConnection(("8.1.0", "TIBBOU_READER", "TIBBOU_WH"))

        with patch("snowflake.connector.connect", return_value=fake_connection) as connect:
            success, _detail = test_connection(payload)

        self.assertTrue(success)
        self.assertEqual(connect.call_args.kwargs["authenticator"], "oauth")
        self.assertEqual(connect.call_args.kwargs["token"], "a-token")

    def test_connect_failure_surfaces_the_actual_driver_error(self):
        payload = SnowflakeConnectionTestRequest(
            account_identifier="acme",
            role_name="TIBBOU_READER",
            warehouse_name="TIBBOU_WH",
            auth_method="external_oauth",
            oauth_token="a-token",
        )

        with patch(
            "snowflake.connector.connect",
            side_effect=Exception("250001: Could not connect to Snowflake backend"),
        ):
            success, detail = test_connection(payload)

        self.assertFalse(success)
        self.assertIn("250001", detail)

    def test_malformed_private_key_is_reported_without_crashing(self):
        payload = SnowflakeConnectionTestRequest(
            account_identifier="acme",
            role_name="TIBBOU_READER",
            warehouse_name="TIBBOU_WH",
            auth_method="key_pair",
            private_key_pem="not a real key",
        )

        success, detail = test_connection(payload)

        self.assertFalse(success)
        self.assertIn("private key", detail.lower())


def _key_pair_payload(private_key_pem: str, passphrase: str | None = None):
    return SnowflakeConnectionTestRequest(
        account_identifier="acme",
        role_name="TIBBOU_READER",
        warehouse_name="TIBBOU_WH",
        auth_method="key_pair",
        private_key_pem=private_key_pem,
        private_key_passphrase=passphrase,
    )


def _connects_with(pasted: str) -> bool:
    fake_connection = _FakeConnection(("8.1.0", "TIBBOU_READER", "TIBBOU_WH"))
    with patch("snowflake.connector.connect", return_value=fake_connection):
        success, _detail = test_connection(_key_pair_payload(pasted))
    return success


class PastedPrivateKeyNormalizationTests(unittest.TestCase):
    """Terminal copy/paste damages PEM framing without changing the key."""

    def setUp(self):
        self.pem = _generate_private_key_pem()

    def test_trailing_spaces_and_crlf_from_windows_console(self):
        padded = "\r\n".join(line + "      " for line in self.pem.splitlines())
        self.assertTrue(_connects_with(padded))

    def test_leading_indentation_and_surrounding_blank_lines(self):
        indented = "\n\n" + "\n".join("  " + line for line in self.pem.splitlines()) + "\n\n"
        self.assertTrue(_connects_with(indented))

    def test_newlines_collapsed_into_spaces(self):
        self.assertTrue(_connects_with(" ".join(self.pem.split())))

    def test_body_pasted_without_begin_end_lines(self):
        body = "\n".join(line for line in self.pem.splitlines() if "-----" not in line)
        self.assertTrue(_connects_with(body))

    def test_public_key_pasted_by_mistake_gets_a_specific_message(self):
        public_pem = (
            serialization.load_pem_private_key(self.pem.encode(), password=None)
            .public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode()
        )

        success, detail = test_connection(_key_pair_payload(public_pem))

        self.assertFalse(success)
        self.assertIn("public key", detail)

    def test_passphrase_on_an_unencrypted_key_is_reported_not_raised(self):
        success, detail = test_connection(_key_pair_payload(self.pem, passphrase="oops"))

        self.assertFalse(success)
        self.assertIn("private key", detail.lower())


if __name__ == "__main__":
    unittest.main()
