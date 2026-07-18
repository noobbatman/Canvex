"""Add IVFFlat vector index on whiteboard_elements.embedding (deferred from Phase 1 to Phase 9).

Revision ID: 202607060002
Revises: 202607060001
Create Date: 2026-07-06
"""

from __future__ import annotations

from alembic import op


revision = "202607060002"
down_revision = "202607060001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_elements_embedding "
        "ON whiteboard_elements USING ivfflat (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_elements_embedding")
