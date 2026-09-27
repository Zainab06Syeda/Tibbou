"""add organization onboarding fields

Revision ID: 20260926_120000
Revises: 20260910_120000
Create Date: 2026-09-26 12:00:00

Adds domain-claiming support to organizations (claimed_email_domain,
allow_domain_join) so self-service signup can detect "this workspace already
exists" and either auto-join or route to a request-to-join flow, and adds a
database_name column to snowflake_connections so a connection can target a
specific database rather than only account/warehouse/role. Both columns are
nullable additions with no backfill: existing rows simply have no claimed
domain and no configured database until an admin sets one.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260926_120000"
down_revision = "20260910_120000"
branch_labels = None
depends_on = None


DOMAIN_CHECK = (
    "claimed_email_domain is null or ("
    "claimed_email_domain = lower(btrim(claimed_email_domain)) "
    "and claimed_email_domain ~ "
    "'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'"
    ")"
)


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.add_column(
        "organizations",
        sa.Column("claimed_email_domain", sa.Text(), nullable=True),
    )
    op.add_column(
        "organizations",
        sa.Column(
            "allow_domain_join",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_unique_constraint(
        "uq_organizations_claimed_email_domain",
        "organizations",
        ["claimed_email_domain"],
    )
    op.execute(
        f"alter table organizations add constraint ck_organizations_claimed_email_domain "
        f"check ({DOMAIN_CHECK}) not valid"
    )
    op.execute(
        "alter table organizations validate constraint ck_organizations_claimed_email_domain"
    )

    op.add_column(
        "snowflake_connections",
        sa.Column("database_name", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '2min'")
    op.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'")

    op.drop_column("snowflake_connections", "database_name")

    op.drop_constraint(
        "ck_organizations_claimed_email_domain", "organizations", type_="check"
    )
    op.drop_constraint(
        "uq_organizations_claimed_email_domain", "organizations", type_="unique"
    )
    op.drop_column("organizations", "allow_domain_join")
    op.drop_column("organizations", "claimed_email_domain")
