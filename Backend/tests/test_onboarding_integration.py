import importlib.util
import os
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")
from fastapi import HTTPException
from pydantic import ValidationError
from app.api.routes.onboarding import approve_join_request, deny_join_request
from app.api.routes.invitations import create_invitation
from app.auth import CurrentUser, OrganizationAccess
from app.models.organization_memberships import OrganizationMembership
from app.schemas.organizations import OrganizationCreate, OrganizationInvitationCreate


class OnboardingIntegrationTests(unittest.TestCase):
    def test_automatic_enrollment_is_rejected_in_request_schema(self):
        with self.assertRaises(ValidationError):
            OrganizationCreate(name="Workspace", allow_domain_join=True)
        self.assertFalse(OrganizationCreate(name="Workspace").allow_domain_join)

    def test_approve_creates_viewer_membership_and_deny_creates_none(self):
        for approve in (True, False):
            with self.subTest(approve=approve):
                org_id, user_id, applicant = uuid4(), uuid4(), uuid4()
                access = OrganizationAccess(org_id, CurrentUser(user_id, "admin@example.com", None), "admin")
                request = SimpleNamespace(user_id=applicant, status="pending")
                db = MagicMock()
                query = db.query.return_value.filter.return_value.with_for_update.return_value
                query.one_or_none.return_value = request
                action = approve_join_request if approve else deny_join_request
                action(uuid4(), access=access, db=db)
                if approve:
                    membership = db.add.call_args.args[0]
                    self.assertIsInstance(membership, OrganizationMembership)
                    self.assertEqual((membership.organization_id, membership.user_id, membership.role), (org_id, applicant, "viewer"))
                else:
                    db.add.assert_not_called()
                self.assertEqual(request.status, "approved" if approve else "denied")
                self.assertEqual(request.resolved_by, user_id)
                db.commit.assert_called_once()

    def test_cross_organization_join_request_writes_are_hidden(self):
        for action in (approve_join_request, deny_join_request):
            for user_id, org_id in ((uuid4(), uuid4()), (uuid4(), uuid4())):
                db = MagicMock()
                query = db.query.return_value.filter.return_value.with_for_update.return_value
                query.one_or_none.return_value = None
                access = OrganizationAccess(org_id, CurrentUser(user_id, "admin@example.com", None), "admin")
                with self.assertRaises(HTTPException) as raised:
                    action(uuid4(), access=access, db=db)
                self.assertEqual(raised.exception.status_code, 404)
                scope = db.query.return_value.filter.call_args.args[1]
                self.assertEqual(scope.right.value, org_id)
                db.add.assert_not_called()
                db.commit.assert_not_called()

    def test_invitation_response_does_not_read_expired_orm_after_commit(self):
        now = datetime.now(timezone.utc)
        db = MagicMock()
        organization = SimpleNamespace(name="Acme")
        db.query.return_value.filter.return_value.one.return_value = organization
        def flush():
            invite = db.add.call_args.args[0]
            invite.id, invite.created_at, invite.expires_at = uuid4(), now, now
        def expire():
            invite = db.add.call_args.args[0]
            invite.email, invite.role, invite.expires_at = None, None, None
            organization.name = None
        db.flush.side_effect = flush
        db.commit.side_effect = expire
        access = OrganizationAccess(uuid4(), CurrentUser(uuid4(), "owner@example.com", None), "owner")
        with patch("app.api.routes.invitations.send_invitation_email", return_value=False) as send:
            result = create_invitation(OrganizationInvitationCreate(email="new@example.com"), access=access, db=db)
        self.assertFalse(result.email_sent)
        self.assertEqual(send.call_args.kwargs["organization_name"], "Acme")
        self.assertEqual(send.call_args.kwargs["to_email"], "new@example.com")

    def test_forward_policy_has_no_domain_enrollment_or_data_rewrite(self):
        path = Path(__file__).resolve().parents[2] / "Database/alembic/versions/20261005_120000_require_organization_join_approval.py"
        spec = importlib.util.spec_from_file_location("approval_migration", path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        with patch.object(migration.op, "execute") as execute:
            migration.upgrade()
        sql = [call.args[0].lower() for call in execute.call_args_list]
        policy = next(statement for statement in sql if statement.startswith("alter policy"))
        self.assertNotIn("can_join_by_domain", policy)
        self.assertIn("can_accept_organization_invitation", policy)
        self.assertTrue(any("revoke all on function private.can_join_by_domain" in statement for statement in sql))
        self.assertFalse(any(statement.startswith(("update ", "delete ", "truncate ", "insert ")) for statement in sql))
        with patch.object(migration.op, "execute") as execute:
            migration.downgrade()
        execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
