import os
import unittest

import jwt
from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.auth import _decode_access_token


class AuthTests(unittest.TestCase):
    def test_shared_secret_tokens_are_rejected(self):
        token = jwt.encode({"sub": "00000000-0000-0000-0000-000000000001"}, "secret", algorithm="HS256")
        with self.assertRaises(HTTPException) as raised:
            _decode_access_token(token)
        self.assertEqual(raised.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
