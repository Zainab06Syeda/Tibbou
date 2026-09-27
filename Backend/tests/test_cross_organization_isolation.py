"""The most important test in the org-onboarding task: a user in org A must
never be able to read org B's data.

The deep version of this already exists at tests/test_tenancy_rls_integration.py
(test_second_organization_sentinel_is_isolated), which spins up a real local
Postgres, runs the full migration chain, creates a genuine RLS-scoped login
role, and inserts sentinel rows in two organizations to prove Postgres itself
refuses cross-org reads. That test is gated behind TIBBOU_PHASE2B_LOCAL_TEST
and a local Supabase CLI database on a specific port range, so it does not
run by default -- it's real coverage, but silent unless someone deliberately
opts in.

This file is the always-running complement, at the layer below the database:
it proves (a) require_viewer's membership lookup -- the gate every org-scoped
route sits behind -- 404s a user for an organization_id they don't belong to
rather than ever resolving OrganizationAccess for it, and (b) the three
routes that actually serve lineage/cost/dataset data build their query filter
from that resolved access.organization_id and nothing else, by asserting the
exact same code path scopes correctly to two DIFFERENT organizations in turn.
Neither of these needs a database connection, so they run in every test
invocation, not just ones with local Supabase set up.
"""

import os
import unittest
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from app.api.routes.costs import list_cost_snapshots
from app.api.routes.datasets import list_datasets
from app.api.routes.lineage import list_lineage_edges
from app.auth import CurrentUser, OrganizationAccess, require_viewer

ORG_A = UUID("20000000-0000-0000-0000-00000000000a")
ORG_B = UUID("20000000-0000-0000-0000-00000000000b")
USER_ID = UUID("10000000-0000-0000-0000-000000000001")


class RequireViewerCrossOrgTests(unittest.TestCase):
    """require_viewer is the gate list_datasets/list_lineage_edges/
    list_cost_snapshots all sit behind -- if this 404s correctly, none of
    them can ever be reached for an organization the caller isn't in."""

    def setUp(self):
        self.user = CurrentUser(id=USER_ID, email="member@example.com", session_id=None)

    def test_non_member_is_404_not_someone_elses_data(self):
        db = MagicMock()
        # The membership lookup for ORG_B finds nothing -- this user belongs
        # to ORG_A, not ORG_B.
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        with self.assertRaises(HTTPException) as raised:
            require_viewer(organization_id=ORG_B, user=self.user, db=db)
        self.assertEqual(raised.exception.status_code, 404)

    def test_member_resolves_to_their_own_organization_only(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = MagicMock(role="viewer")
        access = require_viewer(organization_id=ORG_A, user=self.user, db=db)
        self.assertEqual(access.organization_id, ORG_A)


class DataRouteScopingTests(unittest.TestCase):
    """For each data-read route, prove the query it builds is filtered by
    whichever organization_id is on the resolved access object -- never a
    hardcoded value, never anything else -- by running the exact same call
    against two different organizations and checking each queries only its
    own."""

    def setUp(self):
        self.user = CurrentUser(id=USER_ID, email="member@example.com", session_id=None)

    def _assert_filters_only_the_given_organization(self, call, organization_id):
        db = MagicMock()
        access = OrganizationAccess(organization_id, self.user, "viewer")
        call(access, db)
        filter_clause = db.query.return_value.filter.call_args.args[0]
        self.assertEqual(filter_clause.right.value, organization_id)

    def test_list_datasets_scopes_to_the_callers_organization(self):
        for organization_id in (ORG_A, ORG_B):
            with self.subTest(organization_id=organization_id):
                self._assert_filters_only_the_given_organization(
                    lambda access, db: list_datasets(limit=100, access=access, db=db),
                    organization_id,
                )

    def test_list_lineage_edges_scopes_to_the_callers_organization(self):
        for organization_id in (ORG_A, ORG_B):
            with self.subTest(organization_id=organization_id):
                self._assert_filters_only_the_given_organization(
                    lambda access, db: list_lineage_edges(limit=500, access=access, db=db),
                    organization_id,
                )

    def test_list_cost_snapshots_scopes_to_the_callers_organization(self):
        for organization_id in (ORG_A, ORG_B):
            with self.subTest(organization_id=organization_id):
                self._assert_filters_only_the_given_organization(
                    lambda access, db: list_cost_snapshots(limit=500, access=access, db=db),
                    organization_id,
                )

    def test_org_a_access_never_queries_org_b_and_vice_versa(self):
        """The direct version of the spec's ask: run the same route once as
        an org-A caller and once as an org-B caller and confirm the two
        resulting queries target different, correct organizations -- an
        org-A caller's query can never be satisfied by org B's rows."""
        db_a, db_b = MagicMock(), MagicMock()
        list_datasets(limit=100, access=OrganizationAccess(ORG_A, self.user, "viewer"), db=db_a)
        list_datasets(limit=100, access=OrganizationAccess(ORG_B, self.user, "viewer"), db=db_b)

        filtered_a = db_a.query.return_value.filter.call_args.args[0].right.value
        filtered_b = db_b.query.return_value.filter.call_args.args[0].right.value
        self.assertEqual(filtered_a, ORG_A)
        self.assertEqual(filtered_b, ORG_B)
        self.assertNotEqual(filtered_a, filtered_b)


if __name__ == "__main__":
    unittest.main()
