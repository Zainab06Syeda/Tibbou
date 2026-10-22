"""cascade memberships when a user is deleted

Revision ID: 20261022_120000
Revises: 20261013_120000
Create Date: 2026-10-22 12:00:00

organization_memberships.user_id referenced auth.users with ON DELETE
RESTRICT, so deleting any user who belonged to an organization failed in
the Supabase dashboard ("Database error deleting user"). Remove their
memberships with them instead. Deleting an organization's last owner still
fails: the protect_last_owner trigger fires for the cascaded delete too,
so an organization is never left without an owner.
"""

from alembic import op


revision = "20261022_120000"
down_revision = "20261013_120000"
branch_labels = None
depends_on = None

CONSTRAINT = "organization_memberships_user_id_fkey"


def _replace_user_foreign_key(on_delete: str) -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")
    # The original constraint was created unnamed, so look its name up.
    op.execute(
        """
        do $$
        declare existing text;
        begin
          for existing in
            select conname from pg_catalog.pg_constraint
            where conrelid = 'public.organization_memberships'::regclass
              and contype = 'f'
              and confrelid = 'auth.users'::regclass
          loop
            execute pg_catalog.format(
              'alter table public.organization_memberships drop constraint %I', existing
            );
          end loop;
        end $$
        """
    )
    op.execute(
        f"alter table public.organization_memberships add constraint {CONSTRAINT} "
        f"foreign key (user_id) references auth.users (id) on delete {on_delete} not valid"
    )
    op.execute(f"alter table public.organization_memberships validate constraint {CONSTRAINT}")


def upgrade() -> None:
    _replace_user_foreign_key("cascade")


def downgrade() -> None:
    _replace_user_foreign_key("restrict")
