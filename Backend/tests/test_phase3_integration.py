import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from snowflake.connector.errors import ProgrammingError

from app.api.routes.connections import disable_connection, update_connection
from app.api.routes.ingestion import enqueue_snowflake_sync, latest_snowflake_summaries
from app.models.datasets import Dataset
from app.models.query_usage import QueryUsage, QueryDatasetAllocation
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.schemas.connections import SnowflakeConnectionCreate, SnowflakeConnectionUpdate
from app.schemas.ingestion import (
    SnowflakeSyncRequest,
    LatestSnowflakeDatasetCreditSummariesResponse,
)
from app.services.ingestion import (
    process_snowflake_sync,
    _matched_access_datasets,
    _dataset_relation_key,
)
from app.services.snowflake import (
    iter_usage_pages,
    registration_sql,
    validate_connection,
    SnowflakeValidationError,
)
from test_ingestion import _FakeSnowflakeConnection
from test_snowflake_connections import _FakeCursor, _connection


class Phase3Tests(unittest.TestCase):
    def test_malformed_accounts_and_setup_identifiers_rejected_before_connect(self):
        fields = dict(
            name="Primary",
            account_identifier="ORG-ACCOUNT",
            user_name="user",
            role_name="role",
            warehouse_name="wh",
        )
        for value in (
            "https://org-account",
            "org-account.snowflakecomputing.com",
            "org/account",
            "org;drop",
            "org@account",
            "org..account",
            "org:443",
        ):
            with self.subTest(account=value), self.assertRaises(ValidationError):
                SnowflakeConnectionCreate(**{**fields, "account_identifier": value})
            with self.assertRaises(ValidationError):
                SnowflakeConnectionUpdate(account_identifier=value)
        self.assertEqual(
            SnowflakeConnectionCreate(**fields).account_identifier, "org-account"
        )
        for field in ("user_name", "role_name", "warehouse_name"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                SnowflakeConnectionCreate(**{**fields, field: 'bad";drop'})
        for name in ('bad";drop', "PUBLIC_KEY_1", "PUBLIC_KEY_2", ""):
            connection = _connection()
            connection.key_pair_name = name
            with (
                patch("snowflake.connector.connect") as connect,
                self.assertRaises(SnowflakeValidationError),
            ):
                validate_connection(MagicMock(), connection)
            connect.assert_not_called()
            with self.assertRaises(SnowflakeValidationError):
                registration_sql(connection)

    def test_wrong_identity_fingerprint_key_scope_status_and_expiry(self):
        for failure in (
            "role",
            "warehouse",
            "fingerprint",
            "key_name_case",
            "scope",
            "disabled",
            "expired",
            "expiry",
        ):
            cursor = _FakeCursor(
                "SHA256:wrong" if failure == "fingerprint" else "SHA256:test"
            )
            if failure == "key_name_case":
                cursor.key_name = "tibbou_key"
            execute = cursor.execute

            def altered(statement):
                result = execute(statement)
                if "current_account" in statement:
                    row = list(cursor.rows[0])
                    if failure == "role":
                        row[4] = "OTHER_ROLE"
                    if failure == "warehouse":
                        row[5] = "OTHER_WH"
                    cursor.rows = [tuple(row)]
                if statement.startswith("show user"):
                    row = list(cursor.rows[0])
                    if failure == "scope":
                        row[2] = "OTHER_ROLE"
                    if failure == "disabled":
                        row[3] = "DISABLED"
                    if failure == "expired":
                        row[3] = "EXPIRED"
                    if failure == "expiry":
                        row[4] = datetime(2020, 1, 1, tzinfo=timezone.utc)
                    cursor.rows = [tuple(row)]
                return result

            cursor.execute = altered
            remote = MagicMock()
            remote.cursor.return_value = cursor
            with (
                self.subTest(failure=failure),
                patch("app.services.snowflake.connection_kwargs", return_value={}),
                patch("snowflake.connector.connect", return_value=remote),
                self.assertRaises(SnowflakeValidationError) as error,
            ):
                validate_connection(MagicMock(), _connection())
            self.assertNotIn("OTHER", str(error.exception))
            self.assertNotIn("wrong", str(error.exception))
            self.assertTrue(cursor.closed)

    def test_disable_during_work_rejected_and_rename_preserves_validation(self):
        connection = SimpleNamespace(
            id=uuid4(),
            organization_id=uuid4(),
            name="Old",
            account_identifier="org-account",
            enabled=True,
            status="valid",
            lifecycle_state="active",
        )
        access = SimpleNamespace(organization_id=connection.organization_id)
        db = MagicMock()
        with (
            patch(
                "app.api.routes.connections._find_connection", return_value=connection
            ),
            patch("app.api.routes.connections._sync_is_active", return_value=True),
        ):
            with self.assertRaises(HTTPException) as error:
                disable_connection(connection.id, access, db)
            self.assertEqual(error.exception.status_code, 409)
            self.assertTrue(connection.enabled)
            with patch(
                "app.api.routes.connections._read_connection", return_value=connection
            ):
                update_connection(
                    connection.id, SnowflakeConnectionUpdate(name="New"), access, db
                )
            self.assertEqual(
                (connection.name, connection.status, connection.enabled),
                ("New", "valid", True),
            )

    def test_usage_pages_over_ten_thousand_exact_boundary_empty_and_partial(self):
        start = datetime(2026, 9, 20, tzinfo=timezone.utc)
        for count, lengths in ((0, []), (1000, [1000]), (10001, [1000] * 10 + [1])):
            remote = _FakeSnowflakeConnection(count)
            metadata = SimpleNamespace(
                warehouse_name="WH", capabilities={"access_history": False}
            )
            with patch("snowflake.connector.connect", return_value=remote):
                pages = list(
                    iter_usage_pages(metadata, {}, start, start + timedelta(days=1))
                )
            ids = [row["query_id"] for rows, _, _ in pages for row in rows]
            self.assertEqual([len(rows) for rows, _, _ in pages], lengths)
            self.assertEqual(len(ids), count)
            self.assertEqual(len(set(ids)), count)
            self.assertEqual(ids, [f"query-{index:06}" for index in range(count)])

    def test_required_attribution_error_fails_and_optional_history_error_is_partial(
        self,
    ):
        start = datetime(2026, 9, 20, tzinfo=timezone.utc)
        for required in (True, False):
            remote = _FakeSnowflakeConnection(1)
            execute = remote.cursor_instance.execute

            def altered(statement, parameters=None):
                if (
                    "query_attribution_history" if required else "access_history"
                ) in statement:
                    raise ProgrammingError(msg="restricted detail", sqlstate="42501")
                return execute(statement, parameters)

            remote.cursor_instance.execute = altered
            metadata = SimpleNamespace(
                warehouse_name="WH", capabilities={"access_history": True}
            )
            with patch("snowflake.connector.connect", return_value=remote):
                if required:
                    with self.assertRaisesRegex(
                        SnowflakeValidationError, "needs access"
                    ) as error:
                        list(
                            iter_usage_pages(
                                metadata, {}, start, start + timedelta(days=1)
                            )
                        )
                    self.assertNotIn("restricted detail", str(error.exception))
                else:
                    page = list(
                        iter_usage_pages(metadata, {}, start, start + timedelta(days=1))
                    )[0]
                    self.assertFalse(page[2])
                    self.assertEqual(page[1], {})

    def test_queue_without_dbt_and_concurrent_waiter_and_explicit_idempotency(self):
        org, connection_id, run_id = uuid4(), uuid4(), uuid4()
        connection = SimpleNamespace(
            id=connection_id,
            enabled=True,
            status="valid",
            watermarks={},
            capabilities={"query_attribution_history": True},
        )
        access = SimpleNamespace(
            organization_id=org,
            role="operator",
            user=SimpleNamespace(id=uuid4(), email="test@example.test"),
        )
        for mode in ("new", "waiter", "same-key", "other-key"):
            db = MagicMock()
            connection_query, active_query = MagicMock(), MagicMock()
            connection_query.filter.return_value.one_or_none.return_value = connection
            active_query.filter.return_value.first.return_value = (
                SimpleNamespace(id=run_id) if mode == "waiter" else None
            )
            db.query.side_effect = [connection_query, active_query]
            existing = SimpleNamespace(
                id=run_id,
                connection_id=connection_id,
                run_type="snowflake_query_usage_ingestion",
                status="queued",
            )
            if mode == "other-key":
                existing.connection_id = uuid4()
            lookups = (
                [None, existing] if mode in ("same-key", "other-key") else [None, None]
            )

            def add(run):
                run.id = run_id

            db.add.side_effect = add
            with (
                patch("app.api.routes.ingestion._existing_run", side_effect=lookups),
                self.subTest(mode=mode),
            ):
                if mode in ("waiter", "other-key"):
                    with self.assertRaises(HTTPException) as error:
                        enqueue_snowflake_sync(
                            SnowflakeSyncRequest(connection_id=connection_id),
                            "key",
                            access,
                            db,
                        )
                    self.assertEqual(error.exception.status_code, 409)
                    db.add.assert_not_called()
                else:
                    response = enqueue_snowflake_sync(
                        SnowflakeSyncRequest(connection_id=connection_id),
                        "key",
                        access,
                        db,
                    )
                    self.assertEqual(response.sync_run_id, run_id)
                    self.assertEqual(db.add.call_count, int(mode == "new"))
                db.refresh.assert_called_once_with(connection)
                self.assertIn(
                    "pg_advisory_xact_lock", str(db.execute.call_args.args[0])
                )
                self.assertIn(str(org), db.execute.call_args.args[1]["scope"])
                self.assertTrue(
                    all(
                        call.args[0] in (SnowflakeConnection, SyncRun)
                        for call in db.query.call_args_list
                    )
                )

    def test_cross_org_queue_connection_is_hidden(self):
        db = MagicMock()
        db.query.return_value.filter.return_value.one_or_none.return_value = None
        access = SimpleNamespace(organization_id=uuid4())
        connection_id = uuid4()
        with self.assertRaises(HTTPException) as error:
            enqueue_snowflake_sync(
                SnowflakeSyncRequest(connection_id=connection_id), "key", access, db
            )
        self.assertEqual(error.exception.status_code, 404)
        parameters = [
            arg.right.value for arg in db.query.return_value.filter.call_args.args
        ]
        self.assertEqual(parameters, [connection_id, access.organization_id])
        db.refresh.assert_not_called()

    def test_legacy_completed_reports_remain_readable_as_numbers_and_nullable_periods(
        self,
    ):
        org, run_id, dataset_id = uuid4(), uuid4(), uuid4()
        run = SimpleNamespace(
            id=run_id,
            connection_id=None,
            status="success",
            details={},
            finished_at=None,
        )
        for rows in (
            [],
            [(dataset_id, "old", Decimal("0.1"), Decimal("0.2"), 1, None, None)],
        ):
            db = MagicMock()
            run_query, rows_query = MagicMock(), MagicMock()
            run_query.filter.return_value.order_by.return_value.first.return_value = run
            rows_query.join.return_value = rows_query
            rows_query.filter.return_value = rows_query
            rows_query.group_by.return_value = rows_query
            rows_query.order_by.return_value.all.return_value = rows
            db.query.side_effect = [run_query, rows_query]
            response = latest_snowflake_summaries(
                SimpleNamespace(organization_id=org), db
            )
            result = json.loads(response.model_dump_json())
            self.assertEqual(result["report_state"], "legacy")
            self.assertIsNone(result["period_start"])
            self.assertEqual(result["dataset_credit_summary_count"], len(rows))
            if rows:
                self.assertIsInstance(
                    result["dataset_credit_summaries"][0][
                        "total_credits_attributed_compute"
                    ],
                    float,
                )
            db.commit.assert_not_called()
        old_shape = dict(
            sync_run_id=run_id,
            status="success",
            period_start=None,
            period_end=None,
            dataset_credit_summaries=[],
            dataset_credit_summary_count=0,
        )
        self.assertEqual(
            LatestSnowflakeDatasetCreditSummariesResponse(**old_shape).model_dump(
                mode="json"
            )["dataset_credit_summaries"],
            [],
        )

    def test_matching_rejects_malformed_and_unmatched_evidence(self):
        for relation in ('"DB"."S"."T', "DB..T", "DB.S.T.EXTRA"):
            self.assertIsNone(
                _dataset_relation_key(SimpleNamespace(relation_name=relation))
            )
        self.assertEqual(
            _matched_access_datasets({"objects_modified": {"OTHER.S.T"}}, {}),
            ([], None),
        )

    def test_legacy_queue_failed_page_retry_day_checkpoint_and_no_dbt_allocation(self):
        org, connection_id, run_id = uuid4(), uuid4(), uuid4()
        start = datetime(2026, 9, 20, tzinfo=timezone.utc)
        connection = SimpleNamespace(
            id=connection_id,
            organization_id=org,
            enabled=True,
            status="valid",
            account_identifier="org-account",
            user_name="USER",
            role_name="ROLE",
            warehouse_name="WH",
            credential_provider="supabase_vault",
            secret_reference="secret-ref",
            public_key_fingerprint="fingerprint",
            key_pair_name="KEY",
            capabilities={"access_history": True},
            watermarks={},
        )
        run = SimpleNamespace(
            id=run_id,
            organization_id=org,
            connection_id=connection_id,
            requested_by=uuid4(),
            details={"connection_id": str(connection_id)},
        )
        # A persistent mocked table retains only pages whose commit succeeded.
        usage = {}
        committed = {}
        db = MagicMock()
        db.get.side_effect = (
            lambda model, key: connection if model is SnowflakeConnection else run
        )

        def query(model):
            result = MagicMock()
            if model is Dataset:
                result.filter.return_value.all.return_value = []
            elif model is QueryUsage:

                def filtered(*conditions):
                    params = [condition.right.value for condition in conditions]
                    self.assertEqual(params[:2], [org, connection_id])
                    lookup = MagicMock()
                    lookup.one_or_none.return_value = usage.get(params[2])
                    return lookup

                result.filter.side_effect = filtered
            elif model is SnowflakeConnection:
                result.filter.return_value.populate_existing.return_value.with_for_update.return_value.one_or_none.return_value = connection
            elif model is QueryDatasetAllocation:
                pass
            else:
                self.fail(f"Unexpected model {model}")
            return result

        db.query.side_effect = query

        def add(item):
            self.assertIsInstance(
                item, QueryUsage
            )  # no dbt -> no fabricated allocation
            item.id = uuid4()
            usage[item.snowflake_query_id] = item

        db.add.side_effect = add
        db.commit.side_effect = lambda: committed.update(copy.deepcopy(usage))
        row = dict(
            query_id="one",
            warehouse_name="WH",
            start_time=start,
            end_time=start + timedelta(minutes=1),
            credits_attributed_compute="0.1",
            credits_used_query_acceleration="0.2",
        )

        def failed(*args):
            yield [row], {"one": {"objects_modified": {"DB.S.T"}}}, True
            raise RuntimeError("page failed")

        end = start + timedelta(days=7)
        with (
            patch("app.services.ingestion.utcnow", return_value=end),
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch("app.services.ingestion.iter_usage_pages", side_effect=failed),
            self.assertRaisesRegex(RuntimeError, "page failed"),
        ):
            process_snowflake_sync(db, run, lambda: None)
        self.assertEqual(len(committed), 1)
        self.assertNotIn("completed_through", run.details)
        self.assertNotIn("query_attribution_history", connection.watermarks)
        self.assertNotIn("published_summary", run.details)
        window = (run.details["period_start"], run.details["period_end"])

        def resumed(*args):
            if args[2] == start:
                yield [row], {"one": {"objects_modified": {"DB.S.T"}}}, True

        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch(
                "app.services.ingestion.iter_usage_pages", side_effect=resumed
            ) as pages,
        ):
            process_snowflake_sync(db, run, lambda: None)
        self.assertEqual(len(committed), 1)
        self.assertEqual(
            committed["one"].compute_credits + committed["one"].acceleration_credits,
            Decimal("0.3"),
        )
        self.assertEqual(
            (run.details["period_start"], run.details["period_end"]), window
        )
        self.assertEqual(run.details["completed_through"], end.isoformat())
        self.assertEqual(
            connection.watermarks["query_attribution_history"], end.isoformat()
        )
        self.assertEqual(pages.call_count, 7)
        # A completed checkpoint avoids fetching the same days on worker resume.
        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch("app.services.ingestion.iter_usage_pages") as pages,
        ):
            process_snowflake_sync(db, run, lambda: None)
        pages.assert_not_called()

    def test_checkpoint_resume_starts_at_the_last_committed_day(self):
        start = datetime(2026, 9, 20, tzinfo=timezone.utc)
        checkpoint = start + timedelta(days=2)
        end = start + timedelta(days=3)
        connection = SimpleNamespace(
            id=uuid4(),
            organization_id=uuid4(),
            enabled=True,
            status="valid",
            account_identifier="org-account",
            user_name="USER",
            role_name="ROLE",
            warehouse_name="WH",
            credential_provider="supabase_vault",
            secret_reference="ref",
            public_key_fingerprint="fingerprint",
            key_pair_name="KEY",
            capabilities={"access_history": False},
            watermarks={},
        )
        run = SimpleNamespace(
            id=uuid4(),
            organization_id=connection.organization_id,
            connection_id=connection.id,
            requested_by=uuid4(),
            details={
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
                "completed_through": checkpoint.isoformat(),
                "queries_processed": 7,
            },
        )
        db = MagicMock()
        db.get.side_effect = (
            lambda model, key: connection if model is SnowflakeConnection else run
        )
        db.query.return_value.filter.return_value.populate_existing.return_value.with_for_update.return_value.one_or_none.return_value = connection

        def pages(*args):
            self.assertEqual((args[2], args[3]), (checkpoint, end))
            return
            yield

        with (
            patch("app.services.ingestion.connection_kwargs", return_value={}),
            patch(
                "app.services.ingestion.iter_usage_pages", side_effect=pages
            ) as fetch,
        ):
            result = process_snowflake_sync(db, run, lambda: None)
        fetch.assert_called_once()
        self.assertEqual(result["queries_processed"], 7)
        self.assertEqual(run.details["completed_through"], end.isoformat())
        self.assertNotIn(
            "published_summary", run.details
        )  # publication belongs to the worker

    def test_account_case_normalization_does_not_change_validated_scope(self):
        connection = SimpleNamespace(
            id=uuid4(), account_identifier="ORG-ACCOUNT", enabled=True, status="valid"
        )
        access = SimpleNamespace(organization_id=uuid4())
        db = MagicMock()
        with (
            patch(
                "app.api.routes.connections._find_connection", return_value=connection
            ),
            patch("app.api.routes.connections._sync_is_active", return_value=True),
            patch(
                "app.api.routes.connections._read_connection", return_value=connection
            ),
        ):
            update_connection(
                connection.id,
                SnowflakeConnectionUpdate(account_identifier="org-account"),
                access,
                db,
            )
        self.assertEqual(connection.account_identifier, "org-account")
        self.assertTrue(connection.enabled)
        self.assertEqual(connection.status, "valid")
        db.query.assert_not_called()
