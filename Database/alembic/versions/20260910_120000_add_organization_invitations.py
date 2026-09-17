"""add organization invitation onboarding

Revision ID: 20260910_120000
Revises: 20260901_120000
Create Date: 2026-09-10 12:00:00

Adds pending exact-email invitations without changing existing organization or
business data. Organization bootstrap remains a separate platform operation.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260910_120000"
down_revision = "20260901_120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.create_table(
        "organization_invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), server_default=sa.text("'viewer'"), nullable=False),
        sa.Column("invited_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now() + interval '7 days'"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "email = lower(btrim(email)) and length(email) between 3 and 320 "
            "and email not like '% %' and email like '%_@_%._%'",
            name="ck_organization_invitations_email",
        ),
        sa.CheckConstraint(
            "role in ('admin', 'operator', 'viewer')",
            name="ck_organization_invitations_role",
        ),
        sa.CheckConstraint(
            "expires_at > created_at",
            name="ck_organization_invitations_expiry",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"], ["organizations.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["invited_by"], ["auth.users.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "email",
            name="uq_organization_invitations_org_email",
        ),
    )
    op.create_index(
        "ix_organization_invitations_email_expiry",
        "organization_invitations",
        ["email", "expires_at"],
    )

    op.execute(
        """
        create function private.request_user_email()
        returns text language sql stable security invoker set search_path = ''
        as $$
          select nullif(
            pg_catalog.lower(pg_catalog.btrim(
              pg_catalog.current_setting('app.current_user_email', true)
            )),
            ''
          )
        $$
        """
    )
    op.execute(
        """
        create function private.list_request_user_organization_invitations()
        returns table (
          id uuid,
          organization_id uuid,
          organization_name text,
          organization_slug text,
          role text,
          expires_at timestamptz
        )
        language plpgsql stable security definer set search_path = ''
        as $$
        declare
          request_user uuid := private.request_user_id();
          request_email text := private.request_user_email();
        begin
          if not pg_catalog.pg_has_role(session_user, 'tibbou_runtime', 'member')
             or request_user is null
             or request_email is null then
            return;
          end if;

          return query
          select invitation.id,
                 organization.id,
                 organization.name,
                 organization.slug,
                 invitation.role,
                 invitation.expires_at
          from public.organization_invitations invitation
          join public.organizations organization
            on organization.id = invitation.organization_id
          where invitation.email = request_email
            and invitation.expires_at > pg_catalog.statement_timestamp()
          order by organization.name, invitation.id;
        end
        $$
        """
    )
    op.execute(
        """
        create function private.can_accept_organization_invitation(
          target_organization_id uuid,
          target_user_id uuid,
          target_role text
        )
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
            and request_email is not null
            and request_user = target_user_id
            and target_role in ('admin', 'operator', 'viewer')
            and exists (
              select 1
              from public.organization_invitations invitation
              where invitation.organization_id = target_organization_id
                and invitation.email = request_email
                and invitation.role = target_role
                and invitation.expires_at > pg_catalog.statement_timestamp()
            );
        end
        $$
        """
    )

    for signature in (
        "private.request_user_email()",
        "private.list_request_user_organization_invitations()",
        "private.can_accept_organization_invitation(uuid, uuid, text)",
    ):
        op.execute(
            f"revoke all on function {signature} from public, anon, authenticated, service_role"
        )
    op.execute(
        "grant execute on function private.request_user_email(), "
        "private.list_request_user_organization_invitations(), "
        "private.can_accept_organization_invitation(uuid, uuid, text) "
        "to tibbou_runtime"
    )

    op.execute("alter table organization_invitations enable row level security")
    op.execute("alter table organization_invitations force row level security")
    op.execute(
        "create policy organization_invitations_read on organization_invitations "
        "for select to tibbou_runtime using ("
        "(email = (select private.request_user_email()) "
        "and expires_at > statement_timestamp()) "
        "or private.has_organization_role(organization_id, array['owner', 'admin']::text[]))"
    )
    op.execute(
        "create policy organization_invitations_insert on organization_invitations "
        "for insert to tibbou_runtime with check ("
        "invited_by = (select private.request_user_id()) and "
        "private.has_organization_role(organization_id, case when role = 'admin' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )
    op.execute(
        "create policy organization_invitations_delete on organization_invitations "
        "for delete to tibbou_runtime using ("
        "email = (select private.request_user_email()) or "
        "private.has_organization_role(organization_id, case when role = 'admin' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )

    op.execute("drop policy memberships_insert on organization_memberships")
    op.execute(
        "create policy memberships_insert on organization_memberships for insert to tibbou_runtime "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end) "
        "or private.can_accept_organization_invitation(organization_id, user_id, role))"
    )

    op.execute(
        "revoke all on organization_invitations from anon, authenticated, service_role"
    )
    op.execute(
        "grant select, insert, delete on organization_invitations to tibbou_runtime"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.execute("drop policy memberships_insert on organization_memberships")
    op.execute(
        "create policy memberships_insert on organization_memberships for insert to tibbou_runtime "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end))"
    )

    for policy in (
        "organization_invitations_delete",
        "organization_invitations_insert",
        "organization_invitations_read",
    ):
        op.execute(f"drop policy if exists {policy} on organization_invitations")

    op.execute(
        "drop function private.can_accept_organization_invitation(uuid, uuid, text)"
    )
    op.execute("drop function private.list_request_user_organization_invitations()")
    op.drop_index(
        "ix_organization_invitations_email_expiry",
        table_name="organization_invitations",
    )
    op.drop_table("organization_invitations")
    op.execute("drop function private.request_user_email()")
