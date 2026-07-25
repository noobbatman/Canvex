"""Fix embedding vector dimensions to match text-embedding-004 (768, not 1536).

Revision ID: 202607060001
Revises: 202606040001
Create Date: 2026-07-06
"""

from __future__ import annotations

from alembic import op


revision = "202607060001"
down_revision = "202606040001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Any existing values were produced against the wrong dimensionality
    # (or the local deterministic fallback), so there is nothing worth
    # preserving across the resize.
    op.execute("UPDATE whiteboard_elements SET embedding = NULL WHERE embedding IS NOT NULL")
    op.execute("ALTER TABLE whiteboard_elements ALTER COLUMN embedding TYPE vector(768)")


def downgrade() -> None:
    op.execute("UPDATE whiteboard_elements SET embedding = NULL WHERE embedding IS NOT NULL")
    op.execute("ALTER TABLE whiteboard_elements ALTER COLUMN embedding TYPE vector(1536)")
