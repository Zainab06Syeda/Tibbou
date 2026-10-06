import hashlib
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Callable

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.models.datasets import Dataset
from app.models.lineage_edges import LineageEdge
from app.models.query_usage import QueryDatasetAllocation, QueryUsage
from app.models.raw_ingestions import RawIngestion
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.services.snowflake import SnowflakeValidationError, connection_kwargs, iter_usage_pages

DBT_RESOURCE_TYPES = frozenset({"model", "source", "seed", "snapshot"})


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _dbt_resources(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    resources: dict[str, dict[str, Any]] = {}
    for collection_name in ("nodes", "sources"):
        for unique_id, node in (payload.get(collection_name) or {}).items():
            if not isinstance(node, dict) or node.get("resource_type") not in DBT_RESOURCE_TYPES:
                continue
            if node.get("name"):
                resources[unique_id] = node
    return resources


def _dbt_name(node: dict[str, Any]) -> str:
    if node.get("resource_type") == "source" and node.get("source_name"):
        return f"{node['source_name']}.{node['name']}"
    return str(node["name"])


def process_dbt_manifest(db: Session, sync_run: SyncRun, raw: RawIngestion) -> dict[str, int]:
    resources = _dbt_resources(raw.raw_payload or {})
    seen_at = utcnow()
    existing = {
        dataset.source_unique_id: dataset
        for dataset in db.query(Dataset)
        .filter(
            Dataset.organization_id == sync_run.organization_id,
            Dataset.system == "dbt",
            Dataset.source_unique_id.isnot(None),
        )
        .all()
    }

    datasets_by_unique_id: dict[str, Dataset] = {}
    datasets_created = 0
    for unique_id, node in resources.items():
        dataset = existing.get(unique_id)
        if dataset is None:
            dataset = Dataset(
                organization_id=sync_run.organization_id,
                system="dbt",
                source_unique_id=unique_id,
                name=_dbt_name(node),
            )
            db.add(dataset)
            datasets_created += 1

        dataset.name = _dbt_name(node)
        dataset.namespace = node.get("package_name") or node.get("source_name")
        dataset.database_name = node.get("database")
        dataset.schema_name = node.get("schema")
        dataset.object_name = node.get("alias") or node.get("identifier") or node.get("name")
        dataset.object_domain = node.get("resource_type")
        dataset.relation_name = node.get("relation_name")
        dataset.is_active = True
        dataset.last_seen_at = seen_at
        db.flush()
        datasets_by_unique_id[unique_id] = dataset

    active_ids = set(resources)
    datasets_deactivated = 0
    for unique_id, dataset in existing.items():
        if unique_id not in active_ids and dataset.is_active:
            dataset.is_active = False
            datasets_deactivated += 1

    existing_edges = {
        (edge.upstream_dataset_id, edge.downstream_dataset_id): edge
        for edge in db.query(LineageEdge)
        .filter(
            LineageEdge.organization_id == sync_run.organization_id,
            LineageEdge.provenance == "dbt_manifest",
        )
        .all()
    }
    previously_active_edge_keys = {
        key for key, edge in existing_edges.items() if edge.is_active
    }
    for edge in existing_edges.values():
        edge.is_active = False

    lineage_edges_processed = 0
    lineage_edges_created = 0
    active_edge_keys = set()
    for downstream_unique_id, node in resources.items():
        dependencies = (node.get("depends_on") or {}).get("nodes") or []
        if not isinstance(dependencies, list):
            continue
        downstream = datasets_by_unique_id[downstream_unique_id]
        for upstream_unique_id in dependencies:
            upstream = datasets_by_unique_id.get(upstream_unique_id)
            if upstream is None or upstream.id == downstream.id:
                continue
            lineage_edges_processed += 1
            key = (upstream.id, downstream.id)
            active_edge_keys.add(key)
            edge = existing_edges.get(key)
            if edge is None:
                edge = LineageEdge(
                    organization_id=sync_run.organization_id,
                    upstream_dataset_id=upstream.id,
                    downstream_dataset_id=downstream.id,
                    relationship_type="depends_on",
                    provenance="dbt_manifest",
                    confidence=Decimal("1"),
                )
                db.add(edge)
                existing_edges[key] = edge
                lineage_edges_created += 1
            edge.is_active = True
            edge.observed_at = seen_at

    lineage_edges_deactivated = len(previously_active_edge_keys - active_edge_keys)
    return {
        "datasets_processed": len(resources),
        "datasets_created": datasets_created,
        "datasets_deactivated": datasets_deactivated,
        "lineage_edges_processed": lineage_edges_processed,
        "lineage_edges_created": lineage_edges_created,
        "lineage_edges_deactivated": lineage_edges_deactivated,
    }


def _relation_parts(value: str, fold_unquoted: bool) -> tuple[str, ...]:
    parts: list[str] = []
    current = ""
    quoted = False
    was_quoted = False
    index = 0
    while index < len(value):
        char = value[index]
        if char == '"':
            if quoted and index + 1 < len(value) and value[index + 1] == '"':
                current += '"'
                index += 1
            else:
                quoted = not quoted
                was_quoted = True
        elif char == "." and not quoted:
            parts.append(current if was_quoted or not fold_unquoted else current.strip().upper())
            current = ""
            was_quoted = False
        else:
            current += char
        index += 1
    if quoted:
        return ()
    parts.append(current if was_quoted or not fold_unquoted else current.strip().upper())
    return tuple(parts) if all(parts) else ()


def usage_window(watermarks: dict, period_end: datetime) -> tuple[datetime, datetime]:
    watermark = watermarks.get("query_attribution_history")
    try:
        prior = datetime.fromisoformat(watermark) if watermark else None
    except (TypeError, ValueError):
        prior = None
    if prior is not None and prior.tzinfo is None:
        prior = prior.replace(tzinfo=timezone.utc)
    # Revisit the source latency window; malformed/future legacy metadata uses seven days.
    start = prior - timedelta(hours=8) if prior and prior <= period_end else period_end - timedelta(days=7)
    return start, period_end


def _dataset_relation_key(dataset: Dataset) -> tuple[str, ...] | None:
    if dataset.relation_name:
        parts = _relation_parts(dataset.relation_name, True)
        return parts if len(parts) == 3 else None
    if dataset.database_name and dataset.schema_name and dataset.object_name:
        parts = [_relation_parts(part, True) for part in (dataset.database_name, dataset.schema_name, dataset.object_name)]
        return tuple(part[0] for part in parts) if all(len(part) == 1 for part in parts) else None
    return None


def _equal_allocation_weights(count: int) -> list[Decimal]:
    if count < 1:
        return []
    base = Decimal("1") / Decimal(count)
    return [base] * (count - 1) + [Decimal("1") - base * Decimal(count - 1)]


def _matched_access_datasets(
    objects: dict[str, set[str]], datasets_by_relation: dict[tuple[str, ...], list[Dataset]]
) -> tuple[list[Dataset], str | None]:
    for tier in ("objects_modified", "direct_objects_accessed", "base_objects_accessed"):
        matches = {
            dataset.id: dataset
            for name in objects.get(tier, set())
            for dataset in datasets_by_relation.get(_relation_parts(name, False), [])
        }
        if matches:
            return [matches[key] for key in sorted(matches, key=str)], tier
    return [], None


def _connection_scope(connection: SnowflakeConnection) -> tuple:
    return tuple(getattr(connection, field).casefold() if field == "account_identifier" else getattr(connection, field) for field in (
        "account_identifier", "user_name", "role_name", "warehouse_name",
        "organization_id", "credential_provider", "secret_reference", "public_key_fingerprint", "key_pair_name",
    ))


def _assert_sync_connection(current: SnowflakeConnection | None, original: SnowflakeConnection) -> None:
    if (current is None or not current.enabled or current.status != "valid"
            or _connection_scope(current) != _connection_scope(original)):
        raise SnowflakeValidationError("Snowflake connection changed during synchronization")


def build_legacy_credit_summary(
    db: Session, organization_id, run_id
) -> dict[str, Any]:
    """Capture only the legacy response determinable from its existing rows."""
    rows = (
        db.query(
            Dataset.id, Dataset.name,
            func.sum(QueryUsage.compute_credits * QueryDatasetAllocation.allocation_weight),
            func.sum(QueryUsage.acceleration_credits * QueryDatasetAllocation.allocation_weight),
            func.count(QueryUsage.id.distinct()),
            func.min(QueryUsage.started_at), func.max(QueryUsage.ended_at),
        )
        .join(QueryDatasetAllocation, QueryDatasetAllocation.dataset_id == Dataset.id)
        .join(QueryUsage, QueryUsage.id == QueryDatasetAllocation.query_usage_id)
        .filter(
            Dataset.organization_id == organization_id,
            QueryUsage.sync_run_id == run_id,
            QueryUsage.organization_id == organization_id,
            QueryDatasetAllocation.organization_id == organization_id,
        )
        .group_by(Dataset.id, Dataset.name)
        .order_by(Dataset.name, Dataset.id)
        .all()
    )
    period_start = min((row[5] for row in rows if row[5]), default=None)
    period_end = max((row[6] for row in rows if row[6]), default=None)
    return {
        "report_state": "legacy",
        "period_start": period_start.isoformat() if period_start else None,
        "period_end": period_end.isoformat() if period_end else None,
        "dataset_credit_summary_count": len(rows),
        "dataset_credit_summaries": [
            {
                "dataset_id": str(row[0]), "dataset_name": row[1],
                "total_credits_attributed_compute": str(row[2]) if row[2] is not None else None,
                "total_credits_used_query_acceleration": str(row[3]) if row[3] is not None else None,
                "attributed_query_count": row[4],
                "period_start": row[5].isoformat() if row[5] else None,
                "period_end": row[6].isoformat() if row[6] else None,
            }
            for row in rows
        ],
    }


def _preserve_legacy_report(db: Session, organization_id, run_id) -> None:
    previous = db.query(SyncRun).filter(
        SyncRun.id == run_id,
        SyncRun.organization_id == organization_id,
        SyncRun.run_type == "snowflake_query_usage_ingestion",
        SyncRun.status.in_(["success", "partial"]),
    ).one_or_none()
    if previous is not None and not isinstance((previous.details or {}).get("published_summary"), dict):
        # Capture before the first overlapping upsert, in the same page transaction.
        # No reconstruction of missing history or bulk backfill of other runs.
        previous.details = {
            **(previous.details or {}),
            "published_summary": build_legacy_credit_summary(db, organization_id, run_id),
        }
        db.flush()


def process_snowflake_sync(
    db: Session, sync_run: SyncRun, assert_ownership: Callable[[], None]
) -> dict[str, int | bool]:
    """Persist one requested window in bounded pages; checkpoint only completed days."""
    organization_id = sync_run.organization_id
    requested_by = sync_run.requested_by
    sync_run_id = sync_run.id
    connection_id = sync_run.connection_id
    connection = db.get(SnowflakeConnection, sync_run.connection_id)
    if (connection is None or connection.organization_id != organization_id
            or not connection.enabled or connection.status != "valid"):
        raise RuntimeError("Snowflake connection is unavailable")

    details = sync_run.details or {}
    # Old queued runs only carried connection_id. Initialize the window once;
    # retries reuse it rather than moving the endpoint each time.
    if not details.get("period_start") or not details.get("period_end"):
        window_end = utcnow()
        window_start, window_end = usage_window(connection.watermarks or {}, window_end)
        assert_ownership()
        sync_run.details = details = {**details, "period_start": window_start.isoformat(),
                                     "period_end": window_end.isoformat(), "source_latency_hours": 8}
    else:
        window_start = datetime.fromisoformat(details["period_start"])
        window_end = datetime.fromisoformat(details["period_end"])
    if window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=timezone.utc)
    if window_end.tzinfo is None:
        window_end = window_end.replace(tzinfo=timezone.utc)
    if window_start >= window_end:
        raise RuntimeError("Invalid Snowflake usage window")
    snowflake_kwargs = connection_kwargs(db, connection)
    # Do not hold a PostgreSQL transaction open while Snowflake is queried.
    db.expunge(connection)
    db.commit()
    queries_created = int(details.get("queries_created", 0))
    allocations_created = int(details.get("allocations_created", 0))
    queries_processed = int(details.get("queries_processed", 0))
    access_history_available = bool((connection.capabilities or {}).get("access_history"))
    checkpoint = datetime.fromisoformat(details["completed_through"]) if details.get("completed_through") else window_start
    if checkpoint.tzinfo is None:
        checkpoint = checkpoint.replace(tzinfo=timezone.utc)
    if not window_start <= checkpoint <= window_end:
        raise RuntimeError("Invalid Snowflake ingestion checkpoint")
    chunk_start = checkpoint
    while chunk_start < window_end:
        chunk_end = min(chunk_start + timedelta(days=1), window_end)
        with closing(iter_usage_pages(connection, snowflake_kwargs, chunk_start, chunk_end)) as pages:
            for usage_rows, objects_by_query, page_access_history_available in pages:
                access_history_available &= page_access_history_available
                db.execute(text("select set_config('app.current_user_id', :user_id, true)"),
                           {"user_id": str(requested_by)})
                db.execute(text("select set_config('app.current_organization_id', :organization_id, true)"),
                           {"organization_id": str(organization_id)})
                datasets = db.query(Dataset).filter(
                    Dataset.organization_id == organization_id, Dataset.system == "dbt",
                    Dataset.is_active.is_(True)
                ).all()
                datasets_by_relation: dict[tuple[str, ...], list[Dataset]] = {}
                for dataset in datasets:
                    key = _dataset_relation_key(dataset)
                    if key is not None:
                        datasets_by_relation.setdefault(key, []).append(dataset)

                for row in usage_rows:
                    query_id = str(row["query_id"])
                    query_usage = db.query(QueryUsage).filter(
                        QueryUsage.organization_id == organization_id,
                        QueryUsage.connection_id == connection_id,
                        QueryUsage.snowflake_query_id == query_id,
                    ).one_or_none()
                    if query_usage is None:
                        query_usage = QueryUsage(
                            organization_id=organization_id, sync_run_id=sync_run_id,
                            connection_id=connection_id, snowflake_query_id=query_id,
                            query_hash=hashlib.sha256(query_id.encode()).hexdigest(),
                            warehouse_name=row.get("warehouse_name"), started_at=row["start_time"],
                        )
                        db.add(query_usage)
                        queries_created += 1
                    if query_usage.sync_run_id != sync_run_id:
                        _preserve_legacy_report(db, organization_id, query_usage.sync_run_id)
                    query_usage.sync_run_id = sync_run_id
                    query_usage.ended_at = row.get("end_time")
                    query_usage.compute_credits = Decimal(str(row["credits_attributed_compute"])) if row.get("credits_attributed_compute") is not None else None
                    acceleration = row.get("credits_used_query_acceleration")
                    query_usage.acceleration_credits = Decimal(str(acceleration or 0))
                    db.flush()
                    queries_processed += 1

                    if query_id not in objects_by_query:
                        if page_access_history_available:
                            db.query(QueryDatasetAllocation).filter(
                                QueryDatasetAllocation.query_usage_id == query_usage.id
                            ).delete(synchronize_session=False)
                        continue
                    db.query(QueryDatasetAllocation).filter(
                        QueryDatasetAllocation.query_usage_id == query_usage.id
                    ).delete(synchronize_session=False)
                    ordered_matches, tier = _matched_access_datasets(
                        objects_by_query[query_id], datasets_by_relation
                    )
                    if ordered_matches:
                        for dataset, weight in zip(
                            ordered_matches, _equal_allocation_weights(len(ordered_matches)), strict=True
                        ):
                            db.add(QueryDatasetAllocation(
                                organization_id=organization_id, query_usage_id=query_usage.id,
                                dataset_id=dataset.id, allocation_weight=weight,
                                evidence_source=f"snowflake_access_history:{tier}",
                            ))
                            allocations_created += 1

                assert_ownership()
                persisted_connection = db.query(SnowflakeConnection).filter(
                    SnowflakeConnection.id == connection_id,
                    SnowflakeConnection.organization_id == organization_id,
                ).populate_existing().with_for_update().one_or_none()
                _assert_sync_connection(persisted_connection, connection)
                db.commit()

        db.execute(text("select set_config('app.current_user_id', :user_id, true)"),
                   {"user_id": str(requested_by)})
        db.execute(text("select set_config('app.current_organization_id', :organization_id, true)"),
                   {"organization_id": str(organization_id)})
        assert_ownership()
        persisted_connection = db.query(SnowflakeConnection).filter(
            SnowflakeConnection.id == connection_id,
            SnowflakeConnection.organization_id == organization_id,
        ).populate_existing().with_for_update().one_or_none()
        _assert_sync_connection(persisted_connection, connection)
        prior_watermark = (persisted_connection.watermarks or {}).get("query_attribution_history")
        try:
            prior = datetime.fromisoformat(prior_watermark) if prior_watermark else chunk_end
            prior = prior.replace(tzinfo=prior.tzinfo or timezone.utc)
        except (ValueError, TypeError):
            prior = chunk_end
        persisted_connection.watermarks = {
            **(persisted_connection.watermarks or {}),
            "query_attribution_history": max(
                prior,
                chunk_end,
            ).isoformat(),
        }
        persisted_connection.capabilities = {
            **(persisted_connection.capabilities or {}),
            "access_history": access_history_available,
            "query_attribution_history": True,
            "mode": "full" if access_history_available else "partial",
        }
        run = db.get(SyncRun, sync_run_id)
        run.details = {
            **(run.details or {}), "completed_through": chunk_end.isoformat(),
            "queries_processed": queries_processed, "queries_created": queries_created,
            "allocations_created": allocations_created,
        }
        db.commit()
        chunk_start = chunk_end

    db.execute(text("select set_config('app.current_user_id', :user_id, true)"),
               {"user_id": str(requested_by)})
    db.execute(text("select set_config('app.current_organization_id', :organization_id, true)"),
               {"organization_id": str(organization_id)})
    assert_ownership()
    persisted_connection = db.query(SnowflakeConnection).filter(
        SnowflakeConnection.id == connection_id,
        SnowflakeConnection.organization_id == organization_id,
    ).populate_existing().with_for_update().one_or_none()
    _assert_sync_connection(persisted_connection, connection)
    persisted_connection.lifecycle_state = "active"
    persisted_connection.last_success_at = utcnow()
    return {
        "queries_processed": queries_processed,
        "queries_created": queries_created,
        "allocations_created": allocations_created,
        "access_history_available": access_history_available,
    }


