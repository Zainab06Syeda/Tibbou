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


if __name__ == "__main__":
    unittest.main()
