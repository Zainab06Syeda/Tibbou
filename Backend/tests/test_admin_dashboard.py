import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.api.routes.organizations import get_admin_dashboard
from app.auth import CurrentUser, OrganizationAccess, require_admin


ORGANIZATION_ID = UUID("20000000-0000-0000-0000-000000000001")
USER_ID = UUID("10000000-0000-0000-0000-000000000001")


def query_returning(value):
    query = MagicMock()
    query.filter.return_value.one_or_none.return_value = value
    return query


class AdminDashboardTests(unittest.TestCase):
    def setUp(self):
        self.user = CurrentUser(id=USER_ID, email="owner@example.com", session_id=None)

    def test_admin_dependency_allows_owner_and_admin_memberships(self):
        for role, expected_status in (
            ("owner", None),
            ("admin", None),
            ("operator", 403),
            ("viewer", 403),
        ):
            with self.subTest(role=role):
                db = MagicMock()
                db.query.return_value.filter.return_value.one_or_none.return_value = SimpleNamespace(
                    role=role
                )

                if expected_status:
                    with self.assertRaises(HTTPException) as raised:
                        require_admin(organization_id=ORGANIZATION_ID, user=self.user, db=db)
                    self.assertEqual(raised.exception.status_code, expected_status)
                else:
                    access = require_admin(organization_id=ORGANIZATION_ID, user=self.user, db=db)
                    self.assertEqual(access.role, role)
                    self.assertEqual(access.organization_id, ORGANIZATION_ID)

    def test_non_member_organization_is_hidden(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        with self.assertRaises(HTTPException) as raised:
            require_admin(organization_id=ORGANIZATION_ID, user=self.user, db=db)
        self.assertEqual(raised.exception.status_code, 404)

    def test_owner_response_contains_only_requested_organization_data(self):
        created_at = datetime(2026, 9, 10, tzinfo=timezone.utc)
        organization = SimpleNamespace(
            id=ORGANIZATION_ID,
            name="Organization One",
            slug="organization-one",
            created_at=created_at,
        )
        memberships = [
            SimpleNamespace(user_id=USER_ID, role="owner", created_at=created_at),
            SimpleNamespace(
                user_id=UUID("10000000-0000-0000-0000-000000000002"),
                role="viewer",
                created_at=created_at,
            ),
        ]
        organization_query = query_returning(organization)
        membership_query = MagicMock()
        membership_query.filter.return_value.order_by.return_value.all.return_value = memberships
        invitation_query = MagicMock()
        invitation_query.filter.return_value.order_by.return_value.all.return_value = []
        db = MagicMock()
        db.query.side_effect = [organization_query, membership_query, invitation_query]

        result = get_admin_dashboard(
            access=OrganizationAccess(ORGANIZATION_ID, self.user, "owner"),
            db=db,
        )

        self.assertEqual(result.organization.id, ORGANIZATION_ID)
        self.assertEqual(result.current_user.role, "owner")
        self.assertEqual([row.user_id for row in result.memberships], [row.user_id for row in memberships])
        self.assertEqual(result.invitations, [])
        self.assertEqual(organization_query.filter.call_args.args[0].right.value, ORGANIZATION_ID)
        self.assertEqual(membership_query.filter.call_args.args[0].right.value, ORGANIZATION_ID)


if __name__ == "__main__":
    unittest.main()
