import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from psycopg2.errors import UniqueViolation
from sqlalchemy.exc import IntegrityError

os.environ.setdefault("DATABASE_URL", "postgresql://localhost:5432/tibbou")

from app.api.routes.ingestion import _existing_run_after_idempotency_conflict
from app.services.ingestion import (
    _dbt_resources,
    _equal_allocation_weights,
    _fetch_snowflake_usage,
    _secret_env_prefix,
    process_dbt_manifest,
)


class _IdempotencyUniqueViolation(UniqueViolation):
    @property
    def diag(self):
        return SimpleNamespace(constraint_name="uq_sync_runs_org_idempotency")


class _FakeSnowflakeCursor:
    def __init__(self):
        self.description = []
        self.executions = []
        self._rows = []

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
            self._rows = [("query-1", "TEST_WH", None, None, 1, 0)]
        elif "access_history" in statement:
            self._rows = [("query-1", "DB.SCHEMA.TABLE")]
        else:
            self._rows = []
        return self

    def fetchall(self):
        return self._rows

    def close(self):
        return None


class _FakeSnowflakeConnection:
    def __init__(self):
        self.cursor_instance = _FakeSnowflakeCursor()

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

    def test_access_history_is_scoped_to_usage_query_ids_and_bounded(self):
        fake_connection = _FakeSnowflakeConnection()
        metadata = SimpleNamespace(warehouse_name="TEST_WH")
        with (
            patch("snowflake.connector.connect", return_value=fake_connection),
            patch("app.services.ingestion._snowflake_connection_kwargs", return_value={}),
        ):
            usage, object_names, available = _fetch_snowflake_usage(metadata)

        self.assertEqual([row["query_id"] for row in usage], ["query-1"])
        self.assertEqual(object_names, {"query-1": {"DB.SCHEMA.TABLE"}})
        self.assertTrue(available)
        access_statement, access_parameters = fake_connection.cursor_instance.executions[2]
        self.assertIn("relevant_query_ids", access_statement)
        self.assertIn("limit 10000", access_statement.lower())
        self.assertEqual(access_parameters, ('["query-1"]',))

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
            db, "organization", "idempotency-key", error
        )

        db.rollback.assert_called_once_with()
        self.assertIs(actual, expected)


if __name__ == "__main__":
    unittest.main()
