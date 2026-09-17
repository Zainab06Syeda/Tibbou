import os
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from fastapi.testclient import TestClient

from app.main import app


class ApiSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_is_public(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_business_api_requires_bearer_token(self):
        response = self.client.get("/api/v1/organizations")
        self.assertEqual(response.status_code, 401)

        admin_response = self.client.get(
            "/api/v1/organizations/00000000-0000-0000-0000-000000000001/admin"
        )
        self.assertEqual(admin_response.status_code, 401)
        invitation_response = self.client.get("/api/v1/invitations")
        self.assertEqual(invitation_response.status_code, 401)
        accept_response = self.client.post(
            "/api/v1/invitations/00000000-0000-0000-0000-000000000002/accept"
        )
        self.assertEqual(accept_response.status_code, 401)
        create_invitation_response = self.client.post(
            "/api/v1/organizations/00000000-0000-0000-0000-000000000001/invitations",
            json={"email": "member@example.com", "role": "viewer"},
        )
        self.assertEqual(create_invitation_response.status_code, 401)

    def test_database_ping_is_not_public(self):
        response = self.client.get("/db/ping")
        self.assertEqual(response.status_code, 401)

    def test_oversized_dbt_manifest_is_rejected_before_authentication(self):
        organization_id = "00000000-0000-0000-0000-000000000001"
        with patch.dict(os.environ, {"MAX_DBT_MANIFEST_BYTES": "1024"}):
            response = self.client.post(
                f"/api/v1/organizations/{organization_id}/ingestion/dbt/manifest",
                content=b"x" * 1025,
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(
            response.json(),
            {"detail": "dbt manifest exceeds configured ingestion limits"},
        )

    def test_openapi_exposes_only_tenant_scoped_business_routes(self):
        paths = app.openapi()["paths"]
        self.assertNotIn("/datasets", paths)
        self.assertIn("/api/v1/organizations/{organization_id}/datasets", paths)
        self.assertIn("/api/v1/organizations/{organization_id}/admin", paths)
        self.assertIn("/api/v1/invitations", paths)
        self.assertIn("/api/v1/invitations/{invitation_id}/accept", paths)
        self.assertNotIn("post", paths["/api/v1/organizations"])
        self.assertEqual(paths["/api/v1/organizations/{organization_id}/ingestion/dbt/manifest"]["post"]["responses"].get("202", {}).get("description"), "Successful Response")


if __name__ == "__main__":
    unittest.main()
