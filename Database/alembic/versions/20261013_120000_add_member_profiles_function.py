"""add member profiles function

Revision ID: 20261013_120000
Revises: 20260926_140000
Create Date: 2026-10-13 12:00:00

The admin page listed members by user id only, because member emails and
names live in Supabase's auth.users, which the runtime role cannot read.
Adds a security-definer lookup that returns the email and display name of
an organization's members, and only to that organization's owners and
admins (the same check the memberships policies use). No tables change.
"""

from alembic import op


revision = "20261013_120000"
down_revision = "20260926_140000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.execute(
        """
        create function private.list_organization_member_profiles(target_organization_id uuid)
        returns table (user_id uuid, email text, display_name text)
        language plpgsql stable security definer set search_path = ''
        as $$
        begin
          if not private.has_organization_role(
            target_organization_id, array['owner', 'admin']::text[]
          ) then
            return;
          end if;

          return query
          select membership.user_id,
                 account.email::text,
                 nullif(
                   pg_catalog.btrim(
                     coalesce(
                       account.raw_user_meta_data ->> 'full_name',
                       account.raw_user_meta_data ->> 'name',
                       ''
                     )
                   ),
                   ''
                 )
          from public.organization_memberships membership
          join auth.users account on account.id = membership.user_id
          where membership.organization_id = target_organization_id;
        end $$
        """
    )
    op.execute(
        "revoke all on function private.list_organization_member_profiles(uuid) "
        "from public, anon, authenticated, service_role"
    )
    op.execute(
        "grant execute on function private.list_organization_member_profiles(uuid) "
        "to tibbou_runtime"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.execute("drop function private.list_organization_member_profiles(uuid)")
