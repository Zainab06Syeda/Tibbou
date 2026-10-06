import os
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from psycopg2.errors import UniqueViolation
from sqlalchemy.exc import IntegrityError

os.environ.setdefault("DATABASE_URL", "postgresql://tibbou_api_login@localhost:5432/tibbou")

from app.api.routes.ingestion import (
    _existing_run_after_idempotency_conflict, latest_snowflake_summaries, usage_window,
)
from app.models.datasets import Dataset
from app.models.query_usage import QueryUsage
from app.models.snowflake_connections import SnowflakeConnection
from app.services.ingestion import (
    _dbt_resources,
    _dataset_relation_key,
    _equal_allocation_weights,
    _assert_sync_connection,
    _matched_access_datasets,
    build_credit_summary,
    process_dbt_manifest,
    process_snowflake_sync,
)
from app.schemas.ingestion import SyncRunRead
from app.services.snowflake import _secret_env_prefix, iter_usage_pages


class _IdempotencyUniqueViolation(UniqueViolation):
    @property
    def diag(self):
        return SimpleNamespace(constraint_name="uq_sync_runs_org_idempotency")


class _FakeSnowflakeCursor:
    def __init__(self, row_count=1):
        self.description = []
        self.executions = []
        self._rows = []
        self.row_count = row_count

    def execute(self, statement, parameters=None):
        self.executions.append((statement, parameters))
        if "query_attribution_history" in statement:
            self.description = [
                ("QUERY_ID",),
                ("WAREHOUSE_NAME",),
                ("START_TIME",),
                ("END_TIME",),
                ("CREDITS_ATTRIBUTED_COMPUTE",),
                ("CREDITS_USED_QUERY_ACCELERATION",),
            ]
            offset = int(parameters[-1].split("-")[-1]) + 1 if parameters[3] is not None else 0
            self._rows = [
                (f"query-{index:06}", "TEST_WH", datetime(2026, 9, 20, tzinfo=timezone.utc),
                 None, 1, 0)
                for index in range(offset, min(offset + 1000, self.row_count))
            ]
        elif "access_history" in statement:
            self._rows = [
                ("query-000000", '[{"objectName":"DB.Schema.Table"}]', "[]", "[]")
            ]
        else:
            self._rows = []
        return self

    def fetchall(self):
        return self._rows

    def close(self):
        return None


class _FakeSnowflakeConnection:
    def __init__(self, row_count=1):
        self.cursor_instance = _FakeSnowflakeCursor(row_count)

    def cursor(self):
        return self.cursor_instance

    def close(self):
        return None


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *args):
        return self

    def all(self):
        return self.rows


class _FakeDbtSession:
    def __init__(self, edges):
        self.edges = edges

    def query(self, model):
        return _FakeQuery(self.edges if model.__name__ == "LineageEdge" else [])


