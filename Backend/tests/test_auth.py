import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientConnectionError

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.auth import _decode_access_token


class AuthTests(unittest.TestCase):
    def test_es256_supabase_token_is_accepted(self):
        now = datetime.now(timezone.utc)
        private_key = ec.generate_private_key(ec.SECP256R1())
        token = jwt.encode(
            {
                "sub": "00000000-0000-0000-0000-000000000001",
                "iss": "https://example.supabase.co/auth/v1",
                "aud": "authenticated",
                "role": "authenticated",
                "iat": now,
                "exp": now + timedelta(minutes=5),
            },
            private_key,
            algorithm="ES256",
            headers={"kid": "test"},
        )
        with patch("app.auth._jwk_client") as jwk_client:
            jwk_client.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(
                key=private_key.public_key()
            )
            claims = _decode_access_token(token)

        self.assertEqual(claims["role"], "authenticated")

    def test_shared_secret_tokens_are_rejected(self):
        token = jwt.encode({"sub": "00000000-0000-0000-0000-000000000001"}, "secret", algorithm="HS256")
        with self.assertRaises(HTTPException) as raised:
            _decode_access_token(token)
        self.assertEqual(raised.exception.status_code, 401)

    def test_jwks_connection_failure_is_reported_as_service_unavailable(self):
        with (
            patch("app.auth.jwt.get_unverified_header", return_value={"alg": "RS256"}),
            patch("app.auth._jwk_client") as jwk_client,
        ):
            jwk_client.return_value.get_signing_key_from_jwt.side_effect = (
                PyJWKClientConnectionError("JWKS endpoint unavailable")
            )
            with self.assertRaises(HTTPException) as raised:
                _decode_access_token("header.payload.signature")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail,
            "Authentication service temporarily unavailable",
        )


class AuthTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = ec.generate_private_key(ec.SECP256R1())
        cls.other_key = ec.generate_private_key(ec.SECP256R1())
        cls.now = datetime.fromisoformat("2026-10-10T02:50:39.940164+00:00")
        cls.second = int(cls.now.timestamp())

    def decode(self, changes=None, signing_key=None):
        token = jwt.encode(
            {
                "sub": "00000000-0000-0000-0000-000000000001",
                "iss": "https://example.supabase.co/auth/v1",
                "aud": "authenticated",
                "role": "authenticated",
                "iat": self.second - 1,
                "exp": self.second + 300,
                **(changes or {}),
            },
            signing_key or self.private_key,
            algorithm="ES256",
            headers={"kid": "test"},
        )
        with (
            patch("jwt.api_jwt.datetime") as clock,
            patch("app.auth._supabase_auth_settings", return_value=(
                "https://example.supabase.co/auth/v1", "authenticated", "unused"
            )),
            patch("app.auth._jwk_client") as jwk_client,
        ):
            clock.now.return_value = self.now
            jwk_client.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(
                key=self.private_key.public_key()
            )
            return _decode_access_token(token)

    def test_normal_issued_at_is_accepted(self):
        self.assertEqual(self.decode()["iat"], self.second - 1)

    def test_recorded_subsecond_future_issued_at_is_accepted(self):
        self.assertEqual(self.decode({"iat": self.second + 1})["iat"], self.second + 1)

    def test_fresh_token_about_one_second_ahead_is_accepted(self):
        self.assertEqual(self.decode({"iat": self.second + 2})["iat"], self.second + 2)

    def test_issued_at_outside_two_seconds_is_rejected(self):
        for seconds in (3, 60):
            with self.subTest(seconds=seconds), self.assertRaises(HTTPException) as raised:
                self.decode({"iat": self.second + seconds})
            self.assertEqual(raised.exception.status_code, 401)
            self.assertIsInstance(raised.exception.__cause__, jwt.ImmatureSignatureError)

    def test_expiration_outside_two_seconds_is_rejected(self):
        for seconds in (2, 300):
            with self.subTest(seconds=seconds), self.assertRaises(HTTPException) as raised:
                self.decode({"exp": self.second - seconds})
            self.assertEqual(raised.exception.status_code, 401)
            self.assertIsInstance(raised.exception.__cause__, jwt.ExpiredSignatureError)

    def test_expiration_has_only_the_approved_two_second_grace(self):
        self.assertEqual(self.decode({"exp": self.second})["exp"], self.second)

    def test_not_before_respects_the_same_bounded_tolerance(self):
        self.assertEqual(self.decode({"nbf": self.second + 2})["nbf"], self.second + 2)
        with self.assertRaises(HTTPException) as raised:
            self.decode({"nbf": self.second + 3})
        self.assertEqual(raised.exception.status_code, 401)
        self.assertIsInstance(raised.exception.__cause__, jwt.ImmatureSignatureError)

    def test_incorrect_issuer_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self.decode({"iss": "https://foreign.example/auth/v1"})
        self.assertEqual(raised.exception.status_code, 401)
        self.assertIsInstance(raised.exception.__cause__, jwt.InvalidIssuerError)

    def test_incorrect_audience_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self.decode({"aud": "foreign"})
        self.assertEqual(raised.exception.status_code, 401)
        self.assertIsInstance(raised.exception.__cause__, jwt.InvalidAudienceError)

    def test_invalid_signature_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self.decode(signing_key=self.other_key)
        self.assertEqual(raised.exception.status_code, 401)
        self.assertIsInstance(raised.exception.__cause__, jwt.InvalidSignatureError)

    def test_unauthenticated_role_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self.decode({"role": "service_role"})
        self.assertEqual(raised.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
