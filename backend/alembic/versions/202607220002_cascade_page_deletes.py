"""ON DELETE CASCADE so a channel (and its pages) can actually be deleted.

element_events / sessions / ai_interactions referenced whiteboard_pages without
cascade, and ai_feedback references ai_interactions — so deleting a channel that
had any usage history failed with a foreign-key error (500). Recreate those FKs
with ON DELETE CASCADE, and SET NULL for review_comments.snapshot_event.

The initial schema created these via inline ``REFERENCES`` (no explicit name), so
Postgres named them ``<table>_<column>_fkey``.

Revision ID: 202607220002
Revises: 202607220001
"""

from alembic import op

revision = "202607220002"
down_revision = "202607220001"
branch_labels = None
depends_on = None

# (table, column, referenced table, on-delete action)
_FKS = [
    ("element_events", "page_id", "whiteboard_pages", "CASCADE"),
    ("sessions", "page_id", "whiteboard_pages", "CASCADE"),
    ("ai_interactions", "page_id", "whiteboard_pages", "CASCADE"),
    ("ai_feedback", "interaction_id", "ai_interactions", "CASCADE"),
    ("review_comments", "snapshot_event", "element_events", "SET NULL"),
]


def _recreate(action_override: str | None) -> None:
    for table, col, ref, action in _FKS:
        act = action_override if action_override is not None else action
        clause = f" ON DELETE {act}" if act else ""
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_{col}_fkey")
        op.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {table}_{col}_fkey "
            f"FOREIGN KEY ({col}) REFERENCES {ref}(id){clause}"
        )


def upgrade() -> None:
    _recreate(None)


def downgrade() -> None:
    # Restore the original NO ACTION foreign keys.
    _recreate("")