class IngestionTests(unittest.TestCase):
    def test_dbt_resources_include_supported_physical_resources(self):
        payload = {
            "nodes": {
                "model.pkg.orders": {"resource_type": "model", "name": "orders"},
                "seed.pkg.states": {"resource_type": "seed", "name": "states"},
                "test.pkg.orders": {"resource_type": "test", "name": "orders_unique"},
            },
            "sources": {
                "source.pkg.raw.orders": {"resource_type": "source", "name": "orders"}
            },
        }
        resources = _dbt_resources(payload)
        self.assertEqual(
            set(resources),
            {"model.pkg.orders", "seed.pkg.states", "source.pkg.raw.orders"},
        )

    def test_secret_reference_maps_to_bounded_environment_prefix(self):
        self.assertEqual(_secret_env_prefix("customer-one"), "SNOWFLAKE_SECRET_CUSTOMER_ONE_")

    def test_equal_allocation_weights_conserve_credits(self):
        weights = _equal_allocation_weights(3)
        self.assertEqual(sum(weights), 1)
        self.assertEqual(len(weights), 3)

    def test_initial_and_incremental_usage_windows(self):
        end = datetime(2026, 9, 24, tzinfo=timezone.utc)
        self.assertEqual(usage_window({}, end), (end - timedelta(days=7), end))
        watermark = end - timedelta(days=1)
        self.assertEqual(
            usage_window({"query_attribution_history": watermark.isoformat()}, end),
            (watermark - timedelta(hours=8), end),
        )

    def test_usage_pages_do_not_truncate_and_preserve_access_tiers(self):
        fake_connection = _FakeSnowflakeConnection(1001)
        metadata = SimpleNamespace(warehouse_name="TEST_WH", capabilities={"access_history": True})
        with patch("snowflake.connector.connect", return_value=fake_connection):
            pages = list(iter_usage_pages(
                metadata, {}, datetime(2026, 9, 20, tzinfo=timezone.utc),
                datetime(2026, 9, 21, tzinfo=timezone.utc),
            ))

        self.assertEqual([len(page[0]) for page in pages], [1000, 1])
        self.assertEqual(pages[0][1]["query-000000"]["objects_modified"], {"DB.Schema.Table"})
        self.assertTrue(all(page[2] for page in pages))
        access_statement, access_parameters = fake_connection.cursor_instance.executions[2]
        self.assertIn("relevant_query_ids", access_statement)
        self.assertNotIn("limit 10000", access_statement.lower())
        self.assertEqual(len(__import__("json").loads(access_parameters[0])), 1000)
        second_usage_statement, second_usage_parameters = fake_connection.cursor_instance.executions[3]
        self.assertIn("query_id > %s", second_usage_statement)
        self.assertEqual(second_usage_parameters[-1], "query-000999")

    def test_partial_mode_does_not_query_unavailable_access_history(self):
        fake_connection = _FakeSnowflakeConnection()
        metadata = SimpleNamespace(warehouse_name="TEST_WH", capabilities={"access_history": False})
        with patch("snowflake.connector.connect", return_value=fake_connection):
            pages = list(iter_usage_pages(
                metadata, {}, datetime(2026, 9, 20, tzinfo=timezone.utc),
                datetime(2026, 9, 21, tzinfo=timezone.utc),
            ))
        self.assertFalse(pages[0][2])
        self.assertEqual(pages[0][1], {})
        self.assertFalse(any(
            "access_history" in statement
            for statement, _ in fake_connection.cursor_instance.executions
        ))

    def test_quoted_relation_case_is_preserved(self):
        dataset = SimpleNamespace(relation_name='"DB"."Schema"."Table"')
        self.assertEqual(_dataset_relation_key(dataset), ("DB", "Schema", "Table"))
        self.assertNotEqual(_dataset_relation_key(dataset), ("DB", "SCHEMA", "TABLE"))

    def test_allocation_prefers_matched_modified_then_direct_then_base(self):
        modified = SimpleNamespace(id="modified")
        direct = SimpleNamespace(id="direct")
        base = SimpleNamespace(id="base")
        datasets = {
            ("DB", "Schema", "Modified"): [modified],
            ("DB", "Schema", "Direct"): [direct],
            ("DB", "Schema", "Base"): [base],
        }
        objects = {
            "objects_modified": {"DB.Schema.Modified"},
            "direct_objects_accessed": {"DB.Schema.Direct"},
            "base_objects_accessed": {"DB.Schema.Base"},
        }
        self.assertEqual(_matched_access_datasets(objects, datasets), ([modified], "objects_modified"))
        objects["objects_modified"] = {"DB.Schema.Unmatched"}
        self.assertEqual(_matched_access_datasets(objects, datasets), ([direct], "direct_objects_accessed"))
        objects["direct_objects_accessed"] = set()
        self.assertEqual(_matched_access_datasets(objects, datasets), ([base], "base_objects_accessed"))

    def test_dbt_deactivation_count_excludes_already_inactive_edges(self):
        active_edge = SimpleNamespace(
            upstream_dataset_id="upstream-active",
            downstream_dataset_id="downstream-active",
            is_active=True,
        )
        inactive_edge = SimpleNamespace(
            upstream_dataset_id="upstream-inactive",
            downstream_dataset_id="downstream-inactive",
            is_active=False,
        )
        result = process_dbt_manifest(
            _FakeDbtSession([active_edge, inactive_edge]),
            SimpleNamespace(organization_id="organization"),
            SimpleNamespace(raw_payload={}),
        )

        self.assertEqual(result["lineage_edges_deactivated"], 1)

    def test_idempotency_race_returns_the_committed_winner(self):
        expected = SimpleNamespace(id="winning-run", status="queued")
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = expected
        error = IntegrityError("insert", {}, _IdempotencyUniqueViolation())

        actual = _existing_run_after_idempotency_conflict(
            db, "organization", "idempotency-key", error, SimpleNamespace(id="user", email="user@example.test")
        )

        db.rollback.assert_called_once_with()
        self.assertIs(actual, expected)

    def test_failed_page_commit_cannot_change_published_report_and_retry_can_publish(self):
        start = datetime(2026, 9, 17, tzinfo=timezone.utc)
        end = start + timedelta(days=7)
        original_details = {"period_start": start.isoformat(), "period_end": end.isoformat()}
        connection = SimpleNamespace(
            id="connection-id", organization_id="organization-id", enabled=True,
            status="valid", account_identifier="ORG-ACCOUNT", user_name="USER",
            role_name="ROLE", warehouse_name="WH", credential_provider="supabase_vault",
            secret_reference="vault-id", public_key_fingerprint="fingerprint",
            key_pair_name="KEY", capabilities={"access_history": False}, watermarks={},
        )
        run = SimpleNamespace(
            id="run-id", organization_id="organization-id", requested_by="user-id",
            connection_id=connection.id, details=dict(original_details),
        )
        db = MagicMock()
        db.get.return_value = connection

        def query(model):
            result = MagicMock()
            if model is Dataset:
                result.filter.return_value.all.return_value = []
            elif model is QueryUsage:
                result.filter.return_value.one_or_none.return_value = None
            elif model is SnowflakeConnection:
                result.filter.return_value.populate_existing.return_value.with_for_update.return_value.one_or_none.return_value = connection
            else:
                self.fail(f"Unexpected model: {model}")
            return result

        db.query.side_effect = query
        row = {
            "query_id": "query-1", "start_time": start, "end_time": start + timedelta(minutes=1),
            "warehouse_name": "WH", "credits_attributed_compute": 1,
            "credits_used_query_acceleration": 0,
        }

        def pages(*_args):
            yield [row], {}, False
            raise RuntimeError("second page failed")

        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch("app.services.ingestion.iter_usage_pages", side_effect=pages),
            self.assertRaisesRegex(RuntimeError, "second page failed"),
        ):
            process_snowflake_sync(db, run, lambda: None)
        self.assertEqual(db.commit.call_count, 2)  # initial transaction and the first page
        self.assertEqual(run.details, original_details)
        self.assertIsInstance(db.add.call_args.args[0], QueryUsage)

        dataset_id = uuid4()
        old_report = {
            "period_start": start.isoformat(), "period_end": end.isoformat(),
            "observed_start": start.isoformat(), "observed_end": end.isoformat(),
            "capabilities": {"access_history": True}, "attribution_status": "available",
            "credit_precision": "0.000000001", "query_count": 1,
            "attributed_query_count": 1, "attribution_coverage": "1",
            "total_compute_credits": "1", "total_acceleration_credits": "0",
            "total_credits": "1", "allocated_credits": "1", "unattributed_credits": "0",
            "unavailable_attribution_credits": None,
            "dataset_credit_summaries": [{
                "dataset_id": str(dataset_id), "dataset_name": "orders",
                "total_credits_attributed_compute": "1",
                "total_credits_used_query_acceleration": "0",
                "attributed_query_count": 1,
                "period_start": start.isoformat(), "period_end": end.isoformat(),
            }],
            "dataset_credit_summary_count": 1,
        }
        published = SimpleNamespace(
            id=uuid4(), connection_id=uuid4(), status="success",
            details={"published_summary": old_report}, finished_at=end,
        )
        access = SimpleNamespace(organization_id=uuid4())

        def response_for(report_run, latest_status):
            report_db = MagicMock()
            queries = [MagicMock(), MagicMock()]
            report_db.query.side_effect = queries
            queries[0].filter.return_value.order_by.return_value.first.return_value = report_run
            queries[1].filter.return_value.order_by.return_value.first.return_value = (latest_status,)
            return latest_snowflake_summaries(access, report_db)

        failed_response = response_for(published, "failed")
        self.assertEqual(failed_response.total_credits, Decimal("1"))
        self.assertEqual(failed_response.dataset_credit_summaries[0].total_credits_attributed_compute, Decimal("1"))
        self.assertEqual(failed_response.latest_attempt_status, "failed")
        self.assertEqual(failed_response.status, "success")
        retry = SimpleNamespace(
            id=uuid4(), connection_id=published.connection_id, status="success",
            details={"published_summary": {**old_report, "total_compute_credits": "2",
                                           "total_credits": "2", "allocated_credits": "2",
                                           "dataset_credit_summaries": [{
                                               **old_report["dataset_credit_summaries"][0],
                                               "total_credits_attributed_compute": "2",
                                           }]}},
            finished_at=end + timedelta(hours=1),
        )
        retried_response = response_for(retry, "success")
        self.assertEqual(retried_response.total_credits, Decimal("2"))
        self.assertEqual(retried_response.allocated_credits, Decimal("2"))
        self.assertEqual(retried_response.dataset_credit_summaries[0].total_credits_attributed_compute, Decimal("2"))

    def test_frozen_report_reconciles_and_full_to_partial_hides_old_allocations(self):
        end = datetime(2026, 9, 24, tzinfo=timezone.utc)
        start = end - timedelta(days=7)
        run = SimpleNamespace(
            organization_id=uuid4(), connection_id=uuid4(),
            details={"period_end": end.isoformat()},
        )
        dataset_one, dataset_two = uuid4(), uuid4()

        def report_db():
            db = MagicMock()
            connection_query = MagicMock()
            connection_query.filter.return_value.one.return_value = SimpleNamespace(capabilities={"access_history": True})
            totals = MagicMock()
            totals.filter.return_value.one.return_value = (
                3, Decimal("2.0000000005"), Decimal("0"), start, end,
            )
            rows = MagicMock()
            rows.join.return_value = rows
            rows.filter.return_value = rows
            rows.group_by.return_value = rows
            rows.order_by.return_value.all.return_value = [
                (dataset_one, "one", Decimal("0.75"), Decimal("0"), 1),
                (dataset_two, "two", Decimal("0.75"), Decimal("0"), 1),
            ]
            allocated_count = MagicMock()
            allocated_count.join.return_value = allocated_count
            allocated_count.filter.return_value.scalar.return_value = 2
            db.query.side_effect = [totals, connection_query, rows, allocated_count]
            return db

        full = build_credit_summary(report_db(), run, True)
        self.assertEqual(full["total_credits"], "2.000000000")
        self.assertEqual(full["allocated_credits"], "1.500000000")
        self.assertEqual(full["unattributed_credits"], "0.500000000")
        self.assertEqual(full["attributed_query_count"], 2)
        self.assertEqual(full["dataset_credit_summary_count"], 2)
        self.assertEqual(
            Decimal(full["allocated_credits"]) + Decimal(full["unattributed_credits"]),
            Decimal(full["total_credits"]),
        )
        self.assertTrue(all(item["period_start"] == start.isoformat() for item in full["dataset_credit_summaries"]))

        partial_db = report_db()
        partial = build_credit_summary(partial_db, run, False)
        self.assertEqual(partial["attribution_status"], "unavailable")
        self.assertEqual(partial["unavailable_attribution_credits"], "2.000000000")
        self.assertIsNone(partial["allocated_credits"])
        self.assertIsNone(partial["unattributed_credits"])
        self.assertEqual(partial["dataset_credit_summaries"], [])
        self.assertEqual(partial_db.query.call_count, 2)

    def test_sync_status_marks_partial_window_complete_but_failed_run_incomplete(self):
        fields = dict(
            id=uuid4(), organization_id=uuid4(), connection_id=None,
            run_type="snowflake_query_usage_ingestion", queued_at=datetime.now(timezone.utc),
            started_at=None, finished_at=None, attempt_count=1, details={}, error=None,
        )
        self.assertTrue(SyncRunRead.model_validate(SimpleNamespace(**fields, status="partial")).is_complete)
        self.assertFalse(SyncRunRead.model_validate(SimpleNamespace(**fields, status="failed")).is_complete)

    def test_sync_rechecks_scope_and_disable_before_page_publication(self):
        original = SimpleNamespace(
            organization_id="organization-id", enabled=True, status="valid", account_identifier="ORG-ACCOUNT",
            user_name="USER", role_name="ROLE", warehouse_name="WH",
            credential_provider="supabase_vault", secret_reference="vault-id",
            public_key_fingerprint="fingerprint", key_pair_name="KEY",
        )
        for changed in (
            SimpleNamespace(**{**vars(original), "warehouse_name": "OTHER_WH"}),
            SimpleNamespace(**{**vars(original), "enabled": False}),
        ):
            with self.subTest(changed=vars(changed)), self.assertRaisesRegex(
                RuntimeError, "connection changed during synchronization"
            ):
                _assert_sync_connection(changed, original)
        _assert_sync_connection(SimpleNamespace(**vars(original)), original)

        start = datetime(2026, 9, 23, tzinfo=timezone.utc)
        source = SimpleNamespace(
            **vars(original), id="connection-id",
            capabilities={"access_history": False}, watermarks={},
        )
        run = SimpleNamespace(
            id="run-id", organization_id="organization-id", requested_by="user-id",
            connection_id=source.id,
            details={"period_start": start.isoformat(),
                     "period_end": (start + timedelta(days=1)).isoformat()},
        )
        db = MagicMock()
        db.get.return_value = source
        changed_connection = SimpleNamespace(**{**vars(source), "role_name": "OTHER_ROLE"})

        def query(model):
            result = MagicMock()
            if model is Dataset:
                result.filter.return_value.all.return_value = []
            elif model is QueryUsage:
                result.filter.return_value.one_or_none.return_value = None
            elif model is SnowflakeConnection:
                result.filter.return_value.populate_existing.return_value.with_for_update.return_value.one_or_none.return_value = changed_connection
            else:
                self.fail(f"Unexpected model: {model}")
            return result

        db.query.side_effect = query
        page = [dict(
            query_id="query-1", start_time=start, end_time=start + timedelta(minutes=1),
            warehouse_name="WH", credits_attributed_compute=1,
            credits_used_query_acceleration=0,
        )]
        def pages(*_args):
            yield page, {}, False

        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch("app.services.ingestion.iter_usage_pages", side_effect=pages),
            self.assertRaisesRegex(RuntimeError, "connection changed during synchronization"),
        ):
            process_snowflake_sync(db, run, lambda: None)
        self.assertEqual(db.commit.call_count, 1)  # no page or report committed


if __name__ == "__main__":
    unittest.main()
