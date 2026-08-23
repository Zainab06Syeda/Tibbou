"""add tenancy, authorization, and normalized ingestion tables

Revision ID: 20260818_120000
Revises: 20260408_203100
Create Date: 2026-08-18 12:00:00

This is the expand/security stage. Existing rows keep every value and temporarily
have a null organization_id. NOT VALID checks reject new unowned rows without
inventing ownership for legacy data. A later authorized backfill must validate
the checks before organization_id is made NOT NULL.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260818_120000"
down_revision = "20260408_203100"
branch_labels = None
depends_on = None

LEGACY_BUSINESS_TABLES = (
    "datasets", "lineage_edges", "cost_snapshots", "raw_ingestions", "sync_runs",
)
BUSINESS_TABLES = LEGACY_BUSINESS_TABLES + (
    "snowflake_connections", "query_usage", "query_dataset_allocations",
)


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["auth.users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_index("ix_organizations_created_by", "organizations", ["created_by"])

    op.create_table(
        "organization_memberships",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.Text(), server_default=sa.text("'viewer'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "role in ('owner', 'admin', 'operator', 'viewer')",
            name="ck_organization_memberships_role",
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["user_id"], ["auth.users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_memberships_org_user"),
    )
    op.create_index(
        "ix_memberships_user_org_role",
        "organization_memberships",
        ["user_id", "organization_id", "role"],
    )

    op.create_table(
        "snowflake_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("account_identifier", sa.Text(), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column("role_name", sa.Text(), nullable=False),
        sa.Column("warehouse_name", sa.Text(), nullable=False),
        sa.Column("auth_method", sa.Text(), nullable=False),
        sa.Column("secret_reference", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("capabilities", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("watermarks", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("last_validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "auth_method in ('external_oauth', 'workload_identity', 'key_pair')",
            name="ck_snowflake_connections_auth_method",
        ),
        sa.CheckConstraint(
            "status in ('pending', 'valid', 'invalid', 'disabled')",
            name="ck_snowflake_connections_status",
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "name", name="uq_snowflake_connections_org_name"),
    )
    op.create_index("ix_snowflake_connections_org", "snowflake_connections", ["organization_id"])

    # Expand first. NOT VALID constraints protect new writes while allowing the
    # separately authorized legacy backfill to happen later.
    for table_name in LEGACY_BUSINESS_TABLES:
        op.add_column(
            table_name,
            sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.create_foreign_key(
            f"fk_{table_name}_organization_id",
            table_name,
            "organizations",
            ["organization_id"],
            ["id"],
            ondelete="RESTRICT",
            postgresql_not_valid=True,
        )
        op.create_index(f"ix_{table_name}_organization_id", table_name, ["organization_id"])

    for name, type_ in (
        ("source_unique_id", sa.Text()), ("account_name", sa.Text()),
        ("database_name", sa.Text()), ("schema_name", sa.Text()),
        ("object_name", sa.Text()), ("object_domain", sa.Text()),
        ("relation_name", sa.Text()), ("last_seen_at", sa.DateTime(timezone=True)),
    ):
        op.add_column("datasets", sa.Column(name, type_, nullable=True))
    op.add_column(
        "datasets",
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.create_unique_constraint(
        "uq_datasets_org_source_id",
        "datasets",
        ["organization_id", "system", "source_unique_id"],
    )
    op.create_index(
        "ix_datasets_org_active_created",
        "datasets",
        ["organization_id", "is_active", "created_at"],
    )
    op.create_index(
        "ix_datasets_physical_identity",
        "datasets",
        ["organization_id", "account_name", "database_name", "schema_name", "object_name"],
    )

    op.drop_constraint(
        "uq_lineage_edges_upstream_downstream_relationship",
        "lineage_edges",
        type_="unique",
    )
    op.add_column(
        "lineage_edges",
        sa.Column("provenance", sa.Text(), server_default=sa.text("'manual'"), nullable=False),
    )
    op.add_column(
        "lineage_edges",
        sa.Column("confidence", sa.Numeric(), server_default=sa.text("1"), nullable=False),
    )
    op.add_column(
        "lineage_edges",
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column(
        "lineage_edges",
        sa.Column("observed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_check_constraint(
        "ck_lineage_edges_not_self",
        "lineage_edges",
        "upstream_dataset_id <> downstream_dataset_id",
        postgresql_not_valid=True,
    )
    op.create_check_constraint(
        "ck_lineage_edges_confidence",
        "lineage_edges",
        "confidence >= 0 and confidence <= 1",
    )
    op.create_unique_constraint(
        "uq_lineage_edges_upstream_downstream_relationship",
        "lineage_edges",
        ["upstream_dataset_id", "downstream_dataset_id", "relationship_type", "provenance"],
    )
    op.create_index("ix_lineage_upstream", "lineage_edges", ["upstream_dataset_id"])
    op.create_index("ix_lineage_downstream", "lineage_edges", ["downstream_dataset_id"])
    op.create_index("ix_lineage_org_active", "lineage_edges", ["organization_id", "is_active"])

    op.create_check_constraint(
        "ck_cost_snapshots_period",
        "cost_snapshots",
        "period_end > period_start",
        postgresql_not_valid=True,
    )
    op.create_check_constraint(
        "ck_cost_snapshots_nonnegative",
        "cost_snapshots",
        "cost_amount >= 0 and (usage_amount is null or usage_amount >= 0)",
        postgresql_not_valid=True,
    )
    op.create_index("ix_cost_snapshots_dataset", "cost_snapshots", ["dataset_id"])
    op.create_index(
        "ix_cost_snapshots_org_collected",
        "cost_snapshots",
        ["organization_id", "collected_at"],
    )

    op.add_column("sync_runs", sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("sync_runs", sa.Column("requested_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("sync_runs", sa.Column("queued_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "sync_runs",
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column("sync_runs", sa.Column("idempotency_key", sa.Text(), nullable=True))
    op.execute("update sync_runs set queued_at = coalesce(started_at, now())")
    op.alter_column("sync_runs", "queued_at", nullable=False, server_default=sa.text("now()"))
    op.alter_column("sync_runs", "started_at", nullable=True)
    op.create_foreign_key(
        "fk_sync_runs_connection_id",
        "sync_runs",
        "snowflake_connections",
        ["connection_id"],
        ["id"],
        ondelete="SET NULL",
        postgresql_not_valid=True,
    )
    op.create_foreign_key(
        "fk_sync_runs_requested_by",
        "sync_runs",
        "users",
        ["requested_by"],
        ["id"],
        referent_schema="auth",
        ondelete="SET NULL",
        postgresql_not_valid=True,
    )
    op.create_unique_constraint(
        "uq_sync_runs_org_idempotency",
        "sync_runs",
        ["organization_id", "idempotency_key"],
    )
    op.create_check_constraint(
        "ck_sync_runs_status",
        "sync_runs",
        "status in ('queued', 'running', 'success', 'failed', 'partial', 'cancelled')",
        postgresql_not_valid=True,
    )
    op.create_index("ix_sync_runs_queue", "sync_runs", ["status", "queued_at"])
    op.create_index("ix_sync_runs_connection", "sync_runs", ["connection_id"])
    op.create_index("ix_sync_runs_requested_by", "sync_runs", ["requested_by"])

    op.add_column("raw_ingestions", sa.Column("sync_run_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("raw_ingestions", sa.Column("artifact_hash", sa.Text(), nullable=True))
    op.execute(
        "update raw_ingestions r set sync_run_id = s.id from sync_runs s "
        "where s.details->>'raw_ingestion_id' = r.id::text and r.sync_run_id is null"
    )
    op.create_foreign_key(
        "fk_raw_ingestions_sync_run_id",
        "raw_ingestions",
        "sync_runs",
        ["sync_run_id"],
        ["id"],
        ondelete="RESTRICT",
        postgresql_not_valid=True,
    )
    op.create_index("ix_raw_ingestions_sync_run", "raw_ingestions", ["sync_run_id"])
    op.create_index(
        "ix_raw_ingestions_org_type_time",
        "raw_ingestions",
        ["organization_id", "source_system", "ingestion_type", "ingested_at"],
    )
    op.create_check_constraint(
        "ck_raw_ingestions_status",
        "raw_ingestions",
        "status in ('queued', 'running', 'success', 'failed', 'partial')",
        postgresql_not_valid=True,
    )

    # Add these after all migration-owned updates. A NOT VALID check still
    # applies to rows touched after creation, even when they predate it.
    for table_name in LEGACY_BUSINESS_TABLES:
        op.create_check_constraint(
            f"ck_{table_name}_organization_required",
            table_name,
            "organization_id is not null",
            postgresql_not_valid=True,
        )

    op.create_table(
        "query_usage",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sync_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("snowflake_query_id", sa.Text(), nullable=False),
        sa.Column("query_hash", sa.Text(), nullable=False),
        sa.Column("warehouse_name", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("compute_credits", sa.Numeric(), nullable=True),
        sa.Column("acceleration_credits", sa.Numeric(), nullable=True),
        sa.CheckConstraint(
            "compute_credits is null or compute_credits >= 0",
            name="ck_query_usage_compute_nonnegative",
        ),
        sa.CheckConstraint(
            "acceleration_credits is null or acceleration_credits >= 0",
            name="ck_query_usage_acceleration_nonnegative",
        ),
        sa.ForeignKeyConstraint(["connection_id"], ["snowflake_connections.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["sync_run_id"], ["sync_runs.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "connection_id",
            "snowflake_query_id",
            name="uq_query_usage_org_query",
        ),
    )
    op.create_index("ix_query_usage_connection_time", "query_usage", ["connection_id", "started_at"])
    op.create_index("ix_query_usage_sync_run", "query_usage", ["sync_run_id"])
    op.create_index("ix_query_usage_org_time", "query_usage", ["organization_id", "started_at"])

    op.create_table(
        "query_dataset_allocations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("query_usage_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("allocation_weight", sa.Numeric(), nullable=False),
        sa.Column("evidence_source", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "allocation_weight > 0 and allocation_weight <= 1",
            name="ck_query_dataset_allocation_weight",
        ),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["query_usage_id"], ["query_usage.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("query_usage_id", "dataset_id", name="uq_query_dataset_allocation"),
    )
    op.create_index("ix_query_allocations_dataset", "query_dataset_allocations", ["dataset_id"])
    op.create_index("ix_query_allocations_org", "query_dataset_allocations", ["organization_id"])

    _create_rls_and_grants()


def _create_rls_and_grants() -> None:
    op.execute("create schema if not exists private")
    op.execute("revoke all on schema private from public, anon, authenticated, service_role")
    op.execute(
        """
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'tibbou_runtime') then
            create role tibbou_runtime nologin nosuperuser nocreatedb nocreaterole nobypassrls;
          end if;
          if not exists (select 1 from pg_roles where rolname = 'tibbou_worker') then
            create role tibbou_worker nologin nosuperuser nocreatedb nocreaterole nobypassrls;
          end if;
        end $$
        """
    )
    op.execute("grant usage on schema public, private to tibbou_runtime, tibbou_worker")

    op.execute(
        """
        create function private.request_user_id()
        returns uuid language sql stable security invoker set search_path = ''
        as $$ select nullif(pg_catalog.current_setting('app.current_user_id', true), '')::pg_catalog.uuid $$
        """
    )
    op.execute(
        """
        create function private.request_organization_id()
        returns uuid language sql stable security invoker set search_path = ''
        as $$ select nullif(pg_catalog.current_setting('app.current_organization_id', true), '')::pg_catalog.uuid $$
        """
    )
    op.execute(
        """
        create function private.is_organization_member(target_organization_id uuid)
        returns boolean language plpgsql stable security definer set search_path = ''
        as $$
        declare request_user uuid := private.request_user_id();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member')
             and not pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member') then
            return false;
          end if;
          return request_user is not null and exists (
            select 1 from public.organization_memberships membership
            where membership.organization_id = target_organization_id
              and membership.user_id = request_user
          );
        end $$
        """
    )
    op.execute(
        """
        create function private.has_organization_role(target_organization_id uuid, allowed_roles text[])
        returns boolean language plpgsql stable security definer set search_path = ''
        as $$
        declare
          request_user uuid := private.request_user_id();
          request_organization uuid := private.request_organization_id();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member')
             and not pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member') then
            return false;
          end if;
          return request_user is not null
            and request_organization is not null
            and request_organization = target_organization_id
            and allowed_roles is not null
            and exists (
              select 1 from public.organization_memberships membership
              where membership.organization_id = target_organization_id
                and membership.user_id = request_user
                and membership.role = any(allowed_roles)
            );
        end $$
        """
    )
    op.execute(
        """
        create function private.can_bootstrap_owner(target_organization_id uuid, target_user_id uuid)
        returns boolean language plpgsql stable security definer set search_path = ''
        as $$
        declare request_user uuid := private.request_user_id();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member') then
            return false;
          end if;
          return request_user is not null
            and request_user = target_user_id
            and exists (
              select 1 from public.organizations organization
              where organization.id = target_organization_id
                and organization.created_by = request_user
            )
            and not exists (
              select 1 from public.organization_memberships membership
              where membership.organization_id = target_organization_id
            );
        end $$
        """
    )
    op.execute(
        """
        create function private.protect_last_owner()
        returns trigger language plpgsql security definer set search_path = ''
        as $$
        begin
          if old.role = 'owner'
             and (tg_op = 'DELETE' or new.role <> 'owner')
             and not exists (
               select 1 from public.organization_memberships other
               where other.organization_id = old.organization_id
                 and other.user_id <> old.user_id
                 and other.role = 'owner'
             ) then
            raise exception 'an organization must retain at least one owner';
          end if;
          if tg_op = 'DELETE' then return old; end if;
          return new;
        end $$
        """
    )
    op.execute(
        "create trigger organization_memberships_protect_last_owner "
        "before update of role or delete on organization_memberships "
        "for each row execute function private.protect_last_owner()"
    )
    op.execute(
        """
        create function private.enforce_raw_ingestion_sync_run()
        returns trigger language plpgsql security definer set search_path = ''
        as $$
        begin
          if new.sync_run_id is null
             and (tg_op = 'INSERT' or old.sync_run_id is not null) then
            raise exception 'raw ingestion requires a sync run'
              using errcode = '23514';
          end if;
          return new;
        end $$
        """
    )
    op.execute(
        "create trigger raw_ingestions_require_sync_run "
        "before insert or update of sync_run_id on raw_ingestions "
        "for each row execute function private.enforce_raw_ingestion_sync_run()"
    )

    for signature in (
        "private.request_user_id()",
        "private.request_organization_id()",
        "private.is_organization_member(uuid)",
        "private.has_organization_role(uuid, text[])",
        "private.can_bootstrap_owner(uuid, uuid)",
        "private.protect_last_owner()",
        "private.enforce_raw_ingestion_sync_run()",
    ):
        op.execute(
            f"revoke all on function {signature} from public, anon, authenticated, service_role"
        )
    op.execute(
        "grant execute on function private.request_user_id(), "
        "private.request_organization_id(), private.is_organization_member(uuid), "
        "private.has_organization_role(uuid, text[]) to tibbou_runtime, tibbou_worker"
    )
    op.execute(
        "grant execute on function private.can_bootstrap_owner(uuid, uuid) to tibbou_runtime"
    )

    op.execute("alter table organizations enable row level security")
    op.execute("alter table organizations force row level security")
    op.execute("alter table organization_memberships enable row level security")
    op.execute("alter table organization_memberships force row level security")
    op.execute(
        "create policy organizations_read on organizations for select to tibbou_runtime "
        "using (created_by = (select private.request_user_id()) or private.is_organization_member(id))"
    )
    op.execute(
        "create policy organizations_insert on organizations for insert to tibbou_runtime "
        "with check (created_by = (select private.request_user_id()))"
    )
    op.execute(
        "create policy memberships_read on organization_memberships for select to tibbou_runtime "
        "using (user_id = (select private.request_user_id()) or "
        "private.is_organization_member(organization_id))"
    )
    op.execute(
        "create policy memberships_insert on organization_memberships for insert to tibbou_runtime "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )
    op.execute(
        "create policy memberships_update on organization_memberships for update to tibbou_runtime "
        "using (private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end)) "
        "with check (private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )
    op.execute(
        "create policy memberships_delete on organization_memberships for delete to tibbou_runtime "
        "using (private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )

    for table_name in BUSINESS_TABLES:
        op.execute(f"alter table {table_name} enable row level security")
        op.execute(f"alter table {table_name} force row level security")
        op.execute(
            f"create policy {table_name}_select on {table_name} for select "
            "to tibbou_runtime, tibbou_worker using ("
            f"private.has_organization_role({table_name}.organization_id, "
            "array['owner', 'admin', 'operator', 'viewer']::text[]))"
        )
        op.execute(
            f"create policy {table_name}_insert on {table_name} for insert "
            "to tibbou_runtime, tibbou_worker with check ("
            f"private.has_organization_role({table_name}.organization_id, "
            "array['owner', 'admin', 'operator']::text[]))"
        )
        op.execute(
            f"create policy {table_name}_update on {table_name} for update "
            "to tibbou_runtime, tibbou_worker using ("
            f"private.has_organization_role({table_name}.organization_id, "
            "array['owner', 'admin', 'operator']::text[])) with check ("
            f"private.has_organization_role({table_name}.organization_id, "
            "array['owner', 'admin', 'operator']::text[]))"
        )
        op.execute(
            f"create policy {table_name}_delete on {table_name} for delete "
            "to tibbou_runtime, tibbou_worker using ("
            f"private.has_organization_role({table_name}.organization_id, "
            "array['owner', 'admin', 'operator']::text[]))"
        )

    for table_name in ("users", "alembic_version"):
        op.execute(f"alter table {table_name} enable row level security")
        op.execute(f"alter table {table_name} force row level security")

    # Browser business-data access is intentionally absent: Supabase provides
    # identity, while FastAPI uses dedicated least-privilege database roles.
    op.execute("revoke all on all tables in schema public from anon, authenticated, service_role")
    op.execute("revoke all on all sequences in schema public from anon, authenticated, service_role")
    op.execute(
        "alter default privileges for role postgres in schema public "
        "revoke all on tables from anon, authenticated, service_role"
    )
    op.execute(
        "alter default privileges for role postgres in schema public "
        "revoke all on sequences from anon, authenticated, service_role"
    )
    op.execute(
        "alter default privileges for role postgres in schema public "
        "revoke execute on functions from public, anon, authenticated, service_role"
    )
    op.execute(
        "grant select, insert, update, delete on organizations, organization_memberships "
        "to tibbou_runtime"
    )
    op.execute(
        "grant select, insert, update, delete on "
        + ", ".join(BUSINESS_TABLES)
        + " to tibbou_runtime, tibbou_worker"
    )

    op.execute(
        """
        create function private.claim_sync_run()
        returns table (id uuid, organization_id uuid, requested_by uuid)
        language plpgsql security definer set search_path = ''
        as $$
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member') then
            raise exception 'worker role required';
          end if;
          return query
          update public.sync_runs as target
          set status = 'running', started_at = now(),
              attempt_count = attempt_count + 1, error = null
          where target.id = (
            select candidate.id from public.sync_runs candidate
            where candidate.status = 'queued'
              and candidate.queued_at <= now()
              and candidate.organization_id is not null
              and candidate.requested_by is not null
            order by candidate.queued_at, candidate.id
            limit 1 for update skip locked
          )
          returning target.id, target.organization_id, target.requested_by;
        end $$
        """
    )
    op.execute(
        "revoke all on function private.claim_sync_run() "
        "from public, anon, authenticated, service_role, tibbou_runtime"
    )
    op.execute("grant execute on function private.claim_sync_run() to tibbou_worker")


def downgrade() -> None:
    # Destructive after tenant-era writes. Intentionally does not restore the
    # insecure Data API grants/default privileges revoked during upgrade.
    op.execute("drop function if exists private.claim_sync_run()")
    for table_name in BUSINESS_TABLES:
        for operation in ("delete", "update", "insert", "select"):
            op.execute(f"drop policy if exists {table_name}_{operation} on {table_name}")
        op.execute(f"alter table {table_name} no force row level security")
        op.execute(f"alter table {table_name} disable row level security")

    for policy, table in (
        ("memberships_delete", "organization_memberships"),
        ("memberships_update", "organization_memberships"),
        ("memberships_insert", "organization_memberships"),
        ("memberships_read", "organization_memberships"),
        ("organizations_insert", "organizations"),
        ("organizations_read", "organizations"),
    ):
        op.execute(f"drop policy if exists {policy} on {table}")
    op.execute(
        "drop trigger if exists organization_memberships_protect_last_owner "
        "on organization_memberships"
    )
    op.execute(
        "drop trigger if exists raw_ingestions_require_sync_run on raw_ingestions"
    )
    for signature in (
        "private.protect_last_owner()",
        "private.enforce_raw_ingestion_sync_run()",
        "private.can_bootstrap_owner(uuid, uuid)",
        "private.has_organization_role(uuid, text[])",
        "private.is_organization_member(uuid)",
        "private.request_organization_id()",
        "private.request_user_id()",
    ):
        op.execute(f"drop function if exists {signature}")

    for table_name in ("users", "alembic_version"):
        op.execute(f"alter table {table_name} no force row level security")
        op.execute(f"alter table {table_name} disable row level security")

    op.drop_table("query_dataset_allocations")
    op.drop_table("query_usage")

    op.drop_constraint("ck_raw_ingestions_status", "raw_ingestions", type_="check")
    op.drop_index("ix_raw_ingestions_org_type_time", table_name="raw_ingestions")
    op.drop_index("ix_raw_ingestions_sync_run", table_name="raw_ingestions")
    op.drop_constraint("fk_raw_ingestions_sync_run_id", "raw_ingestions", type_="foreignkey")
    op.drop_column("raw_ingestions", "artifact_hash")
    op.drop_column("raw_ingestions", "sync_run_id")

    op.drop_index("ix_sync_runs_requested_by", table_name="sync_runs")
    op.drop_index("ix_sync_runs_connection", table_name="sync_runs")
    op.drop_index("ix_sync_runs_queue", table_name="sync_runs")
    op.drop_constraint("ck_sync_runs_status", "sync_runs", type_="check")
    op.drop_constraint("uq_sync_runs_org_idempotency", "sync_runs", type_="unique")
    op.drop_constraint("fk_sync_runs_requested_by", "sync_runs", type_="foreignkey")
    op.drop_constraint("fk_sync_runs_connection_id", "sync_runs", type_="foreignkey")
    op.alter_column("sync_runs", "started_at", nullable=False)
    for column in ("idempotency_key", "attempt_count", "queued_at", "requested_by", "connection_id"):
        op.drop_column("sync_runs", column)

    op.drop_index("ix_cost_snapshots_org_collected", table_name="cost_snapshots")
    op.drop_index("ix_cost_snapshots_dataset", table_name="cost_snapshots")
    op.drop_constraint("ck_cost_snapshots_nonnegative", "cost_snapshots", type_="check")
    op.drop_constraint("ck_cost_snapshots_period", "cost_snapshots", type_="check")

    op.drop_index("ix_lineage_org_active", table_name="lineage_edges")
    op.drop_index("ix_lineage_downstream", table_name="lineage_edges")
    op.drop_index("ix_lineage_upstream", table_name="lineage_edges")
    op.drop_constraint(
        "uq_lineage_edges_upstream_downstream_relationship",
        "lineage_edges",
        type_="unique",
    )
    op.drop_constraint("ck_lineage_edges_confidence", "lineage_edges", type_="check")
    op.drop_constraint("ck_lineage_edges_not_self", "lineage_edges", type_="check")
    for column in ("observed_at", "is_active", "confidence", "provenance"):
        op.drop_column("lineage_edges", column)
    op.create_unique_constraint(
        "uq_lineage_edges_upstream_downstream_relationship",
        "lineage_edges",
        ["upstream_dataset_id", "downstream_dataset_id", "relationship_type"],
    )

    op.drop_index("ix_datasets_physical_identity", table_name="datasets")
    op.drop_index("ix_datasets_org_active_created", table_name="datasets")
    op.drop_constraint("uq_datasets_org_source_id", "datasets", type_="unique")
    for column in (
        "last_seen_at", "is_active", "relation_name", "object_domain", "object_name",
        "schema_name", "database_name", "account_name", "source_unique_id",
    ):
        op.drop_column("datasets", column)

    for table_name in reversed(LEGACY_BUSINESS_TABLES):
        op.drop_index(f"ix_{table_name}_organization_id", table_name=table_name)
        op.drop_constraint(f"ck_{table_name}_organization_required", table_name, type_="check")
        op.drop_constraint(f"fk_{table_name}_organization_id", table_name, type_="foreignkey")
        op.drop_column(table_name, "organization_id")

    op.drop_table("snowflake_connections")
    op.drop_table("organization_memberships")
    op.drop_index("ix_organizations_created_by", table_name="organizations")
    op.drop_table("organizations")
