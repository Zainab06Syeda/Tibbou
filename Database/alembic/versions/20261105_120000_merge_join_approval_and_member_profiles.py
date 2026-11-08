"""merge the join-approval and member-profile migration branches

Revision ID: 20261105_120000
Revises: 20261005_120000, 20261022_120000
Create Date: 2026-11-05 12:00:00

Both branches start from 20260926_140000 and were developed in parallel:
20261005_120000 requires approval or an invitation to join an existing
organization; 20261013_120000 -> 20261022_120000 add member profiles and
cascade memberships when a user is deleted. They touch different objects,
so this revision only joins them; `alembic upgrade head` applies whichever
side a database is missing.
"""

revision = "20261105_120000"
down_revision = ("20261005_120000", "20261022_120000")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
