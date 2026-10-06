"""Require approval or invitation for existing-organization enrollment.

Revision ID: 20261005_120000
Revises: 20260926_140000

Changes a membership INSERT policy and helper grants only; no business rows
are backfilled, updated, or deleted. ALTER POLICY takes a brief metadata lock.
Downgrade intentionally retains the stricter policy: rolling back code must
not silently restore automatic enrollment. Any later relaxation needs its own
explicitly reviewed forward migration.
"""
from alembic import op

revision = "20261005_120000"
down_revision = "20260926_140000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")
    op.execute(
        "alter policy memberships_insert on public.organization_memberships "
        "with check ((role = 'owner' and private.can_bootstrap_owner(organization_id, user_id)) "
        "or private.has_organization_role(organization_id, case when role = 'owner' "
        "then array['owner']::text[] else array['owner', 'admin']::text[] end) "
        "or private.can_accept_organization_invitation(organization_id, user_id, role))"
    )
    op.execute(
        "revoke all on function private.can_join_by_domain(uuid, uuid) "
        "from public, anon, authenticated, service_role, tibbou_runtime, tibbou_worker"
    )


def downgrade() -> None:
    # Retain approval-only enrollment; there is no data/schema to undo.
    pass
