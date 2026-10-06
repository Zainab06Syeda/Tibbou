import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.datasets import Dataset
from app.models.lineage_edges import LineageEdge
from app.models.query_usage import QueryDatasetAllocation, QueryUsage
from app.models.raw_ingestions import RawIngestion
from app.models.snowflake_connections import SnowflakeConnection
from app.models.sync_runs import SyncRun
from app.services.snowflake import connection_kwargs, fetch_usage

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


def _dataset_relation_key(dataset: Dataset) -> str | None:
    if dataset.relation_name:
        return dataset.relation_name.replace('"', "").upper()
    if dataset.database_name and dataset.schema_name and dataset.object_name:
        return f"{dataset.database_name}.{dataset.schema_name}.{dataset.object_name}".upper()
    return None


def _equal_allocation_weights(count: int) -> list[Decimal]:
    if count < 1:
        return []
    base = Decimal("1") / Decimal(count)
    return [base] * (count - 1) + [Decimal("1") - base * Decimal(count - 1)]


def process_snowflake_sync(db: Session, sync_run: SyncRun) -> dict[str, int | bool]:
    organization_id = sync_run.organization_id
    requested_by = sync_run.requested_by
    sync_run_id = sync_run.id
    connection_id = sync_run.connection_id
    connection = db.get(SnowflakeConnection, sync_run.connection_id)
    if connection is None or connection.organization_id != organization_id:
        raise RuntimeError("Snowflake connection is unavailable")

    snowflake_kwargs = connection_kwargs(db, connection)
    # Do not hold a PostgreSQL transaction open while Snowflake is queried.
    db.expunge(connection)
    db.commit()
    usage_rows, objects_by_query, access_history_available = fetch_usage(
        connection, snowflake_kwargs
    )
    db.execute(
        text("select set_config('app.current_user_id', :user_id, true)"),
        {"user_id": str(requested_by)},
    )
    db.execute(
        text("select set_config('app.current_organization_id', :organization_id, true)"),
        {"organization_id": str(organization_id)},
    )
    persisted_connection = db.get(SnowflakeConnection, connection_id)
    if persisted_connection is None:
        raise RuntimeError("Snowflake connection was removed during synchronization")
    datasets = (
        db.query(Dataset)
        .filter(Dataset.organization_id == organization_id, Dataset.is_active.is_(True))
        .all()
    )
    datasets_by_relation = {
        relation: dataset
        for dataset in datasets
        if (relation := _dataset_relation_key(dataset)) is not None
    }

    queries_created = 0
    allocations_created = 0
    for row in usage_rows:
        query_id = str(row["query_id"])
        query_usage = (
            db.query(QueryUsage)
            .filter(
                QueryUsage.organization_id == organization_id,
                QueryUsage.connection_id == connection_id,
                QueryUsage.snowflake_query_id == query_id,
            )
            .one_or_none()
        )
        if query_usage is None:
            query_usage = QueryUsage(
                organization_id=organization_id,
                sync_run_id=sync_run_id,
                connection_id=connection_id,
                snowflake_query_id=query_id,
                query_hash=hashlib.sha256(query_id.encode()).hexdigest(),
                warehouse_name=row.get("warehouse_name"),
                started_at=row["start_time"],
            )
            db.add(query_usage)
            queries_created += 1
        query_usage.sync_run_id = sync_run_id
        query_usage.ended_at = row.get("end_time")
        query_usage.compute_credits = row.get("credits_attributed_compute")
        query_usage.acceleration_credits = row.get("credits_used_query_acceleration")
        db.flush()

        db.query(QueryDatasetAllocation).filter(
            QueryDatasetAllocation.query_usage_id == query_usage.id
        ).delete(synchronize_session=False)
        matched = {
            datasets_by_relation[name]
            for name in objects_by_query.get(query_id, set())
            if name in datasets_by_relation
        }
        if matched:
            ordered_matches = sorted(matched, key=lambda dataset: str(dataset.id))
            for dataset, weight in zip(
                ordered_matches, _equal_allocation_weights(len(ordered_matches)), strict=True
            ):
                db.add(
                    QueryDatasetAllocation(
                        organization_id=organization_id,
                        query_usage_id=query_usage.id,
                        dataset_id=dataset.id,
                        allocation_weight=weight,
                        evidence_source="snowflake_access_history",
                    )
                )
                allocations_created += 1

    persisted_connection.capabilities = {
        **(persisted_connection.capabilities or {}),
        "access_history": access_history_available,
        "query_attribution_history": True,
    }
    persisted_connection.status = "valid"
    persisted_connection.lifecycle_state = "active"
    persisted_connection.enabled = True
    persisted_connection.last_success_at = utcnow()
    return {
        "queries_processed": len(usage_rows),
        "queries_created": queries_created,
        "allocations_created": allocations_created,
        "access_history_available": access_history_available,
    }
