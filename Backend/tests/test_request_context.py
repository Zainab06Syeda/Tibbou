import os
import unittest
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from app.auth import set_request_organization_context, set_request_user_context

USER_ID = UUID("10000000-0000-0000-0000-000000000001")
ORGANIZATION_ID = UUID("20000000-0000-0000-0000-000000000001")


class RequestContextSurvivesCommitTests(unittest.TestCase):
    """RLS reads transaction-local settings; a commit clears them in Postgres.

    SQLite stands in for Postgres here, with set_config recorded per
    transaction, so the test can see which settings each transaction got.
    """

    def setUp(self):
        self.engine = create_engine("sqlite://")
        self.transactions = []

        @event.listens_for(self.engine, "connect")
        def register(dbapi_connection, _record):
            def set_config(name, value, _is_local):
                self.transactions[-1][name] = value
                return value

            dbapi_connection.create_function("set_config", 3, set_config)

        @event.listens_for(self.engine, "begin")
        def begin(_connection):
            self.transactions.append({})

    def test_user_and_organization_are_reapplied_after_a_commit(self):
        with Session(self.engine) as db:
            set_request_user_context(db, USER_ID, " Owner@Example.com ")
            set_request_organization_context(db, ORGANIZATION_ID)
            db.commit()

            db.execute(text("select 1"))  # e.g. db.refresh() after the commit

        expected = {
            "app.current_user_id": str(USER_ID),
            "app.current_user_email": "owner@example.com",
            "app.current_organization_id": str(ORGANIZATION_ID),
        }
        self.assertEqual(len(self.transactions), 2)
        self.assertEqual(self.transactions[0], expected)
        self.assertEqual(self.transactions[1], expected)

    def test_sessions_do_not_share_context(self):
        with Session(self.engine) as db:
            set_request_user_context(db, USER_ID, "owner@example.com")
            db.commit()
        with Session(self.engine) as other:
            other.execute(text("select 1"))

        self.assertEqual(self.transactions[-1], {})


if __name__ == "__main__":
    unittest.main()
