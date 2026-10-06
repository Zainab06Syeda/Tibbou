"""Phase 6 regressions using real ORM expiration/transactions in memory.

SQLite is a data-flow fixture only: it does not reproduce PostgreSQL RLS,
advisory locks, Auth, or Vault. PostgreSQL-only context calls are ignored.
"""
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app import models  # noqa: F401
from app.api.routes.connections import (
    create_connection,
    update_connection,
    validate_snowflake_connection,
)
from app.api.routes.costs import create_cost_snapshot
from app.api.routes.ingestion import (
    build_legacy_credit_summary, enqueue_dbt_manifest, enqueue_snowflake_sync,
    latest_snowflake_summaries,
)
from app.db import Base
from app.models.cost_snapshots import CostSnapshot
from app.models.datasets import Dataset
from app.models.organizations import Organization
from app.models.query_usage import QueryDatasetAllocation, QueryUsage
from app.models.raw_ingestions import RawIngestion
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.schemas.connections import SnowflakeConnectionCreate, SnowflakeConnectionUpdate
from app.schemas.costs import CostSnapshotCreate
from app.schemas.ingestion import DbtManifestIngestionRequest, SnowflakeSyncRequest
from app.services.ingestion import build_credit_summary, process_snowflake_sync
from app.services.snowflake import GeneratedKeyPair, ValidationResult


@compiles(JSONB, "sqlite")
def _fixture_jsonb(_element, _compiler, **_kwargs):
    return "JSON"


class _FixtureSession(Session):
    def execute(self, statement, *args, **kwargs):
        if str(statement).startswith(("select set_config(", "select pg_advisory_xact_lock(")):
            return None
        return super().execute(statement, *args, **kwargs)


