"""add managed Snowflake key-pair connections

Revision ID: 20260921_120000
Revises: 20260910_120000
Create Date: 2026-09-21 12:00:00

Adds Vault-backed Snowflake credentials and connection lifecycle metadata without
changing existing business rows or deleting existing credentials.
"""

from alembic import op
import sqlalchemy as sa


revision = "20260921_120000"
down_revision = "20260910_120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")
    op.execute(
        """
        do $$ begin
          if not exists (
            select 1 from pg_catalog.pg_extension where extname = 'supabase_vault'
          ) then
            raise exception 'supabase_vault extension is required';
          end if;
        end $$
        """
    )

    op.add_column(
        "snowflake_connections",
        sa.Column(
            "credential_provider",
            sa.Text(),
            server_default=sa.text("'environment'"),
            nullable=False,
        ),
    )
    op.add_column(
        "snowflake_connections",
        sa.Column(
            "lifecycle_state",
            sa.Text(),
            server_default=sa.text("'configured'"),
            nullable=False,
        ),
    )
    op.add_column("snowflake_connections", sa.Column("public_key", sa.Text()))
    op.add_column(
        "snowflake_connections", sa.Column("public_key_fingerprint", sa.Text())
    )
    op.add_column("snowflake_connections", sa.Column("key_pair_name", sa.Text()))
    op.add_column(
        "snowflake_connections",
        sa.Column("key_expires_at", sa.DateTime(timezone=True)),
    )
    op.add_column("snowflake_connections", sa.Column("validation_error", sa.Text()))
    op.alter_column("snowflake_connections", "secret_reference", nullable=True)

    op.create_check_constraint(
        "ck_snowflake_connections_credential_provider",
        "snowflake_connections",
        "credential_provider in ('environment', 'supabase_vault')",
        postgresql_not_valid=True,
    )
    op.create_check_constraint(
        "ck_snowflake_connections_lifecycle_state",
        "snowflake_connections",
        "lifecycle_state in ('configured', 'validated', 'active', 'invalid', 'disabled')",
        postgresql_not_valid=True,
    )
    op.create_check_constraint(
        "ck_snowflake_connections_vault_metadata",
        "snowflake_connections",
        "credential_provider <> 'supabase_vault' or "
        "(public_key is not null and public_key_fingerprint is not null and "
        "key_pair_name is not null and "
        "(secret_reference is not null or lifecycle_state = 'configured'))",
        postgresql_not_valid=True,
    )
    for constraint in (
        "ck_snowflake_connections_credential_provider",
        "ck_snowflake_connections_lifecycle_state",
        "ck_snowflake_connections_vault_metadata",
    ):
        op.execute(
            f"alter table public.snowflake_connections validate constraint {constraint}"
        )

    op.create_index(
        "uq_snowflake_connections_one_enabled_per_org",
        "snowflake_connections",
        ["organization_id"],
        unique=True,
        postgresql_where=sa.text("enabled"),
    )

    op.execute(
        """
        create function private.create_snowflake_connection_secret(
          target_connection_id uuid,
          target_private_key text
        )
        returns uuid language plpgsql volatile security definer set search_path = ''
        as $$
        declare
          target_organization_id uuid;
          target_provider text;
          current_secret_reference text;
          created_secret_id uuid;
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member') then
            raise exception 'runtime role required';
          end if;

          select connection.organization_id,
                 connection.credential_provider,
                 connection.secret_reference
          into target_organization_id, target_provider, current_secret_reference
          from public.snowflake_connections connection
          where connection.id = target_connection_id;

          if target_organization_id is null
             or not private.has_organization_role(
               target_organization_id, array['owner', 'admin']::text[]
             ) then
            raise exception 'snowflake connection unavailable';
          end if;
          if target_provider <> 'supabase_vault' or current_secret_reference is not null then
            raise exception 'snowflake credential cannot be created';
          end if;
          if target_private_key is null or length(target_private_key) < 1 then
            raise exception 'snowflake private key is required';
          end if;

          created_secret_id := vault.create_secret(
            target_private_key,
            'tibbou-snowflake-' || target_connection_id::text,
            'Tibbou Snowflake private key'
          );
          update public.snowflake_connections
          set secret_reference = created_secret_id::text,
              updated_at = pg_catalog.now()
          where id = target_connection_id;
          return created_secret_id;
        end
        $$
        """
    )
    op.execute(
        """
        create function private.read_snowflake_connection_secret(
          target_connection_id uuid
        )
        returns text language plpgsql stable security definer set search_path = ''
        as $$
        declare
          target_organization_id uuid;
          target_provider text;
          target_secret_reference text;
          decrypted_private_key text;
        begin
          select connection.organization_id,
                 connection.credential_provider,
                 connection.secret_reference
          into target_organization_id, target_provider, target_secret_reference
          from public.snowflake_connections connection
          where connection.id = target_connection_id;

          if target_organization_id is null
             or not (
               (
                 pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member')
                 and private.has_organization_role(
                   target_organization_id, array['owner', 'admin']::text[]
                 )
               )
               or (
                 pg_catalog.pg_has_role(session_user, 'tibbou_worker', 'member')
                 and private.has_organization_role(
                   target_organization_id, array['owner', 'admin', 'operator']::text[]
                 )
               )
             ) then
            raise exception 'snowflake connection unavailable';
          end if;
          if target_provider <> 'supabase_vault' or target_secret_reference is null then
            raise exception 'snowflake credential unavailable';
          end if;

          select secret.decrypted_secret
          into decrypted_private_key
          from vault.decrypted_secrets secret
          where secret.id = target_secret_reference::uuid;

          if decrypted_private_key is null then
            raise exception 'snowflake credential unavailable';
          end if;
          return decrypted_private_key;
        end
        $$
        """
    )

    for signature in (
        "private.create_snowflake_connection_secret(uuid, text)",
        "private.read_snowflake_connection_secret(uuid)",
    ):
        op.execute(
            f"revoke all on function {signature} from public, anon, authenticated, service_role"
        )
    op.execute(
        "grant execute on function "
        "private.create_snowflake_connection_secret(uuid, text) to tibbou_runtime"
    )
    op.execute(
        "grant execute on function "
        "private.read_snowflake_connection_secret(uuid) to tibbou_runtime, tibbou_worker"
    )
    op.execute(
        "revoke all on vault.secrets, vault.decrypted_secrets "
        "from public, anon, authenticated, service_role, tibbou_runtime, tibbou_worker"
    )

    for policy in (
        "snowflake_connections_insert",
        "snowflake_connections_update",
        "snowflake_connections_delete",
    ):
        op.execute(f"drop policy {policy} on snowflake_connections")
    op.execute(
        "create policy snowflake_connections_insert on snowflake_connections "
        "for insert to tibbou_runtime with check ("
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[]))"
    )
    op.execute(
        "create policy snowflake_connections_update on snowflake_connections "
        "for update to tibbou_runtime, tibbou_worker using ("
        "(pg_has_role(session_user, 'tibbou_runtime', 'member') and "
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[])) or "
        "(pg_has_role(session_user, 'tibbou_worker', 'member') and "
        "private.has_organization_role(organization_id, "
        "array['owner', 'admin', 'operator']::text[]))) with check ("
        "(pg_has_role(session_user, 'tibbou_runtime', 'member') and "
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[])) or "
        "(pg_has_role(session_user, 'tibbou_worker', 'member') and "
        "private.has_organization_role(organization_id, "
        "array['owner', 'admin', 'operator']::text[])))"
    )
    op.execute(
        "create policy snowflake_connections_delete on snowflake_connections "
        "for delete to tibbou_runtime using ("
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[]))"
    )
    op.execute("revoke insert, delete on snowflake_connections from tibbou_worker")


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    for policy in (
        "snowflake_connections_insert",
        "snowflake_connections_update",
        "snowflake_connections_delete",
    ):
        op.execute(f"drop policy if exists {policy} on snowflake_connections")
    for action in ("insert", "update", "delete"):
        op.execute(
            f"create policy snowflake_connections_{action} on snowflake_connections "
            f"for {action} to tibbou_runtime, tibbou_worker "
            + ("with check (" if action == "insert" else "using (")
            + "private.has_organization_role(organization_id, "
            "array['owner', 'admin', 'operator']::text[]))"
            + (
                " with check (private.has_organization_role(organization_id, "
                "array['owner', 'admin', 'operator']::text[]))"
                if action == "update"
                else ""
            )
        )
    op.execute(
        "grant select, insert, update, delete on snowflake_connections to tibbou_worker"
    )

    op.execute("drop function private.read_snowflake_connection_secret(uuid)")
    op.execute("drop function private.create_snowflake_connection_secret(uuid, text)")
    op.drop_index(
        "uq_snowflake_connections_one_enabled_per_org",
        table_name="snowflake_connections",
    )
    for constraint in (
        "ck_snowflake_connections_vault_metadata",
        "ck_snowflake_connections_lifecycle_state",
        "ck_snowflake_connections_credential_provider",
    ):
        op.drop_constraint(constraint, "snowflake_connections", type_="check")
    op.alter_column("snowflake_connections", "secret_reference", nullable=False)
    for column in (
        "validation_error",
        "key_expires_at",
        "key_pair_name",
        "public_key_fingerprint",
        "public_key",
        "lifecycle_state",
        "credential_provider",
    ):
        op.drop_column("snowflake_connections", column)