CREDIT_QUANTUM = Decimal("0.000000001")


def _credit(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(CREDIT_QUANTUM, rounding=ROUND_DOWN)


def build_credit_summary(db: Session, run: SyncRun, access_history_available: bool) -> dict[str, Any]:
    """Freeze one completed seven-day report inside the successful run transaction."""
    period_end = datetime.fromisoformat(run.details["period_end"])
    period_start = period_end - timedelta(days=7)
    usage_filter = (
        QueryUsage.organization_id == run.organization_id,
        QueryUsage.connection_id == run.connection_id,
        QueryUsage.started_at >= period_start,
        QueryUsage.started_at < period_end,
    )
    query_count, compute, acceleration, observed_start, observed_end = db.query(
        func.count(QueryUsage.id), func.sum(QueryUsage.compute_credits),
        func.sum(QueryUsage.acceleration_credits), func.min(QueryUsage.started_at),
        func.max(QueryUsage.ended_at),
    ).filter(*usage_filter).one()
    connection = db.query(SnowflakeConnection).filter(SnowflakeConnection.id == run.connection_id, SnowflakeConnection.organization_id == run.organization_id).one()
    report = {
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "observed_start": observed_start.isoformat() if observed_start else None,
        "observed_end": observed_end.isoformat() if observed_end else None,
        "capabilities": dict(connection.capabilities or {}),
        "attribution_status": "available" if access_history_available else "unavailable",
        "credit_precision": str(CREDIT_QUANTUM),
        "query_count": query_count,
        "total_compute_credits": str(_credit(compute)) if query_count else None,
        "total_acceleration_credits": str(_credit(acceleration)) if query_count else None,
        "total_credits": str(_credit(compute) + _credit(acceleration)) if query_count else None,
        "attributed_query_count": None,
        "attribution_coverage": None,
        "allocated_credits": None,
        "unattributed_credits": None,
        "unavailable_attribution_credits": str(_credit(compute) + _credit(acceleration))
            if query_count and not access_history_available else None,
        "dataset_credit_summaries": [],
        "dataset_credit_summary_count": 0,
    }
    if not access_history_available or not query_count:
        return report

    rows = (
        db.query(
            Dataset.id, Dataset.name,
            func.sum(QueryUsage.compute_credits * QueryDatasetAllocation.allocation_weight),
            func.sum(QueryUsage.acceleration_credits * QueryDatasetAllocation.allocation_weight),
            func.count(QueryUsage.id.distinct()),
        )
        .join(QueryDatasetAllocation, QueryDatasetAllocation.dataset_id == Dataset.id)
        .join(QueryUsage, QueryUsage.id == QueryDatasetAllocation.query_usage_id)
        .filter(Dataset.organization_id == run.organization_id,
                QueryDatasetAllocation.organization_id == run.organization_id,
                Dataset.system == "dbt", *usage_filter)
        .group_by(Dataset.id, Dataset.name)
        .order_by(Dataset.name, Dataset.id)
        .all()
    )
    dataset_summaries = [
        {
            "dataset_id": str(row[0]), "dataset_name": row[1],
            "total_credits_attributed_compute": str(_credit(row[2])),
            "total_credits_used_query_acceleration": str(_credit(row[3])),
            "attributed_query_count": row[4],
            "period_start": report["period_start"], "period_end": report["period_end"],
        }
        for row in rows
    ]
    attributed_query_count = db.query(func.count(QueryUsage.id.distinct())).join(
        QueryDatasetAllocation, QueryDatasetAllocation.query_usage_id == QueryUsage.id
    ).join(Dataset, Dataset.id == QueryDatasetAllocation.dataset_id).filter(
        Dataset.organization_id == run.organization_id,
        QueryDatasetAllocation.organization_id == run.organization_id,
        Dataset.system == "dbt", *usage_filter
    ).scalar()
    allocated = sum(
        Decimal(item["total_credits_attributed_compute"])
        + Decimal(item["total_credits_used_query_acceleration"])
        for item in dataset_summaries
    )
    total = Decimal(report["total_credits"])
    if allocated > total:
        raise RuntimeError("Dataset allocations exceed reported query credits")
    report.update({
        "attributed_query_count": attributed_query_count,
        "attribution_coverage": str(Decimal(attributed_query_count) / Decimal(query_count)),
        "allocated_credits": str(allocated),
        "unattributed_credits": str(total - allocated),
        "unavailable_attribution_credits": None,
        "dataset_credit_summaries": dataset_summaries,
        "dataset_credit_summary_count": len(dataset_summaries),
    })
    return report
