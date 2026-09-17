import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.api.routes.invitations import (
    _require_invitable_role,
    accept_invitation,
    create_invitation,
    delete_invitation,
    list_my_invitations,
)
from app.auth import CurrentUser, OrganizationAccess
from app.schemas.organizations import OrganizationInvitationCreate


ORGANIZATION_ID = UUID("20000000-0000-0000-0000-000000000001")
INVITATION_ID = UUID("30000000-0000-0000-0000-000000000001")
USER_ID = UUID("10000000-0000-0000-0000-000000000001")


def query_returning(value):
    query = MagicMock()
    query.filter.return_value.one_or_none.return_value = value
    query.filter.return_value.with_for_update.return_value.one_or_none.return_value = value
    return query


class OrganizationInvitationTests(unittest.TestCase):
    def setUp(self):
        self.user = CurrentUser(id=USER_ID, email=" Invitee@Example.com ", session_id=None)

    def test_invitation_email_is_normalized_and_owner_role_is_rejected(self):
        payload = OrganizationInvitationCreate(email=" Invitee@Example.com ")
        self.assertEqual(payload.email, "invitee@example.com")
        with self.assertRaises(ValidationError):
            OrganizationInvitationCreate(email="invitee@example.com", role="owner")

    def test_admin_cannot_invite_another_admin(self):
        access = OrganizationAccess(ORGANIZATION_ID, self.user, "admin")
        with self.assertRaises(HTTPException) as raised:
            _require_invitable_role(access, "admin")
        self.assertEqual(raised.exception.status_code, 403)
        _require_invitable_role(access, "viewer")

    def test_owner_can_create_an_admin_invitation(self):
        now = datetime.now(timezone.utc)
        db = MagicMock()

        def add_server_values():
            invitation = db.add.call_args.args[0]
            invitation.id = INVITATION_ID
            invitation.created_at = now
            invitation.expires_at = now + timedelta(days=7)

        db.flush.side_effect = add_server_values
        access = OrganizationAccess(ORGANIZATION_ID, self.user, "owner")
        result = create_invitation(
            payload=OrganizationInvitationCreate(
                email=" Admin@Example.com ", role="admin"
            ),
            access=access,
            db=db,
        )

        self.assertEqual(result.email, "admin@example.com")
        self.assertEqual(result.role, "admin")
        self.assertEqual(result.invited_by, USER_ID)
        db.commit.assert_called_once()

    def test_user_without_email_cannot_list_or_accept_invitations(self):
        user = CurrentUser(id=USER_ID, email=None, session_id=None)
        for call in (
            lambda: list_my_invitations(user=user, db=MagicMock()),
            lambda: accept_invitation(invitation_id=INVITATION_ID, user=user, db=MagicMock()),
        ):
            with self.subTest(call=call):
                with self.assertRaises(HTTPException) as raised:
                    call()
                self.assertEqual(raised.exception.status_code, 400)

    def test_uninvited_user_gets_an_empty_list(self):
        db = MagicMock()
        db.execute.return_value.mappings.return_value = []
        self.assertEqual(list_my_invitations(user=self.user, db=db), [])
        params = db.execute.call_args_list[0].args[1]
        self.assertEqual(params["email"], "invitee@example.com")

    def test_invitee_summary_contains_only_the_approved_organization_projection(self):
        expires_at = datetime.now(timezone.utc) + timedelta(days=1)
        db = MagicMock()
        db.execute.return_value.mappings.return_value = [
            {
                "id": INVITATION_ID,
                "organization_id": ORGANIZATION_ID,
                "organization_name": "Example Organization",
                "organization_slug": "example-organization",
                "role": "viewer",
                "expires_at": expires_at,
            }
        ]
        result = list_my_invitations(user=self.user, db=db)
        self.assertEqual(result[0].organization_name, "Example Organization")
        self.assertNotIn("created_by", result[0].model_dump())
        self.assertNotIn("invited_by", result[0].model_dump())

    def test_acceptance_creates_membership_and_consumes_invitation_atomically(self):
        now = datetime.now(timezone.utc)
        invitation = SimpleNamespace(
            id=INVITATION_ID,
            organization_id=ORGANIZATION_ID,
            email="invitee@example.com",
            role="viewer",
            expires_at=now + timedelta(days=1),
        )
        organization = SimpleNamespace(
            id=ORGANIZATION_ID,
            name="Example Organization",
            slug="example-organization",
            created_at=now,
        )
        organization_query = MagicMock()
        organization_query.filter.return_value.one.return_value = organization
        db = MagicMock()
        db.query.side_effect = [
            query_returning(invitation),
            query_returning(None),
            organization_query,
        ]

        result = accept_invitation(invitation_id=INVITATION_ID, user=self.user, db=db)

        membership = db.add.call_args.args[0]
        self.assertEqual(membership.organization_id, ORGANIZATION_ID)
        self.assertEqual(membership.user_id, USER_ID)
        self.assertEqual(membership.role, "viewer")
        db.delete.assert_called_once_with(invitation)
        self.assertEqual(db.flush.call_count, 2)
        db.commit.assert_called_once()
        self.assertEqual(result.id, ORGANIZATION_ID)

    def test_wrong_email_or_expired_invitation_is_hidden(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.with_for_update.return_value.one_or_none.return_value = None
        with self.assertRaises(HTTPException) as raised:
            accept_invitation(invitation_id=INVITATION_ID, user=self.user, db=db)
        self.assertEqual(raised.exception.status_code, 404)
        self.assertFalse(db.add.called)
        self.assertFalse(db.commit.called)

    def test_failed_membership_insert_rolls_back_without_consuming_invitation(self):
        now = datetime.now(timezone.utc)
        invitation = SimpleNamespace(
            id=INVITATION_ID,
            organization_id=ORGANIZATION_ID,
            email="invitee@example.com",
            role="viewer",
            expires_at=now + timedelta(days=1),
        )
        db = MagicMock()
        db.query.side_effect = [query_returning(invitation), query_returning(None)]
        db.flush.side_effect = IntegrityError("insert", {}, Exception("denied"))

        with self.assertRaises(IntegrityError):
            accept_invitation(invitation_id=INVITATION_ID, user=self.user, db=db)

        db.rollback.assert_called_once()
        self.assertFalse(db.delete.called)
        self.assertFalse(db.commit.called)

    def test_cross_organization_invitation_is_hidden_from_delete(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        access = OrganizationAccess(ORGANIZATION_ID, self.user, "owner")
        with self.assertRaises(HTTPException) as raised:
            delete_invitation(invitation_id=INVITATION_ID, access=access, db=db)
        self.assertEqual(raised.exception.status_code, 404)
        self.assertFalse(db.delete.called)


if __name__ == "__main__":
    unittest.main()
