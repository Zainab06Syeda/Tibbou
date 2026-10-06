import os
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException
from psycopg2.errors import RaiseException
from sqlalchemy.exc import DBAPIError

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.api.routes.organizations import change_member_role, remove_member, transfer_ownership
from app.auth import CurrentUser, OrganizationAccess
from app.schemas.organizations import MembershipRoleUpdate


ORGANIZATION_ID = UUID("20000000-0000-0000-0000-000000000001")
ACTOR_ID = UUID("10000000-0000-0000-0000-000000000001")
TARGET_ID = UUID("10000000-0000-0000-0000-000000000002")


def db_returning_membership(role, *, commit_raises=None):
    db = MagicMock()
    membership = MagicMock(
        organization_id=ORGANIZATION_ID,
        user_id=TARGET_ID,
        role=role,
        created_at=datetime.now(timezone.utc),
    )
    db.query.return_value.filter.return_value.one_or_none.return_value = membership
    if commit_raises is not None:
        db.commit.side_effect = commit_raises
    return db, membership


class ChangeMemberRoleTests(unittest.TestCase):
    def setUp(self):
        self.actor = CurrentUser(id=ACTOR_ID, email="owner@example.com", session_id=None)

    def test_admin_can_promote_an_operator_to_admin_only_if_owner(self):
        db, membership = db_returning_membership("operator")
        admin_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "admin")
        with self.assertRaises(HTTPException) as raised:
            change_member_role(
                user_id=TARGET_ID,
                payload=MembershipRoleUpdate(role="admin"),
                access=admin_access,
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 403)

    def test_owner_can_promote_an_operator_to_admin(self):
        db, membership = db_returning_membership("operator")
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        result = change_member_role(
            user_id=TARGET_ID,
            payload=MembershipRoleUpdate(role="admin"),
            access=owner_access,
            db=db,
        )
        self.assertEqual(result.role, "admin")
        db.commit.assert_called_once()

    def test_admin_cannot_change_an_owners_role(self):
        db, membership = db_returning_membership("owner")
        admin_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "admin")
        with self.assertRaises(HTTPException) as raised:
            change_member_role(
                user_id=TARGET_ID,
                payload=MembershipRoleUpdate(role="viewer"),
                access=admin_access,
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 403)
        db.commit.assert_not_called()

    def test_owner_can_demote_another_owner(self):
        db, membership = db_returning_membership("owner")
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        result = change_member_role(
            user_id=TARGET_ID,
            payload=MembershipRoleUpdate(role="admin"),
            access=owner_access,
            db=db,
        )
        self.assertEqual(result.role, "admin")

    def test_demoting_the_last_owner_is_rejected_by_the_db_trigger(self):
        db, membership = db_returning_membership(
            "owner",
            commit_raises=DBAPIError(
                "update organization_memberships set role = %s",
                {},
                RaiseException("an organization must retain at least one owner"),
            ),
        )
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        with self.assertRaises(HTTPException) as raised:
            change_member_role(
                user_id=TARGET_ID,
                payload=MembershipRoleUpdate(role="admin"),
                access=owner_access,
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 409)
        db.rollback.assert_called_once()

    def test_missing_member_is_404(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        with self.assertRaises(HTTPException) as raised:
            change_member_role(
                user_id=TARGET_ID,
                payload=MembershipRoleUpdate(role="viewer"),
                access=owner_access,
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 404)


class RemoveMemberTests(unittest.TestCase):
    def setUp(self):
        self.actor = CurrentUser(id=ACTOR_ID, email="owner@example.com", session_id=None)

    def test_admin_cannot_remove_an_owner(self):
        db, membership = db_returning_membership("owner")
        admin_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "admin")
        with self.assertRaises(HTTPException) as raised:
            remove_member(user_id=TARGET_ID, access=admin_access, db=db)
        self.assertEqual(raised.exception.status_code, 403)
        db.delete.assert_not_called()

    def test_admin_can_remove_a_viewer(self):
        db, membership = db_returning_membership("viewer")
        admin_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "admin")
        remove_member(user_id=TARGET_ID, access=admin_access, db=db)
        db.delete.assert_called_once_with(membership)
        db.commit.assert_called_once()

    def test_removing_the_last_owner_is_rejected_by_the_db_trigger(self):
        db, membership = db_returning_membership(
            "owner",
            commit_raises=DBAPIError(
                "delete from organization_memberships",
                {},
                RaiseException("an organization must retain at least one owner"),
            ),
        )
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        with self.assertRaises(HTTPException) as raised:
            remove_member(user_id=TARGET_ID, access=owner_access, db=db)
        self.assertEqual(raised.exception.status_code, 409)


class TransferOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.actor = CurrentUser(id=ACTOR_ID, email="owner@example.com", session_id=None)

    def test_transfer_promotes_the_target_to_owner(self):
        db, membership = db_returning_membership("admin")
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        result = transfer_ownership(user_id=TARGET_ID, access=owner_access, db=db)
        self.assertEqual(result.role, "owner")
        db.commit.assert_called_once()

    def test_missing_member_is_404(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        owner_access = OrganizationAccess(ORGANIZATION_ID, self.actor, "owner")
        with self.assertRaises(HTTPException) as raised:
            transfer_ownership(user_id=TARGET_ID, access=owner_access, db=db)
        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
