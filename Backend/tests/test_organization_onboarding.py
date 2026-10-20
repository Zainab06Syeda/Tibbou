import os
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.api.routes.onboarding import (
    create_organization,
    get_domain_match,
    request_join_by_domain,
)
from app.auth import CurrentUser
from app.schemas.organizations import OrganizationCreate


ORGANIZATION_ID = UUID("20000000-0000-0000-0000-000000000001")
USER_ID = UUID("10000000-0000-0000-0000-000000000001")


def db_with_domain_match(row):
    db = MagicMock()
    db.execute.return_value.mappings.return_value.one_or_none.return_value = row
    return db


class DomainMatchTests(unittest.TestCase):
    def test_free_mail_domain_never_matches(self):
        db = db_with_domain_match(
            {
                "id": ORGANIZATION_ID,
                "name": "Should Not Appear",
                "slug": "acme",
                "allow_domain_join": True,
                "already_requested": False,
            }
        )
        user = CurrentUser(id=USER_ID, email="person@gmail.com", session_id=None)
        result = get_domain_match(user=user, db=db)
        self.assertIsNone(result.organization)
        # Only the request-context call should fire; the free-mail short
        # circuit must skip the domain-match SQL function entirely.
        self.assertEqual(db.execute.call_count, 1)

    def test_claimed_domain_returns_the_matching_organization(self):
        db = db_with_domain_match(
            {
                "id": ORGANIZATION_ID,
                "name": "Acme",
                "slug": "acme",
                "allow_domain_join": True,
                "already_requested": False,
            }
        )
        user = CurrentUser(id=USER_ID, email="person@acme.com", session_id=None)
        result = get_domain_match(user=user, db=db)
        self.assertEqual(result.organization.id, ORGANIZATION_ID)
        self.assertFalse(result.allow_domain_join)

    def test_unclaimed_domain_returns_no_organization(self):
        db = db_with_domain_match(None)
        user = CurrentUser(id=USER_ID, email="person@unclaimed.com", session_id=None)
        result = get_domain_match(user=user, db=db)
        self.assertIsNone(result.organization)


class CreateOrganizationTests(unittest.TestCase):
    def _flush_sets_created_at(self, db, organization_id=ORGANIZATION_ID):
        def side_effect():
            added = db.add.call_args.args[0]
            if not hasattr(added, "created_at") or added.created_at is None:
                added.id = organization_id
                added.created_at = datetime.now(timezone.utc)

        db.flush.side_effect = side_effect

    def test_free_mail_signup_creates_an_unclaimed_organization(self):
        db = db_with_domain_match(None)
        self._flush_sets_created_at(db)
        user = CurrentUser(id=USER_ID, email="founder@gmail.com", session_id=None)

        result = create_organization(
            payload=OrganizationCreate(name="My Workspace"), user=user, db=db
        )

        self.assertEqual(result.role, "owner")
        organization = db.add.call_args_list[0].args[0]
        self.assertIsNone(organization.claimed_email_domain)
        # Only the request-context call should fire; domain-match must never
        # be consulted for a free-mail signup.
        self.assertEqual(db.execute.call_count, 1)

    def test_work_domain_signup_claims_the_domain(self):
        db = db_with_domain_match(None)
        self._flush_sets_created_at(db)
        user = CurrentUser(id=USER_ID, email="founder@acme.com", session_id=None)

        create_organization(payload=OrganizationCreate(name="Acme"), user=user, db=db)

        organization = db.add.call_args_list[0].args[0]
        self.assertEqual(organization.claimed_email_domain, "acme.com")

    def test_signup_for_an_already_claimed_domain_is_rejected(self):
        db = db_with_domain_match(
            {
                "id": ORGANIZATION_ID,
                "name": "Acme",
                "slug": "acme",
                "allow_domain_join": False,
                "already_requested": False,
            }
        )
        user = CurrentUser(id=USER_ID, email="founder@acme.com", session_id=None)

        with self.assertRaises(HTTPException) as raised:
            create_organization(payload=OrganizationCreate(name="Acme Clone"), user=user, db=db)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Acme", raised.exception.detail)
        db.add.assert_not_called()


class JoinRequestTests(unittest.TestCase):
    def test_request_is_filed_against_the_matched_organization(self):
        db = db_with_domain_match(
            {
                "id": ORGANIZATION_ID,
                "name": "Acme",
                "slug": "acme",
                "allow_domain_join": False,
                "already_requested": False,
            }
        )

        def flush_sets_fields():
            join_request = db.add.call_args.args[0]
            join_request.id = UUID("30000000-0000-0000-0000-000000000001")
            join_request.status = "pending"  # normally comes back from server_default
            join_request.created_at = datetime.now(timezone.utc)
            join_request.resolved_at = None

        db.flush.side_effect = flush_sets_fields
        user = CurrentUser(id=USER_ID, email="new@acme.com", session_id=None)

        result = request_join_by_domain(user=user, db=db)

        self.assertEqual(result.organization_id, ORGANIZATION_ID)
        self.assertEqual(result.status, "pending")

    def test_request_is_rejected_when_no_domain_matches(self):
        db = db_with_domain_match(None)
        user = CurrentUser(id=USER_ID, email="new@unclaimed.com", session_id=None)

        with self.assertRaises(HTTPException) as raised:
            request_join_by_domain(user=user, db=db)
        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
