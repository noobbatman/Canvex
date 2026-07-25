"""Drop the unused branch-lineage expression index.

idx_elements_origin_id was created for branch diff, but the diff loads all page
elements and matches _origin_id in Python (services/branching.py) — so the index
only adds write/storage cost without accelerating any query. Drop it; a future
optimization can reintroduce it alongside a SQL join that actually uses it.

Revision ID: 202607220003
Revises: 202607220002
"""

from alembic import op

revision = "202607220003"
down_revision = "202607220002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_elements_origin_id")


def downgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_elements_origin_id "
        "ON whiteboard_elements ((content->>'_origin_id')) "
        "WHERE content ? '_origin_id'"
    )
