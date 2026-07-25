"""Phase 12.8 indexes found via EXPLAIN ANALYZE.

- sessions(page_id, started_at DESC): the replay session list
  (GET /pages/{id}/sessions) sorted+filtered with no index support.
- whiteboard_elements expression index on content->>'_origin_id': the branch
  diff joins parent elements by origin id; the GIN index can't serve ->>
  equality, so at scale that join degrades to a per-row scan.

Revision ID: 202607200001
Revises: 202607060002
"""

from alembic import op

revision = "202607200001"
down_revision = "202607060002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_page_started "
        "ON sessions (page_id, started_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_elements_origin_id "
        "ON whiteboard_elements ((content->>'_origin_id')) "
        "WHERE content ? '_origin_id'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_elements_origin_id")
    op.execute("DROP INDEX IF EXISTS idx_sessions_page_started")
