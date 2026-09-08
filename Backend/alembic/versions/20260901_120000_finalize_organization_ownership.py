"""finalize organization ownership constraints

Revision ID: 20260901_120000
Revises: 20260818_120000
Create Date: 2026-09-01 12:00:00

This contract stage assumes ownership was reviewed and assigned separately.
It validates the deferred organization constraints and makes the five legacy
business-table organization_id columns physically NOT NULL without changing
row data.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260901_120000"
down_revision = "20260818_120000"
branch_labels = None
depends_on = None

LEGACY_BUSINESS_TABLES = (
    "datasets",
    "lineage_edges",
    "cost_snapshots",
    "raw_ingestions",
    "sync_runs",
)


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    for table_name in LEGACY_BUSINESS_TABLES:
        op.execute(
            sa.text(
                f"ALTER TABLE public.{table_name} "
                f"VALIDATE CONSTRAINT fk_{table_name}_organization_id"
            )
        )
        op.execute(
            sa.text(
                f"ALTER TABLE public.{table_name} "
                f"VALIDATE CONSTRAINT ck_{table_name}_organization_required"
            )
        )
        op.alter_column(
            table_name,
            "organization_id",
            existing_type=postgresql.UUID(as_uuid=True),
            nullable=False,
            schema="public",
        )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    for table_name in reversed(LEGACY_BUSINESS_TABLES):
        op.alter_column(
            table_name,
            "organization_id",
            existing_type=postgresql.UUID(as_uuid=True),
            nullable=True,
            schema="public",
        )
        op.drop_constraint(
            f"ck_{table_name}_organization_required",
            table_name,
            type_="check",
            schema="public",
        )
        op.create_check_constraint(
            f"ck_{table_name}_organization_required",
            table_name,
            "organization_id is not null",
            schema="public",
            postgresql_not_valid=True,
        )
