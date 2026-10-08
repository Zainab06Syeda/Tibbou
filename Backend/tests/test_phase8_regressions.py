"""Real ORM transaction regressions; SQLite does not simulate PostgreSQL RLS."""
import os
import unittest
from types import SimpleNamespace
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models  # noqa: F401
from app.api.routes.datasets import create_dataset
from app.api.routes.lineage import create_lineage_edge
from app.db import Base
from app.models.datasets import Dataset
from app.models.lineage_edges import LineageEdge
from app.models.organizations import Organization
from app.schemas.datasets import DatasetCreate
from app.schemas.lineage import LineageEdgeCreate


class Phase8ResponseRegressionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        tables = [Base.metadata.tables[name] for name in ("organizations", "datasets", "lineage_edges")]
        Base.metadata.create_all(self.engine, tables=tables)
        self.db = Session(self.engine, autoflush=False)
        self.org = uuid4()
        self.access = SimpleNamespace(organization_id=self.org)
        self.upstream, self.downstream = uuid4(), uuid4()
        self.db.add(Organization(id=self.org, name="Phase 8", slug="phase8"))
        self.db.add_all([
            Dataset(id=self.upstream, organization_id=self.org, name="upstream", system="fixture"),
            Dataset(id=self.downstream, organization_id=self.org, name="downstream", system="fixture"),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def deny_post_commit_sql(self):
        committed = [False]
        event.listen(self.db, "after_commit", lambda _session: committed.__setitem__(0, True))

        def guard(_conn, _cursor, _statement, _parameters, _context, _many):
            if committed[0]:
                raise AssertionError("SQL after commit has lost transaction-local authorization")

        event.listen(self.engine, "before_cursor_execute", guard)
        self.assertTrue(self.db.expire_on_commit)
        return guard

    def payload(self):
        return LineageEdgeCreate(
            upstream_dataset_id=self.upstream, downstream_dataset_id=self.downstream,
            relationship_type="dependency", provenance="phase8",
        )

    def test_dataset_returns_committed_defaults_without_post_commit_sql(self):
        guard = self.deny_post_commit_sql()
        response = create_dataset(DatasetCreate(name="new", system="fixture"), self.access, self.db)
        self.assertEqual(response.organization_id, self.org)
        self.assertTrue(response.is_active)
        self.assertIsNotNone(response.created_at)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            row = reader.get(Dataset, response.id)
            self.assertEqual(row.name, response.name)
            self.assertEqual(row.created_at, response.created_at)

    def test_lineage_returns_committed_defaults_without_post_commit_sql(self):
        guard = self.deny_post_commit_sql()
        response = create_lineage_edge(self.payload(), self.access, self.db)
        self.assertEqual(response.organization_id, self.org)
        self.assertTrue(response.is_active)
        self.assertIsNotNone(response.created_at)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(LineageEdge, response.id).provenance, "phase8")

    def test_duplicate_dataset_rolls_back(self):
        payload = DatasetCreate(name="duplicate", system="fixture", source_unique_id="same")
        create_dataset(payload, self.access, self.db)
        with self.assertRaises(HTTPException) as raised:
            create_dataset(payload, self.access, self.db)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.db.query(Dataset).filter_by(source_unique_id="same").count(), 1)

    def test_duplicate_lineage_rolls_back(self):
        create_lineage_edge(self.payload(), self.access, self.db)
        with self.assertRaises(HTTPException) as raised:
            create_lineage_edge(self.payload(), self.access, self.db)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.db.query(LineageEdge).count(), 1)

    def test_foreign_dataset_does_not_create_lineage(self):
        payload = LineageEdgeCreate(upstream_dataset_id=uuid4(), downstream_dataset_id=self.downstream)
        with self.assertRaises(HTTPException) as raised:
            create_lineage_edge(payload, self.access, self.db)
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(self.db.query(LineageEdge).count(), 0)

    def test_dataset_commit_failure_does_not_return_or_persist_prepared_response(self):
        def reject(_session):
            raise IntegrityError("commit", {}, Exception("controlled failure"))

        event.listen(self.db, "before_commit", reject)
        with self.assertRaises(HTTPException) as raised:
            create_dataset(DatasetCreate(name="failed", system="fixture"), self.access, self.db)
        self.assertEqual(raised.exception.status_code, 409)
        with Session(self.engine) as reader:
            self.assertEqual(reader.query(Dataset).filter_by(name="failed").count(), 0)

    def test_lineage_commit_failure_does_not_return_or_persist_prepared_response(self):
        def reject(_session):
            raise IntegrityError("commit", {}, Exception("controlled failure"))

        event.listen(self.db, "before_commit", reject)
        with self.assertRaises(HTTPException) as raised:
            create_lineage_edge(self.payload(), self.access, self.db)
        self.assertEqual(raised.exception.status_code, 409)
        with Session(self.engine) as reader:
            self.assertEqual(reader.query(LineageEdge).count(), 0)


if __name__ == "__main__":
    unittest.main()

