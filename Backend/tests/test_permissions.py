import os
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.auth import ORGANIZATION_ROLES
from app.permissions import allowed_roles_for, has_permission


class PermissionMatrixTests(unittest.TestCase):
    def test_every_role_is_a_known_organization_role(self):
        for capability_roles in (
            allowed_roles_for("view_data"),
            allowed_roles_for("trigger_sync"),
            allowed_roles_for("upload_dbt_manifest"),
            allowed_roles_for("manage_invitations"),
            allowed_roles_for("manage_members"),
            allowed_roles_for("manage_connection"),
            allowed_roles_for("manage_organization"),
            allowed_roles_for("transfer_ownership"),
        ):
            for role in capability_roles:
                self.assertIn(role, ORGANIZATION_ROLES)

    def test_view_data_is_open_to_every_role(self):
        for role in ORGANIZATION_ROLES:
            self.assertTrue(has_permission(role, "view_data"))

    def test_only_owner_can_manage_or_transfer_the_organization(self):
        for role in ("admin", "operator", "viewer"):
            self.assertFalse(has_permission(role, "manage_organization"))
            self.assertFalse(has_permission(role, "transfer_ownership"))
        self.assertTrue(has_permission("owner", "manage_organization"))
        self.assertTrue(has_permission("owner", "transfer_ownership"))

    def test_operator_can_run_ingestion_but_not_manage_membership_or_connections(self):
        self.assertTrue(has_permission("operator", "trigger_sync"))
        self.assertTrue(has_permission("operator", "upload_dbt_manifest"))
        self.assertFalse(has_permission("operator", "manage_invitations"))
        self.assertFalse(has_permission("operator", "manage_members"))
        self.assertFalse(has_permission("operator", "manage_connection"))

    def test_viewer_can_only_view(self):
        self.assertTrue(has_permission("viewer", "view_data"))
        for capability in (
            "trigger_sync",
            "upload_dbt_manifest",
            "manage_invitations",
            "manage_members",
            "manage_connection",
            "manage_organization",
            "transfer_ownership",
        ):
            self.assertFalse(has_permission("viewer", capability))

    def test_unknown_capability_raises(self):
        with self.assertRaises(KeyError):
            allowed_roles_for("not_a_real_capability")


if __name__ == "__main__":
    unittest.main()
