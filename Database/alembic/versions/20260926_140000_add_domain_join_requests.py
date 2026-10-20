"""add domain-based self-join and join requests

Revision ID: 20260926_140000
Revises: 20260926_120000
Create Date: 2026-09-26 14:00:00

Backs self-service onboarding's domain-claiming behavior: when a signup's
email domain matches an org with allow_domain_join, they can self-join
directly (new RLS branch on organization_memberships, no new table needed,
mirroring how invitation-accept already works). When allow_domain_join is
false, they instead file an organization_join_requests row that the org's
owners/admins can see and resolve -- this is the "request to join, notify
the admins" path from the spec; the notification itself is a later,
separate concern (email delivery), this migration only adds the durable
record an admin UI can list and act on.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260926_140000"
down_revision = "20260926_120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    # --- domain-based self-join -------------------------------------------------
    op.execute(
        """
        create function private.can_join_by_domain(target_organization_id uuid, target_user_id uuid)
        returns boolean language plpgsql stable security definer set search_path = ''
        as $$
        declare
          request_user uuid := private.request_user_id();
          request_email text := private.request_user_email();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member') then
            return false;
          end if;
          return request_user is not null
            and request_user = target_user_id
            and request_email is not null
            and exists (
              select 1 from public.organizations organization
              where organization.id = target_organization_id
                and organization.allow_domain_join = true
                and organization.claimed_email_domain is not null
                and organization.claimed_email_domain = pg_catalog.split_part(request_email, '@', 2)
            );
        end $$
        """
    )
    op.execute(
        """
        create function private.can_request_join_by_domain(target_organization_id uuid, target_user_id uuid)
        returns boolean language plpgsql stable security definer set search_path = ''
        as $$
        declare
          request_user uuid := private.request_user_id();
          request_email text := private.request_user_email();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member') then
            return false;
          end if;
          return request_user is not null
            and request_user = target_user_id
            and request_email is not null
            and exists (
              select 1 from public.organizations organization
              where organization.id = target_organization_id
                and organization.claimed_email_domain is not null
                and organization.claimed_email_domain = pg_catalog.split_part(request_email, '@', 2)
            );
        end $$
        """
    )

    for signature in (
        "private.can_join_by_domain(uuid, uuid)",
        "private.can_request_join_by_domain(uuid, uuid)",
    ):
        op.execute(
            f"revoke all on function {signature} from public, anon, authenticated, service_role"
        )
    op.execute(
        "grant execute on function private.can_join_by_domain(uuid, uuid), "
        "private.can_request_join_by_domain(uuid, uuid) to tibbou_runtime"
    )

    op.execute("drop policy memberships_insert on organization_memberships")
    op.execute(
        "create policy memberships_insert on organization_memberships for insert to tibbou_runtime "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end) "
        "or private.can_accept_organization_invitation(organization_id, user_id, role) "
        "or (role = 'viewer' and private.can_join_by_domain(organization_id, user_id)))"
    )

    # --- join requests (the "notify the admins" path when domain-join is off) ---
    op.create_table(
        "organization_join_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint(
            "email = lower(btrim(email)) and length(email) between 3 and 320 "
            "and email not like '% %' and email like '%_@_%._%'",
            name="ck_organization_join_requests_email",
        ),
        sa.CheckConstraint(
            "status in ('pending', 'approved', 'denied')",
            name="ck_organization_join_requests_status",
        ),
        sa.CheckConstraint(
            "(status = 'pending' and resolved_at is null and resolved_by is null) "
            "or (status <> 'pending' and resolved_at is not null and resolved_by is not null)",
            name="ck_organization_join_requests_resolution",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"], ["organizations.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["auth.users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_by"], ["auth.users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ux_organization_join_requests_pending_org_user",
        "organization_join_requests",
        ["organization_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "ix_organization_join_requests_org_status",
        "organization_join_requests",
        ["organization_id", "status"],
    )

    op.execute("alter table organization_join_requests enable row level security")
    op.execute("alter table organization_join_requests force row level security")
    op.execute(
        "create policy join_requests_read on organization_join_requests "
        "for select to tibbou_runtime using ("
        "user_id = (select private.request_user_id()) "
        "or private.has_organization_role(organization_id, array['owner', 'admin']::text[]))"
    )
    op.execute(
        "create policy join_requests_insert on organization_join_requests "
        "for insert to tibbou_runtime with check ("
        "user_id = (select private.request_user_id()) "
        "and email = (select private.request_user_email()) "
        "and private.can_request_join_by_domain(organization_id, user_id))"
    )
    op.execute(
        "create policy join_requests_resolve on organization_join_requests "
        "for update to tibbou_runtime using ("
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[])) "
        "with check ("
        "private.has_organization_role(organization_id, array['owner', 'admin']::text[]) "
        "and resolved_by = (select private.request_user_id()))"
    )

    op.execute(
        "revoke all on organization_join_requests from anon, authenticated, service_role"
    )
    op.execute(
        "grant select, insert, update on organization_join_requests to tibbou_runtime"
    )

    # --- domain-match lookup, for a user who isn't a member of anything yet -----
    # organizations_read RLS only shows orgs you already created or belong to, so
    # a brand-new signup checking "does my domain already have a workspace" needs
    # a definer function with a narrow projection, same pattern as
    # list_request_user_organization_invitations() above.
    op.execute(
        """
        create function private.find_organization_by_domain()
        returns table (
          id uuid,
          name text,
          slug text,
          allow_domain_join boolean,
          already_requested boolean
        )
        language plpgsql stable security definer set search_path = ''
        as $$
        declare
          request_user uuid := private.request_user_id();
          request_email text := private.request_user_email();
          request_domain text;
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member')
             or request_user is null
             or request_email is null then
            return;
          end if;
          request_domain := pg_catalog.split_part(request_email, '@', 2);
          if request_domain = '' then
            return;
          end if;

          return query
          select organization.id,
                 organization.name,
                 organization.slug,
                 organization.allow_domain_join,
                 exists (
                   select 1 from public.organization_join_requests join_request
                   where join_request.organization_id = organization.id
                     and join_request.user_id = request_user
                     and join_request.status = 'pending'
                 )
          from public.organizations organization
          where organization.claimed_email_domain = request_domain
          limit 1;
        end
        $$
        """
    )
    op.execute(
        "revoke all on function private.find_organization_by_domain() "
        "from public, anon, authenticated, service_role"
    )
    op.execute(
        "grant execute on function private.find_organization_by_domain() to tibbou_runtime"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.execute("drop function private.find_organization_by_domain()")

    for policy in ("join_requests_resolve", "join_requests_insert", "join_requests_read"):
        op.execute(f"drop policy if exists {policy} on organization_join_requests")
    op.drop_index(
        "ix_organization_join_requests_org_status",
        table_name="organization_join_requests",
    )
    op.drop_index(
        "ux_organization_join_requests_pending_org_user",
        table_name="organization_join_requests",
    )
    op.drop_table("organization_join_requests")

    op.execute("drop policy memberships_insert on organization_memberships")
    op.execute(
        "create policy memberships_insert on organization_memberships for insert to tibbou_runtime "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end) "
        "or private.can_accept_organization_invitation(organization_id, user_id, role))"
    )

    op.execute("drop function private.can_request_join_by_domain(uuid, uuid)")
    op.execute("drop function private.can_join_by_domain(uuid, uuid)")