class Phase6RegressionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        names = (
            "organizations", "snowflake_connections", "sync_runs",
            "datasets", "query_usage", "query_dataset_allocations", "raw_ingestions", "cost_snapshots",
        )
        Base.metadata.create_all(self.engine, tables=[Base.metadata.tables[name] for name in names])
        self.db = _FixtureSession(self.engine, autoflush=False)
        self.org, self.user, self.connection_id = uuid4(), uuid4(), uuid4()
        self.end = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        self.access = SimpleNamespace(
            organization_id=self.org, user=SimpleNamespace(id=self.user, email="fixture@example.test")
        )
        self.db.add(Organization(id=self.org, name="Fixture", slug="fixture"))
        self.connection = SnowflakeConnection(
            id=self.connection_id, organization_id=self.org, name="Primary",
            account_identifier="org-account", user_name="USER", role_name="ROLE",
            warehouse_name="WH_A", auth_method="key_pair",
            credential_provider="supabase_vault", secret_reference="fixture-ref",
            public_key="public-only-fixture", public_key_fingerprint="fixture-fingerprint",
            key_pair_name="KEY", enabled=True, status="valid", lifecycle_state="validated",
            capabilities={"access_history": True, "query_attribution_history": True},
            watermarks={}, updated_at=datetime(2000, 1, 1),
        )
        self.db.add(self.connection)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def _deny_sql_after_commit(self):
        authorized = [True]

        def committed(_session):
            authorized[0] = False

        def sql(_conn, _cursor, _statement, _parameters, _context, _many):
            if not authorized[0]:
                raise AssertionError("Post-commit SQL has no transaction-local authorization")

        event.listen(self.db, "after_commit", committed)
        event.listen(self.engine, "before_cursor_execute", sql)
        self.assertTrue(self.db.expire_on_commit)
        return sql

    def _assert_public_response(self, response):
        data = response.model_dump(mode="json")
        self.assertEqual(data["organization_id"], str(self.org))
        self.assertNotIn("secret_reference", data)
        self.assertNotIn("private_key", data)
        self.assertNotIn("fixture-ref", response.model_dump_json())
        self.assertIn("ADD KEY PAIR", response.registration_sql)

    def test_patch_returns_committed_response_without_post_commit_sql(self):
        guard = self._deny_sql_after_commit()
        response = update_connection(
            self.connection_id, SnowflakeConnectionUpdate(name="Renamed"), self.access, self.db
        )
        self._assert_public_response(response)
        self.assertEqual(response.name, "Renamed")
        self.assertNotEqual(response.updated_at.year, 2000)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(SnowflakeConnection, self.connection_id).name, "Renamed")

    def test_validation_returns_committed_response_without_post_commit_sql(self):
        guard = self._deny_sql_after_commit()
        expires = self.end + timedelta(days=90)
        with patch("app.api.routes.connections.validate_connection",
                   return_value=ValidationResult({"mode": "partial"}, expires)):
            response = validate_snowflake_connection(self.connection_id, self.access, self.db)
        self._assert_public_response(response)
        self.assertEqual((response.status, response.lifecycle_state, response.enabled),
                         ("valid", "validated", True))
        self.assertEqual(response.key_expires_at, expires)
        self.assertIsNotNone(response.last_validated_at)
        self.assertNotEqual(response.updated_at.year, 2000)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(SnowflakeConnection, self.connection_id).capabilities,
                             {"mode": "partial"})

    def test_create_returns_defaults_without_post_commit_sql_or_private_key(self):
        guard = self._deny_sql_after_commit()
        with (
            patch("app.api.routes.connections.generate_key_pair",
                  return_value=GeneratedKeyPair("private-fixture", "public-fixture", "fingerprint")),
            patch("app.api.routes.connections.create_vault_secret", return_value="fixture-new-ref"),
        ):
            response = create_connection(
                SnowflakeConnectionCreate(
                    name="Second", account_identifier="org-account", user_name="USER",
                    role_name="ROLE", warehouse_name="WH_B",
                ), self.access, self.db,
            )
        self._assert_public_response(response)
        self.assertNotIn("private-fixture", response.model_dump_json())
        self.assertEqual((response.status, response.enabled, response.capabilities),
                         ("pending", False, {}))
        self.assertIsNotNone(response.created_at)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(SnowflakeConnection, response.id).secret_reference,
                             "fixture-new-ref")

    def test_snowflake_queue_returns_committed_response_without_post_commit_sql(self):
        guard = self._deny_sql_after_commit()
        response = enqueue_snowflake_sync(
            SnowflakeSyncRequest(connection_id=self.connection_id), "fixture-sync",
            self.access, self.db,
        )
        self.assertEqual(response.status, "queued")
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(SyncRun, response.sync_run_id).connection_id,
                             self.connection_id)
            self.assertEqual(reader.query(Dataset).count(), 0)

    def test_dbt_queue_returns_committed_ids_without_post_commit_sql(self):
        guard = self._deny_sql_after_commit()
        response = enqueue_dbt_manifest(
            DbtManifestIngestionRequest(nodes={}), "fixture-dbt", self.access, self.db
        )
        self.assertEqual(response.status, "queued")
        self.assertIsNotNone(response.raw_ingestion_id)
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(RawIngestion, response.raw_ingestion_id).sync_run_id,
                             response.sync_run_id)

    def test_cost_post_returns_committed_defaults_without_post_commit_sql(self):
        dataset_id = uuid4()
        self.db.add(Dataset(id=dataset_id, organization_id=self.org, name="orders", system="dbt"))
        self.db.commit()
        guard = self._deny_sql_after_commit()
        response = create_cost_snapshot(
            CostSnapshotCreate(
                dataset_id=dataset_id, period_start=self.end - timedelta(days=1),
                period_end=self.end, cost_amount=Decimal("1.25"), collected_at=self.end,
            ), self.access, self.db,
        )
        self.assertEqual((response.currency, response.cost_amount), ("USD", Decimal("1.25")))
        event.remove(self.engine, "before_cursor_execute", guard)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(CostSnapshot, response.id).cost_amount, Decimal("1.25"))

    def _legacy_fixture(self, status="success"):
        self.old_id, self.new_id, self.usage_id = uuid4(), uuid4(), uuid4()
        old = SyncRun(
            id=self.old_id, organization_id=self.org, connection_id=self.connection_id,
            requested_by=self.user, run_type="snowflake_query_usage_ingestion",
            status=status, queued_at=self.end - timedelta(hours=3),
            finished_at=self.end - timedelta(hours=2), details={"legacy_note": "retain"},
        )
        new = SyncRun(
            id=self.new_id, organization_id=self.org, connection_id=self.connection_id,
            requested_by=self.user, run_type="snowflake_query_usage_ingestion",
            status="running", queued_at=self.end,
            details={"period_start": (self.end - timedelta(days=1)).isoformat(),
                     "period_end": self.end.isoformat()},
        )
        dataset = Dataset(
            id=uuid4(), organization_id=self.org, name="orders", system="dbt",
            relation_name="DB.S.T", is_active=True,
        )
        usage = QueryUsage(
            id=self.usage_id, organization_id=self.org, connection_id=self.connection_id,
            sync_run_id=self.old_id, snowflake_query_id="one", query_hash="fixture",
            warehouse_name="WH_A", started_at=self.end - timedelta(hours=10),
            ended_at=self.end - timedelta(hours=9), compute_credits=Decimal("100"),
            acceleration_credits=Decimal("0"),
        )
        self.db.add_all([old, new, dataset, usage])
        self.db.flush()
        self.db.add(QueryDatasetAllocation(
            organization_id=self.org, query_usage_id=self.usage_id, dataset_id=dataset.id,
            allocation_weight=Decimal("1"), evidence_source="fixture",
        ))
        self.db.commit()
        return new

    def _pages(self, fail=False):
        yield [{
            "query_id": "one", "warehouse_name": "WH_A",
            "start_time": self.end - timedelta(hours=10),
            "end_time": self.end - timedelta(hours=9),
            "credits_attributed_compute": "200", "credits_used_query_acceleration": "0",
        }], {"one": {"objects_modified": {"DB.S.T"}}}, True
        if fail:
            raise RuntimeError("later page failed")

    def _sync(self, run, fail=False, ownership=lambda: None):
        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch("app.services.ingestion.iter_usage_pages",
                  side_effect=lambda *_: self._pages(fail)),
        ):
            return process_snowflake_sync(self.db, run, ownership)

    @staticmethod
    def _historical(response):
        values = response.model_dump(mode="json")
        values.pop("latest_attempt_status")
        return values

    def test_failed_overlap_preserves_legacy_report_and_retry_publishes_new_report(self):
        run = self._legacy_fixture()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))
        with self.assertRaisesRegex(RuntimeError, "later page failed"):
            self._sync(run, fail=True)
        self.db.rollback()
        run = self.db.get(SyncRun, self.new_id)
        run.status = "failed"
        self.db.commit()
        after = latest_snowflake_summaries(self.access, self.db)
        self.assertEqual(self._historical(after), before)
        self.assertEqual(after.latest_attempt_status, "failed")
        self.assertEqual(self.db.get(QueryUsage, self.usage_id).sync_run_id, self.new_id)
        self.assertNotIn("completed_through", self.db.get(SyncRun, self.new_id).details)
        old = self.db.get(SyncRun, self.old_id)
        self.assertEqual(old.details["legacy_note"], "retain")
        preserved = dict(old.details["published_summary"])

        run = self.db.get(SyncRun, self.new_id)
        run.status = "running"
        self.db.commit()
        result = self._sync(run)
        run = self.db.get(SyncRun, self.new_id)
        run.details = {**run.details,
                       "published_summary": build_credit_summary(
                           self.db, run, result["access_history_available"])}
        run.status = "success"
        run.finished_at = self.end
        self.db.commit()
        latest = latest_snowflake_summaries(self.access, self.db)
        self.assertEqual(latest.total_credits, Decimal("200"))
        self.assertEqual(latest.report_state, "frozen")
        self.assertEqual(self.db.query(QueryUsage).count(), 1)
        self.assertEqual(self.db.query(QueryDatasetAllocation).count(), 1)
        self.assertEqual(self.db.get(SyncRun, self.old_id).details["published_summary"], preserved)

    def test_successful_overlap_preserves_partial_legacy_report_without_bulk_freezing(self):
        run = self._legacy_fixture(status="partial")
        before = self._historical(latest_snowflake_summaries(self.access, self.db))
        untouched_id = uuid4()
        self.db.add(SyncRun(
            id=untouched_id, organization_id=self.org, connection_id=self.connection_id,
            requested_by=self.user, run_type="snowflake_query_usage_ingestion",
            status="success", finished_at=self.end - timedelta(days=10), details={},
        ))
        self.db.commit()
        self._sync(run)
        self.db.commit()
        self.assertEqual(self._historical(latest_snowflake_summaries(self.access, self.db)), before)
        self.assertEqual(self.db.get(SyncRun, untouched_id).details, {})

    def test_legacy_reader_handles_capture_committed_during_aggregation(self):
        self._legacy_fixture()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))

        def aggregate_after_writer_commit(db, organization_id, run_id):
            # The reader has already loaded the legacy run without a snapshot.
            # An independent ORM session commits the overlapping page before its aggregate.
            with _FixtureSession(self.engine, autoflush=False) as writer:
                with (
                    patch("app.services.ingestion.connection_kwargs", return_value={}),
                    patch("app.services.ingestion.iter_usage_pages",
                          side_effect=lambda *_: self._pages(fail=True)),
                    self.assertRaisesRegex(RuntimeError, "later page failed"),
                ):
                    process_snowflake_sync(
                        writer, writer.get(SyncRun, self.new_id), lambda: None
                    )
                writer.rollback()
            return build_legacy_credit_summary(db, organization_id, run_id)

        with patch("app.api.routes.ingestion.build_legacy_credit_summary",
                   side_effect=aggregate_after_writer_commit):
            after = latest_snowflake_summaries(self.access, self.db)
        self.assertEqual(self._historical(after), before)

    def test_existing_frozen_report_is_not_rewritten_by_overlap(self):
        run = self._legacy_fixture()
        old = self.db.get(SyncRun, self.old_id)
        old.details = {**old.details, "period_end": self.end.isoformat()}
        snapshot = build_credit_summary(self.db, old, True)
        old.details = {**old.details, "published_summary": snapshot}
        self.db.commit()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))
        with self.assertRaisesRegex(RuntimeError, "later page failed"):
            self._sync(run, fail=True)
        self.db.rollback()
        self.assertEqual(self._historical(latest_snowflake_summaries(self.access, self.db)), before)
        self.assertEqual(self.db.get(SyncRun, self.old_id).details["published_summary"], snapshot)

    def test_legacy_capture_preserves_all_rows_and_nullable_connection_metadata(self):
        run = self._legacy_fixture()
        old = self.db.get(SyncRun, self.old_id)
        old.connection_id = None
        dataset = self.db.query(Dataset).one()
        second_id = uuid4()
        self.db.add(QueryUsage(
            id=second_id, organization_id=self.org, connection_id=self.connection_id,
            sync_run_id=self.old_id, snowflake_query_id="two", query_hash="second",
            warehouse_name="WH_A", started_at=self.end - timedelta(hours=8),
            ended_at=self.end - timedelta(hours=7), compute_credits=Decimal("5"),
            acceleration_credits=None,
        ))
        self.db.add(QueryDatasetAllocation(
            organization_id=self.org, query_usage_id=second_id, dataset_id=dataset.id,
            allocation_weight=Decimal("1"), evidence_source="fixture",
        ))
        self.db.commit()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))
        self._sync(run)
        self.db.commit()
        after = latest_snowflake_summaries(self.access, self.db)
        self.assertEqual(self._historical(after), before)
        self.assertIsNone(after.connection_id)
        self.assertEqual(after.dataset_credit_summaries[0].total_credits_attributed_compute,
                         Decimal("105"))

    def test_failed_patch_does_not_return_a_response_or_commit(self):
        self.db.add(SnowflakeConnection(
            organization_id=self.org, name="Taken", account_identifier="org-account",
            role_name="ROLE", warehouse_name="WH_A", auth_method="key_pair",
            enabled=False,
        ))
        self.db.commit()
        with self.assertRaises(HTTPException) as error:
            update_connection(
                self.connection_id, SnowflakeConnectionUpdate(name="Taken"), self.access, self.db
            )
        self.assertEqual(error.exception.status_code, 409)
        with Session(self.engine) as reader:
            self.assertEqual(reader.get(SnowflakeConnection, self.connection_id).name, "Primary")

    def test_lost_ownership_rolls_back_legacy_capture_and_usage_update(self):
        run = self._legacy_fixture()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))

        def lost():
            raise RuntimeError("lost ownership")

        with self.assertRaisesRegex(RuntimeError, "lost ownership"):
            self._sync(run, ownership=lost)
        self.db.rollback()
        self.assertEqual(self._historical(latest_snowflake_summaries(self.access, self.db)), before)
        self.assertNotIn("published_summary", self.db.get(SyncRun, self.old_id).details)
        usage = self.db.get(QueryUsage, self.usage_id)
        self.assertEqual((usage.sync_run_id, usage.compute_credits), (self.old_id, Decimal("100")))

    def test_warehouse_can_change_before_history(self):
        response = update_connection(
            self.connection_id, SnowflakeConnectionUpdate(warehouse_name="WH_B"),
            self.access, self.db,
        )
        self.assertEqual((response.warehouse_name, response.status, response.enabled),
                         ("WH_B", "pending", False))

    def test_warehouse_cannot_change_after_usage_and_history_is_unchanged(self):
        self._legacy_fixture()
        # History requires a new connection even while another sync is active.
        self.connection.watermarks = {"query_attribution_history": self.end.isoformat()}
        self.db.commit()
        before = self._historical(latest_snowflake_summaries(self.access, self.db))
        with self.assertRaises(HTTPException) as error:
            update_connection(self.connection_id, SnowflakeConnectionUpdate(warehouse_name="WH_B"),
                              self.access, self.db)
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("new connection", error.exception.detail.lower())
        self.assertIn("warehouse", error.exception.detail.lower())
        self.db.rollback()
        self.assertEqual(self.db.get(SnowflakeConnection, self.connection_id).warehouse_name, "WH_A")
        self.assertEqual(self.db.get(QueryUsage, self.usage_id).warehouse_name, "WH_A")
        self.assertEqual(self.db.get(SnowflakeConnection, self.connection_id).watermarks,
                         {"query_attribution_history": self.end.isoformat()})
        self.assertEqual(self._historical(latest_snowflake_summaries(self.access, self.db)), before)

    def test_new_warehouse_connection_reports_exclude_original_history(self):
        self._legacy_fixture()
        other_connection, other_run = uuid4(), uuid4()
        self.db.add(SnowflakeConnection(
            id=other_connection, organization_id=self.org, name="Warehouse B",
            account_identifier="org-account", user_name="USER", role_name="ROLE",
            warehouse_name="WH_B", auth_method="key_pair", enabled=False,
            capabilities={"access_history": False},
        ))
        run = SyncRun(
            id=other_run, organization_id=self.org, connection_id=other_connection,
            requested_by=self.user, run_type="snowflake_query_usage_ingestion",
            status="success", details={"period_end": self.end.isoformat()},
        )
        self.db.add(run)
        self.db.add(QueryUsage(
            organization_id=self.org, connection_id=other_connection, sync_run_id=other_run,
            snowflake_query_id="one", query_hash="fixture-b", warehouse_name="WH_B",
            started_at=self.end - timedelta(hours=1), compute_credits=Decimal("3"),
            acceleration_credits=Decimal("0"),
        ))
        self.db.commit()
        summary = build_credit_summary(self.db, run, False)
        self.assertEqual((summary["query_count"], Decimal(summary["total_credits"])),
                         (1, Decimal("3")))
        original = self.db.get(QueryUsage, self.usage_id)
        self.assertEqual((original.connection_id, original.warehouse_name, original.compute_credits),
                         (self.connection_id, "WH_A", Decimal("100")))

    def test_warehouse_cannot_change_after_processed_empty_window(self):
        self.connection.watermarks = {"query_attribution_history": self.end.isoformat()}
        self.db.commit()
        with self.assertRaises(HTTPException) as error:
            update_connection(self.connection_id, SnowflakeConnectionUpdate(warehouse_name="WH_B"),
                              self.access, self.db)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.db.query(QueryUsage).count(), 0)

    def test_same_warehouse_rename_and_role_edit_keep_existing_rules(self):
        self._legacy_fixture()
        response = update_connection(
            self.connection_id, SnowflakeConnectionUpdate(warehouse_name="WH_A", name="Renamed"),
            self.access, self.db,
        )
        self.assertEqual((response.name, response.status, response.enabled), ("Renamed", "valid", True))
        with self.assertRaises(HTTPException) as error:
            update_connection(self.connection_id, SnowflakeConnectionUpdate(role_name="OTHER_ROLE"),
                              self.access, self.db)
        self.assertEqual(error.exception.status_code, 409)
        self.db.rollback()
        self.db.get(SyncRun, self.new_id).status = "failed"
        self.db.commit()
        response = update_connection(
            self.connection_id, SnowflakeConnectionUpdate(role_name="OTHER_ROLE"),
            self.access, self.db,
        )
        self.assertEqual((response.role_name, response.status, response.enabled),
                         ("OTHER_ROLE", "pending", False))


if __name__ == "__main__":
    unittest.main()
